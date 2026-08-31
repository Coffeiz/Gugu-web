# Reminder role 缓存与协议兼容性测试

日期：2026-08-24
环境：devserver，使用真实 session snapshot、历史消息、工具历史和正式 history adapter 组装；只读请求，不写入会话历史。
脚本：`backend/scripts/diagnostics/test_reminder_role_cache.py`

## 目的

验证把 `[system-reminder]` 消息的 role 从 `user` 改为 `system`，以及改成自定义 role，是否会：

- 破坏真实上下文结构；
- 造成跨轮缓存前缀断裂；
- 被 MiniMax / 百炼 provider 拒绝。

每个 provider、每种 role 连续请求 3 轮。测试只输出消息数量、role 统计、结构 digest、token usage 和错误类型，不输出会话正文。

## 测试结果

### MiniMax-M3

使用完整真实 session 上下文，约 480 条组装消息、176 条 reminder。

| reminder role | 第 1 轮 | 第 2 轮 | 第 3 轮 | 结果 |
|---|---:|---:|---:|---|
| `user` | 94.06% | 99.96% | 99.96% | 三轮成功 |
| `system` | 94.13% | 99.96% | 99.96% | 三轮成功 |
| `context` | 请求被拒绝 | - | - | `invalid role: context` |

MiniMax 接受 `system` role，且在本次真实上下文中没有观察到比 `user` 更严重的跨轮前缀断点。自定义 `context` 在 provider 边界被明确拒绝。

### 百炼 / Qwen

完整 session 历史请求等待时间过长，因此使用同一真实 snapshot、同一正式组装链路，截取最近 100 条历史完成可控复测。组装结果为约 160 条消息、59 条 reminder。

| reminder role | 第 1 轮 | 第 2 轮 | 第 3 轮 | 结果 |
|---|---:|---:|---:|---|
| `user` | 成功 | 成功 | 成功 | 三轮成功 |
| `system` | 成功 | 成功 | 成功 | 三轮成功 |
| `context` | 请求被拒绝 | - | - | `context is not one of ['system', 'assistant', 'user', 'tool', 'function']` |

百炼本次接口返回了 input token，但没有返回可用的 cache read/write 字段，因此不能用这次 usage 单独判断 provider 缓存命中率；role 协议兼容性已确认。

## 结论

1. `system` role 在本次配置的 MiniMax 和百炼 endpoint 上都能请求成功，且三轮测试没有出现 role 导致的明显缓存断裂。
2. 自定义 role 不属于这两个 provider 接受的消息协议，不能作为通用抽象。
3. 自定义 role 不属于通用抽象；`system` 作为内部 canonical role 是可行的，但 provider wire 不能统一照搬。
4. 已按 adapter 边界采用：内部 reminder 一律是 `role=system`；MiniMax/百炼保留 system；原生 Anthropic 在发送边界转换为合法的 user message。静态 persona/policy/snapshot 仍保留在固定 system 前缀，动态时间、RAG、stance 和消息时间仍位于 conversation 的 canonical reminder 区域。
5. 测试脚本支持 `--session-id`、`--max-messages` 和 `--provider`，后续可在固定 session 上重复复测。

## 复测命令

```bash
cd backend
PYTHONUNBUFFERED=1 PYTHONPATH=. .venv/bin/python \
  scripts/diagnostics/test_reminder_role_cache.py \
  --session-id <session_id> \
  --provider minimax \
  --provider qwen
```
