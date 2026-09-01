# TEST：LLM-16 5 工具多模型 Schema 模式复测

> 测试日期：2026-09-01
> 测试环境：devserver `192.168.110.51`，使用当前运行配置中的真实 provider
> 测试对象：MiniMax、GLM、DeepSeek、Qwen；description/full 两种 Schema 注入模式
> 测试目的：复核注入模式更新后，5 个目标工具的连续 session、缓存、token 和工具调用表现


---

## 1. 测试范围

本次按照 [`2026-09-01-OPT-LLM-16-5TOOLS-MULTI-MODEL.md`](2026-09-01-OPT-LLM-16-5TOOLS-MULTI-MODEL.md) 的口径重测，但使用注入模式更新后的代码和当前 devserver 模型配置。

测试目标工具固定为：

1. `list_folders`
2. `read_file`
3. `list_events`
4. `create_project`
5. `note_create`

每个模型、每种模式分别建立一个连续 session：先执行 1 次预热，再执行 20 个测量用例。20 个用例按上述 5 个工具循环 4 次；工具 dispatch 被诊断脚本拦截为 `not_executed`，不写入真实项目、文件、日历或笔记数据。

本次不是“只注入 5 个工具”的实验。description 模式仍注入全部已授权工具的能力目录和固定 Adapter Schema；full 模式仍注入完整工具 Schema。5 个工具只表示本轮实际要求模型调用的目标工具数量。

## 2. 统计口径

- `provider input` 为本轮所有 provider 子请求 input 的累计值；Anthropic 口径包含 fresh input 和 cache read，OpenAI-compatible usage 按脚本统一后的 provider input 统计。
- `cache rate = cache_read / provider_input`。
- `context input` 取每个测量轮最后一次 provider 请求的上下文长度；它不等于该轮所有子请求 input 的累计值。
- `provider requests` 是该轮内模型请求、Schema 查询和工具续轮请求的总数，不等于用户测量轮数。
- Schema token 和目录 token 是当前模型 tokenizer 的运行时估算，只适合比较同一模型的模式差异，不用于比较不同模型的绝对 token 化效率。
- 准确率要求：目标工具被调用，且参数结构满足诊断脚本预期；额外的合理核实工具调用不单独判错。

## 3. 结果总览

### 3.1 description 模式

| 模型 | Schema 工具数 | Schema token/请求 | 目录 token/请求 | Provider input | Output | Cache read | Cache rate | 准确率 | Schema errors | Provider 请求数（含预热） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniMax-M3 | 4 | 322 | 5,800 | 508,301 | 1,376 | 503,408 | 99.04% | 12/20（60%） | 8 | 40 |
| glm-4.5-air | 4 | 351 | 5,995 | 692,435 | 4,864 | 681,984 | 98.49% | 16/20（80%） | 4 | 51 |
| deepseek-v4-flash-vision-exp | 4 | 351 | 5,995 | 902,438 | 4,025 | 892,672 | 98.92% | 20/20（100%） | 0 | 56 |
| qwen3.8-flash | 4 | 351 | 5,995 | 772,153 | 5,202 | 760,339 | 98.47% | 20/20（100%） | 0 | 50 |

### 3.2 full 模式

| 模型 | Schema 工具数 | Schema token/请求 | Provider input | Output | Cache read | Cache rate | 准确率 | Schema errors | Provider 请求数（含预热） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniMax-M3 | 100 | 12,010 | 978,324 | 1,466 | 965,760 | 98.72% | 16/20（80%） | 4 | 44 |
| glm-4.5-air | 100 | 12,735 | 1,684,764 | 7,002 | 1,670,400 | 99.15% | 20/20（100%） | 0 | 69 |
| deepseek-v4-flash-vision-exp | 100 | 12,735 | 1,128,875 | 2,478 | 1,122,176 | 99.41% | 20/20（100%） | 0 | 49 |
| qwen3.8-flash | 100 | 12,735 | 1,359,134 | 4,823 | 1,350,679 | 99.38% | 20/20（100%） | 0 | 54 |

## 4. description 与 full 对比

