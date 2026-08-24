# History 归一化与完整性契约
> 状态：Phase 0 已完成，Phase 1 待实施
> 创建：2026-08-24
> 最近更新：2026-08-24
> 所属层：Agent / Conversation History / Provider Adapter
> 关联模块：`backend/app/models/__init__.py`、`backend/agent/context/history.py`、`backend/agent/context/canonical_tool_history.py`、`backend/agent/im/context_loader.py`、`backend/agent/runner.py`
> 协作文档：[`32-上下文架构与扩展指南.md`](../../agent/32-上下文架构与扩展指南.md)、[`PRD-LLM-9-工具与Skill注册制及按需注入.md`](./PRD-LLM-9-工具与Skill注册制及按需注入.md)、[`PRD-RAG-1-统一知识召回与索引.md`](./PRD-RAG-1-统一知识召回与索引.md)
> 调查记录：[`docs/devlog.md`](../../devlog.md)「2026-08-24 · History 完整性审计」

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：现状审计与契约草案 | ✅ 已完成 | 已盘点 Web、QQ、微信、飞书、定时任务、压缩、RAG、工具事件和 OpenAI/Anthropic History 适配链路；已确认引用恢复问题和附件解析内容跨轮丢失边界。 |
| Phase 1：Canonical History 数据模型 | 🔲 待实施 | 定义统一消息 envelope、block 类型、字段保留/省略策略和版本号；暂不迁移历史数据。 |
| Phase 2：持久化边界归一化 | 🔲 待实施 | 在消息写入和工具轮持久化前统一生成 canonical history，覆盖普通文本、引用、附件、转写、工具事件和 RAG。 |
| Phase 3：Provider 渲染统一 | 🔲 待实施 | OpenAI、Anthropic、MiniMax 及本地兼容模型只消费同一 canonical history，Provider adapter 负责最终 wire format。 |
| Phase 4：历史兼容迁移与回归 | 🔲 待实施 | 为旧消息、旧工具格式、旧附件记录和未知 block 提供只读归一化；补齐跨平台、跨 Provider 和压缩边界测试。 |
| Phase 5：观测与性能收口 | 🔲 待实施 | LoopScope 展示归一化统计、丢弃原因、block 数量和 digest；不记录正文、附件内容或工具参数。 |

## 1. 背景与目标

### 1.1 当前问题

当前 `ConversationMessage` 同时保存原始展示正文、附件卡片、引用文本、平台身份和
`content_json`。不同入口对这些字段的使用不完全一致：

- 当前轮附件解析结果通过 `aug_text` 注入模型，但落库时只保存原始用户正文；文本文件正文和语音转写结果下一轮可能丢失。
- 图片会恢复轻量 `attach_id`，但普通文件没有统一的历史附件引用文本。
- 工具调用、工具结果、Skill/Tool Schema 和 RAG 已有 canonical block，但普通消息、引用、附件和平台元数据还没有统一 envelope。
- Anthropic 路径会保留未知 block，OpenAI 路径可能通过 `content_text()` 将其文本化，跨 Provider 的历史语义不完全一致。
- thinking/reasoning、base64 和 UI-only 交互状态属于有意省略，但目前主要依赖代码约定，缺少单一规范和回归矩阵。

### 1.2 目标

建立一套与 Provider 无关的 History Contract：

```text
平台入口
  -> AgentRequest
  -> canonical history envelope / blocks
  -> 持久化
  -> Provider adapter
  -> OpenAI / Anthropic / MiniMax / 本地模型 History
```

目标是保证：

1. 能影响模型后续理解的内容有明确的持久化或恢复规则。
2. 展示正文与模型上下文分离，引用和附件不会污染网页气泡。
3. Provider 切换只改变 wire format，不改变历史事实。
4. base64、供应商 thinking 签名和 UI-only 状态不会破坏缓存或跨 Provider 请求。
5. Web、QQ、微信、飞书和定时任务共享同一套归一化逻辑。

### 1.3 非目标

- 不把完整附件二进制、图片 base64 或供应商 thinking 签名写入长期 History。
- 不把工具气泡、交互按钮和 LoopScope span 直接当成模型消息。
- 不替换现有 `canonicalize_tool_messages()`，而是将其能力纳入更大的 History normalizer。
- 不改变现有消息展示格式、缓存分段策略、工具权限或 RAG 召回策略。
- 不在首期重写数据库历史；旧数据通过读取时归一化兼容。

## 2. 功能需求

### FR-HIS-1：统一 History envelope（🔲）

