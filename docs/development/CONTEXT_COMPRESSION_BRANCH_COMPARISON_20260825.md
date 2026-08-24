# 分支式上下文压缩对比报告

日期：2026-08-25

## 测试范围

使用 devserver 的真实 provider，对现有 `session=388` 做只读测试。脚本读取 session snapshot、baseline 水位和 history，但没有调用生产压缩入口，也没有写入 `ConversationSession`、`ConversationMessage` 或更新 baseline。

压缩边界保持一致：

- snapshot/system prompt 不进入压缩输入；
- 旧 baseline 之前的历史不重复处理；
- 最近 20,000 字符作为完整尾部保留；
- 只有尾部之前的 history 进入摘要。

测试脚本：`backend/scripts/diagnostics/compare_branch_compaction.py`

## 策略定义

普通滚动压缩复现当前实现：旧 history 按 48,000 字符分块，逐块把上一份摘要合并进下一次摘要请求。

分支式压缩使用同一份 session 快照和 history，在隔离请求中一次性生成候选摘要。它只模拟“从当前 session 分支创建压缩任务”，不包含最终 CAS 写回；因此本次结果不能证明并发提交逻辑已经完成。

## 首轮冷启动结果

最初的测试没有先执行对话预热，因此只能作为冷启动基线：

样本统计：

| 指标 | 数值 |
| --- | ---: |
| history 总行数 | 546 |
| baseline 之后可见行数 | 96 |
| 本次压缩行数 | 67 |
| 保留尾部行数 | 29 |
| snapshot | 已存在，未压缩 |

| 指标 | 普通滚动 | 分支式 |
| --- | ---: | ---: |
| 摘要请求数 | 2 | 1 |
| provider fresh input tokens | 30,738 | 29,736 |
| cache read tokens | 256 | 128 |
| provider 统计总 input | 30,994 | 29,864 |
| 加权 cache 命中率 | 0.83% | 0.43% |
| 摘要字符数 | 713 | 1,431 |
| 与源文本的词汇重叠数 | 13 | 34 |

provider 这次只返回了每个请求 128 个 cache read token，缓存量过小，不能据此证明分支式更有利于缓存。分支式减少了约 1,000 个 fresh input token 和一次摘要请求，但一次性输入仍然接近 30k token；在当前 provider 的缓存行为下，缓存收益没有出现。

脚本现已默认在正式对比前执行一轮只读对话预热。预热请求使用 session 的 system snapshot，不写回对话；预热 usage 单独报告，不并入普通/分支压缩统计。由于压缩请求使用独立的摘要 system prompt，预热不能直接证明摘要请求的 cache 命中，只能排除连接和模型冷启动因素。

## 预热后复测

同一 session、同一 provider 再执行一轮只读对话预热后复测：

| 指标 | 普通滚动 | 分支式 |
| --- | ---: | ---: |
| 摘要请求数 | 2 | 1 |
| provider fresh input tokens | 8,295 | 1 |
| cache read tokens | 22,769 | 29,863 |
| provider 统计总 input | 31,064 | 29,864 |
| 加权 cache 命中率 | 73.28% | 100% |
| 摘要字符数 | 870 | 852 |
| 盲评总分 | 7 | 7 |
| 盲评准确性 | 6 | 7 |

普通策略的第一块请求命中 22,641 cache tokens，但第二块因为把上一轮摘要合并进请求，前缀发生变化，cache read 只有 128 tokens；分支式一次性请求命中 29,863 cache tokens。这个结果支持“从稳定 session 上下文分支压缩更利于保持前缀缓存”的判断。

盲评认为两者主线覆盖相近，但普通摘要混入了部分原文没有明确出现的待办/情绪推断，准确性为 6；分支式准确性为 7。分支式不是全面胜出：它仍需要硬长度限制、结构校验和 CAS 写回，不能直接绕过现有 baseline 保护。

## MiniMax-M3 历史 session 复测

在 devserver 当前激活的 `MiniMax-M3`（上下文上限 80,000）上，使用同一个历史 QQ session `388` 复测。测试前先执行一轮只读对话预热，测试结束后确认 session 的 baseline 水位仍为 `20190`，状态为 `idle`，没有写回压缩结果。

| 指标 | 普通滚动 | 分支式 |
| --- | ---: | ---: |
| 摘要请求数 | 2 | 1 |
| provider fresh input tokens | 8,172 | 1 |
| cache read tokens | 22,769 | 29,863 |
| provider 统计总 input | 30,941 | 29,864 |
| 加权 cache 命中率 | 73.59% | 100% |
| 摘要字符数 | 875 | 1,222 |

结果与前一次热启动测试一致：分支式在 MiniMax 上保持了完整稳定前缀，少一次摘要请求，并把压缩请求的 cache read 提升到 29,863 token。普通滚动策略第一块可命中缓存，但第二块由于合并了新摘要导致前缀变化，cache read 退回 128 token。

本轮额外盲评未返回可解析的 JSON，故不纳入质量分数；token/cache 与请求次数数据有效。

## 质量观察

普通滚动摘要更紧凑，主题边界和待办收束更稳定；分支式摘要保留了更多细节，但明显更长，也把多个话题、时间点和待办堆在同一份摘要中，后续作为 baseline 时更容易增加 snapshot/history 的固定前缀长度。

本次盲评请求没有返回可解析的 JSON 分数，因此不把模型自评当作有效结论。以上质量结论来自摘要长度、结构指标和人工对照；后续应使用固定 JSON 输出或独立评测集再做可量化评估。

## 结论与建议

当前不建议直接用分支式一次性摘要替换普通压缩。它的主要收益是减少摘要请求和少量输入 token，主要风险是摘要膨胀、跨话题混合以及单次模型调用失败时没有中间结果。

建议下一阶段采用混合方案：

1. 在独立分支 session/context 中执行压缩，不触碰当前 run、snapshot、工具目录和用户记忆。
2. 优先沿用普通分块滚动策略；只有完整 history 在模型预算内且通过硬上限检查时，才尝试一次性分支压缩。
3. 分支结果必须经过长度、结构和关键信息校验，失败则丢弃候选，不影响当前 baseline。
4. 通过 `baseline_message_id` 与 `baseline_message_hash` 做 CAS 提交；只有源 baseline 未变化时才写回。
5. 等 provider 的真实 cache read 稳定可观测后，再单独评估分支请求是否能改善缓存，而不是用本次 128 token 的结果推断。
