# Tool 目录职责

`backend/agent/tools/` 只放 Agent 可调用的业务工具定义和执行适配器；工具通过
`Tool` / `BaseSkill` 注册到全局 registry。职责按资源边界拆分，避免把多个领域的
数据库读写和工具 Schema 堆进一个文件。

## 文件职责

| 文件 | 职责 | 不负责 |
| --- | --- | --- |
| `base.py` | `Tool`、`BaseSkill`、registry、Schema 校验、统一 dispatch | 具体业务和资源查询 |
| `meta.py` | 固定 Adapter（`call_tool`、`get_tool_schema`）、Skill 正文加载（`use_skill`）和元能力组合 | 用户 Skill 的创建、更新、删除实现 |
| `skill_management.py` | 用户 Prompt Skill 的创建、更新、删除工具；复用 Skill 注册服务、权限校验和确认门 | Skill 正文加载、普通业务工具注册 |
| `line_edit.py` | 正文行级编辑契约和安全校验 | 具体文件、笔记或 Skill 的持久化 |
| `filesystem_policy.py` | 把当前 Session/定时任务 dispatch 主体适配到统一 filesystem policy | 保存授权事实、创建 grant、实现第二套权限判断 |
| `files.py` / `trash.py` | 文件库与回收站领域工具；写操作调用 `filesystem_policy.py` | 自行复制 Session/任务授权规则 |
| `shell.py` | 受控 Shell 与显式 `run_script` 执行入口 | 绕过 sandbox 或提供任意脚本命令 |
| 其他领域文件 | 项目、文件、日历、记忆、画布等各自资源的工具 | 跨领域的通用 Adapter |

新增 Skill 生命周期能力放在 `skill_management.py`；新增固定协议或工具 Schema
获取能力放在 `meta.py`。两个文件都不得直接绕过 `SkillCapabilityRegistry` 写入
`UserSkill`，也不得在工具之外复制权限或确认逻辑。

依赖方向固定为：

```text
meta.py ───────────────┐
skill_management.py ───┼─> SkillCapabilityRegistry
                        └─> agent.tools.base registry / confirm
```

`MetaSkill` 通过 `SKILL_MANAGEMENT_TOOLS` 组合生命周期工具，因此对外仍保持原有
`meta` 能力分组和固定 Adapter 注入方式；拆文件不会新增第二套工具入口。

# Tool 注册格式

工具仍由 `Tool` 和 `BaseSkill` 注册，执行、Schema 校验、确认门和权限检查不变。
能力发现 metadata 直接写在工具定义上：

```python
Tool(
    name="example_search",
    description_short="按关键词搜索资料并返回候选结果。",
    category="search",
    description="完整的模型调用说明……",
    input_schema={"type": "object", "properties": {}},
    handler=example_search,
)
```

`description_short` 为 1-100 个 Unicode 字符，建议通常控制在 30-60 字、目标约 50 字。
它只说明“能做什么、什么时候用、必要的相邻工具关系”；不要在这里重复字段名、类型、必填项或完整示例、
枚举长列表或权限事实。完整 `description` 只用于 provider Schema。`category`、`permissions`、`platforms`、
`related_skills` 和 `source` 用于能力目录，不承担第二套权限判断。

生产环境只保留两种注入模式：全量模式（`full`）是默认模式，向 provider 发送工具源码中的规范 Schema；简介模式（`description`）是可选的低成本模式，提供能力目录和固定 Adapter，业务工具需要调用时再按需获取 Schema。新工具不再维护“完整 Schema 再运行时精简”的两套定义：`input_schema` 本身就是 provider、按需获取和执行校验的共同契约。原始旧版完整 Schema 只作为迁移前快照和测试基准。

Schema 的默认规范是：用类型、枚举、必填、互斥、`oneOf`、`anyOf`、`allOf`、`if/then` 和边界约束表达机器可校验事实；字段级 `description`、`title`、`default`、`example/examples` 默认不写。只有日期格式、清空语义、资源边界等无法可靠结构化表达的信息，才保留一句短说明。注册期 lint 负责拒绝不合规范的新增定义，不在运行时悄悄删除字段说明。

### 可选字段规则

可选字段不是越多越灵活，只有在“不传”本身有独立业务意义时才保留。新增可选字段必须满足至少一项：

- 不传代表真实业务状态，例如 `end_time` 不传表示没有结束时间；
- 是否提供会改变工具行为，且不能由固定默认值安全替代；
- 是低风险便利参数，例如分页数量或排序方式。

不要因为 handler 暂时支持省略、兼容旧调用、表达空操作或重复表达默认值而保留可选字段。需要区分“未修改”和“清空”时使用 `null`、显式布尔值或 action 枚举。格式优先写进 Schema：严格格式使用 `pattern`，必要时配一条极短说明，例如 `pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$"` 加 `description: "24小时制 HH:MM"`；不要只依赖 `format: "time"`。全天使用必填 `all_day`，不要用“省略 `time` 表示全天”作为新契约。