| 模型 | description 总 token | full 总 token | description 节省 input | description 节省总 token | 固定注入节省 | 准确率变化 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniMax-M3 | 509,677 | 979,790 | 48.04% | 47.98% | 49.03% | -20 个百分点 |
| glm-4.5-air | 697,299 | 1,691,766 | 58.90% | 58.78% | 63.17% | -20 个百分点 |
| deepseek-v4-flash-vision-exp | 906,463 | 1,131,353 | 20.06% | 19.88% | 43.05% | 无变化 |
| qwen3.8-flash | 777,355 | 1,363,957 | 43.19% | 43.01% | 53.86% | 无变化 |

固定注入成本按实际请求数折算如下。description 的固定成本为 `Schema + 目录`，full 的固定成本为完整 Schema：

| 模型 | description 固定 token/请求 | full 固定 token/请求 | description 实际固定 token | full 实际固定 token | 固定部分节省 |
| --- | ---: | ---: | ---: | ---: | ---: |
| MiniMax-M3 | 6,122 | 12,010 | 244,880 | 528,440 | 53.66% |
| glm-4.5-air | 6,346 | 12,735 | 323,646 | 878,715 | 63.17% |
| deepseek-v4-flash-vision-exp | 6,346 | 12,735 | 355,376 | 624,015 | 43.05% |
| qwen3.8-flash | 6,346 | 12,735 | 317,300 | 687,690 | 53.86% |

上表中固定 token 的核心变化是：优化后的 DeepSeek description 目录为 13,563 字符、约 5,995 token，固定 Adapter Schema 仍只有 4 个工具；full 仍发送 100 个工具 Schema。因此不能沿用优化前的固定成本解释，需要把目录和 Adapter 相加后再比较。

## 5. 连续 session 与缓存边界

### 5.1 连续性校验

| 模型 | 模式 | 测量轮数 | 首轮末次上下文 | 末轮末次上下文 | 是否单调增长 | 轮内请求数范围 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| MiniMax-M3 | description | 20 | 10,002 | 14,849 | 是 | 1–4 |
| MiniMax-M3 | full | 20 | 20,548 | 24,711 | 是 | 1–6 |
| glm-4.5-air | description | 20 | 10,398 | 16,832 | 是 | 2–4 |
| glm-4.5-air | full | 20 | 20,898 | 29,538 | 否，存在 provider 统计回落 | 2–7 |
| DeepSeek | description | 20 | 11,088 | 20,808 | 是 | 2–5 |
| DeepSeek | full | 20 | 20,751 | 26,586 | 是 | 2–3 |
| Qwen | description | 20 | 10,733 | 20,235 | 是 | 2–3 |
| Qwen | full | 20 | 21,772 | 29,692 | 是 | 2–4 |

除 GLM full 的 provider usage 出现一次统计回落外，所有模式的 session 历史都持续累积；没有发现 20 轮内上下文被压缩、重置或重新冷启动的迹象。GLM full 的回落出现在 provider 返回的末次 input 统计，不伴随脚本历史 compaction 记录，不能单凭该字段判定应用侧丢失历史。

### 5.2 各模式每轮 provider 请求数

以下序列按第 1 到第 20 个测量轮排列；它用于解释累计 input 与准确率差异，不把续轮误报成额外用户对话轮。

| 模型 | description 请求数序列 | full 请求数序列 |
| --- | --- | --- |
| MiniMax-M3 | `1,2,2,3,4,2,2,2,2,1,2,2,2,2,1,2,2,2,2,1` | `2,2,2,3,6,2,2,2,1,3,2,2,2,1,3,2,2,2,1,1` |
| GLM | `2,3,2,4,3,2,2,2,3,3,2,2,2,3,3,2,2,2,3,3` | `2,2,2,3,3,2,2,2,5,5,2,2,2,7,7,2,2,2,7,7` |
| DeepSeek | `2,3,3,5,5,2,2,2,4,3,2,2,2,3,3,2,2,2,3,3` | `2,2,2,3,3,2,2,2,3,3,2,2,2,3,3,2,2,2,3,3` |
| Qwen | `2,2,2,3,3,2,2,2,3,3,2,2,2,3,3,2,2,3,3,3` | `2,2,2,4,3,3,2,2,4,4,2,2,2,3,3,2,3,2,3,3` |

