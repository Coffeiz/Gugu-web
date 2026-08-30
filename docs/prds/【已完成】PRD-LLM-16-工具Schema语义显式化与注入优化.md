# PRD-LLM-16：工具 Schema 语义显式化与注入优化

> 状态：已完成（Phase 0-8）
> 创建：2026-08-29
> 最近更新：2026-08-29（Phase 0-8 完成）
> 关联模块：`backend/agent/tools/`、`backend/agent/capabilities/injector.py`、`backend/agent/runner.py`、`backend/agent/tools/base.py`、`backend/tests/`
> 背景参考：工具 Schema 轻量注入与完整 Schema A/B 测试；生产环境只保留简介模式与全量模式。

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：语义盘点与契约基线 | ✅ 已完成 | 已固化高风险工具清单、错误分类和 A/B 评测口径，见 `docs/reports/2026-08-29-OPT-LLM-16-TOOL-SCHEMA-BASELINE.md` |
| Phase 1：Schema 语义规范 | ✅ 已完成 | 已增加来源互斥、条件必填、action 分支和 validator 回归测试 |
| Phase 2：工具契约改造 | ✅ 已完成 | 已落地日历全天、附件来源、文件来源/目标和提醒定位约束，并保留旧调用兼容 |
| Phase 3：注入器与错误恢复 | ✅ 已完成 | 保持轻量注入，按需获取当前完整 Schema |
| Phase 4：测试与灰度 | ✅ 已完成 | 已完成契约回归和错误 trace 验证；A/B 灰度进入 Phase 5 |
| Phase 5：description 优化 | ✅ 已完成 | 完成全量审计和第一批高成本工具压缩，保留不可结构化语义 |
| Phase 6：A/B 与真实业务灰度 | ✅ 已完成 | 已完成连续会话 A/B；生产模式收敛为简介模式与全量模式 |
| Phase 7：工具编写规范与文档收尾 | ✅ 已完成 | 已完成工具 README、职责边界、可选字段和格式约束规范 |
| Phase 8：全量工具 Schema 源码规范化 | ✅ 已完成 | 101 个注册工具已完成源码规范化、运行时直出和 devserver 注册/注入/按需获取/dispatch 回归；README 与报告已同步 |

## 1. 背景与目标

### 1.1 现状问题

当前部分工具把业务状态编码在“字段是否省略”“空字符串”“多个候选字段优先级”中。例如：

- `create_event` 的 `time` 不传表示全天；
- `copy_file` 的 `target` 不传表示原位复制；
- `save_uploaded_file` 的 `attach_id` 不传时可能自动取最近附件；
- `send_file` 同时接受 `file`、`file_id`、`url`、`attach_id`，实际含有优先级；
- 更新类工具中，字段不传表示保持原值，空值又可能表示清空；
- `create_project` 的 `deadline` 不传会生成默认截止日期，但无法表达“无截止日期”。

这些语义对人类描述看似简短，对模型却容易造成三类错误：漏传关键状态、把“保持不变”误解成“清空”、同时填写互斥字段导致执行路径不确定。

全量 Schema 基线也暴露出评测口径问题：20 个脱敏 case 的全量模式为 14/20（70%），但失败不等同于 Schema 校验错误。`memory_search` 不是注册工具名（实际为 `search_memory`）；`create_event` 后查询事件、`create_document` 后读取文件可能是合理的多步核实；`save_uploaded_file` 的 `attach_id` 允许在暂存区无歧义时省略。只有未路由到目标工具、字段缺失或值格式不符，才应分别计入路由、字段或值错误。本轮使用 no-op dispatch，`schema_errors=0` 仅表示没有进入真实校验失败路径，不能代表任务全部正确。

静态契约核对确认，部分失败确实来自 Schema 过于宽松：

