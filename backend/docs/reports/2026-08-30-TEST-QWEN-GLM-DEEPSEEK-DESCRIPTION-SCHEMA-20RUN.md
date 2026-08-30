# Qwen 与 GLM description 模式 20 轮连续对话测试报告

## 对比结论

三组测试均使用 devserver 真实 provider、真实 `LLMRunner` 和同一套连续会话脚本；工具分发被拦截为 no-op，不写入业务数据。三种模型的工具选择和参数均 20/20 正确，Schema 错误均为 0，缓存率都稳定在 98% 左右。

| 模型 | 预设模型 | 输入 token | 缓存读取 token | 加权缓存率 | 输出 token | 工具准确率 |
|---|---|---:|---:|---:|---:|---:|
| Qwen（session 模式重测） | `qwen3.8-flash` | 745,259 | 733,365 | 98.40% | 5,138 | 20/20 |
| GLM | `glm-4.5-air` | 652,294 | 641,792 | 98.39% | 4,507 | 20/20 |
| DeepSeek | `deepseek-v4-flash-vision-exp` | 728,307 | 719,616 | 98.81% | 3,839 | 20/20 |

Qwen 原始结果曾因 `note_create.blocks` 嵌套 JSON 字段顺序差异被旧校验器误判为 19/20；修复校验器后确认实际工具参数正确，结论为 20/20。GLM 没有出现校验误判。

## 测试脚本

- 使用脚本：[`test_schema_accumulation_5tools.py`](../../scripts/diagnostics/test_schema_accumulation_5tools.py)
- Qwen 命令：
  `PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_schema_accumulation_5tools.py --allow-real-llm --preset qwen --variants description --rounds 20 --case-timeout 180 --output /tmp/qwen-description-cache-20run-session-v2.json`
- GLM 命令：
  `PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_schema_accumulation_5tools.py --allow-real-llm --preset glm --variants description --rounds 20 --case-timeout 180 --output /tmp/glm-description-cache-20run-20260830.json`
- DeepSeek 命令：
  `PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_schema_accumulation_5tools.py --allow-real-llm --preset deepseek --variants description --rounds 20 --case-timeout 180 --output /tmp/deepseek-description-cache-20run-20260830.json`
- 原始脱敏结果均保存在 devserver 的对应 `/tmp` 路径，测试后未清理
- 每组均为 1 轮预热后连续执行 20 轮测量；连接真实 provider，不连接真实业务数据库，不读取真实用户数据；工具分发被拦截为 no-op

## Qwen 历史基线数据（仅作对照）

| 轮次 | 输入 | 缓存读取 | 未缓存 | 缓存率 | 输出 | 工具调用 | 校验 |
|---:|---:|---:|---:|---:|---:|---|---:|:---:|
| 1 | 20,034 | 19,818 | 216 | 98.92% | 156 | `list_folders` | 正确 |
| 2 | 31,120 | 30,647 | 473 | 98.48% | 311 | `read_file` ×2 | 正确 |
| 3 | 32,549 | 32,045 | 504 | 98.45% | 286 | `list_events` ×2 | 正确 |
| 4 | 35,302 | 33,308 | 1,994 | 94.35% | 465 | `create_project`, `get_project` | 正确 |
| 5 | 39,160 | 36,906 | 2,254 | 94.24% | 310 | `note_create`, `note_search` | 正确 |
| 6 | 27,367 | 27,142 | 225 | 99.18% | 159 | `list_folders` | 正确 |
| 7 | 27,775 | 27,560 | 215 | 99.23% | 149 | `read_file` | 正确 |
| 8 | 28,225 | 27,977 | 248 | 99.12% | 184 | `list_events` | 正确 |
| 9 | 58,784 | 57,966 | 818 | 98.61% | 368 | `create_project`, `get_project`, `list_projects` | 正确 |
| 10 | 46,251 | 45,584 | 667 | 98.56% | 268 | `note_create`, `note_search` | 正确 |
| 11 | 47,433 | 47,127 | 306 | 99.35% | 221 | `list_folders` ×2 | 正确 |
| 12 | 32,084 | 31,885 | 199 | 99.38% | 176 | `read_file` | 正确 |
| 13 | 32,505 | 32,272 | 233 | 99.28% | 203 | `list_events` | 正确 |
| 14 | 85,065 | 83,896 | 1,169 | 98.63% | 496 | `create_project`, `list_projects` ×2 | 正确 |
| 15 | 53,695 | 53,030 | 665 | 98.76% | 286 | `note_create`, `note_search` | 正确 |
| 16 | 36,513 | 36,296 | 217 | 99.41% | 146 | `list_folders` | 正确 |
| 17 | 36,877 | 36,682 | 195 | 99.47% | 164 | `read_file` | 正确 |
| 18 | 56,206 | 55,778 | 428 | 99.24% | 302 | `list_events`, `get_upcoming` | 正确 |
| 19 | 58,127 | 57,439 | 688 | 98.82% | 381 | `create_project`, `list_projects` | 正确 |
| 20 | 60,230 | 59,507 | 723 | 98.80% | 377 | `note_create`, `note_search` | 正确 |

