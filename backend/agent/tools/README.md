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
它要同时说明“能做什么、什么时候用、最关键的字段或相邻工具关系”；不要塞完整示例、
枚举长列表或权限事实。完整 `description` 只用于 provider Schema。`category`、`permissions`、`platforms`、
`related_skills` 和 `source` 用于能力目录，不承担第二套权限判断。

完整 Schema 的 description 优化规则：类型、枚举、必填、互斥和条件分支交给 JSON Schema；description
只保留模型无法从结构推断的日期格式、清空语义、资源边界、确认要求和 provider 兼容说明。修改后运行
`PYTHONPATH=. .venv/bin/python scripts/audit_tool_descriptions.py`，按字段描述总字符数从高到低处理，
并保留对应的 Schema 正反例测试，避免只删文字而丢失业务语义。

短简介的推荐形状：

```text
创建项目；可带 stages/todos，后续用 add_stage/add_todo
给活动加提醒；关键字段 event_id/lead_minutes/channels
搜索公网网页；关键字段 query/max_results
```

关键字段只列路由和首次调用最容易遗漏的字段，不代替参数 Schema。模型在当前历史中没有
该工具的完整 Schema 时，必须先调用 `get_tool_schema`；工具错误回执也会提示重新获取
当前工具 Schema。所有 96 个内置工具都必须显式填写 `description_short`，注册表会拒绝
缺失或超过 100 个 Unicode 字符的简介，不再静默截断。

## Action 工具规范

同一资源存在多个互斥修改动作时，用 `action` 枚举表达动作，不把多个可选字段的优先级交给模型猜测。
`action` 必须同时满足以下要求：

- 枚举值使用稳定、短小的英文动词，例如 `complete`、`rename`、`move`；
- 在 `description` 中说明每个 action 的含义；
- 用 `oneOf` 或 `if/then` 表达 action 对应的条件必填字段；
- action 只覆盖一个资源边界，不把项目、阶段、待办和删除合成超级工具；
- 旧字段兼容必须放在版本适配层，handler 内只接收规范化参数。

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
