# 5 Tools 多模型 Schema 模式对比报告

日期：2026-09-01

基线：`2026-08-29-OPT-LLM-16-TOOL-SCHEMA-BASELINE`

## 1. 简介

本次在 devserver 使用当前已配置的 MiniMax、GLM、DeepSeek、Qwen 预设，复测生产中的两种工具 Schema 注入模式：

- **简介模式**：注入固定适配器 Schema 和工具目录，需要时通过 `get_tool_schema` 获取目标工具 Schema。
- **全量模式**：每轮直接注入完整工具 Schema。

测试覆盖 5 个工具：`list_folders`、`read_file`、`list_events`、`create_project`、`note_create`。工具 dispatch 被诊断脚本拦截为 no-op，仅校验模型选择的工具、参数结构和 provider usage，不会写入项目、文件、日历或笔记数据。

## 2. 测试口径

- 每个模型、每种模式各 1 个连续会话。
- 先执行 1 轮预热，再记录 20 个测量用例。
- 20 个测量用例按 5 个工具顺序循环 4 次。
- 工具准确率要求：目标工具正确，且参数字段/结构符合预期。
- `provider input` 按 OpenAI-compatible usage 口径统计，已包含 cache 命中部分；`cache rate = cache_read / provider input`。
- Schema token 为当前模型 tokenizer 的估算值，因此适合比较同一模型的模式差异，不应直接横向比较不同模型的绝对值。

## 3. 结果总览

### 3.1 简介模式

| 模型 | Schema tokens/请求 | 目录 tokens/请求 | provider input | output | 总 tokens | cache read | cache rate | 工具准确率 | Schema errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniMax-M3 | 322 | 5,800 | 698,781 | 2,552 | 701,333 | 690,777 | 98.85% | 13/20（65%） | 7 |
| glm-4.5-air | 351 | 5,800 | 706,805 | 5,548 | 712,353 | 695,936 | 98.46% | 19/20（95%） | 1 |
| deepseek-v4-flash-vision-exp | 351 | 5,800 | 771,807 | 3,500 | 775,307 | 762,752 | 98.83% | 16/20（80%） | 4 |
| qwen3.8-flash | 351 | 5,800 | 830,729 | 5,843 | 836,572 | 818,112 | 98.48% | 19/20（95%） | 1 |

### 3.2 全量模式

| 模型 | Schema tokens/请求 | provider input | output | 总 tokens | cache read | cache rate | 工具准确率 | Schema errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniMax-M3 | 12,010 | 863,471 | 1,425 | 864,896 | 738,944 | 85.58% | 10/20（50%） | 10 |
| glm-4.5-air | 12,735 | 1,068,249 | 3,905 | 1,072,154 | 1,060,480 | 99.27% | 15/20（75%） | 5 |
| deepseek-v4-flash-vision-exp | 12,735 | 1,136,497 | 2,477 | 1,138,974 | 1,129,344 | 99.37% | 20/20（100%） | 0 |
| qwen3.8-flash | 12,735 | 1,601,475 | 6,698 | 1,608,173 | 1,591,129 | 99.35% | 20/20（100%） | 0 |

## 4. 模式对比

以下为同一模型从简介模式切换到全量模式后的变化：

| 模型 | 总 tokens 变化 | provider input 变化 | cache rate 变化 | 准确率变化 |
| --- | ---: | ---: | ---: | ---: |
| MiniMax-M3 | +23.3% | +23.6% | -13.27 个百分点 | -15 个百分点 |
| glm-4.5-air | +50.5% | +51.1% | +0.81 个百分点 | -20 个百分点 |
| deepseek-v4-flash-vision-exp | +46.9% | +47.3% | +0.54 个百分点 | +20 个百分点 |
| qwen3.8-flash | +92.2% | +92.8% | +0.87 个百分点 | +5 个百分点 |

Schema 本身从约 0.3–0.35k tokens 增加到约 12.0–12.7k tokens；简介模式虽然额外携带约 5.8k tokens 的工具目录，但总消耗仍低于全量模式。对 Qwen，本次全量模式总 token 消耗约为简介模式的 1.92 倍；对 MiniMax 约为 1.23 倍。

## 5. 失败分类

- **MiniMax 简介模式**：3 个基础查询工具在早期用例未选择目标工具；4 次 `note_create` 出现 `blocks` 结构字段匹配失败。
- **MiniMax 全量模式**：10 次未选择目标工具，集中在 3 个基础查询工具和后续循环；说明全量 Schema 下工具路由稳定性较差，且 cache rate 同步降至 85.58%。
- **GLM 简介模式**：1 次 `note_create` 的 `blocks` 字段结构匹配失败。
- **GLM 全量模式**：第 1 个 `list_folders` 用例未选工具；另有 4 次 `note_create` 结构字段匹配失败。
- **DeepSeek 简介模式**：4 次 `note_create` 的 `blocks` 字段结构字段匹配失败；基础工具路由均成功。
- **Qwen 简介模式**：1 次 `note_create` 结构字段匹配失败，且该轮出现重复调用链；全量模式 20/20。

这里的 `blocks` 失败不是工具执行失败，而是模型返回的数组内部结构与当前诊断期望不同；准确率指标按严格参数结构统计，因此会计入失败。

## 6. 结论与建议

1. **简介模式是更节省 token 的默认方案**：四个模型的总 token 消耗都低于全量模式，cache rate 也总体稳定在 98.46%–98.85%。
2. **全量模式的准确率依模型差异明显**：DeepSeek/Qwen 本次达到 100%，GLM 为 75%，MiniMax 为 50%。不能仅依据 Schema 更完整就假设路由更可靠。
3. **MiniMax 需要单独关注 cache 行为**：全量模式 cache rate 从 98.85% 降至 85.58%，同时工具路由失败增加；建议继续用固定前缀/请求序列做专项 cache 复测，不要直接把本次结果归因于 Schema 大小。
4. **`note_create.blocks` 应作为独立参数兼容性问题处理**：四个模型都出现过或受影响，建议后续补充结构化参数约束/评测用例，而不是只调整全量或简介注入模式。
5. **生产建议**：默认继续采用简介模式；对 DeepSeek、Qwen 可保留全量模式作为高准确率候选；GLM、MiniMax 在切换全量前应增加工具路由回归和失败重试策略评估。

## 7. 可复现信息

测试脚本：`backend/scripts/diagnostics/test_schema_accumulation_5tools.py`

运行口径：

```bash
PYTHONPATH=. .venv/bin/python -m scripts.diagnostics.test_schema_accumulation_5tools \
  --allow-real-llm --preset <minimax|glm|deepseek|qwen> \
  --rounds 20 --case-timeout 180 --output <脱敏结果路径>
```

原始聚合结果暂存于 devserver：`/tmp/gugu-5tools-20260901/<preset>.json`。仓库仅保留本报告的聚合数字和脱敏失败分类，不提交原始模型响应、聊天正文、用户标识或凭据。