`_compact_schema` 仅作为 Phase 8 迁移审计辅助，不参与 provider 输出；所有新工具必须直接声明源码规范结构。简介模式的字段签名由该结构自动生成，不得另写一份字段目录。修改后运行
`PYTHONPATH=. .venv/bin/python scripts/audit_tool_schemas.py`，并保留对应的 Schema 正反例测试，避免只删文字而丢失业务语义。

## 正文编辑统一约定

所有支持修改正文的 Agent 工具都使用统一的行级编辑契约，避免不同工具分别实现一套定位规则。当前 `note_update` 和 `edit_file` 均采用 `mode: "line_edit"` + `line_edits`；以后新增正文编辑工具也必须复用 `backend/agent/tools/line_edit.py`，不得重新引入独立的整篇覆盖模式。

```json
{
  "mode": "line_edit",
  "line_edits": [
    {"target_lines": "8-11", "expected": "原始第八行\n原始第九行\n原始第十行\n原始第十一行", "content": "替换后的内容"},
    {"target_lines": "15", "expected": "要删除的原始第十五行", "content": ""}
  ]
}
```

`target_lines` 使用 1-based 原始 Markdown 物理行号，支持单行（`8`）、范围（`8-11`）、Bash/`sed` 风格范围（`8,11`）和整篇（`all`）。数字目标必须同时提供读取结果中的 `expected` 原文，范围编辑时用换行连接；原文不匹配会拒绝修改，避免把渲染后的页面行号误当成 Markdown 行号。`content` 为空表示删除目标行；多个范围不得重叠，由工具从后往前应用。调用前必须先读取最新正文，修改后必须重新读取核对；整篇编辑只能使用 `target_lines: "all"`，不再使用 `replace_all`。笔记的追加仍使用 `append_blocks`，不应通过追加“作废说明”替代删除原内容。

新增正文编辑工具时必须遵守同一套边界：读取接口返回原始正文和稳定的物理行号，编辑接口复用 `backend/agent/tools/line_edit.py`，不得依据 UI/HTML/Markdown 渲染后的可见行号；数字目标没有 `expected` 或校验失败时必须拒绝执行，不能猜测或静默改动。编辑成功后必须重新读取同一资源核对，测试至少覆盖行号偏移、过期正文、删除范围、`all` 整篇替换和多范围倒序应用；批量入口也必须逐项沿用这些规则。

## 工具 Schema 防错约定

Schema 必须表达真实调用形状，而不是只声明一个宽泛的 `object`：

- 单项和批量入口使用互斥分支（例如 `item_id` 与 `updates`），每个分支声明自己的必填字段；不能只在 handler 里事后判断。
- ID 使用 `integer`，坐标使用 `number`，状态使用 `boolean`；不要让模型把数字放在字符串里后再依赖 handler 转换。
- 批量数组的 `items` 必须声明完整字段、类型、必填条件和 `additionalProperties: false`，不能只写 `items: {}`。
- 资源 ID 必须由读取工具返回或由用户提供；工具不得根据节点 ID、名称或当前上下文猜测所属资源，以免误操作或越权。
- 同一字段不能同时支持两套含义；单项、批量、确认参数和危险操作都要在 Schema 中明确互斥关系。新增工具必须补“正确参数通过、缺字段失败、类型错误失败、单批混用失败”的 Schema 测试。

例如画布节点移动必须明确区分：`canvas_id + item_id + (x/y/z/collapsed)`，或 `canvas_id + updates[]`；不能只传节点 ID，也不能把 `"1450"` 当作坐标。

```mermaid
flowchart LR
    R[工具 / Skill 注册系统] --> D[能力目录]
    D --> S[按需选择能力]
    S --> P[注入简介与紧凑 Schema]
    P --> L[LLM 提供商]
    L --> Q{选择调用方式}
    Q --> CT[call_tool]
    Q --> US[use_skill]
    CT --> E[权限、参数与执行校验]
    US --> ST[注入 Skill 文档注册的工具]
    ST --> E
```

| 环节 | 作用 |
| --- | --- |
| 注册系统 | 用统一定义快速注册工具和 Skills，声明名称、用途、参数与执行入口 |
| 能力目录 | 先向 Agent 展示可用能力，避免每轮发送所有完整 Schema |
| 按需注入 | 根据任务注入相关能力的简介和字段信息，在保持可调用性的同时减少 Token 消耗 |
| 工具调用 | 模型根据任务选择工具并生成 `call_tool` 请求，由 Runtime 解析参数后执行 |
| Skills 调用 | 模型通过 `use_skill` 加载对应 Skill；系统再注入该 Skill 文档中注册并选择的工具 Schema |
| 执行校验 | 由代码最终校验权限、参数和危险操作；群聊中按群组、成员和发起者隔离数据访问与工具权限，再执行实际能力 |

## 新增工具检查清单

