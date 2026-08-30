# Qwen、GLM 与 DeepSeek description 模式 20 轮连续会话测试报告

## 测试结论

本报告只记录 2026-08-30 本次新测试，不包含历史基线数据。三组测试均使用 devserver 真实 provider、真实 `LLMRunner` 和同一套连续 session 脚本；工具分发被拦截为 no-op，不写入业务数据。

| 模型 | 预设模型 | 测试轮数 | 首轮上下文 input | 末轮上下文 input | run input 总量 | 缓存读取总量 | 加权缓存率 | 输出总量 | 工具准确率 | Schema 错误 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Qwen | `qwen3.8-flash` | 20 | 9,896 | 19,513 | 745,259 | 733,365 | 98.40% | 5,138 | 20/20 | 0 |
| GLM | `glm-4.5-air` | 20 | 9,793 | 16,231 | 637,588 | 627,584 | 98.43% | 5,341 | 20/20 | 0 |
| DeepSeek | `deepseek-v4-flash-vision-exp` | 20 | 10,302 | 20,208 | 868,901 | 859,264 | 98.89% | 4,299 | 20/20 | 0 |

三组测试的最后一次 provider 请求上下文均持续增长，没有发生历史上下文回退。每轮的 `run input` 是该轮所有 provider 子请求的累计值，因此会随着工具调用次数变化；逐轮连续性应以最后一次 provider 请求的上下文 input 判断。

## 测试口径

- 测试模式：`description`
- 测试流程：1 轮预热，随后连续执行 20 轮真实会话
- provider 请求：记录 core 发出的每一次真实 provider 子请求
- 分轮 input：该轮最后一次 provider 请求的上下文 input
- 分轮缓存：该轮最后一次 provider 请求的 `cache_read`
- 工具执行：no-op 拦截，只验证模型选择和参数，不修改业务数据
- 校验：使用修复后的参数校验器，兼容嵌套 JSON 字段顺序差异

## 测试命令

```bash
PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_schema_accumulation_5tools.py \
  --allow-real-llm --preset qwen --variants description --rounds 20 \
  --case-timeout 180 --output /tmp/qwen-description-cache-20run-session-v2.json

PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_schema_accumulation_5tools.py \
  --allow-real-llm --preset glm --variants description --rounds 20 \
  --case-timeout 180 --output /tmp/glm-description-cache-20run-20260830-rerun.json

PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_schema_accumulation_5tools.py \
  --allow-real-llm --preset deepseek --variants description --rounds 20 \
  --case-timeout 180 --output /tmp/deepseek-description-cache-20run-20260830-rerun.json
```

Qwen、GLM 和 DeepSeek 的脱敏 JSON 均已写入 devserver 对应的 `/tmp` 路径。

## Qwen 逐轮数据

| 轮次 | 上下文 input | 缓存读取 | 未缓存 | 缓存率 | 输出 | 工具调用 | provider 请求数 | 校验 |
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

## GLM 逐轮数据

| 轮次 | 上下文 input | 缓存读取 | 未缓存 | 缓存率 | 输出 | 工具调用 | provider 请求数 | 校验 |
|---:|---:|---:|---:|---:|---:|---|---:|:---:|
| 1 | 9,793 | 9,728 | 65 | 99.34% | 111 | `list_folders` | 2 | 正确 |
| 2 | 9,937 | 9,728 | 209 | 97.90% | 101 | `read_file` | 2 | 正确 |
| 3 | 10,213 | 9,984 | 229 | 97.76% | 115 | `list_events` | 2 | 正确 |
| 4 | 11,101 | 10,880 | 221 | 98.01% | 236 | `create_project`, `list_projects` | 3 | 正确 |
| 5 | 12,269 | 12,032 | 237 | 98.07% | 136 | `note_create`, `note_search` | 3 | 正确 |
| 6 | 12,457 | 12,416 | 41 | 99.67% | 72 | `list_folders` | 2 | 正确 |
| 7 | 12,557 | 12,416 | 141 | 98.88% | 57 | `read_file` | 2 | 正确 |
| 8 | 12,738 | 12,672 | 66 | 99.48% | 124 | `list_events` | 2 | 正确 |
| 9 | 13,184 | 13,056 | 128 | 99.03% | 270 | `create_project`, `list_projects` | 3 | 正确 |
| 10 | 13,637 | 13,568 | 69 | 99.49% | 183 | `note_create`, `note_search` | 3 | 正确 |
| 11 | 13,811 | 13,696 | 115 | 99.17% | 44 | `list_folders` | 2 | 正确 |
| 12 | 13,854 | 13,824 | 30 | 99.78% | 59 | `read_file` | 2 | 正确 |
| 13 | 13,979 | 13,824 | 155 | 98.89% | 70 | `list_events` | 2 | 正确 |
| 14 | 14,431 | 14,336 | 95 | 99.34% | 115 | `create_project`, `list_projects` | 3 | 正确 |
| 15 | 14,917 | 14,848 | 69 | 99.54% | 169 | `note_create`, `note_search` | 3 | 正确 |
| 16 | 15,088 | 14,976 | 112 | 99.26% | 63 | `list_folders` | 2 | 正确 |
| 17 | 15,149 | 15,104 | 45 | 99.70% | 40 | `read_file` | 2 | 正确 |
| 18 | 15,266 | 15,232 | 34 | 99.78% | 61 | `list_events` | 2 | 正确 |
| 19 | 15,722 | 15,616 | 106 | 99.33% | 283 | `create_project`, `list_projects` | 3 | 正确 |
| 20 | 16,231 | 16,128 | 103 | 99.37% | 170 | `note_create`, `note_search` | 3 | 正确 |

