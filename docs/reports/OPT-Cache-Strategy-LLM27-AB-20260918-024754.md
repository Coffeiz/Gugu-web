# PRD-LLM-27 反思缓存 A/B 报告（standalone vs append_reuse）

- 时间：2026-09-18T02:47:54
- 会话：387（owner 019eec39…）
- 模型：minimax / MiniMax-M3（用户真实配置，BYOK 覆盖生效）
- 触发次数：3（每次前缀递增 1 轮；主请求模拟调用单独计量，不计入两模式对比）

| 触发 | 前缀轮数 | 模式 | fresh input | cache_read | cache_write | output | 缓存率 |
|---|---|---|---|---|---|---|---|
| 1 | 33 | append_reuse（新） | 4665 | 16429 | 0 | 211 | 77.9% |
| 1 | 33 | standalone（旧） | 4246 | 128 | 0 | 262 | 2.9% |
| 2 | 34 | append_reuse（新） | 3914 | 16859 | 0 | 131 | 81.2% |
| 2 | 34 | standalone（旧） | 3875 | 128 | 0 | 93 | 3.2% |
| 3 | 35 | append_reuse（新） | 4180 | 16907 | 0 | 171 | 80.2% |
| 3 | 35 | standalone（旧） | 3910 | 128 | 0 | 160 | 3.2% |

## 汇总

| 模式 | fresh input 合计 | cache_read 合计 | output 合计 | 缓存率 |
|---|---|---|---|---|
| append_reuse（新） | 12759 | 50195 | 513 | 79.7% |
| standalone（旧） | 12031 | 384 | 515 | 3.1% |

## 说明

- 「主请求模拟」调用的成本单独存在（生产中该请求就是聊天本身，属沉没成本），不计入两模式对比。
- standalone 侧以 complete_messages(history=[]) 等价模拟 _extract 请求，输入 token 口径一致。
- append 侧走生产 ContextBranch 真实链路（branch_mode=append_reuse、观测与摘出机制生效）。
- 报告生成脚本：`backend/scripts/ab_reflection_cache.py`。

## 结论

1. **append_reuse 机制在真实链路上生效**：三次触发稳定命中 16.4k~16.9k tokens 的前缀缓存（79.7% 缓存率），standalone 仅 3.1%（两者同数据同配置同 LLM）。
2. **重要发现——MiniMax-M3 具备跨调用前缀缓存**：本会话用户 BYOK 配置为 MiniMax-M3，append 分支请求（带显式 cache_control 的 system 标注，与主 run 同口径）三次稳定命中。这推翻了早期「MiniMax 不跨调用缓存」的判断，白名单已把 minimax 更新为准入（`cache_capability.py`），生产资格门此前会错杀该用户的 append_reuse。
3. **成本口径要诚实**：append 的 fresh input（~4.2k/次，含 reflection.md 规则 + 存量上下文块 + 目标回合）与 standalone（~4k/次）基本持平；append 的收益不是省掉这 4k，而是把完整会话历史（~16.8k）以缓存命中价提供给反思模型——同等 fresh 成本下上下文信息量大幅提升。若追求纯成本最低且不需要历史上下文，standalone 仍是合法回落路径（资格门不满足时自动走）。
4. 缓存率 79.7% 略低于 §8.3 的 85% 目标：fresh 部分被 reflection.md 规则文本占据（设计上必须进 delta）；随会话前缀继续增长，比率会进一步上升。MiniMax 的 cache_write 恒为 0 属 provider 上报口径，不影响命中判定。

