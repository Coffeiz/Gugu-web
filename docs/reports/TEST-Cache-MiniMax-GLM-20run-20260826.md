# MiniMax 与 GLM 真实 Agent 20 轮对话/工具协议测试报告

## 1. 测试结论

使用 devserver 真实配置和同一个真实 session（503），分别对 MiniMax-M3 与 GLM（glm-4.5-air）连续执行 20 个 run。每个 run 真实调用一次 provider，并发送真实工具 schema；工具 dispatch 按脚本安全模式关闭。

| 模型 | 完成 | 输入 Token | 新鲜 Token | 缓存命中 Token | 加权缓存率 | 输出 Token | 工具调用轮数 | 总耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MiniMax-M3 | 20/20 | 1,085,064 | 7,176 | 1,077,888 | 99.34% | 2,554 | 7 | 84.4s |
| GLM | 20/20 | 993,004 | 3,052 | 989,952 | 99.69% | 5,989 | 8 | 153.1s |
| 合计 | 40/40 | 2,078,068 | 10,228 | 2,067,840 | 99.51% | 8,543 | 15 | 237.5s |

40 个 provider run 全部成功，无失败。工具调用共 15 轮，观察到 `call_tool` 和 `use_skill`。

## 2. 测试条件

- 环境：devserver。
- 预设：`provider=minimax / model=MiniMax-M3`；`provider=glm / model=glm-4.5-air`。
- 每个模型独立使用同一真实 session 的 snapshot/history，连续 20 个 run。
- 每个 run 只有 1 次 provider 请求，发送 `call_tool`、`use_skill`、`ask_user` 工具 schema。
- 工具 dispatch：关闭；模型返回的 tool call 只追加脱敏 diagnostic tool result，不执行真实业务工具。
- 未保存提示词正文、模型回复正文、工具参数、附件名、用户标识和密钥。
- 缓存率：`cache_read_tokens / input_tokens * 100%`。

## 3. MiniMax-M3 逐轮结果

| Run | 场景 | 输入 | 新鲜 | 缓存命中 | 缓存率 | 输出 | 工具调用 | 耗时 |
|---:|---|---:|---:|---:|---:|---:|---|---:|
| 1 | simple-chat | 52,619 | 11 | 52,608 | 99.98% | 37 | — | 3.0s |
| 2 | project-query | 52,723 | 115 | 52,608 | 99.78% | 51 | call_tool | 2.3s |
| 3 | calendar-query | 52,861 | 253 | 52,608 | 99.52% | 37 | call_tool | 2.6s |
| 4 | memory-query | 52,986 | 378 | 52,608 | 99.29% | 97 | — | 3.6s |
| 5 | complex-planning | 53,151 | 415 | 52,736 | 99.22% | 258 | — | 6.9s |
| 6 | simple-chat | 53,474 | 482 | 52,992 | 99.10% | 34 | — | 2.0s |
| 7 | web-query | 53,575 | 327 | 53,248 | 99.39% | 29 | use_skill | 2.1s |
| 8 | complex-research | 53,700 | 324 | 53,376 | 99.40% | 68 | call_tool | 2.7s |
| 9 | project-update | 53,858 | 354 | 53,504 | 99.34% | 130 | — | 5.2s |
| 10 | calendar-plan | 54,050 | 418 | 53,632 | 99.23% | 139 | — | 5.1s |
| 11 | simple-chat | 54,248 | 360 | 53,888 | 99.34% | 36 | — | 2.3s |
| 12 | memory-query | 54,346 | 330 | 54,016 | 99.39% | 112 | — | 4.7s |
| 13 | complex-planning | 54,526 | 382 | 54,144 | 99.30% | 409 | — | 8.5s |
| 14 | file-query | 55,004 | 732 | 54,272 | 98.67% | 56 | — | 2.4s |
| 15 | web-query | 55,130 | 346 | 54,784 | 99.37% | 65 | call_tool | 2.5s |
| 16 | complex-research | 55,288 | 376 | 54,912 | 99.32% | 349 | — | 7.7s |
| 17 | simple-chat | 55,699 | 659 | 55,040 | 98.82% | 40 | — | 3.1s |
| 18 | project-query | 55,800 | 248 | 55,552 | 99.56% | 48 | call_tool | 3.7s |
| 19 | complex-planning | 55,940 | 388 | 55,552 | 99.31% | 47 | call_tool | 3.5s |
| 20 | final-summary | 56,086 | 278 | 55,808 | 99.50% | 512 | — | 10.6s |