| 工具 | 当前缺口 | 优化方向 |
| --- | --- | --- |
| `copy_file` | `file_id`/`file` 没有来源互斥或至少一个必填，`target` 也无法表达原位复制与目标复制 | 用 `oneOf` 表达来源；显式区分原位复制与目标位置 |
| `send_file` | `file`、`file_id`、`url`、`attach_id` 均可同时省略，handler 实际有静默优先级 | 四选一来源结构；`title` 仅随 `url` 出现 |
| `add_event_reminder` | `event_id`/`event` 均可省略，空对象在 Schema 层合法但 handler 无法定位活动 | 活动定位二选一；`reminders` 与 `lead_minutes` 互斥 |
| `update_todo` | 只有 `todo` 必填，没有要求至少提供 `done`、`text` 或 `to_stage` 之一 | 将定位字段与修改动作分组，动作至少一个 |
| `search_conversations` | 搜索输入与“列最近对话”共用宽松结构，并保留多个别名 | 明确搜索分支；逐步收敛 `keyword` 兼容字段 |
| `http_get` | 已有 `url`/`urls` 的 `anyOf` 互斥约束 | 保持现状，重复调用单列为轨迹问题 |
| `save_uploaded_file` | 无参数是“唯一最近附件”的有意默认，不应简单改成必填 | 增加显式来源模式，仅在唯一附件时允许隐式默认 |

因此优化顺序必须是“先收紧高风险契约，再压缩解释文本”，不能通过删除 description 掩盖来源、定位和动作没有结构化的问题。

### 1.2 目标

1. 让影响业务结果的状态使用显式字段或互斥结构表达，不依赖隐含的省略语义。
2. 保持简介模式的低 token 成本，并提供全量模式满足准确性优先场景。
3. 不在生产环境保留独立的旧版全量 Schema 定义；当前源码规范 Schema 可通过全量模式注入，也用于按需获取、校验和测试基准。
4. 让 Schema、handler、服务层和历史兼容策略拥有同一份契约。
5. 通过结构化错误 trace 记录“模型调用了什么工具、违反了哪条 Schema”，而不记录用户正文、附件名或凭据。

### 1.3 非目标

- 不把所有默认值都改成必填字段。
- 不把工具业务权限、scope 或确认要求写进动态提示词。
- 不为了追求 Schema 严格而破坏已有合法调用；兼容策略必须有明确的迁移边界。
- 不恢复未规范化的原始 Schema；当前源码规范化后的 Schema 由简介模式和全量模式共同使用。

## 2. 设计原则

### 2.1 业务状态优先显式化

满足以下任一条件时，优先增加字段或使用 `oneOf`/条件 Schema：

- 省略值与显式值代表不同业务状态；
- 同一字段既承担“未修改”又承担“清空”；
- 多个字段互斥，但当前依赖 description 说明优先级；
- 默认行为可能造成创建、发送、移动或删除目标误判。

仅影响便利性的稳定默认值，例如 `limit=5`、`mode=OR`、`space=personal`，继续保留可选，不为每个默认值增加一个开关。

可选字段必须满足以下至少一项：

- 不传本身代表一个真实且有意义的业务状态，例如 `end_time` 不传表示没有结束时间；
- 用户是否提供该值会改变工具行为，且无法由固定默认值安全替代；
- 属于低风险的便利参数，例如分页数量或排序方式。

不要为了兼容历史调用、承载空操作、重复表达默认值，或因为 handler 暂时支持省略，就保留没有独立语义的可选字段。需要区分“未修改”和“清空”时，使用 `null`、显式布尔值或 action 枚举，不用省略和空字符串猜测。

### 2.2 Schema 是机器契约，description 是解释

生产默认使用简介模式（`description`）；全量模式（`full`）保留为用户可选的准确性优先模式。

- 类型、枚举、`required`、`oneOf`、`if/then`、`null` 和边界约束表达可校验事实。
- description 只补充短语义和操作边界，不承担唯一的业务分支定义。
- 轻量目录只注入字段名、类型、必填状态和一层结构，不注入完整 JSON 或长字段说明。
- 全量模式向 provider 发送当前工具源码中的规范 `input_schema`，用于准确性优先场景；不再维护独立的 compact/full 两套 Schema 定义。

### 2.2A 工具源码即线上 Schema

完成迁移后，工具作者维护的 `input_schema` 就是 provider、`get_tool_schema` 和执行校验共同使用的规范 Schema，不再依赖运行时复制一份“精简版”。

