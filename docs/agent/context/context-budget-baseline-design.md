# 上下文预算与 Baseline 设计

> 本文历史设计已由 [`PRD-AGENT-4：统一 ContextBudget 上下文压缩重构`](../../product/PRD/PRD-AGENT-4-统一ContextBudget上下文压缩重构.md) 收口。当前实现只维护一个 baseline；下文出现的 checkpoint 仅用于解释旧迁移背景，新的代码和流程不得新增该语义。provider overflow 或成功 usage ≥90% 时才推进压缩；压缩后只保留最近 5k token 对应的完整 history，其余全部滚动合并为 summary，最终 summary 不超过 10,000 字符，50% 仅用 provider 实际 usage 检测。

## 1. 背景

当前 Web 和 IM 共用会话历史，但不同模型、不同入口的上下文上限可能不同。历史中还可能包含大型工具结果、图片或视频数据。provider 的真实 usage 才是上下文事实；本地只保留字符/条数边界，避免数据库全量加载和异常 payload。

本设计将“provider overflow 时的运行中上下文保护”、“run 完成后的 baseline 更新”和“正常记忆维护”分开：

- 正常维护可以使用 LLM 做摘要和长期压缩。
- Agent Loop 收到 provider context overflow 时，只压缩当前 run 之前的历史，保护当前 run 的消息链并继续执行。
- provider 成功且真实 usage 达到 90% 后，run 完成时启动 baseline 更新；下一条消息消费这个 baseline，不让压缩与新消息并发写同一 session。
- 供应商异常或压缩失败时，执行确定性的分级兜底，不把“开小差”作为第一次预算处理手段。

## 2. 目标

- 直接以 provider response usage 驱动压缩，避免本地 token 估算与 provider tokenizer 不一致。
- 保留当前合法的历史基线：只要 provider usage 仍低于当前模型上限就继续累积。
- 超量时按消息边界快速截断，保证请求可以重新发送。
- 使用 `baseline_message_id` 标记已经被处理的历史水位，后续请求和 TTL 都从新基线继续。
- 对 Web、私聊、群聊和定时任务使用同一套预算策略。
- 让视觉附件和工具结果不会把原始二进制反复注入上下文。

## 3. 核心概念

### 3.1 provider usage 与 ContextBudget

```text
total_context_tokens = uncached_input_tokens + cached_input_tokens + cache_write_tokens
usage_ratio = total_context_tokens / model_context_tokens
```

provider 返回的 usage 是唯一的压缩触发事实。`ContextBudget` 负责归一化 usage、记录分项和计算
90% 观察线、50% 压缩验证线；本地字符/条数限制只用于防止异常 payload 或全量读取，不能在发送前替代 provider 判断。

### 3.2 Baseline

`baseline_message_id` 是上下文历史水位，不是“最近 N 条消息”。

- baseline 之前的内容已经被摘要、归档或明确丢弃。
- 普通请求只加载 baseline 之后的消息。
- 每次强制截断或正常 LLM 压缩完成后，baseline 推进到最后一个已处理的完整消息。
- 工具调用和对应工具结果视为不可拆分的消息组；不能只保留其中一半。
- 压缩 summary 是 baseline 的第一条 history：持久化层保留 `role="summary"` 以便覆盖更新，发送边界将其规范化为普通 `role="user"` 消息。
- summary 不再从 history 弹出到 system/reminder，也不作为动态尾部重复注入；snapshot 只保存稳定业务上下文。

### 3.3 两种压缩

| 类型 | 触发时机 | 是否允许调用 LLM | 目的 |
| --- | --- | --- | --- |
| 正常维护压缩 | 空闲、定时、累计达到阈值 | 可以 | 生成可读的 daily/summary/memory |
| provider overflow 压缩 | provider 返回 context overflow | 可以，先压缩当前 run 之前的历史 | 保护当前 run，压缩后 retry |
| 请求自救截断 | overflow retry 仍失败、单条结果超限或异常 payload | 不可以 | 按字符/条数边界兜底，避免无限重试 |