## GLM 分轮数据

| 轮次 | 输入 | 缓存读取 | 未缓存 | 缓存率 | 输出 | 工具调用 | 校验 |
|---:|---:|---:|---:|---:|---:|---|:---:|
| 1 | 19,493 | 19,200 | 293 | 98.50% | 218 | `list_folders` | 正确 |
| 2 | 29,571 | 29,184 | 387 | 98.69% | 214 | `read_file` ×2 | 正确 |
| 3 | 30,570 | 30,080 | 490 | 98.40% | 438 | `list_events` ×2 | 正确 |
| 4 | 32,441 | 31,232 | 1,209 | 96.27% | 465 | `create_project`, `get_project` | 正确 |
| 5 | 35,525 | 34,176 | 1,349 | 96.20% | 364 | `note_create`, `note_search` | 正确 |
| 6 | 24,717 | 24,448 | 269 | 98.91% | 108 | `list_folders` | 正确 |
| 7 | 24,905 | 24,704 | 201 | 99.19% | 120 | `read_file` | 正确 |
| 8 | 25,132 | 24,832 | 300 | 98.81% | 147 | `list_events` | 正确 |
| 9 | 38,717 | 37,888 | 829 | 97.86% | 214 | `create_project`, `get_project` | 正确 |
| 10 | 40,089 | 39,424 | 665 | 98.34% | 261 | `note_create`, `note_search` | 正确 |
| 11 | 27,169 | 26,880 | 289 | 98.94% | 122 | `list_folders` ×2 | 正确 |
| 12 | 27,342 | 27,008 | 334 | 98.78% | 119 | `read_file` | 正确 |
| 13 | 27,580 | 27,264 | 316 | 98.85% | 138 | `list_events` | 正确 |
| 14 | 42,403 | 41,728 | 675 | 98.41% | 305 | `create_project`, `get_project` | 正确 |
| 15 | 43,718 | 43,008 | 710 | 98.38% | 236 | `note_create`, `note_search` | 正确 |
| 16 | 29,627 | 29,312 | 315 | 98.94% | 115 | `list_folders` | 正确 |
| 17 | 29,786 | 29,568 | 218 | 99.27% | 97 | `read_file` | 正确 |
| 18 | 30,018 | 29,824 | 194 | 99.35% | 145 | `list_events` | 正确 |
| 19 | 46,110 | 45,312 | 798 | 98.27% | 384 | `create_project`, `get_project` | 正确 |
| 20 | 47,381 | 46,720 | 661 | 98.60% | 297 | `note_create`, `note_search` | 正确 |

## Qwen 修正脚本重测数据

新版统计按每个连续 run 的完整 provider usage 聚合，并记录 core 发出的真实 provider 子请求数。分轮表展示该 run 最后一次 provider 请求的当前上下文 input；run 累计 input 和累计缓存读取只放在摘要中。

