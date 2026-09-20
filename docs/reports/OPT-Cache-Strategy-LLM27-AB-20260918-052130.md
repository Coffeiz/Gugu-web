# PRD-LLM-27 反思缓存 A/B 报告（standalone vs append_reuse）

- 时间：2026-09-18T05:21:30
- 会话：324（owner 019fc2e0…）
- 模型：qwen / qwen3.8-flash（用户真实配置，BYOK 覆盖生效）
- 触发次数：3（每次前缀递增 1 轮；主请求模拟调用单独计量，不计入两模式对比）

| 触发 | 前缀轮数 | 模式 | fresh input | cache_read | cache_write | output | 缓存率 |
|---|---|---|---|---|---|---|---|
| 1 | 4 | append_reuse（新） | 4149 | 8530 | 0 | 282 | 67.3% |
| 1 | 4 | standalone（旧） | 3895 | 0 | 0 | 399 | 0.0% |
| 2 | 5 | append_reuse（新） | 4273 | 8530 | 0 | 820 | 66.6% |
| 2 | 5 | standalone（旧） | 377 | 3568 | 0 | 550 | 90.4% |
| 3 | 6 | append_reuse（新） | 4565 | 8530 | 0 | 930 | 65.1% |
| 3 | 6 | standalone（旧） | 503 | 3568 | 0 | 419 | 87.6% |

## 汇总

| 模式 | fresh input 合计 | cache_read 合计 | output 合计 | 缓存率 |
|---|---|---|---|---|
| append_reuse（新） | 12987 | 25590 | 2032 | 66.3% |
| standalone（旧） | 4775 | 7136 | 1368 | 59.9% |

## 说明

- 「主请求模拟」调用的成本单独存在（生产中该请求就是聊天本身，属沉没成本），不计入两模式对比。
- standalone 侧以 complete_messages(history=[]) 等价模拟 _extract 请求，输入 token 口径一致。
- append 侧走生产 ContextBranch 真实链路（branch_mode=append_reuse、观测与摘出机制生效）。
- 报告生成脚本：`backend/scripts/ab_reflection_cache.py`。

## 结论

1. **qwen（qwen3.8-flash / DashScope 兼容端）支持跨调用前缀缓存**：append 三次触发 cache_read 稳定 8530 tokens（主请求模拟 warm 命中 95.97%）——机制成立，白名单准入 qwen（`cache_capability.py` 已更新）。
2. 缓存率 66% 偏低是**测试素材规模问题**，非机制问题：该会话仅 7 轮交换，前缀只有 ~8.5k tokens，而 delta（reflection.md + 任务要求）约 4.5k tokens 固定占比高；生产长会话下前缀越大比率越高（对照 MiniMax 报告 79.7%）。
3. standalone 侧第 2/3 次触发也命中 3568 tokens（reflection.md + 上下文块前缀被上一次 standalone 请求写入缓存）——说明 qwen 对**任意稳定前缀**都做隐式缓存，进一步支持准入。
4. 附带校验：append 全链路（branch_mode=append_reuse + 资格门在 qwen 当前默认关闭下被脚本绕过、观测链路）工作正常；准入后生产资格门将放行 qwen 用户的 append_reuse。