- 工具 Schema 默认只保留可执行结构和机器约束：字段名、类型、必填、枚举、条件分支、互斥关系和边界值。
- 字段级 `description`、`title`、`default`、`example/examples` 默认不写；确实无法结构化表达的格式或语义，才允许保留一句短说明。
- 工具用途写在 `description_short`；复杂动作和字段关系必须同时由 Schema 结构表达，不能只写在自然语言里。
- 注册期 lint 负责拒绝冗余元数据和不合法结构；它是规范校验，不负责替换或改写 Schema。
- `_compact_schema` 仅作为迁移期审计辅助，不是注入模式，也不参与 provider 输出；禁止新代码依赖运行时 Schema 转换。
- 字段格式优先用 `pattern` 和结构约束表达，必要时补充一条极短格式说明；`format` 不作为唯一约束。例如 `HH:MM` 使用 `pattern` 严格限制为 `00:00`-`23:59`，可配 `description: "24小时制 HH:MM"` 帮助模型填写。全天状态用必填 `all_day`，不再用“省略 `time` 表示全天”作为新契约。

### 2.3 更新工具区分“未修改”和“清空”

更新类工具默认采用：

- 字段省略：保持原值；
- 字段传 `null`：清空，前提是该字段业务允许为空；
- 字段传具体值：设置为该值。

如果 `null` 与业务值本身仍有冲突，再增加 `*_action` 枚举，不使用空字符串承载清空语义。

### 2.4 Action 显式表达可执行动作

同一资源存在多个互斥修改动作时，使用 `action` 枚举表达动作，并让动作与参数形成条件约束。不得只列出动作名称而把字段关系留给 description 猜测。

以待办为例：

```json
{
  "properties": {
    "action": {
      "type": "string",
      "enum": ["complete", "rename", "move"],
      "description": "complete=完成或取消完成；rename=修改待办文本；move=移动到其他阶段"
    },
    "todo": {"type": "string"},
    "done": {"type": "boolean"},
    "text": {"type": "string"},
    "to_stage": {"type": "string"}
  },
  "required": ["action", "todo"],
  "allOf": [
    {"if": {"properties": {"action": {"const": "complete"}}}, "then": {"required": ["done"]}},
    {"if": {"properties": {"action": {"const": "rename"}}}, "then": {"required": ["text"]}},
    {"if": {"properties": {"action": {"const": "move"}}}, "then": {"required": ["to_stage"]}}
  ]
}
```

全量模式使用 `enum` 加 `oneOf`/`if/then` 表达完整约束；简介模式至少注入 `action` 的可选值和对应字段签名。若 provider 对条件 Schema 支持不足，由服务端按 `action` 做同一份条件校验，不能退回到多个可选字段互相猜优先级。

`action` 只适用于同一资源的紧密动作集合。不得把项目、阶段、待办、删除和权限确认全部合并为一个超级工具；权限、确认门和 handler 仍按资源边界独立负责。

## 3. 功能需求

### FR-SCHEMA-1：显式表达全天事件

`create_event` 增加 `all_day` 字段，推荐使用标准命名 `all_day`，不使用 `fullday`。

- `all_day` 为必填布尔值。
- `all_day=true` 时不得传 `time` 或 `end_time`。
- `all_day=false` 时必须传 `time`，`end_time` 继续可选。
- handler 将显式状态转换为服务层所需的时间字段。
- `update_event` 后续采用同一语义，更新全天状态时不能依赖空字符串。

建议 Schema 形态：

```json
{
  "required": ["title", "date", "all_day"],
  "allOf": [
    {
      "if": {"properties": {"all_day": {"const": true}}},
      "then": {"not": {"anyOf": [{"required": ["time"]}, {"required": ["end_time"]}]}}
    },
    {
      "if": {"properties": {"all_day": {"const": false}}},
      "then": {"required": ["time"]}
    }
  ]
}
```

### FR-SCHEMA-2：显式表达默认日期和无日期

`create_project` 必须同时填写开始日期和结束日期，避免项目时间范围依赖服务端默认值：

- `start_date` 和 `deadline` 均为必填日期；
- `deadline` 必须不早于 `start_date`，由 Schema 表达格式、由 service 校验日期先后；
- 暂不增加“无开始日期”或“无结束日期”模式；
- 旧调用缺少日期时由版本适配层处理，不让 handler 静默补今天或默认截止日。

### FR-SCHEMA-2A：项目日期迁移

- 新版本 Schema 将 `start_date`、`deadline` 放入 `required`；
- 历史项目数据继续可读，不回写虚构日期；
- 创建和更新项目的日期校验保持一致，跨日范围错误在 service 层返回结构化错误。

### FR-SCHEMA-3：显式表达文件来源和目标

逐步将文件工具的多个互斥可选字段收敛为可辨识结构：

