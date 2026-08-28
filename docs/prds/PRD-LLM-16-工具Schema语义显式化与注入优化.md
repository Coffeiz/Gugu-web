# PRD-LLM-16：工具 Schema 语义显式化与注入优化

> 状态：Phase 0 规划中
> 创建：2026-08-29
> 最近更新：2026-08-29
> 关联模块：`backend/agent/tools/`、`backend/agent/capabilities/injector.py`、`backend/agent/runner.py`、`backend/agent/tools/base.py`、`backend/tests/`
> 背景参考：工具 Schema 轻量注入与完整 Schema A/B 测试；当前默认使用轻量能力目录，完整工具定义作为用户可切换模式。

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：语义盘点与契约基线 | 🚧 进行中 | 已完成第一轮工具描述扫描，待固化字段分类和兼容规则 |
| Phase 1：Schema 语义规范 | 🔲 待评估 | 建立显式状态字段、互斥结构和默认值边界 |
| Phase 2：工具契约改造 | 🔲 待评估 | 按优先级改造日历、文件、项目和任务工具 |
| Phase 3：注入器与错误恢复 | 🔲 待评估 | 保持轻量注入，按需获取当前完整 Schema |
| Phase 4：测试与灰度 | 🔲 待评估 | 对比错误率、token、恢复轮数和真实业务成功率 |

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

### 1.2 目标

1. 让影响业务结果的状态使用显式字段或互斥结构表达，不依赖隐含的省略语义。
2. 保持默认轻量注入，避免恢复近 30,000 token 的全量 Schema 成本。
3. 保留完整 Schema 模式作为准确性优先的可切换方案。
4. 让 Schema、handler、服务层和历史兼容策略拥有同一份契约。
5. 通过结构化错误 trace 记录“模型调用了什么工具、违反了哪条 Schema”，而不记录用户正文、附件名或凭据。

### 1.3 非目标

- 不把所有默认值都改成必填字段。
- 不把工具业务权限、scope 或确认要求写进动态提示词。
- 不为了追求 Schema 严格而破坏已有合法调用；兼容策略必须有明确的迁移边界。
- 不恢复全量工具 Schema 作为默认注入方式。

## 2. 设计原则

### 2.1 业务状态优先显式化

满足以下任一条件时，优先增加字段或使用 `oneOf`/条件 Schema：

- 省略值与显式值代表不同业务状态；
- 同一字段既承担“未修改”又承担“清空”；
- 多个字段互斥，但当前依赖 description 说明优先级；
- 默认行为可能造成创建、发送、移动或删除目标误判。

仅影响便利性的稳定默认值，例如 `limit=5`、`mode=OR`、`space=personal`，继续保留可选，不为每个默认值增加一个开关。

### 2.2 Schema 是机器契约，description 是解释

- 类型、枚举、`required`、`oneOf`、`if/then`、`null` 和边界约束表达可校验事实。
- description 只补充短语义和操作边界，不承担唯一的业务分支定义。
- 轻量目录只注入字段名、类型、必填状态和一层结构，不注入完整 JSON 或长字段说明。
- 完整模式才向 provider 发送当前工具的完整 `input_schema`，用于准确性优先场景。

### 2.3 更新工具区分“未修改”和“清空”

更新类工具默认采用：

- 字段省略：保持原值；
- 字段传 `null`：清空，前提是该字段业务允许为空；
- 字段传具体值：设置为该值。

如果 `null` 与业务值本身仍有冲突，再增加 `*_action` 枚举，不使用空字符串承载清空语义。

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

`create_project` 保留日期字段可选，但补足“默认值”和“禁用值”的表达能力：

- `deadline` 传具体日期：使用该日期；
- `deadline_mode="none"`：明确无截止日期；
- `deadline_mode="default"`：使用系统默认截止日期；
- 三者同时出现时由 Schema 拒绝，而不是由 handler 猜优先级。

`start_date` 暂时保留“省略即今天”，只有出现“无开始日期”的产品需求时再增加对应模式字段。

### FR-SCHEMA-3：显式表达文件来源和目标

逐步将文件工具的多个互斥可选字段收敛为可辨识结构：

- `save_uploaded_file`：区分 `source="latest"`、单个 `attach_id` 和多个 `attach_ids`；自动取最近附件必须是显式选择。
- `copy_file`：区分 `destination="same"` 与目标文件夹；不传目标不再隐式决定原位复制。
- `send_file`：用 `oneOf` 或带 `source_type` 的结构区分文件库文件、网络 URL 和暂存附件，禁止多个来源同时存在。
- `move_items`：继续要求 `target`，并校验空间、项目和文件夹之间的条件关系。

### FR-SCHEMA-4：统一更新操作的清空语义

- `update_event.time/end_time` 使用 `string | null`，省略表示不修改，`null` 表示清空。
- `update_project.priority` 保留 `none` 作为显式清除值，禁止再依赖空字符串。
- `update_todo` 评估将 `done` 收敛为 `action="complete" | "reopen"`；如果保留布尔值，必须让省略只表示“不修改”。
- 定时任务更新中，渠道使用 `channels_action="keep" | "replace" | "clear"` 的方案评估，避免 `[]` 的含义依赖 description。

### FR-SCHEMA-5：维持两档工具注入模式

保留现有用户级开关，并明确产品语义：