- 完成：20/20；失败：0。
- 工具调用轮数：7；工具：`call_tool`、`use_skill`。
- 加权缓存率：99.34%；缓存率范围：98.67%–99.98%。

## 4. GLM 逐轮结果

| Run | 场景 | 输入 | 新鲜 | 缓存命中 | 缓存率 | 输出 | 工具调用 | 耗时 |
|---:|---|---:|---:|---:|---:|---:|---|---:|
| 1 | simple-chat | 48,656 | 16 | 48,640 | 99.97% | 413 | — | 14.6s |
| 2 | project-query | 48,742 | 102 | 48,640 | 99.79% | 53 | call_tool | 2.1s |
| 3 | calendar-query | 48,832 | 192 | 48,640 | 99.61% | 52 | call_tool | 1.7s |
| 4 | memory-query | 48,919 | 151 | 48,768 | 99.69% | 454 | — | 12.1s |
| 5 | complex-planning | 49,056 | 160 | 48,896 | 99.67% | 512 | — | 11.8s |
| 6 | simple-chat | 49,194 | 170 | 49,024 | 99.65% | 173 | — | 4.7s |
| 7 | web-query | 49,295 | 143 | 49,152 | 99.71% | 56 | use_skill | 2.3s |
| 8 | complex-research | 49,377 | 97 | 49,280 | 99.80% | 82 | call_tool | 8.8s |
| 9 | project-update | 49,482 | 202 | 49,280 | 99.59% | 83 | call_tool | 3.3s |
| 10 | calendar-plan | 49,556 | 148 | 49,408 | 99.70% | 52 | call_tool | 2.9s |
| 11 | simple-chat | 49,632 | 96 | 49,536 | 99.81% | 426 | — | 11.3s |
| 12 | memory-query | 49,728 | 192 | 49,536 | 99.61% | 512 | — | 11.5s |
| 13 | complex-planning | 49,885 | 221 | 49,664 | 99.56% | 512 | — | 13.2s |
| 14 | file-query | 49,993 | 201 | 49,792 | 99.60% | 512 | — | 12.5s |
| 15 | web-query | 50,197 | 277 | 49,920 | 99.45% | 193 | call_tool | 6.4s |
| 16 | complex-research | 50,307 | 131 | 50,176 | 99.74% | 372 | — | 7.6s |
| 17 | simple-chat | 50,430 | 126 | 50,304 | 99.75% | 149 | — | 3.2s |
| 18 | project-query | 50,500 | 196 | 50,304 | 99.61% | 359 | call_tool | 5.6s |
| 19 | complex-planning | 50,581 | 149 | 50,432 | 99.71% | 512 | — | 7.9s |
| 20 | final-summary | 50,642 | 82 | 50,560 | 99.84% | 512 | — | 9.6s |

- 完成：20/20；失败：0。
- 工具调用轮数：8；工具：`call_tool`、`use_skill`。
- 加权缓存率：99.69%；缓存率范围：99.45%–99.97%。

## 5. 工具调用说明

本次验证的是真实模型的工具选择、schema 兼容、工具历史拼接和 usage/cache 记账。实际业务工具没有执行，因此不能把本报告当作项目、文件、日历等业务工具已经完成真实 dispatch 验证。

## 6. 原始数据与脚本

- devserver 原始 JSON：`backend/docs/reports/TEST-Cache-MiniMax-GLM-20run-20260826.json`。
- 执行脚本：`backend/scripts/diagnostics/test_real_session_20_run_cache_matrix.py`。