请求自救流程不是记忆压缩：先保留当前用户消息、最近 5k token 的完整 history 和完整工具链；若摘要不可用，仍立即进入同一 ContextBudget 的确定性保护。

### 3.4 当前 run 保护范围

当前 run 从本轮用户消息开始，到最终 assistant 输出结束。运行中的压缩只允许处理保护边界之前的历史：

```text
旧历史                         可压缩
当前 run 之前的历史             可压缩
当前 run 的用户消息             保留
当前 run 的 assistant/tool call  保留
当前 run 的 tool result         保留
当前 run 的最终 assistant 输出  保留
```

当前 run 的所有消息仍须正常持久化。若当前 run 自身的单条工具结果已经超过模型上限，不能只压缩旧历史，必须对该结果执行字段级截断或摘要化。

## 4. 请求流程

```text
加载 baseline 之后的历史
        ↓
递归清理不可直接注入的附件/工具结果
        ↓
组装 system、工具定义、动态上下文、当前消息
        ↓
直接发送 provider
        ↓
provider response
   ├─ success → 读取真实 usage
   │              ├─ <90%：持久化当前 run
   │              └─ ≥90%：run 收尾压缩并提交 baseline
   └─ context overflow
                  ↓
       压缩旧 history（最近 5k 原文，summary ≤10k 字符）
                  ↓
             retry 当前 round
                  ↓
       仍失败 → 字符/条数确定性兜底并停止无限 retry
```

run 完成后的后台流程独立于上面的同步自救流程：

```text
run 输出完成
    ↓
读取 provider 真实 usage
    ↓
低于 90% → 保持当前 baseline
达到 90% → 提交唯一 baseline
    ↓
下一条消息到来时等待 baseline 更新
    ↓
使用新 baseline 组装上下文
```

### 4.1 provider 请求与 usage

正常请求不做本地 token 预检，直接把完整的 canonical context 发送给 provider。provider 返回的
usage 统一归一化为 `ContextBudget`，至少记录未命中缓存、缓存命中和 cache write 三项；
工具 schema、动态尾部、system、snapshot、history 和当前 round 都由 provider 的实际口径覆盖。

本地只保留两类保护：数据库读取的字符/条数上限，以及 provider overflow retry 仍失败时的确定性 payload 兜底。
这些保护不能生成 90%/95% 的本地 token 触发语义，也不能删除当前消息、动态尾部或不完整的工具调用链。

为诊断和读取保护保留的本地分项如下；它们不决定是否发送，也不触发压缩：

```text
total_tokens = system_prompt_tokens
             + snapshot_tokens
             + history_tokens
             + current_turn_tokens
             + tool_schema_tokens
             + dynamic_tail_tokens
             + output_reserve_tokens
             + provider_overhead_tokens
```

完整消息可以通过 `ContextBudget.from_messages()` 生成诊断分解；已经有分项时使用 `from_parts()`。provider 返回的实际 input token 是压缩触发和 90%/50% 验证的唯一依据，避免 trace、入口预估和压缩模块各自维护不同口径。

### 4.2 provider overflow 兜底规则

本地字符/条数兜底只在 provider overflow 后使用，或用于防止异常 payload：

1. 先移除已经不应进入模型的原始图片、视频、base64 和重复工具输出，仅保留类型、摘要、引用或文件标识。
2. 保留当前用户消息、最近 5k token 的完整 history、完整工具调用链和必要的系统上下文。
3. 从最旧历史开始按完整消息组删除，直到 payload 能够重新发送。
4. 如果仍然超量，继续删除较旧的工具结果和附件描述。
5. 如果单条当前消息或单个工具结果本身超限，按字段级规则截断；不能通过无限重试解决。
6. 推进 `baseline_message_id`，记录本次被截断的范围和原因。

压缩器保留最近 5k token 对应的完整 history，旧 history 全部摘要，单次摘要输入和最终 summary 均不超过 10,000 字符。压缩后的 50% 目标只在 provider retry 后用真实 usage 检测，不做本地 token 硬判断。

