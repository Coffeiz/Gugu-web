# Canonical Context、History 与 Provider Adapter 分层重构 PRD

> 状态：🟡 Phase 0-6 核心链路已完成，完整数据库历史迁移与真实 Provider 长跑验证待后续收尾
> 创建：2026-08-25
> 所属层：LLM / Context Assembly / Provider Adapter
> 关联 PRD：[[PRD-LLM-3-provider供应商适配层整体整理.md]]、[[PRD-LLM-8-Prompt-Caching优化.md]]、[[PRD-LLM-9-工具与Skill注册制及按需注入.md]]
> 关联报告：[[../../reports/TEST-Cache-DeepSeek-MiniMax-M3-20run-20260825.md]]

## 0.1 当前实现状态

本轮已落地 Canonical Context 的核心垂直链路：

- `CanonicalContext`、`CanonicalHistoryUnit`、`CanonicalRequest` 和稳定 digest 已建立；
- Web、IM、定时任务统一经过 `context_assembly`，保持原有消息顺序和动态尾部行为；
- Provider 历史渲染统一从 `ProviderAdapter.render_history()` 出口执行；
- automatic prefix cache、explicit cache control、single history anchor 已拆成独立能力描述；
- LoopScope 已增加 canonical、wire、schema、cache policy 和 first diff 的脱敏诊断字段；
- 工具调用与工具结果在 Canonical Context 中按原子 history unit 归组；
- 新增 Canonical Context、assembly、adapter、缓存断点和 schema digest 回归测试。

以下内容尚未在本轮宣称完成：

- 旧数据库消息的完整 `HistoryEnvelope` 归一化与引用/附件/未知 block 全量恢复；
- OpenAI、Anthropic、DeepSeek、Qwen、MiniMax 的真实跨 provider 连续 run 回归报告；
- 数据库中历史正文的迁移脚本和全量回放校验。

## 0. 一句话目标

建立一套 Provider 无关的 Canonical Context：业务层只负责生成稳定、确定性的上下文结构；Provider Adapter 只负责把同一份结构渲染成 OpenAI、Anthropic 或本地模型可接受的 wire request，并独立声明缓存、工具、图片和 thinking 能力。

目标不是让不同 Provider 的最终 JSON 完全相同，而是让：

```text
Canonical Context 稳定
        ↓
Provider Adapter 确定性渲染
        ↓
Provider-specific wire request 稳定
```

## 1. 背景与问题

### 1.1 当前链路

当前 Web、IM、定时任务和 Agent runner 已经部分共享上下文，但仍存在两层边界混杂：

- `PromptMessages` 同时承担业务消息顺序、动态尾部、压缩边界和缓存锚点记录；
- `history.py` 已经在做 OpenAI/Anthropic 历史转换，但 canonical block、普通消息、引用和附件的边界仍由多个入口共同决定；
- `loop_drivers.py` 既处理 provider wire format，也决定部分 cache marker 行为；
- 工具 Schema 由运行时能力变化驱动，容易造成同一 session 的 tools payload 重建；
- Provider 的“支持自动缓存”和“支持显式 `cache_control`”没有完全分离；
- DeepSeek 等 OpenAI-compatible Provider 使用服务端自动前缀缓存，不能直接复制 MiniMax/Qwen 的显式锚点策略。

### 1.2 已确认的缓存断点问题

当前 DeepSeek 的真实结构检查显示：

```text
稳定 snapshot / history
→ 当前用户消息
→ 每轮变化的 dynamic tail
```

下一轮会变成：

```text
稳定 snapshot / history
→ 当前用户消息
→ assistant 历史消息
→ 新 dynamic tail
```

第一处结构差异落在上一轮 dynamic tail 位置。DeepSeek 依赖服务端自动缓存，不能通过业务层随意添加显式 cache marker 修复。该问题必须由统一 Context 边界和 Provider 缓存能力声明共同处理。

### 1.3 现状痛点