- `save_uploaded_file`：区分 `source="latest"`、单个 `attach_id` 和多个 `attach_ids`；自动取最近附件必须是显式选择。
- `copy_file`：区分 `destination="same"` 与目标文件夹；不传目标不再隐式决定原位复制。
- `send_file`：用 `oneOf` 或带 `source_type` 的结构区分文件库文件、网络 URL 和暂存附件，禁止多个来源同时存在。
- `move_items`：继续要求 `target`，并校验空间、项目和文件夹之间的条件关系。

### FR-SCHEMA-4：统一更新操作的清空语义

- `update_event.time/end_time` 使用 `string | null`，省略表示不修改，`null` 表示清空。
- `update_project.priority` 保留 `none` 作为显式清除值，禁止再依赖空字符串。
- `update_todo` 采用 `action="complete" | "rename" | "move"`；分别条件必填 `done`、`text`、`to_stage`，`todo` 负责定位。
- 定时任务更新中，渠道使用 `channels_action="keep" | "replace" | "clear"` 的方案评估，避免 `[]` 的含义依赖 description。

### FR-SCHEMA-5：维持两档工具注入模式

保留现有用户级开关，并明确产品语义：

- **简介模式（默认、低成本）**：注入工具用途、字段名、类型、必填状态和有限路由信息；节省 token，但复杂参数需要先获取 Schema。
- **全量模式（可选、高准确）**：向 provider 注入工具源码中的规范 Schema；参数识别更准确，但消耗更多 token。
- 两种模式共享当前源码规范 Schema；简介模式按需获取，全量模式直接注入，用于准确性优先场景。
- 简介模式下调用未声明或参数不通过的工具，返回结构化 `tool_schema_required`/校验错误，并回注当前 Schema，不能让模型凭记忆反复重试。
- 模式切换只影响工具描述注入，不改变工具权限、确认门和 handler 行为。

### FR-SCHEMA-6：记录 Schema 错误 trace

每个 LoopScope run 记录脱敏的 Schema 错误结构：

- `tool_name`、Schema digest、implementation digest；
- 错误类型、失败字段路径、期望类型/约束摘要；
- 模型实际提交的字段名集合和字段类型摘要；
- 当前注入模式、恢复次数、最终是否成功。

不得记录用户正文、附件名、完整工具参数、凭据或原始 prompt。错误 trace 用于统计和定位，不改变正常工具回执。

## 4. 技术方案

### 4.1 契约分层

```text
工具定义 input_schema
    ↓
Schema 校验与结构化错误
    ↓
handler 参数适配
    ↓
领域 service / 数据库
```

工具定义是 Schema 的唯一来源；handler 不再通过“缺字段时猜默认分支”扩展模型契约。领域 service 继续负责最终业务不变量和所有权校验。

### 4.2 Schema 规范

- 新增字段优先使用 `snake_case`，与现有工具参数保持一致。
- 日期、时间使用 `format`/`pattern` 表达机器可校验格式；业务状态使用布尔值或枚举表达。
- 互斥输入使用 `oneOf`；条件必填使用 `if/then`；可清空字段使用 `type: ["string", "null"]`。
- 对复杂嵌套结构设置 `additionalProperties: false` 的边界时，先确认 provider 兼容性并保留适配层测试。
- 默认值可通过 Schema 的 `default` 和短 description 说明，但 `default` 不替代服务端实际默认逻辑。

### 4.3 兼容与迁移

- 先增加 Schema 和失败回执，再迁移 handler，避免静默改变旧调用含义。
- 旧历史中的 `time` 缺失事件按历史数据继续读取，不回写为错误状态。
- 对新 provider 调用采用新契约；必要的旧调用兼容必须位于明确的版本化适配层，不能散落在各 handler 的 `get()` 兜底里。
- 每项改造都增加“新 Schema 正例、缺字段反例、互斥字段反例、旧历史读取”测试。

### 4.4 轻量注入

轻量注入只生成稳定签名，例如：

```text
create_event(title(string,必填), date(string,必填), all_day(boolean,必填), time(string), ...)
```

不自动把所有字段 description、枚举解释和示例拼入固定目录。模型需要复杂工具时，先通过 `get_tool_schema` 获取当前完整定义；错误恢复只回注当前工具，不扩大到全量工具集合。

## 5. 验证与上线

### 5.1 单元测试

