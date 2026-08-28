# DeepSeek 自动缓存与上下文断点专项优化 PRD

> 状态：🔲 待实施
> 创建：2026-08-25
> 所属层：LLM / DeepSeek Provider / Prompt Cache
> 前置 PRD：[[PRD-LLM-11-Canonical Context、History 与 Provider Adapter 分层重构.md]]
> 关联 PRD：[[PRD-LLM-8-Prompt-Caching优化.md]]、[[PRD-LLM-3-provider供应商适配层整体整理.md]]
> 关联报告：[[../../reports/TEST-Cache-DeepSeek-MiniMax-M3-20run-20260825.md]]

## 0. 一句话目标

在完成 LLM-11 的 Canonical Context 和 Provider Adapter 收口后，针对 DeepSeek 的服务端自动前缀缓存行为，消除不必要的跨 run 结构变化，让缓存断点能够随稳定历史推进，并用真实 Provider 数据解释每次低命中原因。

本 PRD 不把 MiniMax/Qwen 的显式缓存策略复制给 DeepSeek，也不在业务层增加 DeepSeek 特判。

## 1. 已知事实与待验证假设

### 1.1 已知事实

- DeepSeek 当前走 OpenAI-compatible 接口。
- 当前实现未确认 DeepSeek 支持消息级 `cache_control`，默认不发送显式 cache marker。
- DeepSeek 依赖服务端自动前缀缓存。
- 真实结构诊断中，跨 run 的第一处差异曾落在上一轮 dynamic tail 位置：

```text
上一轮：稳定历史 + 当前消息 + dynamic tail
下一轮：稳定历史 + 当前消息 + assistant 历史 + 新 dynamic tail
```

- 当前测试观察到命中量长期停留在约 `12032 tokens`，输入继续增长后缓存率下降。
- MiniMax-M3 曾达到稳定 90%+，不能把该结果直接当作 DeepSeek 的能力基线。

### 1.2 待验证假设

以下内容必须通过真实请求或官方资料确认，不能直接写成 Provider 契约：

- DeepSeek 服务端缓存的最小缓存粒度是否约为 4K tokens。
- dynamic tail 是否正好导致最后一个缓存块无法复用。
- tools schema 是否参与 DeepSeek 的前缀缓存，以及 schema 变化是否会从 tools 区域重新断开。
- thinking 参数、图片块、工具历史和消息角色是否会改变缓存 key。
- 显式 `cache_control` 是否被忽略、拒绝或改变请求序列化；在确认前禁止启用。

## 2. 当前问题

### 2.1 缓存断点不可解释

当前 LoopScope 可以看到总 input/cache 数量，但不能准确回答：

- canonical context 是否变化；
- Provider wire request 是否变化；
- tool schema 是否变化；
- dynamic tail 是否变化；
- 第一处结构差异位于哪条消息、哪个 block；
- Provider 自动缓存实际覆盖了哪一段。

### 2.2 动态尾部阻止缓存断点推进

当前请求尾部包含时间、stance 或其他本轮动态信息。上一轮动态尾部在下一轮被 assistant 历史消息替换，导致自动前缀在该位置断开。

目标结构不是简单删除动态信息，而是把内容按生命周期分层：

```text
稳定 snapshot
→ canonical history
→ turn-stable metadata
→ current message
→ request-volatile tail
```

只有真正需要每次重新计算的内容才进入 request-volatile tail。

### 2.3 工具 Schema 可能造成第二个断点

工具 Schema 位于 provider request 的独立字段中。若每轮工具集合、顺序、描述或参数 schema 重新生成，即使 messages 完全一致，Provider 也可能无法复用原缓存。

必须把工具 Schema 作为独立的稳定输入检查，而不是只比较 messages。

## 3. 目标架构

### 3.1 DeepSeek 请求结构

LLM-11 完成后，DeepSeek 只接收 Adapter 渲染后的稳定 wire request：

```text
Canonical Context
  ├─ static system
  ├─ session snapshot
  ├─ canonical history
  ├─ current turn
  └─ dynamic tail
        ↓
DeepSeek Adapter
  ├─ OpenAI-compatible messages
  ├─ deterministic tools schema
  ├─ thinking parameters
  └─ automatic-prefix cache policy
```

### 3.2 DeepSeek Cache Policy

```python
DeepSeekCachePolicy(
    automatic_prefix_cache=True,
    explicit_cache_control=False,
    single_history_anchor=False,
    cache_granularity_tokens=None,  # 未经实测确认前不硬编码
)
```

DeepSeek Adapter 不得：