| 问题 | 风险 |
|---|---|
| 业务层直接拼 OpenAI/Anthropic 消息 | Provider 切换后历史语义可能变化 |
| 同一消息在不同入口重复归一化 | Web、QQ、群聊、定时任务出现不同前缀 |
| 工具 Schema 变化没有独立 digest | 无法判断缓存断点来自工具还是 history |
| dynamic tail 边界没有统一 contract | 下一 run 可能从尾部重新开始缓存 |
| cache capability 与 active cache 混用 | DeepSeek 被误加 Qwen/MiniMax 策略 |
| diagnostics 混在实际消息对象 | 观测字段可能污染 prompt 前缀 |

## 2. 目标架构

### 2.1 Canonical Context 四层

所有入口先生成同一套结构：

```text
CanonicalContext
├── static_system       # 人格、政策、稳定规则
├── session_snapshot    # snapshot 生命周期内稳定的项目/日历/文件/memory/source
├── canonical_history   # 连续消息、工具调用、工具结果、RAG、交互事件
├── current_turn        # 当前用户消息及本轮已确定的持久化事件
└── dynamic_tail        # 当前时间、最新 stance 等真正每轮变化的内容
```

固定顺序：

```text
static_system
→ session_snapshot
→ canonical_history
→ current_turn
→ dynamic_tail
```

约束：

1. `static_system` 和 `session_snapshot` 不由 Provider Adapter 修改。
2. `canonical_history` 只追加或按 canonical unit 压缩，不重新拼装旧消息。
3. `current_turn` 中需要进入下一轮的内容必须可持久化、可重建、可去重。
4. `dynamic_tail` 不得混入 snapshot hash、history baseline 或诊断字段。
5. 工具调用与工具结果、交互请求与交互结果必须保持原子关系。

### 2.2 Provider Adapter 两阶段出口

```text
CanonicalContext
  ↓ assemble()
CanonicalRequest
  ↓ adapter.render()
ProviderRequest
```

Adapter 负责：

- `role` 和 block 的 Provider 映射；
- OpenAI `tool_calls` / `role=tool`；
- Anthropic `tool_use` / `tool_result`；
- 图片、音频、视频 payload；
- thinking、structured output 和工具参数；
- Provider 专属 cache marker 或自动缓存参数；
- usage 字段归一化。

Adapter 不负责：

- 选择当前用户能否使用工具；
- 决定 snapshot 是否刷新；
- 重新排序历史消息；
- 删除引用、附件、RAG 或普通正文；
- 处理业务工具结果或 Agent 状态机。

### 2.3 缓存能力模型

能力必须拆开表达：

```python
ProviderCacheCapabilities(
    automatic_prefix_cache: bool,
    explicit_cache_control: bool,
    single_history_anchor: bool,
    cache_granularity_tokens: int | None,
)
```

示例：

| Provider | 自动前缀缓存 | 显式 cache marker | 业务策略 |
|---|---:|---:|---|
| DeepSeek | 是 | 未确认/默认否 | 保持 canonical wire 结构稳定，使用服务端缓存 |
| Qwen Token Plan | 是 | 已验证 | 使用 adapter 声明的单历史锚点 |
| MiniMax M3 | 是 | 按当前真实配置 | 保持既有 Anthropic 缓存策略 |
| 本地 OpenAI-compatible | 未知 | 否 | 不注入云厂商专属字段 |

## 3. 修改目标

### P0：统一 Context Contract

- 为 static system、snapshot、history、current turn、dynamic tail 建立明确的数据结构和生命周期。
- 让 Web、IM、定时任务使用同一个 assembly 入口。
- 将 `PromptMessages` 降级为请求期容器，不再承担业务层 canonical 规则。
- 统一固定前缀、历史区、动态尾部的边界诊断。

### P0：Provider Adapter 成为唯一 wire 出口

- OpenAI、Anthropic、MiniMax、DeepSeek、Qwen 和本地模型均从同一份 canonical history 渲染。
- 删除业务层对 `role=tool`、`tool_use`、`tool_result` 的重复拼装。
- Provider-specific 字段只能在 `backend/agent/providers/` 中产生。