- Schema 结构测试：必填、条件必填、互斥、`null` 清空和额外字段。
- handler 契约测试：显式状态到 service 参数的转换。
- 兼容测试：旧历史读取、旧结果展示和新调用拒绝行为。
- 注入测试：简介模式 token 长度、字段签名稳定性、全量模式 Schema 完整性。
- LoopScope trace 测试：验证工具 Schema、参数、结果和错误能够在受控开发 trace 中完整回放；凭据不得进入 trace。

### 5.2 A/B 指标

对同一批脱敏场景分别测试简介模式和全量模式，至少记录：

- 每轮输入 token、缓存 token、新鲜 token；
- 单 run 总 token 和平均 token；
- 先按错误来源拆分：工具路由错误、必填字段缺失、类型/枚举/范围错误、字段语义错误、无必要重复调用、测试用例或期望值错误；只有真实校验失败计入 Schema 错误率；
- Schema 错误率、错误字段分布、恢复轮数；
- 目标工具最终成功率、重复调用率和总耗时；
- 不同 provider 的差异。

简介模式用于低成本路由；全量模式作为准确性优先的全量注入模式。旧版配置值只做读取兼容，不再出现在 API 或前端选项中。

### 5.3 两种模式的实测与完成度

当前工具 Schema 的生产实现已收敛为简介模式 `description` 和全量模式 `full`，两者共享源码中的规范 Schema。简介模式只注入名称、短描述、字段签名和路由线索，需要时通过 `get_tool_schema` 获取完整定义；全量模式直接注入完整 Schema，适合复杂任务和准确性优先场景。

在 devserver 真实 provider 配置、连续 20 个脱敏 case 的复测中：

| 指标 | 简介模式 | 全量模式 |
|---|---:|---:|
| 工具轨迹准确率 | `17/20（85%）` | `20/20（100%）` |
| Provider 总输入 | `867,514` | `1,518,592` |
| Context input | `341,339` | `610,190` |
| 缓存读取 | `853,120` | `1,509,248` |
| 缓存率 | `98.34%` | `99.38%` |

两组测试不是同一轮请求的逐请求对照，数字用于说明成本与准确率取舍，不作为所有模型和业务场景的绝对排名。当前默认简介模式，全量模式作为准确性优先和排障开关。完整测试口径、失败 case 和原始报告见 [工具 Schema 优化实施报告](../reports/2026-08-29-OPT-LLM-16-TOOL-SCHEMA-BASELINE.md)。

### 5.4 灰度与回滚

- 先灰度非破坏性工具：搜索、列表、读取。
- 再灰度创建和更新工具，最后处理复制、发送、删除等有副作用工具。
- 每个阶段保留旧 Schema 适配和独立开关；出现错误率、误操作或 provider 兼容问题时，回退到上一版工具定义，不回滚数据库历史。
- 上线后重点检索 `tool_schema_required`、`schema_validation_error`、`schema_recovery` 和 `tool_schema_trace`。

## 6. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 增加必填字段导致旧模型调用失败 | 工具调用错误率短期上升 | 先通过错误恢复和版本适配迁移，逐工具灰度 |
| provider 对条件 Schema/`oneOf` 支持不一致 | 某些模型无法正确生成参数 | 保留简化 Schema 适配，测试 wire 形状，不把复杂约束只交给 provider |
| 显式字段增加 token | 轻量目录变长 | 只保留影响业务分支的字段，普通默认值不字段化 |
| 兼容逻辑散落造成双重事实源 | 新旧行为继续漂移 | 统一放在 Schema 版本适配层，handler 只接收规范化参数 |
| 错误 trace 泄露用户输入 | 隐私和安全风险 | 只记录字段名、类型、路径、digest 和统计值，禁止参数值 |
| 自动扫描误把普通默认值升级成字段 | Schema 复杂度无谓增长 | 扫描只产出候选清单，是否改造由业务语义和副作用风险决定 |

待确认问题：

- [x] `create_event.all_day` 第一批直接设为必填；旧调用通过版本适配兼容。
- [x] `create_project` 必须填写开始日期和结束日期，不新增无日期模式。
- [x] provider 对 `if/then`、`oneOf` 和 `additionalProperties` 的实际支持矩阵已使用真实预设完成 wire-level 回归；复杂约束同时保留服务端校验。
- [x] `update_todo` 采用 action 表达互斥修改动作；保留旧字段的版本适配由 Phase 3 处理。