- [ ] 工具名使用稳定的 `资源_动作` 语义，未与已有 canonical name 重复；handler 只处理一个清晰的资源边界。
- [ ] `description_short` 说明用途、路由场景和最容易遗漏的字段，不写权限事实、用户状态或完整 JSON 示例。
- [ ] `input_schema` 直接按源码规范结构编写；字段名、类型、必填和必要的可选分支都能从 Schema 看懂。
- [ ] 省略、清空、默认、互斥和动作分支已使用显式字段、`null`、枚举、`oneOf` 或条件 Schema 表达。
- [ ] 每个可选字段都有独立业务语义或低风险便利性，不是为了兼容、空操作或重复默认值保留。
- [ ] 同一资源的多个互斥修改动作使用 `action`，并为每个 action 条件必填对应字段。
- [ ] handler 不猜测缺失字段、不承担字段优先级；最终业务不变量由 service 校验。
- [ ] 所有权、权限和 destructive confirm 由 registry/dispatch/确认门负责，不写入动态提示词。
- [ ] 已添加合法正例、缺字段反例、互斥字段反例和历史兼容测试。
- [ ] 已运行工具 description 审计、Schema validator 和能力注入回归。

简介模式会在短简介后自动追加一层字段签名，内容来自同一个 `input_schema`：

```text
- 搜索公网网页：搜索公网网页；字段：query(string)，必填、max_results(integer)
```

因此 `description_short` 禁止手写“关键字段”“字段：”、参数类型、必填字段、枚举值和范围；这些内容只维护在
`input_schema`。需要解释清空语义、资源边界或几个字段之间的业务关系时，才在短简介保留一句自然语言说明。

短简介的推荐形状：

```text
创建项目；后续可用 add_stage/add_todo 补充结构
给活动加提醒；支持一次设置多个通知渠道
搜索公网网页；需要实时外部资料时使用
```

短简介不列字段，字段签名不代替完整参数 Schema。简介模式下，模型在当前历史中没有
该工具的完整 Schema 时，必须先调用 `get_tool_schema`；工具错误回执也会提示重新获取
当前工具 Schema。所有内置工具都必须显式填写 `description_short`，注册表会拒绝
缺失或超过 100 个 Unicode 字符的简介，不再静默截断。

## Action 工具规范

同一资源存在多个互斥修改动作时，用 `action` 枚举表达动作，不把多个可选字段的优先级交给模型猜测。
`action` 必须同时满足以下要求：

- 枚举值使用稳定、短小的英文动词，例如 `complete`、`rename`、`move`；
- 在 `description` 中说明每个 action 的含义；
- 用 `oneOf` 或 `if/then` 表达 action 对应的条件必填字段；
- action 只覆盖一个资源边界，不把项目、阶段、待办和删除合成超级工具；
- 旧字段兼容必须放在版本适配层，handler 内只接收规范化参数。
- `version`/`client_version` 只属于数据库、服务层和前端同步协议，禁止放入 Agent 工具输入或返回给模型；更新工具应接收业务增量，由服务端读取当前记录并完成原子写入。

推荐形状：

```json
{
  "required": ["action", "todo"],
  "properties": {
    "action": {"type": "string", "enum": ["complete", "rename", "move"]},
    "todo": {"type": "string"},
    "done": {"type": "boolean"},
    "text": {"type": "string"},
    "to_stage": {"type": "string"}
  }
}
```

新增或收紧互斥字段时，必须同时添加：合法正例、缺字段反例、互斥字段反例、旧调用兼容测试。

新增工具后运行：

```bash
PYTHONPATH=. .venv/bin/python -m pytest tests/test_capability_registry.py tests/test_capability_injection.py
```

不要在 handler 中拼 Prompt、筛选工具或绕过 `registry.dispatch()`。

## 错误反馈规范

所有工具错误都必须经过 `registry.dispatch()` 返回，不要让异常直接冲出 handler。工具可以返回
字典或 JSON 字符串，但错误必须包含一个非空的 `error` 字段；业务错误应尽量说明真实原因，
不要把用户输入、绝对路径、凭据或原始异常堆栈写进返回值。

Runtime 会自动为所有业务错误补齐以下字段，工具不需要重复拼接：

```json
{
  "error": "业务错误说明",
  "tool": "工具名",
  "usage_hint": "如何理解和修正这次失败",
  "next_action": "模型下一步应该询问、修正还是停止重试"
}
```

工具 handler 只需要遵守这些规则：

- 缺少必填信息：返回明确字段名；无法从上下文可靠推断时，让模型向用户询问。
- 参数冲突或类型错误：说明冲突字段或允许范围，不要静默猜测。
- 权限、归属或并发失败：说明需要重新读取、确认或调整权限，不要原参数盲目重试。
- 不可逆动作被拒绝：停止当前动作，等待用户确认，不要自行绕过确认门。
- 外部服务临时失败：说明是否可以稍后重试；不要伪造成功结果。
- 部分成功的批量操作：返回逐项成功/失败，不要只返回一个笼统错误。

参数 schema 不合法的错误由 Runtime 统一返回 `tool_input_invalid`，并附带 `issues`、
`usage_hint` 和 `next_action`。错误回执不重复注入完整 schema；模型应按现有工具声明和回执修正。
