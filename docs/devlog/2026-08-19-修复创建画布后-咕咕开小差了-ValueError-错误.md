# 开发记录 · 2026-08-19 · 修复创建画布后 "咕咕开小差了" ValueError 错误

## 2026-08-19 · 修复创建画布后 "咕咕开小差了" ValueError 错误

### 现象

用户创建画布后，咕咕返回 "咕咕开小差了 😵‍💫 麃烦再说一遍吗？"，实际工具调用成功但第二轮 LLM 调用失败。日志显示：

```
08-19 09:01:34 INFO [agent.traj] {"t": "tool", "tool": "mind_create_canvas", "user": "019eec39", "ok": true, "ms": 23, "args": {"title": "***"}, "trace": "cfc05e34ead3"}
08-19 09:01:34 ERROR [agent.core] LLM 调用中途出错：ValueError
```

### 初步误判

最初认为是 MiniMax API 对工具返回值中 `null` 字段（如 `project_id: null`）的容忍度问题，尝试将 `ValueError` 添加到 MiniMax 的 `transient_exceptions` 重试列表。

### 根本原因

通过完整链路测试，精确定位到 `agent/loop_drivers.py` 第 125 行的缓存处理逻辑错误：

```python
# 错误代码
elif isinstance(content, str):
    new_content = [dict(content, **{"cache_control": {"type": "ephemeral"}})]
```

当 `content` 是字符串时，`dict(content)` 会将字符串的每个字符视为键值对序列。如果字符串长度是奇数（如 `"hello"` 有 5 个字符），会抛出：

```
ValueError: dictionary update sequence element #0 has length 1; 2 is required
```

这不是 MiniMax API 的问题，而是 Anthropic 格式缓存处理的代码逻辑错误。

### 修复

```python
# 修复后
elif isinstance(content, str):
    new_content = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
```

### 验证

通过完整的 agent 链路测试（74步详细跟踪），确认：
- ✅ 第一轮 LLM 调用成功（调用 mind_create_canvas）
- ✅ 工具执行成功并返回结果
- ✅ 第二轮 LLM 调用成功（接收 218 个 token）
- ✅ 没有出现 ValueError

### 调试方法

创建了三个测试脚本逐步排查：

1. **test_simple_valueerror.py** - 测试基础序列化和消息格式
2. **test_minimax_null_fields.py** - 测试 MiniMax API 对 null 字段的容忍度
3. **test_full_agent_flow.py** - 完整 agent 链路测试，精确定位错误发生位置

第三步成功捕获到 ValueError 的确切位置和堆栈。

### 经验教训

- **逻辑错误不重试** - ValueError 通常是代码逻辑问题，重试机制无法解决
- **让错误暴露** - 撤回重试兜底，让错误直接暴露有助于快速定位根因
- **逐步测试** - 从简单到复杂的测试策略能有效缩小问题范围

### 相关文件

- `backend/agent/loop_drivers.py` - 根本原因修复
- `backend/test_full_agent_flow.py` - 完整链路测试脚本
- `backend/test_minimax_null_fields.py` - MiniMax API 容忍度测试