- 注入 Anthropic `cache_control`；
- 复用 MiniMax/Qwen 的显式锚点函数；
- 改写 canonical history 的消息顺序；
- 将诊断字段放入 messages 或 tools；
- 为了缓存删除必要的时间、工具结果或视觉内容。

## 4. 优化目标

### P0：建立真实断点诊断

每次 DeepSeek 请求记录脱敏结构：

```json
{
  "provider": "deepseek",
  "model": "...",
  "run_id": "...",
  "round": 1,
  "canonical_digest": "...",
  "wire_digest": "...",
  "system_digest": "...",
  "snapshot_digest": "...",
  "history_digest": "...",
  "current_turn_digest": "...",
  "current_turn_digest": "...",
  "tool_schema_digest": "...",
  "tool_schema_count": 3,
  "history_message_count": 24,
  "first_diff_index": 26,
  "first_diff_role_before": "system",
  "first_diff_role_after": "assistant",
  "cache_policy": "automatic-prefix"
}
```

禁止记录正文、工具参数、附件名、图片 URL、用户 ID、token 和密钥。

### P0：工具 Schema 稳定化

- 工具按 canonical name 排序，禁止依赖注册表偶然顺序。
- JSON schema 使用稳定 key 顺序和稳定序列化。
- 同一 session 内未变化的工具集合保持相同 digest。
- 工具声明变化时生成新的 schema version，不重写旧 history。
- `use_skill` 注入的工具集合必须和 canonical skill event 对齐。
- 工具权限由代码决定，不能通过 DeepSeek prompt 文本伪造权限。

### P1：动态 Tail 生命周期重构

将当前动态内容明确拆分：

| 类型 | 示例 | 目标处理 |
|---|---|---|
| session-stable | 低频 stance、会话级行为状态 | 由 snapshot 或稳定 session event 管理 |
| turn-stable | 当前消息时间、RAG 结果、已完成 Skill/Tool schema event | 进入 canonical turn，可在下一 run 原样恢复 |
| request-volatile | 当前真实时间、临时诊断、provider usage | 只留在 request tail，不参与 history |

重点评估：turn-stable metadata 是否能在不破坏 Anthropic/OpenAI 消息合法性的前提下进入 canonical history，使下一 run 保留相同字节前缀。

### P1：图片和视觉内容边界稳定

- 首次视觉输入按现有能力发送。
- base64 仅在模型确实需要时保留。
- 模型完成视觉消费后，后续 round/run 使用稳定附件引用或占位结构。
- 不允许上一轮使用 base64、下一轮突然替换为另一种占位文本而无诊断记录。
- 图片变化必须独立标记为 volatile image boundary，不污染普通历史 digest。

### P2：Provider 参数稳定化

- thinking 参数由 DeepSeek Adapter 确定性生成。
- `response_format`、tool choice、并行工具和流式参数保持稳定。
- usage 字段统一转换为 `input/cache_read/cache_write/output`。
- 不把本地模型、Qwen 或 MiniMax 的专属参数发送给 DeepSeek。

## 5. 文件与目录计划

### 5.1 主要修改文件

```text
backend/agent/providers/deepseek.py
  # DeepSeek 能力矩阵、cache policy、thinking/tool 参数

backend/agent/providers/base.py
  # ProviderCacheCapabilities 公共接口

backend/agent/context/canonical_context.py
backend/agent/context/canonical_request.py
backend/agent/context/context_assembly.py
  # 由 LLM-11 提供；本 PRD 只补 DeepSeek 断点约束

backend/agent/context/cache_policy.py
  # automatic-prefix 与 explicit marker 能力分离

backend/agent/context/context_diagnostics.py
  # canonical/wire/schema/tail digest 与 first diff

backend/agent/loop_drivers.py
  # 仅调用 adapter，不直接添加 DeepSeek 专属缓存逻辑

backend/agent/canonical_tool_history.py
backend/agent/context/history.py
  # 仅在 LLM-11 canonical history contract 确认后接入
```

### 5.2 测试与诊断文件

```text
backend/tests/test_deepseek_cache_policy.py
backend/tests/test_deepseek_request_stability.py
backend/tests/test_deepseek_tool_schema_digest.py
backend/tests/test_deepseek_history_breakpoint.py

backend/scripts/diagnostics/test_deepseek_cache_runs.py
backend/scripts/diagnostics/compare_deepseek_breakpoints.py

docs/development/DEEPSEEK-CACHE-BREAKPOINT-REPORT-YYYYMMDD.md
```

测试脚本只输出脱敏统计，不保存真实 prompt、工具参数、图片 URL 或附件正文。

## 6. 实施 TODO

### Phase 0：依赖与基线