### P1：工具与 Skill Schema 稳定化

- 对 canonical tool schema、skill schema 和 declared tools 生成稳定 digest。
- 同一 session 内工具顺序保持稳定。
- 工具集合变化时只记录新版本，不重写旧 history。
- Schema digest 和数量进入诊断，但不得进入模型上下文。

### P1：缓存断点可解释

每次请求只记录脱敏结构字段：

```json
{
  "provider": "deepseek",
  "canonical_digest": "...",
  "wire_digest": "...",
  "static_digest": "...",
  "snapshot_digest": "...",
  "history_digest": "...",
  "dynamic_tail_digest": "...",
  "tool_schema_digest": "...",
  "tool_schema_count": 3,
  "first_diff_index": 26,
  "cache_policy": "automatic-prefix"
}
```

正文、工具参数、附件名、URL、token、密钥和用户身份不得写入诊断。

### P1：动态尾部生命周期明确化

将动态内容分成三类：

| 类型 | 示例 | 处理 |
|---|---|---|
| session-stable | stance、低频会话状态 | 可随 snapshot/turn policy 更新 |
| turn-stable | 当前消息时间、RAG 结果、Skill/Tool schema event | 进入 canonical turn，下一轮可重建 |
| request-volatile | 当前时刻、临时诊断、provider usage | 只进入 dynamic tail，不持久化 |

任何内容只能属于一个区域，禁止同一内容同时出现在 snapshot、history 和 dynamic tail。

## 4. 计划修改的文件与目录

### 4.1 新增目录/文件

```text
backend/agent/context/
  canonical_context.py          # CanonicalContext、CanonicalTurn、区域边界
  canonical_request.py          # 统一请求对象与确定性 digest
  context_assembly.py           # Web/IM/定时任务共用 assembly 入口
  context_diagnostics.py        # 脱敏结构诊断，不进入 prompt
  cache_policy.py               # Provider 缓存能力与策略选择

backend/agent/providers/
  context_adapter.py            # CanonicalRequest -> ProviderRequest 协议
  openai_history_adapter.py     # OpenAI-compatible adapter 入口
  anthropic_history_adapter.py  # Anthropic adapter 入口

backend/tests/
  test_canonical_context.py
  test_context_assembly.py
  test_provider_history_adapters.py
  test_context_cache_boundaries.py
  test_tool_schema_digest.py
```

### 4.2 重点修改文件

```text
backend/agent/context/message_assembly.py
  # 保留 PromptMessages 的请求期动态尾部能力，移除业务规则重复实现

backend/agent/context/history.py
  # 只负责 canonical history -> provider-neutral history 的恢复

backend/agent/context/canonical_tool_history.py
  # 扩展 canonical event / schema digest / tool atomic unit

backend/agent/loop_drivers.py
  # 只调用 Provider Adapter，不再直接判断 provider 缓存策略

backend/agent/runner.py
  # 统一 Web/IM/定时任务的 Context assembly 和 tool schema 生命周期

backend/agent/gateway/web.py
backend/agent/gateway/im.py
backend/agent/im/
  # 删除入口侧重复的 history/message 拼装，改调用统一 assembly

backend/agent/providers/base.py
backend/agent/providers/deepseek.py
backend/agent/providers/qwen.py
backend/agent/providers/minimax.py
  # 声明 wire、缓存、工具、媒体和 thinking 能力

backend/agent/context/compaction.py
backend/agent/context/compress_conv.py
  # 按 canonical unit 压缩，禁止拆分工具/交互/引用原子单元

backend/loopscope/
  # 展示 canonical/wire digest、schema digest 和缓存断点诊断
```

### 4.3 文档与测试文件

```text
docs/agent/context/
  canonical-context-provider-adapter-design.md

docs/development/
  CONTEXT-PROVIDER-BREAKPOINT-REPORT-YYYYMMDD.md

docs/devlog.md
  # 记录迁移过程、断点调查和兼容删除计划
```