GLM description/full 和 MiniMax description/full 的额外续轮较多，直接抬高累计 provider input；这也是固定 Schema 节省比例与实际 input 节省比例不完全相同的原因。

## 6. 失败分类

- **MiniMax description：8 项**：`create_project` 3 次、`note_create` 3 次、`list_folders` 1 次未选中目标工具，另有 1 次 `note_create` 块结构差异；full 降至 4 项（`create_project` 3 次、`note_create` 1 次未选中目标工具）。
- **MiniMax full：4 项**。均为工具路由未选中目标工具，没有单独的 provider 传输错误。
- **GLM description：优化后 4 项**。均为 `note_create` 的块结构差异；full 为 20/20。
- **DeepSeek description：优化后 0 项**。原复测的 4 次 `note_create` 块结构差异和 1 次 `list_folders` 路由失败在本轮均未复现；full 仍为 20/20。
- **Qwen description：优化后 0 项**；full 仍为 20/20。

本轮的 `schema_errors` 是诊断准确率层面的结构/工具轨迹统计，不代表真实工具 handler 已执行失败。所有工具 dispatch 都被 no-op 拦截，因此没有真实业务数据副作用。

## 7. 结论

1. **注入模式更新后的连续 session 没有发生历史断裂。** 8 组都完成 20 轮，历史 compaction 为空；除 GLM full 的一次 provider usage 统计回落外，末次上下文总体保持增长。
2. **description 仍显著节省 provider input。** 四个模型分别节省 20.06%–58.90%；总 token 节省 19.88%–58.78%。DeepSeek 的节省较低，主要因为 full 的续轮较少，而不是 description 固定 Schema 失效。
3. **full 的工具准确率更高。** 本轮 GLM、DeepSeek、Qwen 均 full 20/20；MiniMax full 为 16/20，高于 description 的 12/20。description 的主要剩余风险是复杂 `note_create` 结构和能力路由稳定性。
4. **缓存率不能单独作为模式优劣依据。** description 为 98.08%–99.04%，full 为 98.72%–99.41%；full 的缓存率略高，但它缓存的是更大的固定前缀，实际 input 仍显著更高。
5. **当前默认建议仍是 description。** 对复杂结构准确率优先且 token 预算充足的 provider，可继续保留 full 作为候选；`note_create.blocks` 应继续作为独立的模型参数兼容性问题处理。

## 8. 测试脚本与原始结果

测试脚本：[`test_schema_accumulation_5tools.py`](../../backend/scripts/diagnostics/test_schema_accumulation_5tools.py)

实际运行命令（四个模型均相同，仅替换 `--preset` 和输出文件名）：

```bash
PYTHONPATH=. .venv/bin/python -m scripts.diagnostics.test_schema_accumulation_5tools \
  --allow-real-llm --preset <minimax|glm|deepseek|qwen> \
  --rounds 20 --case-timeout 180 \
  --output /tmp/gugu-5tools-20260901-retest/<preset>.json
```

- 真实 provider：是，读取 devserver 当前配置；没有把 API key 写入命令或结果。
- 真实数据库：否；脚本未建立业务写入链路，`registry.dispatch` 被替换为诊断 no-op。
- 真实用户数据：否；测试使用合成工具参数和固定脱敏 case。
- 原始脱敏结果：devserver `/tmp/gugu-5tools-20260901-retest/{minimax,glm,deepseek,qwen}.json`，未纳入仓库，当前未清理，供复核本报告数字；DeepSeek、Qwen、GLM description 已分别由对应的 `*-description-optimized.json` 替换。
- 测试过程日志：devserver `/tmp/gugu-5tools-20260901-retest/run.log`，仅用于执行排障，不作为报告数据源。

本报告只保留结构化统计和失败类别，没有写入模型正文、真实用户标识、附件名、API key、Cookie 或登录 Token。