`compact_context()` 返回 `CompactionResult`，通过 `return_reason` 区分 `no_compressible_history`、
`summary_failed`、`shape_validation_failed`、`budget_inconsistent` 与 `compacted`。压缩 no-op 或失败后，
仅在 provider overflow retry 仍失败时进入确定性保护流程；正常成功请求不因本地估算触发压缩。

### 4.3 provider overflow 兜底

如果 provider 返回 context overflow：

- 先压缩旧 history，保留最近 5k 原文并限制 summary 为 10,000 字符；
- 重新发送一次并读取 provider 实际 usage；
- 重试仍失败则停止当前请求并返回明确错误；
- 一次 overflow 允许启动 LLM 摘要并 retry；retry 仍失败后不再无限重试；
- 记录请求大小、预算、截断阶段和重试次数，不记录聊天正文。

### 4.4 provider usage 与 baseline

- provider overflow：压缩当前 run 之前的历史，然后 retry 当前 run。
- 当前 run 的用户消息、工具调用、工具结果和最终输出不得被 baseline 更新删除。
- provider 成功后若真实 context usage ≥90%，无论本轮是否调用工具，最终回复收尾前都执行统一检查；本轮完成后推进 baseline，不打断当前输出。
- 多个 provider round 使用 run 内 context usage 高水位判定，不把各 round input 相加；这保持了“当前请求上下文长度”的预算语义。
- baseline 更新必须以 session 为粒度加锁，并携带覆盖消息水位；新消息到来时若发现 baseline 正在更新，应等待同一任务，而不是并发启动第二个压缩。
- baseline 更新失败不阻塞当前已完成的 run；下一次 provider overflow 或真实 usage ≥90% 时继续推进。
- 压缩结果提交前校验消息水位，避免旧任务覆盖新消息产生的 baseline。

## 5. 正常 LLM 压缩

正常记忆压缩由现有异步记忆维护流程负责；对话上下文 baseline 则由 provider overflow 或成功 usage ≥90% 触发。发送前不执行本地 token 预检。

正常压缩完成后：

- 摘要写入对应 scope 的记忆文件或数据库记录；
- `baseline_message_id` 推进到摘要覆盖的最后一条消息；
- 下一次请求只读取新 baseline 之后的内容；
- 如果 LLM 压缩失败，仍保留确定性截断能力，不阻塞对话。
- run 完成后的 baseline 更新不得阻塞已经发送给用户的回复；下一条消息才等待其完成。

## 6. TTL、模型切换与 Scope

### 6.1 TTL

TTL 从当前 baseline 之后的未整理消息计算，不重新扫描已经归档或丢弃的旧历史。空闲整理完成后更新 baseline 和整理时间。

### 6.2 模型切换

每次请求使用当前 provider 返回的 usage 更新 `ContextBudget`：

- 切换到更小上下文模型时，首次 provider overflow 后再执行压缩和确定性兜底；
- 切换到更大模型时，不自动恢复已经丢弃的历史；
- baseline 是单向水位，避免模型切换造成历史来回膨胀。

### 6.3 Scope

owner、member、group、私聊和群聊可以有不同的动态上下文，但使用相同的 baseline、预算、截断和重试规则。不同 scope 不能共享 baseline。

## 7. 附件和工具结果清理

清理必须递归处理嵌套结构，尤其是 `tool_result.content`：

- 图片、视频和音频只保留可供模型使用的引用、尺寸、媒体类型或短描述；
- 禁止把原始 base64 写入后续历史上下文；
- 读取旧数据时也要清理，不能只依赖新消息写入时清理；
- 单个工具结果设置字段级大小上限，超出部分使用截断标记；
- 清理日志只记录大小、类型和 fingerprint，不记录正文、附件名或用户输入。

## 8. 状态与可观测性

每次请求可以记录以下结构化字段：

```json
{
  "event": "context-budget",
  "scope": "group",
  "baseline_message_id": 0,
  "history_messages": 533,
  "total_context_tokens": 0,
  "usage_ratio": 0,
  "provider_overflow": false,
  "protected_run_messages": 0,
  "post_run_baseline_update": false,
  "baseline_status": "idle",
  "forced_truncate": false,
  "deterministic_fallback": false,
  "retry_count": 0,
  "dropped_message_count": 0,
  "oversized_item": false
}
```