每条可进入模型 History 的消息必须先归一化为统一 envelope：

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

字段要求：

- `role`：保留语义角色；`summary` 只在 Provider 渲染时转成约定的历史 user 消息。
- `content_blocks`：保存正文、工具事件、RAG、Skill/Tool Schema 等 canonical block。
- `quote`：保存引用正文和引用附件引用，不拼回展示正文。
- `attachments`：保存稳定引用、类型、名称、扩展名和可读取能力，不保存二进制。
- `sender`：群聊保留平台用户 ID 和显示名；私聊/Web 不强行添加无意义身份字段。
- `sent_at`：使用消息原始发送时间；缺失时不得伪造平台时间。
- `source`：只用于适配和诊断，不作为模型事实注入，除非群聊身份规则要求。

### FR-HIS-2：正文与模型上下文分离（🔲）

数据库中的原始 `content` 继续用于网页和 IM 展示；模型上下文从 canonical blocks 生成。

对于当前轮增广内容：

- 文本文件解析正文应持久化为受限的 `attachment_text` block，或保存可重建的附件引用；
- 语音转写结果应持久化为 `transcript` block；
- 图片只保存 `attach_id` 和稳定提示，不保存 base64；
- 过大的文本必须按既有附件/上下文预算截断，并保留来源和截断标记；
- 原始用户消息不得因为归一化而被改写。

### FR-HIS-3：引用与附件统一恢复（🔲）

引用必须恢复为独立 `quote` block，附件必须恢复为稳定引用 block。模型可见的引用关系应在
Web、QQ、微信、飞书中使用同一渲染规则，不将引用原文拼入聊天展示正文。

附件引用至少包含：

```json
{
  "attach_id": "...",
  "kind": "image|file|audio|video",
  "name": "...",
  "ext": "...",
  "readable_by": ["inspect_images", "read_file"]
}
```

`attach_id`、文件名和用户正文不得进入普通可见日志。

### FR-HIS-4：Canonical 工具与上下文事件（✅ 基础能力，🔲 统一接入）

保留并扩展现有 canonical block：

| block type | 用途 | 是否跨 Provider 保留 |
|---|---|---|
| `text` | 普通正文 | 是 |
| `quote` | 引用正文/引用附件 | 是 |
| `attachment_ref` | 稳定附件引用 | 是 |
| `transcript` | 语音转写 | 是 |
| `attachment_text` | 附件解析文本 | 是，受预算限制 |
| `tool_call` | 工具调用 | 是 |
| `tool_result` | 工具结果 | 是 |
| `tool-schema` | 工具 Schema 事件 | 是 |
| `skill-schema` | Skill Schema 事件 | 是 |
| `tool-discovery` | 能力发现事件 | 是 |
| `knowledge-context` | RAG 召回内容 | 是 |
| `thinking` | 供应商私有思考 | 默认不跨 Provider 保留 |

工具调用和结果必须保持原子配对。缺少调用 ID 的结果不得被渲染成合法工具结果；应在归一化时
标记为无效并记录脱敏计数。

### FR-HIS-5：Provider adapter 单一出口（🔲）

Provider adapter 只负责：

- 将 `tool_call` 转成 OpenAI `tool_calls` 或 Anthropic `tool_use`；
- 将 `tool_result` 转成 OpenAI `role=tool` 或 Anthropic `tool_result`；
- 将 canonical event 转成 Provider 可接受的文本或 block；
- 根据 Provider 能力清除不兼容的 thinking/签名字段。

Provider adapter 不得自行决定是否丢弃引用、附件、转写、RAG 或普通正文。

### FR-HIS-6：旧数据和未知 block 兼容（🔲）

读取旧消息时按以下顺序处理：

1. 已有 `content_json` 按版本和 block type 归一化；
2. 无 `content_json` 的普通消息从 `content/files/quoted_text/sent_at` 构造 envelope；
3. 旧 Anthropic/OpenAI 工具格式转换为 canonical tool block；
4. 未知 block 进入明确的 `unknown` 计数，并使用稳定文本化规则，不允许两个 Provider 各自处理；
5. 无法安全恢复的 block 只丢弃该 block，不丢弃同一条消息中的其他正文。

## 3. 技术方案

### 3.1 推荐模块边界

```text
backend/agent/context/history_contract.py
    HistoryMessage / HistoryBlock / AttachmentRef / QuoteRef

backend/agent/context/history_normalizer.py
    normalize_persisted_message()
    normalize_provider_message()
    validate_history_sequence()

backend/agent/context/history.py
    canonical history -> provider history

backend/agent/context/canonical_tool_history.py
    工具与 Skill/RAG canonical block 的领域对象和 digest
```