## 4.4 History 完整性契约（本 PRD 唯一版本）

History 归一化不再单独维护另一份 PRD，而是作为 Canonical Context 的基础层。
所有进入模型的历史必须先经过统一 envelope，再由 Context Assembly 和 Provider Adapter
继续处理：

```text
平台入口 / 数据库消息
  → HistoryEnvelope
  → CanonicalHistoryUnit
  → CanonicalContext
  → Provider Adapter
  → Provider wire request
```

### 4.4.1 History envelope

```json
{
  "schema_version": 1,
  "role": "user|assistant|tool|summary",
  "content_blocks": [],
  "quote": null,
  "attachments": [],
  "sender": null,
  "sent_at": null,
  "source": "web|qq|wechat|feishu|schedule"
}
```

规则：

- 原始 `content` 继续服务于聊天展示；模型输入从 `content_blocks` 生成。
- `quote`、`attachments`、`sent_at` 是独立元数据，不拼入展示正文。
- 图片只保存稳定 `attach_id` 和可重建引用，不保存 base64。
- 文本附件和语音 transcript 按上下文预算决定保存全文、摘要或稳定引用。
- 群聊保留 sender/scope 所需身份，但不得扩大跨用户可见范围。
- `source` 主要用于 adapter 和诊断，不自动变成模型事实。
- 原始消息不得因为归一化被改写。

### 4.4.2 Canonical block 类型

| block type | 用途 | 跨 Provider |
|---|---|---|
| `text` | 普通正文 | 保留 |
| `quote` | 引用正文和引用附件 | 保留 |
| `attachment_ref` | 稳定附件引用 | 保留 |
| `transcript` | 语音转写 | 保留，受预算限制 |
| `attachment_text` | 附件解析文本 | 保留，受预算限制 |
| `tool_call` | 工具调用 | 保留并保持 ID |
| `tool_result` | 工具结果 | 保留并保持 ID |
| `tool-schema` | 工具 Schema 事件 | 保留 |
| `skill-schema` | Skill Schema 事件 | 保留 |
| `tool-discovery` | 能力发现事件 | 保留 |
| `knowledge-context` | RAG 召回内容 | 保留 |
| `thinking` | Provider 私有思考 | 默认不跨 Provider |

工具调用/结果、交互请求/结果、引用和附件上下文都是原子单元。缺少调用 ID 的工具结果
不得被渲染成合法 Provider 工具消息，只记录脱敏的 invalid/orphan 计数。

### 4.4.3 旧数据归一化

读取历史时统一执行：

1. 已有 `content_json` 按版本和 block 类型归一化。
2. 没有 `content_json` 的消息从 `content`、`files`、`quoted_text`、`sent_at` 构造 envelope。
3. 旧 Anthropic/OpenAI 工具格式转换为 canonical `tool_call` / `tool_result`。
4. 未知 block 使用统一稳定文本化规则，并记录 unknown 数量。
5. 无法安全恢复的 block 只丢弃该 block，不丢弃同一消息的其他正文。

首期不新增数据库字段、不重写旧历史；先在读取和持久化边界构造内存 envelope，验证完成后
再决定是否增加 `context_blocks` 或 `context_text` 字段。

### 4.4.4 History 与压缩、缓存的关系

- 压缩只能按 `CanonicalHistoryUnit` 进行，不能拆开工具调用/结果或交互请求/结果。
- 历史归一化必须确定性：同一数据库消息和同一 Provider 能力产生相同 canonical digest。
- dynamic tail、RAG、时间和 stance 不得重复出现在 snapshot、history 和 dynamic tail 多个区域。
- base64、远程签名 URL、Provider 私有签名和诊断字段不得成为稳定缓存前缀。
- Provider 切换只改变 wire format，不改变历史事实和 canonical digest。

### 4.4.5 History 相关实现归属

以下模块统一归本 PRD 管理，不再由另一份 History PRD 单独定义：