实际实现中不写入估算之外的正文内容；敏感标识按现有日志安全规范处理。

## 9. 实施 Todo

### Phase 1：预算与截断核心

- [x] 抽出纯函数：有效预算计算、消息组大小估算、消息边界截断。
- [x] 定义工具调用/工具结果不可拆分组。
- [x] 支持单条超大工具结果和当前消息的字段级截断。
- [x] 为截断结果返回新的 baseline 和统计信息。
- [x] 补充不调用 LLM 的单元测试。

### Phase 2：历史读取与附件清理

- [x] `session_history` 只读取 baseline 之后的历史。
- [x] 对历史中的嵌套 `tool_result.content` 做递归清理。
- [x] 新消息持久化时同步清理媒体原文，读取旧数据时再次清理。
- [x] 增加大型历史回归测试，确保不会把 MB 级 base64 传给 provider。

### Phase 3：接入 Agent Loop

- [x] 正常请求直接发送 provider，读取并归一化真实 usage。
- [x] provider overflow 时压缩旧 history，保留最近 5k 原文和 ≤10,000 字符 summary，再 retry。
- [x] overflow retry 仍失败时只允许一次确定性字符/条数兜底。
- [x] 统一 Web、IM、定时任务的预算入口。
- [x] 将动态尾部纳入 provider 请求与压缩重组；动态尾部只保留、不参与历史删除。

### Phase 4：Baseline 与正常维护衔接

- [x] 正常 LLM 压缩完成后推进 baseline。
- [x] 强制截断和正常摘要分别记录原因与覆盖范围。
- [x] TTL、补偿扫描和模型切换均以最新 baseline 为起点。
- [x] 验证压缩失败不会阻塞下一次请求。
- [x] 区分 provider overflow 压缩与 run 完成后的 baseline 更新。
- [x] 为当前 run 建立受保护消息边界，压缩只处理边界之前的历史。
- [x] run 完成后达到 90% 时更新唯一 baseline。
- [x] 下一条消息等待同一 baseline 更新，禁止并发压缩和旧水位覆盖新水位。

### Phase 5：验证与上线

- [x] 回归验证动态 RAG/提醒尾部超预算时会截断旧历史而不是直接返回“内容太多”，且动态尾部保持不变。
- [ ] 用长会话验证“低于预算继续累积”。
- [ ] 用 provider overflow 会话验证“压缩后 retry 并读取真实 usage”。
- [ ] 用 overflow retry 失败模拟验证最多一次确定性兜底。
- [ ] 用长历史、嵌套图片工具结果、多模型上下文上限分别验证。
- [ ] 清理临时探针，仅保留预算统计和必要的 devlog。
- [x] 用单元测试验证工具结果追加后，当前 run 消息不会进入旧历史摘要。
- [x] 用单元测试验证 run 完成后的 baseline 更新同一 session 只调度一次并使用 90%阈值。
- [ ] 在真实 provider 上验证工具结果追加后不会先撞上限再返回通用错误。

## 10. 验收标准

- provider 报告仍低于当前模型上限的上下文不会被无条件压缩或截断。
- 正常请求不因本地估算提前压缩；provider overflow 后才进入压缩 retry。
- 异常路径不调用 LLM 压缩，不因压缩失败继续重试。
- 工具轮次达到硬上限时，当前 run 消息不被丢弃，且能在压缩历史后继续下一轮。
- run 完成后达到 90% 会更新唯一 baseline，低于 90% 不重复压缩。
- overflow retry 最多触发一次确定性字符/条数兜底。
- 新 baseline 后的请求不会重复加载已处理历史。
- 旧历史中的嵌套 base64 不会再次进入模型请求。
- Web 和 IM 对同一 scope 使用一致的预算与 baseline 语义。

## 11. 待确认参数

- 各 provider 的真实上下文上限由配置提供，还是维护一份能力表。
- provider usage 字段在不同供应商之间的归一化映射。
- overflow retry 的具体次数和确定性 payload 上限。
- 截断后的历史是否只推进数据库 baseline，还是同时写入一条可审计的系统事件。