首期可以不立即引入数据库新字段：先在读取和持久化边界构造 canonical envelope，验证完整性后再决定
是否新增 `context_blocks` 或 `context_text` 字段。现有 `content`、`content_json`、`files`、
`quoted_text`、`sent_at` 继续兼容读取。

### 3.2 持久化规则

- 普通用户/助手正文继续保存到 `content`。
- 结构化工具、RAG、Schema 事件保存到 `content_json`。
- 引用继续保存到 `quoted_text`，引用附件通过 `files` 或 canonical `quote` 引用表达。
- 附件解析文本和 transcript 需要在“是否持久化全文、只保存摘要、还是只保存可读取引用”之间做明确策略选择；默认不重复保存大型原文。
- assistant 文件发送卡片只作为展示/交付元数据，除非它影响后续模型推理，否则不注入模型 History。

### 3.3 缓存与压缩约束

- 归一化必须确定性：同一数据库消息、同一 Provider 能力下输出字节级稳定的 canonical 内容。
- 动态时间、RAG 和相处方式继续遵守现有动态尾部策略，不移动到固定 snapshot 前缀。
- 压缩只能以 canonical message unit 为边界，不能拆开工具调用/结果、引用和附件上下文。
- base64、远程签名 URL 和供应商私有签名不得成为稳定缓存前缀。

### 3.4 安全与隐私

- 诊断只记录 block 类型、数量、长度、hash/digest、丢弃原因和 Provider，不记录正文。
- 不在日志、LoopScope attributes 或前端响应中记录附件正文、token、签名 URL 或完整参数。
- 归一化不得扩大数据可见范围；群成员、群组和 owner scope 仍由现有权限层决定。

## 4. 验证与上线

### Phase 1：契约与归一化基础（🔲）

验证：

- 普通 Web/IM 消息字段完整性；
- QQ、微信、飞书引用及引用附件恢复；
- 图片、普通文件、语音、视频附件引用恢复；
- 文本附件和语音 transcript 的持久化/恢复策略；
- OpenAI、Anthropic、MiniMax、本地兼容模型输出等价语义；
- tool call/result 原子配对和 orphan block 拒绝；
- 压缩、TTL、snapshot refresh 后 History 顺序稳定。

### Phase 2：Provider 统一与旧数据兼容（🔲）

- 使用旧数据库 fixture 进行只读归一化，不修改原始消息；
- 运行跨 Provider replay，比较 canonical digest 而不是 wire JSON；
- 对未知 block 做降级测试；
- 迁移失败时回退到旧 History builder，不影响消息发送。

### Phase 3：灰度与观测（🔲）

LoopScope 只展示：

- `history_schema_version`；
- canonical message/block 数量；
- attachment/quote/transcript block 数量；
- provider adapter 转换计数；
- dropped/unknown/orphan block 数量；
- canonical digest 和长度。

上线后关注：`history_normalization_error`、`orphan_tool_result`、`unknown_history_block`、
Provider `BadRequestError`、附件读取失败和上下文超预算次数。所有日志必须脱敏。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 追加解析正文导致 History 变大 | Cache 命中率下降、压缩更频繁 | 优先稳定附件引用；transcript/文本正文按预算和摘要策略持久化 |
| 旧 `content_json` 类型复杂 | Provider 切换继续出现 400 | 读取时归一化，未知 block 计数，工具块严格配对 |
| canonical envelope 与现有 ORM 字段重复 | 改造范围扩大 | 首期先做内存 envelope 和读取适配，验证后再决定数据库迁移 |
| 引用附件带签名 URL | 可能泄漏临时凭据 | 只保存内部 `attach_id`，禁止保存签名 URL |
| 压缩边界拆开事件 | 工具历史失效或模型 400 | 使用 canonical message unit 和 tool turn 原子单元 |

待确认：

- 🔲 文本附件历史是保存完整解析文本、摘要，还是只保存 `attach_id` 并要求模型重新调用读取工具。
- 🔲 语音 transcript 是否作为长期 History 正文保存，还是只保存短摘要。
- 🔲 是否为 `ConversationMessage` 新增显式 `context_blocks` 字段，还是先继续复用 `content_json`。
- 🔲 是否需要把助手消息的 `sent_at` 和工具事件时间暴露给模型；当前仅用户消息时间进入模型上下文。