## DeepSeek 逐轮数据

| 轮次 | 上下文 input | 缓存读取 | 未缓存 | 缓存率 | 输出 | 工具调用 | provider 请求数 | 校验 |
|---:|---:|---:|---:|---:|---:|---|---:|:---:|
| 1 | 10,302 | 10,240 | 62 | 99.40% | 37 | `list_folders` | 2 | 正确 |
| 2 | 10,650 | 10,624 | 26 | 99.76% | 48 | `read_file` ×2 | 3 | 正确 |
| 3 | 11,110 | 11,008 | 102 | 99.08% | 41 | `list_events` ×2 | 3 | 正确 |
| 4 | 13,320 | 13,184 | 136 | 98.98% | 76 | `create_project`, `get_project` | 6 | 正确 |
| 5 | 15,292 | 15,232 | 60 | 99.61% | 57 | `note_create`, `note_search` | 5 | 正确 |
| 6 | 15,466 | 15,360 | 106 | 99.31% | 37 | `list_folders` | 2 | 正确 |
| 7 | 15,624 | 15,488 | 136 | 99.13% | 40 | `read_file` | 2 | 正确 |
| 8 | 15,817 | 15,744 | 73 | 99.54% | 39 | `list_events` | 2 | 正确 |
| 9 | 16,382 | 16,256 | 126 | 99.23% | 53 | `create_project`, `get_project` | 3 | 正确 |
| 10 | 16,944 | 16,896 | 48 | 99.72% | 48 | `note_create`, `note_search` | 3 | 正确 |
| 11 | 17,109 | 17,024 | 85 | 99.50% | 35 | `list_folders` | 2 | 正确 |
| 12 | 17,265 | 17,152 | 113 | 99.35% | 38 | `read_file` | 2 | 正确 |
| 13 | 17,456 | 17,408 | 48 | 99.73% | 39 | `list_events` | 2 | 正确 |
| 14 | 18,021 | 17,920 | 101 | 99.44% | 50 | `create_project`, `get_project` | 3 | 正确 |
| 15 | 18,580 | 18,432 | 148 | 99.20% | 44 | `note_create`, `note_search` | 3 | 正确 |
| 16 | 18,741 | 18,688 | 53 | 99.72% | 33 | `list_folders` | 2 | 正确 |
| 17 | 18,895 | 18,816 | 79 | 99.58% | 36 | `read_file` | 2 | 正确 |
| 18 | 19,084 | 18,944 | 140 | 99.27% | 39 | `list_events` | 2 | 正确 |
| 19 | 19,649 | 19,584 | 65 | 99.67% | 50 | `create_project`, `get_project` | 3 | 正确 |
| 20 | 20,208 | 20,096 | 112 | 99.45% | 44 | `note_create`, `note_search` | 3 | 正确 |

## 结果判断

- Qwen：20 轮全部完成，工具选择和参数均正确，Schema 错误为 0，加权缓存率 98.40%。
- GLM：20 轮全部完成，工具选择和参数均正确，Schema 错误为 0，加权缓存率 98.43%。
- DeepSeek：20 轮全部完成，工具选择和参数均正确，Schema 错误为 0，加权缓存率 98.89%。
- 三组测试的上下文 input 均逐轮增长；第 10 轮以后没有出现 session 历史被截断的迹象。
