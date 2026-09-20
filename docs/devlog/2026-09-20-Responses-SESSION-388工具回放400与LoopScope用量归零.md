# SESSION #388 Responses 回退 400 与 LoopScope 用量归零

## 现象

SESSION #388 的 Responses 请求被上游以 HTTP 400 拒绝，后端记录“Responses 完整请求不兼容”，随后同一 run 回退到 Chat Completions。后台 run 的 usage/cache 统计大多为 0，与模型实际完成回退回答的情况不符。

## 排查与根因

使用 devserver 已配置的真实模型端点做结构变异验证；没有输出或持久化密钥，也没有把真实会话正文、工具参数和工具回执重新发送给上游。会话内容在测试副本中替换为占位值，未执行任何工具。

1. **Responses 400：旧工具调用历史缺少 output item ID。**
   - 本次历史投影包含大量旧 Chat Completions 工具调用。它们保存了工具关联用的 `call_id`，但没有 Responses output item 的 `id`；这两个字段用途不同，不能用 `call_id` 替代 `id`。
   - 结构变异验证中，一个没有 item `id` 的 function call/output 往返会被上游拒绝；给 function call 补充唯一 item `id` 后可成功。对整段脱敏历史也得到相同结果。
   - 最新失败 run 的脱敏结构有 262 条消息、142 个 function call 和 144 个 function call output。开头有 2 个无法配对的历史 output，但补齐所有 function call 的 item `id` 后，无论保留还是移除这 2 个孤儿 output，请求都成功。因此孤儿 output 不是这次 400 的根因。
   - 已有 Responses 原生 item ID 的历史不受影响；对旧记录无法恢复上游原 ID，只能在出站投影中稳定补齐。

2. **LoopScope usage/cache 为 0：兼容性回退 driver 绕过了追踪包装。**
   - LoopScope 在 run 入口包装初始 Responses driver 的 `run_round`，并在成功轮结束时记录 provider usage、缓存 token 和 run 汇总。
   - Responses 失败后，`machine.run_loop` 会新建 Chat Completions driver；新实例没有原有追踪包装。于是 fallback 可以正常返回，但成功轮没有产生对应的 LLM span，也没有调用 `run.add_usage()`，统计面板便显示为 0。
   - 这是观测埋点丢失，不代表上游 fallback 请求实际没有返回 usage/cache 数据。

## 修复

- 对没有 `responses_item_id` 的旧 function call，在 Responses 出站投影中按 `call_id` 与重复序号生成确定性合成 ID；保留已有原生 ID，不修改数据库中的会话历史。合成 ID 不包含工具参数或会话正文。
- 将本次 run 的 LoopScope round 包装工厂传给 fallback driver，使 Chat Completions 成功轮继续记录 span、实际 usage/cache 和 run 汇总；保持取消时及时关闭追踪生成器的行为。

## 验证

- 新增回归测试：旧历史 item ID 稳定且唯一；Responses fallback 成功轮能写入实际 input/output/cache usage。
- `PYTHONPATH=. .venv/bin/pytest tests/test_phase2_reasoning_drivers.py tests/test_loopscope_usage.py tests/test_core_loop_characterization.py -q`：**115 passed**。测试输出另有 5 条 Python 3.14/依赖资源清理与弃用警告，不影响通过结果。
- `git diff --check` 通过。
- 当前仅完成本地代码与测试验证；未同步或重启 devserver。
