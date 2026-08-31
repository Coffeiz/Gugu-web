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

生产环境只保留两种注入模式：简介模式（`description`）是默认模式，提供能力目录和固定 Adapter，业务工具需要调用时再按需获取 Schema；全量模式（`full`）是可选的准确性优先模式，向 provider 发送工具源码中的规范 Schema。新工具不再维护“完整 Schema 再运行时精简”的两套定义：`input_schema` 本身就是 provider、按需获取和执行校验的共同契约。原始旧版完整 Schema 只作为迁移前快照和测试基准。

Schema 的默认规范是：用类型、枚举、必填、互斥、`oneOf`、`anyOf`、`allOf`、`if/then` 和边界约束表达机器可校验事实；字段级 `description`、`title`、`default`、`example/examples` 默认不写。只有日期格式、清空语义、资源边界等无法可靠结构化表达的信息，才保留一句短说明。注册期 lint 负责拒绝不合规范的新增定义，不在运行时悄悄删除字段说明。

### 可选字段规则

可选字段不是越多越灵活，只有在“不传”本身有独立业务意义时才保留。新增可选字段必须满足至少一项：

- 不传代表真实业务状态，例如 `end_time` 不传表示没有结束时间；
- 是否提供会改变工具行为，且不能由固定默认值安全替代；
- 是低风险便利参数，例如分页数量或排序方式。

不要因为 handler 暂时支持省略、兼容旧调用、表达空操作或重复表达默认值而保留可选字段。需要区分“未修改”和“清空”时使用 `null`、显式布尔值或 action 枚举。格式优先写进 Schema：严格格式使用 `pattern`，必要时配一条极短说明，例如 `pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$"` 加 `description: "24小时制 HH:MM"`；不要只依赖 `format: "time"`。全天使用必填 `all_day`，不要用“省略 `time` 表示全天”作为新契约。

`_compact_schema` 仅作为 Phase 8 迁移审计辅助，不参与 provider 输出；所有新工具必须直接声明源码规范结构。简介模式的字段签名由该结构自动生成，不得另写一份字段目录。修改后运行
`PYTHONPATH=. .venv/bin/python scripts/audit_tool_schemas.py`，并保留对应的 Schema 正反例测试，避免只删文字而丢失业务语义。

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