| 轮次 | 输入 | 缓存读取 | 未缓存 | 缓存率 | 输出 | 工具调用 | provider 请求数 | 校验 |
|---:|---:|---:|---:|---:|---:|---|---:|:---:|
| 1 | 9,896 | 9,784 | 112 | 98.87% | 156 | `list_folders` | 2 | 正确 |
| 2 | 10,240 | 9,982 | 258 | 97.48% | 219 | `read_file` | 2 | 正确 |
| 3 | 10,632 | 10,343 | 289 | 97.28% | 219 | `list_events` | 2 | 正确 |
| 4 | 12,245 | 11,955 | 290 | 97.63% | 681 | `create_project`, `get_project` | 4 | 正确 |
| 5 | 13,811 | 12,384 | 1,427 | 89.67% | 517 | `note_create`, `note_search` | 3 | 正确 |
| 6 | 14,008 | 13,916 | 92 | 99.34% | 146 | `list_folders` | 2 | 正确 |
| 7 | 14,215 | 14,099 | 116 | 99.18% | 161 | `read_file` | 2 | 正确 |
| 8 | 14,445 | 14,329 | 116 | 99.20% | 186 | `list_events` | 2 | 正确 |
| 9 | 15,180 | 14,972 | 208 | 98.63% | 345 | `create_project`, `list_projects` | 3 | 正确 |
| 10 | 15,775 | 15,684 | 91 | 99.42% | 305 | `note_create`, `note_search` | 3 | 正确 |
| 11 | 15,989 | 15,905 | 84 | 99.47% | 126 | `list_folders` | 2 | 正确 |
| 12 | 16,182 | 16,085 | 97 | 99.40% | 119 | `read_file` | 2 | 正确 |
| 13 | 16,398 | 16,285 | 113 | 99.31% | 165 | `list_events` | 2 | 正确 |
| 14 | 17,016 | 16,923 | 93 | 99.45% | 308 | `create_project`, `list_projects` | 3 | 正确 |
| 15 | 17,631 | 17,537 | 94 | 99.47% | 329 | `note_create`, `note_search` | 3 | 正确 |
| 16 | 17,857 | 17,770 | 87 | 99.51% | 141 | `list_folders` | 2 | 正确 |
| 17 | 18,038 | 17,938 | 100 | 99.45% | 168 | `read_file` | 2 | 正确 |
| 18 | 18,247 | 18,131 | 116 | 99.36% | 170 | `list_events` | 2 | 正确 |
| 19 | 18,890 | 18,778 | 112 | 99.41% | 366 | `create_project`, `get_project` | 3 | 正确 |
| 20 | 19,513 | 19,402 | 111 | 99.43% | 311 | `note_create`, `note_search` | 3 | 正确 |

## DeepSeek 分轮数据

| 轮次 | 输入 | 缓存读取 | 未缓存 | 缓存率 | 输出 | 工具调用 | 校验 |
|---:|---:|---:|---:|---:|---:|---|:---:|
| 1 | 20,851 | 20,480 | 371 | 98.22% | 179 | `list_folders` | 正确 |
| 2 | 21,371 | 21,120 | 251 | 98.83% | 149 | `read_file` | 正确 |
| 3 | 22,033 | 21,632 | 401 | 98.18% | 160 | `list_events` | 正确 |
| 4 | 35,598 | 34,560 | 1,038 | 97.08% | 358 | `create_project`, `list_projects` | 正确 |
| 5 | 39,636 | 38,144 | 1,492 | 96.24% | 275 | `note_create`, `note_search` | 正确 |
| 6 | 27,791 | 27,520 | 271 | 99.02% | 127 | `list_folders` | 正确 |
| 7 | 28,157 | 28,032 | 125 | 99.56% | 134 | `read_file` | 正确 |
| 8 | 28,580 | 28,288 | 292 | 98.98% | 152 | `list_events` | 正确 |
| 9 | 44,239 | 43,648 | 591 | 98.66% | 234 | `create_project`, `list_projects` | 正确 |
| 10 | 45,990 | 45,568 | 422 | 99.08% | 232 | `note_create`, `note_search` | 正确 |
| 11 | 31,329 | 31,104 | 225 | 99.28% | 136 | `list_folders` | 正确 |
| 12 | 31,713 | 31,616 | 97 | 99.69% | 137 | `read_file` | 正确 |
| 13 | 32,142 | 31,872 | 270 | 99.16% | 161 | `list_events` | 正确 |
| 14 | 49,609 | 49,024 | 585 | 98.82% | 239 | `create_project`, `list_projects` | 正确 |
| 15 | 51,375 | 50,944 | 431 | 99.16% | 248 | `note_create`, `note_search` | 正确 |
| 16 | 34,951 | 34,688 | 263 | 99.25% | 134 | `list_folders` | 正确 |
| 17 | 35,331 | 35,200 | 131 | 99.63% | 142 | `read_file` | 正确 |
| 18 | 35,770 | 35,456 | 314 | 99.12% | 157 | `list_events` | 正确 |
| 19 | 55,039 | 54,400 | 639 | 98.84% | 238 | `create_project`, `list_projects` | 正确 |
| 20 | 56,802 | 56,320 | 482 | 99.15% | 247 | `note_create`, `note_search` | 正确 |

## 观察

Qwen 的 run 累计 input 会随 provider 子请求次数变化，但最后一次 provider 请求的当前上下文从第 1 轮 `9,896` 增长到第 20 轮 `19,513`，中间没有下降。第 10→11 轮的 run 总 input 变化不是历史断裂。20 轮工具准确率为 20/20，未观察到 Schema 累积导致的准确率下降。