## 7. 实施 TODO

### Phase 0：语义盘点与契约基线

- [x] 固化高风险工具的“省略/空值/默认/互斥/优先级”扫描结果，形成候选清单。
- [x] 为候选标注副作用、默认值和迁移风险。
- [x] 修正 A/B case 的注册工具名、合法枚举和默认行为，建立“工具轨迹 / 参数契约 / 任务结果”三层评测口径。
- [x] 为失败 case 记录根因类别，避免污染 Schema 错误率。
- [x] 确认 Schema 版本字段、错误类型和 LoopScope trace 的最小结构。

### Phase 1：Schema 规范与公共校验

- [x] 增加统一的 `oneOf`、条件必填、可清空字段和额外字段校验测试。
- [x] 为 `copy_file`、`send_file`、`add_event_reminder`、`update_todo` 补齐来源、定位和动作的互斥与条件必填约束。
- [x] 收敛 `search_conversations` 的搜索分支，保留明确的无参数“列最近对话”分支。
- [x] 为轻量注入器增加稳定字段签名生成和 token 基线。
- [x] 明确 Schema digest 与 implementation digest 的生成和错误回执格式。

### Phase 2：高风险工具改造

- [x] 改造 `create_event`/`update_event` 的 `all_day` 与时间清空语义。
- [x] 改造 `save_uploaded_file` 的附件来源选择。
- [x] 改造 `copy_file` 的原位/目标位置选择。
- [x] 改造 `send_file` 的来源互斥结构。
- [x] 改造 `add_event_reminder` 的活动定位与提醒输入结构。
- [x] 改造 `update_todo` 的待办定位与修改动作结构。

### Phase 3：中风险工具与兼容层

- [x] `create_project` 要求显式填写 `start_date` 和 `deadline`，不再由 handler 静默生成日期；历史数据继续可读。
- [x] `update_todo` 已采用显式 `action`；项目优先级已使用 `none` 表达清除，定时任务渠道动作暂不扩大本轮契约范围。
- [x] 增加集中式旧调用适配入口：仅对 `create_event` 无歧义地补齐 `all_day`；项目日期等业务值缺失时返回结构化缺字段错误，不伪造默认值。

### Phase 4：错误 trace 与恢复

- [x] 在 LoopScope run 中记录脱敏 Schema 错误 trace，保留 Schema/provider Schema、digest、字段形状和错误类别。
- [x] 简介模式错误时只回注当前工具 Schema，并通过回归测试确认不会重复扩大注入。
- [x] 在 LoopScope run 诊断数据中提供按工具、字段路径、错误类别和 provider 的聚合统计，供 Admin/报告读取。

### Phase 5：description 优化

- [x] 按工具统计完整 description 和字段 description 的 token 占比，生成候选清单。
- [x] 删除可由 `type`、`enum`、`required`、`oneOf` 和条件 Schema 直接表达的重复说明。
- [x] 保留日期格式、清空语义、来源边界、确认要求和 provider 兼容等不可由结构推断的说明。
- [x] 优先处理定时任务、文件、技能适配和画布工具，并保留前后字符统计与注册校验。
- [x] 更新 `backend/agent/tools/README.md`，把 description 编写规范和审计脚本作为新增工具入口。

### Phase 6：A/B 与真实业务灰度

- [x] 完成旧版与当前版完整 Schema 的共同工具结构对照，不混入轻量目录指标。
- [x] 使用固定脱敏 case 对当前完整 Schema 和精简后的完整 Schema 进行 20 轮 shadow A/B。
- [x] 对比每轮 token、总 token、错误率、恢复轮数、成功率和耗时，并保留原始 JSON 结果。
- [x] 完成初步根因分类；单独区分工具路由/调用轨迹与 Schema 校验错误，避免把合理辅助调用计入 Schema 错误率。
- [x] 使用 devserver 测试账号完成只读、创建、更新和副作用工具的业务回归；副作用操作遵循确认门并在测试中拦截真实写入。
- [x] 根据结果收敛为简介模式与全量模式；旧版 compact/full 命名仅保留为历史报告或存量配置兼容，不进入新 API。

### Phase 7：工具编写规范与文档收尾

