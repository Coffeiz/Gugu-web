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

`description_short` 为 1-100 个 Unicode 字符，说明“能做什么、什么时候使用”。完整
`description` 只用于 provider Schema。`category`、`permissions`、`platforms`、
`related_skills` 和 `source` 用于能力目录，不承担第二套权限判断。

新增工具后运行：

```bash
PYTHONPATH=. .venv/bin/python -m pytest tests/test_capability_registry.py
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
