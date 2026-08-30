# MiniMax、GLM 与 DeepSeek 真实 Agent 20 轮对话/工具协议测试报告

## 1. 测试结论（不计首轮）

使用 devserver 真实配置，分别对 MiniMax-M3、GLM（glm-4.5-air）和 DeepSeek（deepseek-v4-flash）连续执行 20 个 run。每个 run 真实调用一次 provider，并发送真实工具 schema；工具 dispatch 按脚本安全模式关闭。MiniMax/GLM 测试使用 session 503，DeepSeek 补充测试使用 session 505。

稳定缓存率只统计每个模型的 Round 2–20，共 57 个有效 run。每组 Round 1 保留在逐轮明细中，但作为预热/冷启动样本，不纳入下表和结论。

| 模型 | 稳定段 | 输入 Token | 新鲜 Token | 缓存命中 Token | 加权缓存率 | 输出 Token | 工具调用轮数 | 总耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MiniMax-M3 | Round 2–20（19） | 1,032,445 | 7,165 | 1,025,280 | 99.31% | 2,517 | 7 | 81.4s |
| GLM | Round 2–20（19） | 944,348 | 3,036 | 941,312 | 99.68% | 5,576 | 8 | 138.5s |
| DeepSeek | Round 2–20（19） | 1,085,822 | 4,222 | 1,081,600 | 99.61% | 1,887 | 8 | 35.1s |
| 合计 | 57 个有效 run | 3,062,615 | 14,423 | 3,048,192 | 99.53% | 9,980 | 23 | 254.9s |

完整测试共 60 个 provider run，全部成功，无失败；扣除三组 Round 1 后，稳定段为 57 个有效 run。工具调用共 23 轮，观察到 `call_tool` 和 `use_skill`。

需要注意测试顺序：MiniMax/GLM 的 20 轮记录来自第二次矩阵执行，因此它们的 Round 1 已继承此前测试留下的 provider 热缓存；DeepSeek 是之后单独补测，未额外执行预热轮，所以 Round 1 的 8.49% 更接近冷启动/缓存边界重建表现。稳定段（Round 2–20）才用于本报告的模型间比较。

稳定段结论：MiniMax 99.31%、GLM 99.68%、DeepSeek 99.61%，三者合计 99.53%。

## 2. 测试条件

- 环境：devserver。
- 三组真实预设与 session：

  | Provider | Model | Session | Run 数 |
  |---|---|---:|---:|
  | MiniMax | `MiniMax-M3` | 503 | 20 |
  | GLM | `glm-4.5-air` | 503 | 20 |
  | DeepSeek | `deepseek-v4-flash` | 505 | 20 |

- 每个模型使用对应 devserver 真实 session 的 snapshot/history，连续 20 个 run。
- 执行顺序：先完成 MiniMax/GLM 矩阵的第二次有效执行，再单独补测 DeepSeek；因此三组的 Round 1 预热状态不同。
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
- 稳定段（Round 2–20）加权缓存率：99.31%；缓存率范围：98.67%–99.78%。Round 1 为热缓存预热样本，不纳入结论。

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
- 稳定段（Round 2–20）加权缓存率：99.68%；缓存率范围：99.45%–99.84%。Round 1 为热缓存预热样本，不纳入结论。

## 5. DeepSeek 逐轮结果

模型：`deepseek-v4-flash`；session：`505`。

| Run | 场景 | 输入 | 新鲜 | 缓存命中 | 缓存率 | 输出 | 工具调用 | 耗时 |
|---:|---|---:|---:|---:|---:|---:|---|---:|
| 1 | simple-chat | 55,751 | 51,015 | 4,736 | 8.49% | 80 | — | 4.3s |
| 2 | project-query | 55,882 | 202 | 55,680 | 99.64% | 61 | call_tool | 1.4s |
| 3 | calendar-query | 56,016 | 208 | 55,808 | 99.63% | 61 | call_tool | 1.3s |
| 4 | memory-query | 56,148 | 212 | 55,936 | 99.62% | 61 | call_tool | 1.2s |
| 5 | complex-planning | 56,284 | 220 | 56,064 | 99.61% | 109 | call_tool, call_tool | 1.2s |
| 6 | simple-chat | 56,486 | 294 | 56,192 | 99.48% | 32 | — | 1.4s |
| 7 | web-query | 56,570 | 122 | 56,448 | 99.78% | 91 | — | 2.0s |
| 8 | complex-research | 56,717 | 269 | 56,448 | 99.53% | 84 | use_skill | 1.6s |
| 9 | project-update | 56,873 | 169 | 56,704 | 99.70% | 61 | call_tool | 1.5s |
| 10 | calendar-plan | 57,004 | 172 | 56,832 | 99.70% | 61 | call_tool | 1.4s |
| 11 | simple-chat | 57,131 | 171 | 56,960 | 99.70% | 38 | — | 1.4s |
| 12 | memory-query | 57,216 | 128 | 57,088 | 99.78% | 76 | — | 1.9s |
| 13 | complex-planning | 57,345 | 257 | 57,088 | 99.55% | 232 | — | 3.5s |
| 14 | file-query | 57,631 | 543 | 57,088 | 99.06% | 108 | — | 2.4s |
| 15 | web-query | 57,795 | 195 | 57,600 | 99.66% | 68 | — | 1.5s |
| 16 | complex-research | 57,917 | 189 | 57,728 | 99.67% | 53 | — | 1.7s |
| 17 | simple-chat | 58,017 | 161 | 57,856 | 99.72% | 16 | — | 1.3s |
| 18 | project-query | 58,079 | 95 | 57,984 | 99.84% | 61 | call_tool | 1.6s |
| 19 | complex-planning | 58,214 | 230 | 57,984 | 99.60% | 222 | — | 2.8s |
| 20 | final-summary | 58,497 | 385 | 58,112 | 99.34% | 392 | — | 4.0s |

- 完成：20/20；失败：0。
- 稳定段（Round 2–20）输入 Token：1,085,822；新鲜 Token：4,222；缓存命中：1,081,600；输出 Token：1,887。
- 稳定段加权缓存率：99.61%；单轮缓存率范围：99.06%–99.84%。Round 1 为未预热的冷启动/边界重建样本，不纳入结论。
- 工具调用轮数：8；工具调用总次数：9；工具：`call_tool`、`use_skill`。
- Round 1 只有 8.49% 命中，属于 DeepSeek 本轮缓存建立/边界重建；Round 2 起恢复到 99% 左右，因此稳定段结论不包含 Round 1。
- 与 MiniMax/GLM 不同，DeepSeek 本轮没有额外预热；Round 1 不应与另外两组已经处于热缓存状态的 Round 1 直接比较。

## 6. 工具调用说明

本次验证的是真实模型的工具选择、schema 兼容、工具历史拼接和 usage/cache 记账。实际业务工具没有执行，因此不能把本报告当作项目、文件、日历等业务工具已经完成真实 dispatch 验证。

## 7. 原始数据与脚本

- devserver 原始 JSON：`backend/docs/reports/TEST-Cache-MiniMax-GLM-20run-20260826.json`（MiniMax/GLM）。
- DeepSeek 原始 JSON：`backend/docs/reports/TEST-Cache-DeepSeek-20run-20260826.json`。
- 执行脚本：`backend/scripts/diagnostics/test_real_session_20_run_cache_matrix.py`。
