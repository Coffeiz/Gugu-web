# PRD-LLM-23 Provider 推理状态验收清单

本清单用于发布前验证跨请求推理状态。所有测试账号、会话和模型均使用临时数据；API Key 只从
运行环境或本机安全存储读取，不写入命令、日志、截图或仓库。

## 本地契约

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q \
  tests/test_reasoning_state.py \
  tests/test_phase2_reasoning_drivers.py \
  tests/test_loopscope_usage.py
```

应覆盖：默认 `off`、`summary` 不回放 payload、continuation 未命中/已复用、无稳定会话不可用、
Provider 不支持、状态过期、状态失效、CAS 冲突和 LoopScope 脱敏。

## 真实 Provider 与重启

对每个已启用的 Responses/Anthropic 模型分别执行以下序列，并记录 LoopScope 的
`attributes.reasoning_state`、`duration_ms`、`usage` 和 adapter 错误计数：

1. `off`：连续两次请求，确认没有 provider state 提交。
2. `summary`：请求完成后确认只保存受限摘要，下一次请求不携带完整状态。
3. `continuation`：第一轮完成后再次请求同一会话，确认第一次为 `miss`、第二次为 `reused` 或
   Provider 明确返回不可用；不得把 Chat Completions 标记成 Responses 续接。
4. 工具调用：确认 assistant thinking/tool block 与 tool result 的顺序完整，且用户可见消息不出现
   thinking 正文。
5. 在两次请求之间重启 backend/worker，再重复第 3 步；状态恢复或明确不可恢复均需有诊断结果。
6. 修改模型、Provider、thinking/reasoning 配置，或触发上下文压缩后重试；旧状态必须失效。
7. 将模型策略切回 `off`，确认新请求不再续接，canonical history 和普通对话恢复不受影响。

真实 Provider 返回 4xx/状态链断裂/签名失败时，确认任务或对话得到现有的通用错误处理，LoopScope
状态为 `provider_rejected` 或受限 `unavailable`，不得把原始响应、正文、工具参数或凭据写入日志。

## 通过标准

- 默认值为 `off`，模型配置可单独灰度和立即回滚。
- 每个模型至少有一组成功或明确不可用的真实 Provider 证据；本地 mock 只证明代码契约。
- 对比 `off` 与 `continuation` 的延迟、输入/输出/cache token 和错误计数，异常增长时回滚到 `off`。
- 没有用户正文、reasoning 正文、完整工具参数、签名或凭据进入 LoopScope、普通日志或消息历史。
