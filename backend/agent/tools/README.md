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