```text
backend/agent/context/canonical_context.py
backend/agent/context/canonical_request.py
backend/agent/context/context_assembly.py
backend/agent/context/history.py
backend/agent/context/canonical_tool_history.py
backend/agent/context/compaction.py
backend/agent/context/compress_conv.py
backend/agent/providers/context_adapter.py
backend/agent/providers/openai_history_adapter.py
backend/agent/providers/anthropic_history_adapter.py
backend/tests/test_canonical_context.py
backend/tests/test_context_assembly.py
backend/tests/test_provider_history_adapters.py
```

## 4.5 与旧 History PRD 的合并决议

`PRD-AGENT-5-History归一化与完整性契约.md` 的有效内容已合并到本节，旧文档不再作为
实施依据。后续涉及 History envelope、block、附件/引用恢复、Provider 渲染、压缩原子性
和 LoopScope 诊断时，只修改本 PRD，禁止建立第二套契约。

## 5. 实施 TODO

### Phase 0：基线冻结与真实断点审计

- [x] 记录 Web、QQ、微信群聊、飞书和定时任务的当前 assembly 结构。
- [x] 对 DeepSeek、Qwen、MiniMax 的既有连续 run 基线纳入现有缓存报告。
- [x] 记录 canonical digest、wire digest、schema digest、dynamic tail digest 和 first diff。
- [x] 确认当前低缓存的结构诊断字段覆盖 dynamic tail、tool schema、图片、压缩和 Provider 分块。
- [x] 冻结当前行为报告，作为重构前基线。

### Phase 1：Canonical Context 数据模型

- [x] 新增 `CanonicalContext`、`CanonicalRequest`、`CanonicalTurn`、`CanonicalHistoryUnit` 和 `HistoryEnvelope`。
- [x] 明确 static/snapshot/history/current-turn/dynamic-tail 的字段边界。
- [x] 固化普通文本、引用、附件、转写、RAG、工具、交互和未知 block contract。
- [x] 为每个区域增加稳定 digest；诊断字段与模型字段分离。
- [x] 保持现有 `ConversationMessage` 数据库结构不变。
- [x] 补充普通文本、引用、附件、RAG、工具、交互和未知 block 测试。

### Phase 2：统一入口组装

- [x] 抽出 Web、IM、定时任务共用的 `context_assembly.build_messages()`。
- [x] 统一 snapshot、history baseline、current message 和 dynamic tail 的顺序。
- [x] 为同一 assembly 生成一致的 canonical digest。
- [x] 维持当前权限、群聊 scope、owner scope 和工具过滤行为（本轮只替换组装入口，不改变过滤逻辑）。
- [x] 删除入口侧重复的消息组装调用，统一改用 `context_assembly.assemble()`；旧函数仅作为短期薄包装保留。

### Phase 3：Provider History Adapter

- [x] 提供从持久化消息和旧 `content_json` 恢复 `HistoryEnvelope` 的统一入口。
- [x] OpenAI 兼容链路从 `ProviderAdapter.render_history()` 渲染 canonical history。
- [x] Anthropic 链路从 `ProviderAdapter.render_history()` 渲染 canonical history。
- [x] Provider 切换只改变 wire format，不改变 canonical history digest。
- [x] 未知 block 使用统一稳定文本化策略，不由各 Provider 自行丢弃。
- [x] 工具 call/result、交互 request/result、引用和附件在 canonical envelope 层保持原子性。
- [x] 增加跨 Provider 切换回归测试。

### Phase 4：Provider Cache Policy 收口

- [x] 把 automatic prefix cache、explicit cache control、anchor、granularity 纳入能力矩阵。
- [x] DeepSeek 默认只使用服务端自动缓存，不发送未经验证的显式 marker。
- [x] Qwen/MiniMax 继续使用已验证策略，不影响现有 90%+ 缓存结果。
- [x] 本地模型默认不注入云厂商专属 cache 字段。
- [x] Provider cache capability 与结构 digest 已进入 LoopScope 诊断；真实 usage 继续沿用现有缓存报告。