- [x] 更新 `backend/agent/tools/README.md`，明确工具命名、资源边界、`action` 设计、条件必填、互斥输入、默认值、错误回执和脱敏要求。
- [x] 将 Schema、handler、service、权限/确认门和测试的职责边界写成新增工具的检查清单。
- [x] 补充一个完整工具和一个 action 工具的正例、缺字段反例、互斥字段反例及 provider 兼容注意事项。
- [x] 更新 PRD 的实施状态、变更记录和相关开发 README，确保 README 的工具规范成为后续新增工具的入口。

### Phase 8：全量工具 Schema 源码规范化

目标：将全部注册工具迁移为“源码即线上 Schema”。迁移完成后，工具定义中的 `input_schema` 必须与当前精简算法的输出一致；provider、`get_tool_schema`、执行校验和测试基准使用同一份结构，不再依赖运行时二次精简。

- [x] 盘点全部注册工具，记录字段级 `description`、`title`、`default`、`example/examples` 等冗余元数据及其实际语义；新增 `backend/scripts/audit_tool_schemas.py` 作为盘点入口，迁移前发现 394 个字段级 `description`，当前无冗余字段说明，必要安全语义已移到工具级短描述。
- [x] 按精简算法迁移所有工具定义：保留字段名、类型、必填、枚举、条件分支、互斥关系、嵌套结构和边界约束；删除可由结构表达或不影响调用的元数据。
- [x] 将无法由 Schema 可靠表达的关键语义改成显式字段、枚举或 action；仅保留必要的短字段说明，并同步更新 `description_short`。已覆盖全天、来源/目标互斥、文件编辑 mode、项目待办 action、删除确认和 shell scope/network。
- [x] 逐项审查可选字段：保留项仅属于独立业务状态、会改变工具行为、不能安全默认或低风险分页/筛选便利参数；兼容别名和重复默认说明已移出 Schema，确认门与跨项目定位保留为必要语义。
- [x] 将日期、时间和其他格式约束写入 `pattern` 或结构条件，必要时配极短说明；日期使用 `YYYY-MM-DD` pattern，时间使用严格 24 小时制 pattern，全天使用显式 `all_day`，文件/空间/动作使用条件 Schema。
- [x] 增加一致性测试，验证每个注册工具的源码 `input_schema` 与规范化结果完全一致，且 `to_openai()`/`to_anthropic()` 不再改变 Schema 内容；当前 101 个工具 `noncanonical=0`。
- [x] 为迁移后的工具补齐合法正例、缺字段反例、互斥字段反例、嵌套数组/对象反例和历史兼容测试；覆盖 `test_tool_schema_phase1.py`、`test_tool_schema_validation.py` 及 legacy input 兼容断言。
- [x] 使用 devserver 对全部工具执行 Schema 注册、能力注入、按需获取和 dispatch 回归；确认工具数量、Schema digest 和错误 trace 无异常变化。
- [x] 将 `_compact_schema` 降级为迁移期 lint；provider 输出直接复制源码 Schema，不再依赖运行时 Schema 转换，禁止新增工具依赖运行时 Schema 转换。
- [x] 更新工具编写 README、报告和变更记录，记录迁移前后 Schema 字符数、token、准确率和未迁移工具清单。

## 8. 验收标准

- 影响业务分支的关键语义不再只依赖省略、空字符串或字段优先级。
- `create_event` 能明确区分全天事件和定时事件，且 Schema 与 handler 行为一致。
- 文件来源、复制目标和发送来源不存在静默优先级冲突。
- 简介模式保持低 token；全量模式提供完整的参数约束。两种模式共享源码规范 Schema，不再维护 compact/full 两套生产语义。
- Schema 错误可以定位到工具和字段路径，但不泄露用户正文或参数值。
- 高风险工具不会再接受缺少来源、定位或修改动作的空对象；互斥来源不依赖 handler 的静默优先级。
- A/B 报告同时包含每轮 token、总 token、错误率、恢复轮数和最终成功率。
- A/B 报告能回溯每个失败到唯一根因类别，并证明测试用例错误、合理辅助调用不会污染 Schema 错误率。
- 任一工具改造均有新旧契约、正反例和回滚边界，未完成迁移的工具不宣称已完成。
- Phase 8 完成后，全部注册工具的源码 `input_schema` 与精简输出一致，运行时不再维护第二套精简 Schema。
- Phase 8 完成后，每个保留的可选字段都有登记的业务理由，新增工具不再通过省略、空字符串或兼容字段表达状态。