- [ ] 完成 LLM-11 Phase 1 的 Canonical Context 和 History contract。
- [ ] 确认当前 devserver 使用的 DeepSeek 预设、模型、API 格式和 thinking 配置。
- [ ] 使用同一真实 session 完成 native DeepSeek 3-run、10-run、20-run 基线。
- [ ] 同时记录 messages、tools schema、dynamic tail 三条 digest 链。
- [ ] 明确区分 cold cache、warm cache 和 Provider cache TTL 过期。

### Phase 1：断点诊断

- [ ] 实现 first diff 的消息/block 级脱敏诊断。
- [ ] 记录 canonical digest 与 wire digest 的差异。
- [ ] 记录工具 Schema digest、数量、顺序和版本。
- [ ] 记录图片/附件 volatile boundary。
- [ ] 验证低命中是否总是发生在 dynamic tail、tool schema 或图片边界。

### Phase 2：Schema 与参数稳定化

- [ ] 固定工具 Schema 排序和序列化。
- [ ] 固定 DeepSeek thinking、tool choice、stream 参数。
- [ ] 增加同一 canonical input 多次 wire render 的 byte/digest 回归。
- [ ] 增加工具集合变化、Skill 注入和跨 run 工具历史测试。

### Phase 3：Turn-stable metadata 优化

- [ ] 设计 `turn-context` canonical event，不直接修改 Provider wire history。
- [ ] 验证时间、RAG、stance 在下一 run 是否可以原样恢复。
- [ ] 验证 Anthropic 消息角色约束和 OpenAI tool pairing 不被破坏。
- [ ] 对比“当前 dynamic tail”与“turn-stable event”两种方案的缓存率和语义错误率。
- [ ] 只有在语义回归通过后才启用真实请求。

### Phase 4：图片与大块内容边界

- [ ] 统一 attach_id、占位文本和 base64 的 canonical 表示。
- [ ] 视觉消费完成后确认后续 round/run 不再携带不稳定 base64。
- [ ] 测试图片首次发送、工具返回图片、引用图片和跨 run 恢复。

### Phase 5：真实 Provider 验收

- [ ] 连续 3 run：检查第一处断点是否可解释。
- [ ] 连续 10 run：检查稳定缓存是否随历史增长推进。
- [ ] 连续 20 run：统计平均、去首轮平均、最低、最高、固定命中 token 和 fresh token。
- [ ] 记录工具调用、Skill 注入、RAG、图片和压缩场景的独立结果。
- [ ] 与 LLM-11 基线报告对比，确认没有影响 MiniMax/Qwen/Anthropic。

### Phase 6：清理与关闭

- [ ] 删除 DeepSeek 业务层分支和重复 cache marker 逻辑。
- [ ] 清理临时探针，只保留脱敏正式诊断字段。
- [ ] 更新 Provider 能力矩阵、Context 架构文档和缓存报告。
- [ ] 完成全量测试、compileall 和真实预设回归。

## 7. 验收标准

### 7.1 正确性

- DeepSeek 不收到未经能力声明的 `cache_control`。
- Provider 切换不丢失普通消息、工具结果、引用、附件、RAG 或 Skill event。
- tool call/result 始终保持合法配对。
- 动态尾部不会泄漏为用户可见消息，也不会重复注入。
- 图片、thinking 和工具历史不会产生 BadRequest。

### 7.2 缓存

- 首轮 cache miss 被单独统计，不作为稳定阶段失败。
- 连续 run 的第一处 canonical/wire diff 可解释。
- 工具 Schema 不变时，schema digest 保持不变。
- DeepSeek 的稳定缓存命中量不再无原因固定在早期断点。
- 若 Provider 4K 分块导致无法继续推进，LoopScope 和报告必须明确标注，而不是归因于业务组装错误。

### 7.3 性能与安全

- 断点诊断不读取或输出完整 prompt。
- 诊断开销不显著增加模型调用延迟。
- 不新增网络探测、额外 LLM round 或业务工具调用。
- 不为缓存优化扩大历史消息、附件或群聊数据的可见范围。

## 8. 完成定义

本 PRD 必须在 LLM-11 完成后开始实施，并满足：

1. DeepSeek 真实请求经过统一 Canonical Context 和 Provider Adapter。
2. 自动缓存、显式缓存和缓存粒度能力已分离建模。
3. Schema、history、dynamic tail、图片边界均可用脱敏 digest 解释。
4. 至少完成 3/10/20 run 的真实 DeepSeek 回归。
5. 未降低 MiniMax、Qwen、Anthropic 和本地模型的既有正确性与缓存基线。
6. 所有临时探针已清理，正式诊断不包含正文、附件、参数、URL、token 或密钥。