### Phase 5：Schema 与动态尾部稳定化

- [x] 工具/Skill schema 生成稳定 digest，并进入脱敏诊断。
- [x] 区分 session-stable、turn-stable、request-volatile 内容。
- [x] turn-stable metadata 已具备 canonical history event/envelope 承载方式。
- [x] 保持时间、stance、RAG 的现有语义位置；本阶段不把它们移动到 system，也不以缓存优化改变其注入语义。
- [x] 用 10 次确定性 assembly 回归验证固定区稳定、动态尾部独立变化。

### Phase 6：压缩、LoopScope 与清理

- [x] 压缩以 canonical history unit 为边界；工具调用/result 只有在相邻且 ID 匹配时才作为不可拆单元。
- [x] 为旧消息、未知 block、缺失附件和 orphan tool result 补兼容回归；异常结果在压缩前丢弃，未知 block 稳定文本化，附件只保留可重建引用。
- [x] LoopScope 展示 canonical/wire/schema digest 和断点索引。
- [x] 诊断字段不进入模型输入、持久化正文或用户界面消息；只输出 digest、数量、能力和断点索引。
- [x] provider 请求统一经过 adapter 的 history 出口；保留的旧入口仅为薄兼容包装，不再维护第二套 wire 组装逻辑。
- [x] 更新 Context 架构文档和 Provider 适配说明；缓存报告继续沿用真实 usage，未把本地估算冒充供应商结果。

## 6. 验收标准

### 6.1 结构稳定性

- 同一 session 连续 run 的稳定历史 canonical digest 不变。
- 相同 canonical input 在 OpenAI/Anthropic adapter 下每次 wire digest 可复现。
- dynamic tail 变化不会修改 static system 或 snapshot digest。
- 工具 schema 未变化时 count、顺序和 digest 保持一致。

### 6.2 语义完整性

- Web、QQ、微信群聊、飞书、定时任务看到相同的 canonical history 事实。
- Provider 切换不丢失普通正文、引用、附件、RAG、工具结果和交互结果。
- 压缩不会拆开工具 call/result 或交互 request/result。
- 不出现时间、RAG、工具 schema 重复注入。

### 6.3 缓存与性能

- MiniMax/Qwen 不低于当前稳定基线。
- DeepSeek 至少能明确报告自动缓存断点和无法推进的具体原因。
- 低缓存 run 可以定位到 canonical、adapter、schema、tail 或 Provider 分块层。
- 诊断不记录正文、附件、URL、token 或密钥。

### 6.4 测试命令

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q \
  tests/test_canonical_context.py \
  tests/test_context_assembly.py \
  tests/test_provider_history_adapters.py \
  tests/test_context_cache_boundaries.py \
  tests/test_tool_schema_digest.py

# Phase 5-6 边界回归（当前基线）
PYTHONPATH=. .venv/bin/pytest -q \
  tests/test_canonical_context.py \
  tests/test_compaction.py \
  tests/test_context_cache_boundaries.py \
  tests/test_provider_history_adapters.py

PYTHONPATH=. .venv/bin/python -m compileall -q agent app
```

真实 Provider 测试只保存脱敏 JSON：

```text
provider / run / round / input_tokens / cache_read_tokens
canonical_digest / wire_digest / schema_digest / first_diff_index
```

## 7. 完成定义

满足以下条件后关闭本 PRD：

1. 所有入口共用一个 Canonical Context assembly。
2. Provider wire 差异集中在 adapter，业务层不再拼 provider-specific history。
3. 工具 Schema、历史、动态尾部和 snapshot 均有明确生命周期与 digest。
4. OpenAI、Anthropic、DeepSeek、Qwen、MiniMax 至少各有一组跨 run 回归测试。
5. LoopScope 可以解释缓存断点，但不泄漏模型上下文正文。
6. 旧 history 可读取，压缩、引用、附件、RAG 和工具调用行为无回归。