- **能力目录（轻量）**：注入工具用途、字段名、类型、必填状态和有限结构信息；节省 token，但复杂参数需要先获取 Schema。
- **完整工具定义（高准确）**：向 provider 注入完整工具 Schema 和字段描述；参数识别更准确，但消耗更多 token。
- 默认使用轻量模式。
- 轻量模式下调用未声明或参数不通过的工具，返回结构化 `tool_schema_required`/校验错误，并回注当前 Schema，不能让模型凭记忆反复重试。
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
- 注入测试：轻量模式 token 长度、字段签名稳定性、完整模式 Schema 完整性。
- LoopScope trace 测试：记录结构摘要，不泄露正文和参数值。

### 5.2 A/B 指标

对同一批脱敏场景分别测试轻量模式和完整工具定义，至少记录：

- 每轮输入 token、缓存 token、新鲜 token；
- 单 run 总 token 和平均 token；
- 先按错误来源拆分：工具路由错误、必填字段缺失、类型/枚举/范围错误、字段语义错误、无必要重复调用、测试用例或期望值错误；只有真实校验失败计入 Schema 错误率；
- Schema 错误率、错误字段分布、恢复轮数；
- 目标工具最终成功率、重复调用率和总耗时；
- 不同 provider 的差异。

轻量模式只有在错误率没有明显恶化、且 token 优势稳定时继续作为默认。完整模式作为准确性优先的手动开关保留。

### 5.3 灰度与回滚

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

- [ ] `create_event.all_day` 是否在第一批改造中直接设为必填，还是先通过版本适配兼容旧调用。
- [ ] `create_project` 是否需要支持“无开始日期”，还是仅处理截止日期的默认/无值区分。
- [ ] provider 对 `if/then`、`oneOf` 和 `additionalProperties` 的实际支持矩阵。
- [ ] `update_todo` 是否采用 `action` 替代可选 `done`。

## 7. 实施 TODO

### Phase 0：语义盘点与契约基线

- [ ] 固化全部工具的“省略/空值/默认/互斥/优先级”扫描结果，形成机器可检查的候选清单。
- [ ] 为每个候选标注：是否影响副作用、是否存在无歧义默认值、是否需要迁移。
- [ ] 修正 A/B case 的注册工具名、合法枚举和默认行为，建立“工具轨迹 / 参数契约 / 任务结果”三层评测口径。
- [ ] 为每个失败 case 记录唯一根因类别，避免把合理辅助调用、测试期望错误和真实 Schema 校验错误合并为一个错误率。
- [ ] 确认 Schema 版本字段、错误类型和 LoopScope trace 的最小结构。

### Phase 1：Schema 规范与公共校验

- [ ] 增加统一的 `oneOf`、条件必填、可清空字段和额外字段校验测试。
- [ ] 为轻量注入器增加稳定字段签名生成和 token 基线。
- [ ] 明确 Schema digest 与 implementation digest 的生成和错误回执格式。

### Phase 2：高风险工具改造

- [ ] 改造 `create_event`/`update_event` 的 `all_day` 与时间清空语义。
- [ ] 改造 `save_uploaded_file` 的附件来源选择。
- [ ] 改造 `copy_file` 的原位/目标位置选择。
- [ ] 改造 `send_file` 的来源互斥结构。

### Phase 3：中风险工具与兼容层

- [ ] 处理 `create_project.deadline` 的默认/无截止日期语义。
- [ ] 评估 `update_todo`、定时任务更新和项目优先级的显式动作字段。
- [ ] 增加旧历史和旧调用的版本化适配，删除 handler 内重复猜测逻辑。

### Phase 4：错误 trace 与恢复

- [ ] 在 LoopScope run 中记录脱敏 Schema 错误 trace。
- [ ] 轻量模式错误时只回注当前工具 Schema，并验证不会重复扩大注入。
- [ ] 在 Admin/报告中提供按工具、字段路径和 provider 聚合的错误统计。

### Phase 5：A/B 与真实业务灰度

- [ ] 使用固定脱敏 case 对轻量模式和完整模式进行多轮 A/B。
- [ ] 对比每轮 token、总 token、错误率、恢复轮数、成功率和耗时。
- [ ] 在完成根因分类后，再比较优化前后；单独报告路由、字段和值格式准确率，以及合理多步调用率。
- [ ] 使用 devserver 测试账号完成只读、创建、更新和副作用工具的真实业务回归。
- [ ] 根据结果决定默认模式，保留可回滚开关并更新报告。

## 8. 验收标准

- 影响业务分支的关键语义不再只依赖省略、空字符串或字段优先级。
- `create_event` 能明确区分全天事件和定时事件，且 Schema 与 handler 行为一致。
- 文件来源、复制目标和发送来源不存在静默优先级冲突。
- 轻量注入保持低 token；完整模式可按用户开关启用，并提供更完整的参数约束。
- Schema 错误可以定位到工具和字段路径，但不泄露用户正文或参数值。
- A/B 报告同时包含每轮 token、总 token、错误率、恢复轮数和最终成功率。
- A/B 报告能回溯每个失败到唯一根因类别，并证明测试用例错误、合理辅助调用不会污染 Schema 错误率。
- 任一工具改造均有新旧契约、正反例和回滚边界，未完成迁移的工具不宣称已完成。
