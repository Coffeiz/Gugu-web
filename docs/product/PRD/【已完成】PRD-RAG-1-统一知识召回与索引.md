# 统一知识召回与索引（通用 RAG）PRD

> 状态：Phase 5 跨来源混合召回与 RAG-4 评分过滤已完成；Phase 6 持久化索引首版与质量评估已完成。Global Search 仍保留 ILIKE 紧急开关，Rust 词法迁移的 musl 发布灰度见 PRD-RAG-3。
> Capability RAG 已完成离线软推荐探针，正式运行时接入后置于 `PRD-LLM-9` 固定 Adapter Tool 与 shadow 验证之后。
> 创建：2026-08-04
> 最近更新：2026-08-24
> 关联模块：`backend/agent/memory/`、`backend/agent/tools/global_search.py`、`backend/agent/tools/conversations.py`
> 首个试点：[`PRD-MEM-1-记忆召回工具与混合检索.md`](./PRD-MEM-1-记忆召回工具与混合检索.md)
> 前置文档：[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)
> 协作文档：[`PRD-LLM-9-工具与Skill注册制及按需注入.md`](./PRD-LLM-9-工具与Skill注册制及按需注入.md)

## 0. 实施 Todo

本表是本 PRD 唯一的实施状态来源。阶段内同时记录已完成项和剩余项，避免再维护另一套 P0～P4 进度表。

| 阶段 | 状态 | 已完成 / 当前实现 | 剩余 Todo |
|---|---|---|---|
| Phase 0：数据源与权限协议 | ✅ 已完成 | 首个试点确定为 owner Memory；统一 `Scope`、`IndexDocument`、版本/hash、`SourceAdapter` 边界和 owner-only 查询协议；索引文档只保存摘要/片段，不保存原始文件二进制、密钥或未脱敏聊天正文；冻结切片参数、来源边界、`chunk_id` 规则和 tool round 原子性要求 | 无 |
| Phase 1：Memory 内容摘要与分块召回 | ✅ 已完成 | Memory adapter、稳定切片、中文字符 n-gram BM25、可替换的 `IndexStore` 协议、内存 upsert/invalidate、版本去重和 `search_memory` 已落地；支持空结果、limit 上限、scope 与旧版本失效；已补自动化测试 | IM scope 后置到多来源阶段 |
| Phase 2：统一索引管线与查询预算 | ✅ Memory 试点完成 | Memory 更新已接入 event 体系并发出独立 `rag.index.upsert` 信号；已实现按 owner 持久化 JSON 索引、异步串行更新、最多 3 次有限重试和脱敏生命周期诊断；查询优先读取索引，缺失时可重建回填；召回最多 10 条、单一 Memory 子来源最多 3 条、总输出 3000 字符；主动 `search_memory` 默认 5 条；embedding 作为可选补充，失败或缺缓存稳定退回 BM25 | 其他来源的持久化索引和生产规模升级移至 Phase 6 |
| Phase 3：统一召回服务 | ✅ Memory 单来源完成 | 已抽取 `UnifiedRetriever` / `UnifiedRecallService`；统一候选结果、来源引用、父文档/正文去重、3000 字符预算和 snapshot 去重；显式 `search_memory` 保持 canonical tool round；历史问题启用同一服务的低成本 BM25 被动召回，并以 provider-compatible history 消息注入；LoopScope 增加脱敏 `Knowledge RAG recall` span，区分 `tool` / `passive` 入口；保留 `global_search`、`search_conversations` 等精确工具作为兜底 | Capability RAG 后置到 PRD-LLM-9 后续阶段；群聊 scope 规则在 Phase 4 落地 |
| Phase 4：全量主动召回与 History 生命周期 | ✅ 已完成 | 每条用户消息统一执行 BM25；owner、group、member 共用 `UnifiedRetriever` 与 `MemoryAdapter`，群聊通过 scope、ACL 和两个记忆开关隔离；自动结果放在当前用户消息后的动态尾部，并保存为 canonical `knowledge-context`；按正文 hash 去重，LoopScope 记录模式、scope digest、命中数和注入状态 | 无；Embedding 仍只作为显式/限定条件召回能力，跨来源 RAG 后置 |
| Phase 5：跨来源混合召回 | ✅ 首个跨来源闭环完成 | Project 和 Knowledge 已注册为 Knowledge 来源；owner scope、稳定切片、BM25 候选、来源优先级、正文 hash 去重、父文档预算、合并引用和 3000 字符总预算统一由 `UnifiedRecallService` 收口；`search_memory(source=knowledge)` 已可显式召回用户知识；未引入独立 Ranking/Reranker | 文件、画布、对话等来源和生产规模索引继续后置到 `PRD-RAG-5`；跨来源标注集与质量评估后置 |
| Phase 6：灰度与质量评估 | ✅ 已完成（RAG-4） | `knowledge_index_entries`、owner 级持久化索引、统一 `confidence` 过滤、去重、多样性和质量诊断已完成；质量复测覆盖 BM25/向量/hybrid 与无 embedding 回退。Global Search 继续保留 ILIKE 紧急开关，Rust 制品发布灰度由 RAG-3 Phase 5 管理 | 文件正文抽取、更新事件自动重建和生产规模切换仍按来源独立推进 |

实施顺序：先按 `PRD-MEM-1` 完成 Memory 单来源闭环，再完成 Phase 4 的全量主动召回，
随后扩展文件、日记、画布和对话等来源，最后进入跨来源灰度评估。Memory PRD
是本 PRD 的落地子方案，不是另一套 RAG 基础设施；公共契约
（IndexDocument、scope、version、切片、预算、回退和诊断）以本文件为唯一来源。

补充说明：已完成离线虚拟数据压测，结果见 [RAG 意图与召回压测报告](./report/RAG-意图与召回压测报告.md)。压测验证了 BM25、真实 Embedding 缓存和 LLM 意图判断的链路，但不等同于生产 Knowledge RAG 已经接入。

### 0.1 当前实现盘点

| 当前能力 | 现状 | 与本 PRD 的关系 |
|---|---|---|
| `global_search` | 基于业务表字段的精确/模糊对象搜索；便签可搜短正文，其余多数类型不搜文件正文 | 继续作为精确定位工具，不是统一 RAG |
| `search_conversations` / `read_conversation` | 按用户隔离搜索历史 session，并读取完整消息 | 继续作为历史会话检索和读取工具，不是统一索引 |
| `agent.memory.embedding` | 独立配置 embedding、模型 tag、向量生成、cosine 和失败退回词法；当前主要服务 memory/pattern | 可复用的向量基础设施，不代表已有跨来源索引 |
| `agent.capabilities` | `CapabilityIndex`、`RegistryCapabilitySelector`、`CapabilityToolContext` 已提供注册快照、权限交集和候选接口 | 是 PRD-LLM-9 的能力注册基础；当前 selector 没有 BM25/Embedding 召回，默认仍保留授权工具全集 |
| LoopScope RAG span | 已接入 | 每次召回记录 `namespace/source_type/mode/candidate_count/hit_count/elapsed_ms/fallback_reason/index_version` 和候选/命中 token impact；不记录 query、正文、owner 或完整结果 |
| `bench_rag_virtual.py` | 离线虚拟文档 BM25、Embedding 和意图判断压测 | 评估工具，不是生产索引或召回服务 |
| Knowledge RAG | Memory 与 Project 已具备 `SourceAdapter`、统一 Retriever、BM25 候选、跨来源去重/引用/预算和主动 history 注入；数据库统一索引首版已覆盖八类来源，保留按来源重建能力 | 文件正文抽取、更新事件自动重建、Global Search 切换和生产规模检索优化仍在 Phase 6 |

当前边界：不能因为已有 `CapabilityIndex` 或 memory 向量缓存，就把 Capability RAG 或 Knowledge RAG 标记为完成。Capability Registry 与 Knowledge RAG 保持独立 namespace；前者负责能力元数据和固定 Adapter Tool / canonical Schema 注入，后者负责用户知识片段召回。Capability RAG 只有在 `PRD-LLM-9` Phase 5 完成后，才进入本 PRD 的后续阶段联动。

评分边界：所有来源统一经过 RAG-4 的来源内归一化、RRF、`confidence` 过滤、去重和预算裁剪；调用方不得再按 BM25 原始分或 `normalized_score` 自行设阈值。

## 1. 背景与目标

当前系统的搜索按领域分散：

- `global_search` 适合定位项目、文件、文件夹、日程和便签等对象；
- `search_conversations` 适合查找历史 session；
- `PRD-MEM-1` 规划了记忆专用召回；
- 文件、项目、日记和画布的内容摘要、分块和权限边界尚未统一。

当用户提出“关于这个项目之前的讨论、文件和日记里有什么”时，Agent 需要跨多个工具检索，再分别读取原始对象，调用链长且容易遗漏。

未来建设统一 RAG 层，使不同内容源先转换成统一的可检索文档，再由一个召回器返回可直接使用的摘要和相关片段。

目标不是替换所有业务搜索，而是增加跨来源的语义知识召回能力：

```text
项目 / 日记 / 画布 / 文件 / 对话 / 记忆
                    ↓
          摘要、分块、权限和版本统一
                    ↓
             BM25 / embedding 索引
                    ↓
            Unified RAG Retriever
                    ↓
        摘要 + 片段 + 来源 + 对象引用
```

## 2. 范围与非目标

### 2.1 目标范围

- 统一接入项目、日记、画布、文件、历史对话和长期记忆。
- 无 embedding 配置时使用 BM25；启用 embedding 后使用 BM25 + cosine 混合召回。
- BM25 是首版默认召回方式；Embedding 是语义补充和低命中兜底，不要求所有查询都调用。
- 召回结果直接包含摘要或相关片段，通常不需要再调用读取工具。
- 支持每条用户消息的低成本自动召回：默认 BM25；只有在词法命中不足且满足条件时才升级到 Embedding。
- 自动召回结果进入连续 conversation history，并按稳定 hash/version 复用；不写入 session snapshot。
- 所有结果先经过 owner、project、group、platform-user 等 scope 权限过滤。
- 支持结果去重、来源引用、版本追踪和删除后索引清理。

### 2.2 非目标

- 不立即替换 `global_search` 的精确对象搜索。
- 不立即替换 `search_conversations` 的完整 session 读取能力。
- 不在当前阶段改造所有数据源或引入向量数据库。
- 不允许 RAG 绕过现有 owner/member/group 权限边界。
- 不把原始文件二进制直接塞入 LLM 上下文；文件必须先经过安全抽取和摘要。
- 不在本 PRD 之外重复实现工具候选筛选；Tool/Skill 注册协议和 Schema 注入由 `PRD-LLM-9` 负责。

## 3. 核心概念

### 3.1 统一文档

每个可召回单元统一为：

```json
{
  "id": "stable-source-document-id",
  "source_type": "project|journal|canvas|file|conversation|memory",
  "source_id": "业务对象 ID",
  "scope_type": "owner|group|member",
  "scope": {
    "owner_user_id": "...",
    "project_id": "...",
    "platform": "...",
    "bot_id": "...",
    "group_id": "...",
    "platform_user_id": "..."
  },
  "title": "可展示标题",
  "summary": "短摘要",
  "content": "可检索文本片段",
  "version": "内容版本或 hash",
  "updated_at": "UTC 时间"
}
```

`content` 是检索和上下文注入的文本，不代表原始对象全文。原始对象仍由各业务模块负责保存。

Scope 规范：

| scope | 含义 | 可见范围 |
|---|---|---|
| `owner` | Web/私聊中的 owner 私人知识 | 当前 owner；不得进入群聊 |
| `group` | 当前平台、Bot 和群组的共享记忆/知识 | 当前群会话 |
| `member` | 当前平台、Bot、群组和发言人的群内成员记忆 | 当前发言人对应的当前群会话 |

`member` scope 默认不跨群共享。查询必须先完成 scope/ownership 过滤，再执行 BM25 或
Embedding；不能先算出相关性再补权限过滤。

### 3.2 SourceAdapter

每个内容源提供独立 adapter：

| Adapter | 负责 | 不负责 |
|---|---|---|
| ProjectAdapter | 项目摘要、阶段、重要字段和更新时间 | 权限绕过、跨项目读取 |
| JournalAdapter | 日记摘要和按日期分块 | 修改日记正文 |
| CanvasAdapter | 画布节点/文档摘要和层级路径 | 重新解释画布结构 |
| FileAdapter | 文件名、类型、抽取文本和摘要 | 绕过文件归属、直接暴露二进制 |
| ConversationAdapter | session 摘要和消息片段 | 替代完整 session 读取 |
| MemoryAdapter | profile、pattern、daily、memory 片段 | 改写记忆内容 |

### 3.3 Capability RAG 文档

工具候选召回属于 RAG 的一个独立 namespace，不与项目、文件、对话和记忆的 Knowledge RAG 文档混库：

```json
{
  "id": "capability:tool:image_search",
  "source_type": "capability_tool",
  "capability_kind": "tool",
  "source_id": "image_search",
  "title": "image_search",
  "summary": "按文字或图片搜索相关图片。",
  "content": "图片搜索 以图搜图 相似图 找图",
  "category": "search",
  "platforms": ["web", "qq", "wechat"],
  "related_skills": ["image-analysis"],
  "updated_at": "UTC 时间"
}
```

规则：

- Capability RAG 只召回工具候选，不返回 Skill 正文。当前已通过 `backend/scripts/diagnostics/capability_recommendation_probe.py` 进行离线验证，正式查询接口和运行时接入仍未打开。
- Skill 只提供短描述和关联 metadata；正文仍由 `use_skill` 或明确加载规则按需读取。
- 工具的完整 JSON Schema 不进入 RAG 文档，也不由 RAG 返回；候选命中后由 `PRD-LLM-9` 从 ToolRegistry 取 Schema。
- Capability RAG 与 Knowledge RAG 共用分词、BM25、Embedding、缓存和诊断基础设施，但使用独立 namespace、索引和结果类型。
- Runtime 必须先生成 admin、用户、平台、工作区和会话 scope 的授权视图；这些是硬安全边界，不由 RAG 复制或替代。
- RAG 返回的推荐只影响工具的优先顺序和提示，不改变授权工具全集，不能直接执行工具或绕过 dispatch、确认门和 ownership 校验。

与 `PRD-LLM-9` Phase 5 的边界：

- Capability RAG 只返回工具名、短描述、类别、相关性分数和推荐理由，不返回完整 Provider Schema。
- 固定 `call_tool` 是 Provider 侧唯一的业务工具入口；Capability RAG 不得通过修改 Provider `tools` 集合来注入推荐结果。
- 命中的工具 Schema 由 Capability Registry 转换为 canonical `tool-schema` history event，随后由 `call_tool` 使用；Schema 的版本和 digest 由注册表提供。
- `use_skill` 自动注入关联工具时，同样追加 canonical `skill-schema` / `tool-schema` event，不把 Capability RAG 结果写入 Knowledge RAG 文档或 session snapshot。
- Capability RAG 失败、为空或延迟超限时，不影响固定 Adapter Tool、授权判断和已有 canonical history。

### 3.4 切片协议

切片采用“语义优先、长度兜底”，不按固定字符数机械截断：

```text
原始对象
  ↓
摘要与结构识别
  ↓
按标题、段落、日期或业务单元切片
  ↓
超出长度时按句子/段落继续切分
  ↓
保留少量 overlap
```

首版默认参数：

- 目标长度：300～600 tokens；
- 硬上限：800 tokens；
- overlap：60～100 tokens；
- 中文额外限制约 2400～3200 字，防止 tokenizer 差异导致超限。

来源专用规则：

| 来源 | 切片边界 |
|---|---|
| 项目 | 项目概要、阶段、任务、讨论和备注；小项目可保持一个 chunk |
| 文件 | Markdown 标题、段落、列表；不得拆开代码块、表格和 URL |
| 对话 | 按完整对话轮次切分；`tool_call + tool_result` 必须是一个原子单元 |
| Memory | 按 `profile/pattern/summary/daily/memory/lens` section 切分，过长时再按日期/段落切分 |
| 画布 | 按节点或局部子树切分，并保留分组路径和邻接关系 |
| 日历 | 默认一条事件一个 chunk，必要时按月份或项目聚合 |

每个 chunk 必须生成稳定标识：

```text
chunk_id = document_id + version + position
```

召回结果不能只返回孤立文本，还要带父文档标题、摘要、来源引用、更新时间、版本和 chunk 位置。召回后的确定性处理只包括：按 chunk 去重、同一父文档最多保留 2～3 个 chunk、相邻 chunk 合并、按总字符预算截断；首版不增加额外 Ranking 层。

### 3.5 RAG 注入位置与生命周期

RAG 结果属于**当前用户消息的上下文补充**，必须跟随当前消息进入连续 conversation history；不写入静态 session snapshot。静态 snapshot 只负责冻结 system、projects、calendar、files、memory 等低频上下文，不能因为一次 RAG 召回而刷新。

Phase 4 的目标生命周期是：

```text
当前用户消息
  ↓
自动 BM25 召回
  ↓
命中充分 → 直接形成 knowledge-context
  ↓
命中为空/质量不足 → 按规则判断是否启用 Embedding
  ↓
形成当前消息对应的 canonical knowledge-context history
  ↓
回复完成后保存精确渲染结果，下一 Run 原样复用
```

这里的“保存”指 conversation history 的上下文事件，不是把结果并入 session snapshot。RAG
结果与触发它的用户消息绑定，保存 `content_hash`、`chunk_id`、`document_version`、
`index_version` 和生成时间等内部元数据；Provider 边界仍渲染为普通兼容消息，不增加
OpenAI/Anthropic 不认识的自定义 message 字段。

当前请求的组装顺序固定为：

```text
已有有效 history
  ↓
当前用户原始消息
  ↓
群共享 RAG context（无命中则没有）
  ↓
当前发言人的群友 RAG context（无命中则没有）
  ↓
当前消息时间 reminder / 动态尾部：stance / summary / current time
```

Owner 私聊和群聊共用同一套 `UnifiedRetriever`、BM25 默认策略、去重和字符预算；差异只
存在于候选池与权限过滤。Owner 私聊可以检索 owner 允许的 Memory/Knowledge scope，群聊
只能检索当前群共享 scope 和当前发言人的群内 member scope，不能检索 owner 私人记忆或
其他群友的 member scope。

群聊的动态尾部使用 provider 兼容的普通 history 消息承载，并保持区块顺序稳定：

```text
当前用户原始消息

[group-rag]
群共享记忆/知识片段
[/group-rag]

[group-member-rag]
当前发言人的群内记忆/偏好
[/group-member-rag]

[system-reminder]
当前时间：08-24 04:10
[/system-reminder]
```

群共享 RAG 和群友 RAG 都只在对应开关开启且存在有效命中时出现；无命中时不生成空
区块。群聊短消息优先要求明确 BM25 命中，避免把泛化词带来的噪声注入全群对话。
群友记忆默认绑定当前群，不跨群共享；即使内容只用于帮助当前发言人理解，最终回复
仍会被群内其他成员看到，因此不得把私聊中的私人 owner Memory 直接带入群聊。

被动 RAG context 使用 provider 兼容的普通 history 消息承载，不增加 OpenAI/Anthropic 不认识的自定义 message 字段。显式 `search_memory` 则沿用真实工具调用产生的 canonical `tool-call` / `tool-result` history。内部的 `chunk_id`、`version`、`content_hash` 只作为持久化和组装元数据，不能发送给模型，也不能进入可见正文。

RAG 注入必须遵守整体有效上下文去重，而不是只检查静态 snapshot：

1. 先检查当前有效 history 中已有的 `chunk_id + version`；
2. 再检查规范化正文的 `content_hash`；
3. 相同内容来自多个来源时合并 citations，不重复占用上下文；
4. 只把当前消息尚未覆盖的 RAG chunk 追加到 history；
5. 版本变化、权限 scope 变化或无法确认旧摘要是否覆盖时，允许重新注入。

Memory 试点还必须遵守 snapshot 的注入边界：`profile`、`pattern`、`memory`、`daily`
先经过 snapshot 的实际注入文本过滤，再进入 `search_memory` 候选池。已经落入当前
snapshot 的内容不应再次作为 RAG 结果返回；只有超出当前注入预算或未被 snapshot
覆盖的 chunk 才能召回。不能简单按固定字符前缀推断边界，因为 pattern 和长期记忆
可能会按当前消息做相关性选择。snapshot 命中/重建时登记实际渲染文本，RAG 在请求级
上下文中按规范化正文判断已覆盖 chunk；登记不可用时不阻塞正常召回。

RAG 去重不是永久黑名单。Compaction 把旧 history 收进 summary 后，summary/baseline 的内部 metadata 可以记录已覆盖的 RAG hash；如果无法确认某个 chunk 已被 summary 保留，必须允许再次注入，不能为了去重造成知识丢失。

自动 RAG history 位于当前 user message 之后、时间 reminder 之前，因此不会改变已经稳定
缓存的历史前缀；同一 Run 的后续 tool round 继续复用它。当前轮新增的 RAG 区域本身属于
新鲜输入，回复完成后会成为下一 Run 的稳定 history 前缀。显式工具结果按普通 canonical
tool history 持久化；自动 RAG 则保存为 canonical knowledge-context history，不伪装成
模型已经执行过的工具。

RAG history 的去重范围必须覆盖 snapshot 和完整有效 conversation history，而不是只对当前一次召回去重：

- 相同 `content_hash` 已存在时不再次保存；
- 相同 `chunk_id + document_version` 已存在时不再次保存；
- 多个来源命中相同正文时合并引用，不复制正文；
- 索引版本或内容版本变化时允许产生新的 context 事件；
- 压缩后只有在 summary/baseline 无法证明仍覆盖旧 chunk 时，才允许重新召回。

RAG 召回失败、为空或超时不应阻塞当前消息，也不得刷新静态 snapshot。TTL 或 context
revision 到期只负责重建 snapshot；不会回写或重排历史中的旧 RAG 结果。

## 4. 功能需求

### FR-RAG-1：异步摘要与分块（Memory 试点已实现）

Memory 源内容变更后由事件触发异步任务生成或更新检索分块；其他来源待后续接入。

- 内容 hash 未变化时不重复生成；
- 切片必须保持稳定边界；同一 `document_id + version` 不得因为任务重试产生随机 chunk 顺序；
- 删除、移动、权限变化必须产生索引失效事件；
- 摘要失败不能删除旧索引，保留上一个可用版本；
- 任务失败可重试，但不能无限重试。

### FR-RAG-2：无 embedding 的 BM25 召回（Memory 试点已实现）

- 所有 source adapter 生成的文档进入统一 BM25 候选池；
- 中文使用“通用分词器 + Gugu 动态领域词库”，并保留少量字符二元组作为新词/错别字兜底；
- 英文按空格和标点切分，统一小写；代码标识符、文件名和项目名按完整 token 保留；
- 中英文混合内容分别切分后合并索引词；
- 过滤低信息停用词，但不能删除项目名、文件名、Knowledge 标题等领域词；
- 查询先按 scope 过滤，再计算相关性；
- 返回 top-k 摘要和片段，并保留来源引用。

动态领域词库来源包括：项目名、笔记标题、文件名、Knowledge 标题、用户维护的术语和同义词。词库更新后只需重建受影响文档的索引，不要求修改原始内容。

压测脚本中的字符二元组和简化 BM25 仅用于离线验证，不能直接视为生产分词实现。

### FR-RAG-3：BM25 + embedding 混合召回（Memory 试点基础能力已实现）

- 自动 RAG 默认只执行 BM25，不为每条消息固定生成 query embedding；
- BM25 命中为空、最高分低于阈值，或轻量规则判断为明显的历史/偏好语义但词法覆盖不足时，才允许升级到 Embedding；
- 条件 Embedding 只使用已有缓存向量；没有文档向量缓存时直接退回 BM25，不在用户请求热路径生成全部文档向量；
- 条件召回可以对索引文档执行向量候选检索，也可以在已有 BM25 候选上混合排序，具体由索引规模和缓存能力决定；不能把“只重排 BM25 候选”误称为完整语义兜底；
- 首版不引入独立 Ranking 或 LLM Reranker；结果顺序只使用 BM25/Embedding 本身的可解释分数、来源优先级和稳定时间顺序；
- embedding 未配置、缓存缺失、服务失败或超过延迟预算时自动退回 BM25；
- 查询默认直接使用用户原句，不先让 LLM 改写 Embedding 查询；
- 向量是可重建缓存，模型切换后按 model tag 失效并重建；
- 缓存至少记录模型标识、维度、文本指纹和向量，不能把向量当作主数据。

自动路径与显式工具路径分开：

| 路径 | 默认策略 | Embedding 条件 |
|---|---|---|
| 自动 RAG | BM25 | 无命中、低质量命中或历史/偏好语义信号；且存在可用缓存向量 |
| `search_memory` | `auto` | 按工具参数和同一条件策略决定；允许显式指定 `bm25` / `embedding` |
| 后续跨来源 RAG | BM25 | 由来源规模、索引能力和 Phase 6 评估结果决定 |

正则或轻量规则只负责两类信号：识别“之前、上次、记得”等历史/偏好语义，作为
Embedding 升级信号；识别命令、当前时间、天气、新闻、比赛和已有专用工具可直接处理的
请求，作为 Embedding 排除信号。它不再作为 BM25 自动召回的总开关，也不能替代真正的
相关性阈值。

### FR-RAG-4：统一召回服务（Memory 单来源已实现；自动 History 生命周期待 Phase 4）

RAG-1 只提供内部 Retriever/Service、索引和结果契约，不新增面向 Agent 的
Agent 工具。当前面向 Agent 的记忆入口由 `PRD-MEM-1` 的 `search_memory`
承载，并通过 `strategy=auto|bm25|embedding|ilike` 选择检索策略；未来其他来源
可以复用同一服务，再由对应领域工具决定是否暴露。

内部服务结果至少包含来源类型、对象标题、摘要或片段、更新时间、对象引用和
`has_more`，同时强制执行 scope、数量和总字符预算。

统一召回服务还必须返回稳定的 `chunk_id`、`document_version` 和 `content_hash`，供 history 注入层做确定性去重；相关性分数只用于本次结果排序，不作为事实置信度，也不写入缓存身份。

#### 召回数量与注入预算

首版采用“候选量较宽、最终注入量较窄”的两级限制：

```text
每个来源候选召回：最多 20 条
跨来源合并候选：最多 30 条
同一父文档保留：最多 2～3 个 chunk
当前消息最终注入：默认 5 个 chunk，硬上限 8 个 chunk
```

候选结果经过 scope 过滤、精确去重、父文档去重和相邻 chunk 合并后，才进入最终注入预算。最终数量不足时可以少于 5 个；达到 8 个后不再继续追加，剩余结果通过 `has_more` 和引用信息保留，不为了凑满数量突破 token/字符预算。20 条是每个来源的候选上限，不代表 20 条都会进入模型上下文。

### FR-RAG-5：权限和隔离（部分具备；统一索引前置过滤未实现）

- owner Web/私聊可检索 owner 允许的 Memory/Knowledge scope；不经过群 scope 时不注入群共享或群友记忆；
- 群聊只能检索当前群共享 scope，以及当前发言人的当前群 member scope；不检索 owner 私人 Memory，也不检索其他群友的 member scope；
- 群共享记忆由 `group_memory_enabled` 控制，群友记忆由 `member_memory_enabled` 控制；任一开关关闭时对应候选池为空；
- 群友记忆默认绑定平台、Bot、群组和当前发言人，不跨群共享；当前发言人变化时必须重新计算 member scope；
- 群聊短消息没有明确 BM25 命中时不强行注入；群共享结果排在群友结果之前，最终共同受 3000 字符注入预算约束；
- 群聊和私聊均不为召回结果临时调用 LLM 摘要，优先使用索引已有摘要或短片段；
- 文件、项目、画布和日记必须复用各自的 ownership 校验；
- 不同 owner、Bot、平台、项目、群组和 member 的文档不能串库；scope 过滤必须发生在相关性计算之前。

群聊的 member scope 只能保存和召回低敏感的群内偏好、称呼和对话事实。由于召回内容
最终可能影响全群可见回复，私聊中的私人记忆不能通过“当前发言人是 owner”这一条件
绕过群聊隔离。

### FR-RAG-6：Capability RAG 工具软推荐（注册基础部分具备，后置于 PRD-LLM-9 Phase 6）

Capability RAG 为 `PRD-LLM-9` 提供本轮工具推荐，不负责工具执行，也不负责缩小工具候选集合：

```text
用户消息 / 当前状态
        ↓
Runtime 生成授权工具视图
        ↓
Capability RAG：BM25，未来可选 embedding 混合
        ↓
推荐工具顺序、分数和理由
        ↓
PRD-LLM-9 selector adapter
        ↓
完整授权工具目录 + 推荐优先级
```

当前实现：`backend/agent/capabilities/` 已提供 CapabilityIndex、快照、selector 和动态工具上下文；但 `RegistryCapabilitySelector` 明确不实现 BM25/Embedding，未提供候选时会保留授权工具全集。因此本节的 RAG 候选召回要求仍未完成。

要求：

- 首版默认使用 BM25；候选质量和性能测试复用本 PRD 的 RAG 压测框架。
- 推荐结果可以有展示数量上限，但该上限不能用于裁剪授权工具目录或 Schema 声明能力。
- 每轮重新查询，不自动继承上一轮推荐顺序。
- 返回工具名、短描述、类别、相关性分数和召回原因；不返回完整 Schema、不返回 Skill 正文。
- 无推荐时返回结构化 `capability_recall_empty`，完整短描述目录仍然保留，Agent 仍可声明任意授权工具。
- Capability RAG 的推荐只能生成推荐顺序/提示，不能生成硬性的 `selected_tool_names`，不能绕过 `dispatch()`、确认门、权限和 ownership 校验。

## 5. 技术方案

### 5.1 组件边界

```text
Knowledge SourceAdapter → Knowledge IndexDocument → IndexPipeline
Capability Registry      → Capability IndexDocument ↗
                                      ↓
                    Knowledge / Capability namespace
                       BM25 / Embedding Index
                                      ↓
                        RAG Retriever / Capability Retriever
                              ↓                 ↓
                    domain tool consumers    tool candidates
```

其中 `tool candidates` 只供 `PRD-LLM-9` Phase 6 的 selector 生成推荐提示；它不会生成 Provider 原生业务工具 Schema，也不会替换 Phase 5 的固定 `call_tool` Adapter Tool。

`global_search` 和 `search_conversations` 可复用底层候选排序或分词组件，但继续保留各自的精确查询和完整读取 API。

### 5.2 查询编排策略

自动 RAG 按以下策略执行：

```text
每条用户消息
  → 先执行 BM25
  → 命中充分：直接注入 knowledge-context
  → 无命中/低分：检查轻量规则和 Embedding 缓存
  → 满足条件：执行 Embedding 候选召回
  → 不满足/失败/超时：保留 BM25 结果或不注入
```

显式 `search_memory` 可以直接请求指定策略，但仍然必须经过 scope、权限、去重和预算
限制。后续跨来源服务复用同一策略，不在 Web、IM 或各领域工具中复制检索分支。

自动 RAG 不因为“每条消息都执行 BM25”就把空结果写入 history；只有至少一个结果通过
相关性阈值和内容预算过滤后，才生成 knowledge-context history。没有合格结果时只记录
脱敏的 `hit_count=0` 诊断。

条件混合召回按以下路径执行：

BM25 命中不足且有缓存向量
  → Embedding 全索引候选或 BM25 候选混合

范围不明确、需要判断 sources/scope 的查询
  → 可选 LLM 意图判断
  → 不默认改写原始查询
  → BM25 / Embedding 召回
```

LLM 意图判断只负责结构化 `sources`、`scope`、`need_current` 等路由信息。它生成的关键词不能覆盖用户原句；即使关键词为空，也必须保留原始查询继续召回。首版不引入 LLM reranker。

本阶段明确不做独立 Ranking/Reranker。此前测试显示额外 Ranking 会增加明显延迟，且没有带来足够的前 20 条质量收益。后续只有在新的标注集证明收益显著高于延迟成本时，才单独立项评估，不作为本 PRD 的默认能力。

### 5.3 上下文注入结构

RAG 结果不能写入 session snapshot、静态 system 或每轮固定的 dynamic tail。它属于当前用户问题的检索结果，使用独立的 canonical `knowledge-context` history 边界：

```text
固定 system / session snapshot
        ↓
固定 Adapter Tool：call_tool / use_skill / ask_user
        ↓
canonical history 与已有 tool round
        ↓
历史 RAG context（已持久化、按 hash/version 去重）
        ↓
当前 user message
        ↓
自动 BM25 / 条件 Embedding
        ↓
当前消息对应的 knowledge-context history
        ↓
回复完成后写入 conversation history
        ↓
Provider adapter 重建当前模型所需的合法消息
```

约束：

- 自动召回结果进入当前消息对应的 canonical `knowledge-context` history，不进入 snapshot；
- 显式 `search_memory` 结果进入真实的 canonical `tool-result`，不能把自动召回伪装成工具调用；
- 后续 round 直接继承已有 RAG history，不重复拼装到 system reminder；
- 新 Run 按普通 conversation history 读取已经持久化的 RAG context，不建立独立的 RAG snapshot；
- 结果返回摘要和有限片段，不返回原始文件二进制或全量正文；
- 工具 Schema 以 canonical `tool-schema` history event 保存；Provider 只注册固定 Adapter Tool，Capability RAG 的候选元数据不混入 Knowledge RAG 结果；
- 自动召回、显式 `search_memory` 和未来跨来源入口必须复用同一个内部召回结果结构，不能在业务入口复制一套 system 注入逻辑；
- LoopScope 只记录 namespace、source_type、候选数、命中数、耗时、版本和脱敏 digest，不记录完整敏感正文。

因此，RAG 不应该成为新的 `[system-reminder]` 来源。`[system-reminder]` 继续只承载 session snapshot 和确有必要的动态运行状态；知识检索结果使用独立的 canonical history 事件，保证消息边界、缓存前缀和 compaction 语义稳定。RAG 不得重新引入第二套 Prompt 拼装策略。

### 5.4 向量缓存与规模策略

- 文档向量由异步索引任务生成并缓存，查询时只生成一次 query vector；
- 小规模数据可使用本地 cosine 排序；
- 数据量扩大后再评估 pgvector、HNSW、FAISS 等索引，不提前引入向量数据库；
- Embedding 接口失败、限流或配置不兼容时，整条链路退回 BM25，不阻塞主 Agent。

### 5.5 索引更新

优先使用现有异步任务/事件基础设施：

- 数据变更发出 `rag.index.invalidate` 或 `rag.index.upsert` 事件；
- worker 负责摘要、分块和向量更新；
- 索引更新幂等，按 `source_id + version` 去重；
- 删除和权限变更必须优先使旧文档不可召回，再异步清理缓存。

首版不要求独立向量数据库；当前已使用业务数据库保存可重建的 `knowledge_index_entries`，数据规模和查询延迟达到阈值后再评估 PostgreSQL 原生检索、pgvector/HNSW 或专用索引服务。

## 6. 前置条件

通用 RAG 开始实现前，必须先完成：

1. 各内容源的摘要/正文读取边界稳定；
2. 统一 scope 和 ownership 契约；
3. 内容变更事件或可靠的增量扫描机制；
4. 文件文本抽取和安全校验；
5. 群组/member 记忆隔离（见 `PRD-IM-3`）；
6. 至少准备一批跨来源召回标注样本，用于比较 BM25 和混合召回质量。
7. 建立通用分词器、动态领域词库、停用词和同义词的配置边界。
8. 先完成 `PRD-LLM-9` Phase 5 的固定 `call_tool` 与 canonical history；Capability RAG 不得依赖动态 Provider Schema 注入。

## 7. 验证与上线

### 7.0 离线压测工具

压测脚本位于：

```text
backend/scripts/bench_rag_virtual.py
```

脚本从 `backend/` 目录执行，使用当前后端配置中的 AI 和 Embedding 模型。虚拟文档默认使用随机向量，仅适合测试排序耗时；要测试真实召回质量，必须先为全部测试文档生成真实向量。

在 devserver 上生成 30 条真实向量并保存缓存：

```bash
cd /home/coffeiz/文档/Workspace/Gugu-web/backend
PYTHONPATH=. .venv/bin/python scripts/bench_rag_virtual.py \
  --docs 30 \
  --embed-docs 30 \
  --top-k 20 \
  --relevant-every 10 \
  --relevant-per-window 3
```

默认缓存位置：

```text
backend/scripts/.bench_rag_embeddings.json
```

后续测试直接复用缓存，不重复生成文档向量：

```bash
PYTHONPATH=. .venv/bin/python scripts/bench_rag_virtual.py \
  --docs 30 \
  --embed-docs 0 \
  --top-k 20 \
  --relevant-every 10 \
  --relevant-per-window 3
```

常用参数：

| 参数 | 作用 |
|---|---|
| `--docs` | 虚拟文档数量 |
| `--embed-docs` | 本次最多生成多少条真实文档向量 |
| `--top-k` | 每种召回返回的候选数量 |
| `--cache` | 自定义 JSON 向量缓存路径 |
| `--no-cache` | 禁用缓存读写 |
| `--embed-delay` | 文档向量请求之间的等待时间，避免触发限流 |
| `--rerank-models` | 历史对比参数，仅用于复现旧的 Ranking 延迟测试，不纳入首版验收 |
| `--query` | 自定义测试查询 |

缓存按 Embedding 模型标识和向量维度校验，模型切换后会自动失效。缓存文件已加入 Git 忽略规则，不应提交到仓库。

召回延迟测试示例：

```bash
PYTHONPATH=. .venv/bin/python scripts/bench_rag_virtual.py \
  --docs 1000 \
  --embed-docs 0 \
  --top-k 100
```

当前压测中 BM25 排序约 12ms，上下文注入低于 1ms；额外 Ranking/LLM 重排会增加明显延迟，且没有稳定改善前 20 条质量，因此首版不引入。

### Phase 0：离线评估

- 为项目、日记、画布、文件、对话、记忆准备查询—相关文档样本；
- 对比 BM25、embedding 和混合召回的 Recall@K、命中率和延迟；
- 验证不同 scope 下不会出现越权结果。

### Phase 1：Memory 单一来源试点

按 `PRD-MEM-1` 实现 `pattern`、`daily`、`memory` 的摘要/分块、BM25 召回、可选
Embedding 混合、版本失效和 `search_memory` 工具。先验证记忆专用 scope 和预算，
再扩展其他来源；不在本阶段实现跨来源 Agent 工具。

### Phase 2：多来源灰度

Memory 试点通过后，才对明确要求跨来源检索的请求接入对应领域工具；
`search_memory` 继续作为记忆专用入口保留。记录命中数量、召回耗时、回退原因和用户纠正，
不记录原始敏感正文。

### Phase 3：正式接入

稳定后再让 Agent 在“查以前内容/相关资料”类请求中主动调用，保留现有专用工具作为精确查询和完整读取兜底。

### Phase 4：全量主动召回与 History 生命周期验收

本节只定义第 0 节 Phase 4 的验收项，不维护第二套实施状态：

- 每条用户消息先执行 BM25；普通寒暄、当前事实和专用业务操作即使没有命中，也不能因此触发高成本 Embedding；
- 轻量正则/规则只作为历史/偏好语义的 Embedding 升级信号，以及命令、天气、新闻、比赛等请求的排除信号；不能继续作为 BM25 总开关；
- BM25 无命中或低于相关性阈值时，且索引存在可用缓存向量，才允许执行 Embedding；失败、超时或无缓存时稳定退回 BM25；
- 自动召回结果使用 canonical `knowledge-context` history 保存，显式 `search_memory` 继续使用 canonical `tool-result`；两者不得混淆；
- 跨 snapshot、当前有效 history、同一 Run 后续 round 和下一 Run 均验证 `content_hash + chunk_id + document_version` 去重；
- 验证 TTL / context revision 只重建 snapshot，不重写或重排已保存的旧 RAG history；compaction 无法证明摘要覆盖时允许重新召回；
- Owner 私聊与群聊必须共用同一 `UnifiedRetriever` 和 BM25 默认策略；群聊只通过候选 scope、ACL 和开关改变检索范围，不新增第二套召回算法；
- 群聊自动召回只允许当前群 `group` scope 和当前发言人的当前群 `member` scope；禁止注入 owner 私人记忆或其他群友的 member scope；
- `group_memory_enabled` 控制群共享记忆，`member_memory_enabled` 控制群友记忆；群友记忆默认不跨群共享，当前发言人变化时重新计算 member scope；
- 群聊动态尾部顺序必须是“当前用户消息 → `[group-rag]` → `[group-member-rag]` → 当前时间 reminder”；无命中时不生成空区块，群共享结果排在群友结果之前；
- 群聊和私聊均使用 3000 字符总注入预算；群聊短消息没有明确 BM25 命中时不强行注入，避免泛化词污染全群上下文；
- LoopScope 至少能区分 `bm25`、`embedding`、`fallback`、`skipped`，展示候选数、命中数、耗时、索引版本和注入状态，不记录查询正文或记忆正文；
- LoopScope 额外记录 `scope_type`、脱敏 scope digest、开关状态和 group/member 命中数，不记录群正文、成员昵称、平台 ID 或原始查询；
- 补齐自动召回、owner/group/member ACL、低命中升级、去重、压缩后恢复、Embedding 失败回退和跨 Run 缓存前缀稳定性测试。

### Phase 5：跨来源混合召回（已完成）

- 新增 `ProjectAdapter` / `ProjectRetriever`，只从当前 owner 的未归档项目生成稳定摘要文档；群组和群友 scope 明确返回空集，项目文件正文不在本阶段进入 Knowledge RAG。
- 自动召回使用 `search_knowledge` 统一编排 Memory 与 Project；`search_memory` 继续是记忆专用显式工具，`global_search`、`search_conversations` 和项目领域工具继续保持精确定位职责。
- 跨来源候选先按固定来源优先级，再按来源内召回分数、更新时间和稳定 chunk id 排序；不引入不可解释的独立 Ranking/Reranker。
- `UnifiedRecallService` 按 `source_type` 统计来源上限，按正文 hash 合并重复结果并合并 citation，继续执行父文档上限、最终条数和 3000 字符总预算。
- 已补 Project owner/group 隔离、跨来源引用合并、来源上限和既有精确搜索职责边界测试。

## 7.1 实现清单说明

唯一状态来源为第 0 节。本节不再维护第二套 P0/P1/P2/P3/P4 进度表；`PRD-LLM-9` 负责维护 Capability Registry 的能力注册进度，本 PRD 只维护 Knowledge RAG 的数据源、索引、召回和灰度进度。

## 7.2 文件变更清单

以下清单按“首个单来源试点 + 可扩展到多来源”的最小实现盘点。文件是否已创建、后续新增哪些文件，以第 0 节对应阶段的 Todo 为准。

### 需要新建的 Knowledge RAG 核心文件

```text
backend/agent/rag/
├── __init__.py              # 对外导出召回服务和数据类型
├── models.py                # IndexDocument、Scope、RecallResult、IndexVersion
├── adapters/
│   ├── __init__.py
│   ├── base.py              # SourceAdapter 协议、摘要/分块/版本接口
│   ├── memory.py             # Memory 来源 adapter
│   └── projects.py           # Project 来源 adapter（Phase 5）
├── chunking.py               # 语义边界、atomic/expandable chunk 和稳定 chunk_id
├── scope.py                  # scope 规范化与查询前过滤，不替代 ownership 校验
├── lexical.py               # 生产 BM25、中文分词、领域词库和停用词边界
├── storage.py               # Memory 可重建索引存储适配
├── persistent_store.py      # 统一数据库索引 chunk 的替换、读取和 BM25 查询
├── index_builder.py         # 业务来源投影与 owner 级重建
├── index.py                  # upsert/invalidate、版本去重和索引生命周期
├── retriever.py             # scope-first 的 BM25/Embedding 混合召回
├── service.py               # 查询编排、候选限制、去重和引用组装
├── injection.py             # 作为当前消息 history 的 RAG 注入、整体上下文去重
├── diagnostics.py           # 只记录脱敏召回/索引生命周期指标，不记录正文
└── pipeline.py              # Memory 索引异步更新、按 owner 串行和有限重试
```

说明：`rag/` 是 Knowledge RAG namespace。Capability RAG 不在这里复制一套工具注册代码；它继续复用 `backend/agent/capabilities/` 的注册快照和 Schema 注入，未来只替换 selector 的候选来源。

### 需要新建的工具、任务和测试文件

```text
backend/agent/rag/service.py               # 统一内部召回服务和结果契约
backend/agent/rag/chunking.py              # 来源无关的切片边界和 chunk 身份
backend/agent/rag/injection.py             # 当前消息 history 注入与 content_hash 去重
backend/agent/rag/pipeline.py              # Memory 索引异步更新、upsert/invalidate 和有限重试
backend/tests/test_rag_models.py           # 文档、scope、版本和引用模型
backend/tests/test_rag_lexical.py          # 中文/英文/混合词法召回
backend/tests/test_rag_scope.py             # owner、项目、群组、平台隔离
backend/tests/test_rag_index.py             # 幂等更新、删除、旧版本失效、重试
backend/tests/test_rag_service.py           # 服务输出、预算、空结果和回退
backend/tests/test_rag_adapters.py          # 首个来源 adapter 的摘要/分块契约
backend/scripts/bench_rag_<pilot_source>.py # 真实试点数据的脱敏评估脚本（可选）
```

`backend/scripts/bench_rag_virtual.py` 继续作为离线虚拟压测工具，不改造成生产服务；新建真实评估脚本也不能写入用户正文、附件名或可识别身份。

### 预计需要修改的现有文件

| 文件 | 修改内容 | 阶段 |
|---|---|---|
| `backend/agent/tools/__init__.py` 或领域工具入口 | 由 `search_memory` 等领域工具接入统一服务，不修改 `global_search` 的精确搜索语义 | P1 |
| `backend/agent/events/types.py`、`backend/agent/events/bus.py` | 增加 `rag.index.upsert/invalidate` 事件或等价内部事件；SSE 通知与索引失效分开 | P0/P2 |
| `backend/app/core/ownership.py` | 只复用/补齐统一 scope 查询所需的 ownership helper，不把权限判断复制到 RAG | P0 |
| `backend/app/core/events.py` | 在业务 mutation 已有事件链上接入 snapshot/index invalidation 的独立分支 | P2 |
| `backend/app/models/__init__.py` | 仅当确认数据库持久化索引元数据时增加模型；不提前新增向量表 | P1/P2 |
| `backend/alembic/versions/<revision>_rag_index.py` | 仅在选择数据库索引元数据方案后新增迁移；迁移内容需与存储决策绑定 | P1/P2 |
| `backend/agent/memory/embedding.py` | 抽取稳定的 embedding/cache 接口供 RAG 复用；不改变现有 memory fallback 语义 | P2 |
| `backend/agent/capabilities/selector.py` | 未来接入 Capability RAG 候选时只增加 selector adapter；不把 Knowledge 文档混入能力索引 | P3 |
| `backend/agent/capabilities/injector.py` | 仅接收已过滤的工具候选，不负责知识召回、权限判断或工具执行 | P3 |
| `backend/app/api/v1/search.py`、`backend/app/services/search.py` | 如需复用词法基础设施，只抽公共组件；保留现有全局精确搜索 API | P2/P3 |
| `backend/agent/tools/global_search.py`、`backend/agent/tools/conversations.py` | 只补职责说明或共享结果类型；不改成 RAG 代理 | P3 |
| `backend/agent/context/builder.py` 或 Agent 编排入口 | 仅在确认自动召回策略后接入；首版显式工具不应默认污染每轮上下文 | P3/P4 |
| `backend/agent/context/message_assembly.py` 或独立 history assembler | 只接收已经过权限过滤和预算限制的 RAG history block；不实现召回和索引 | P2/P3 |
| `docs/product/PRD/PRD-MEM-1-记忆召回工具与混合检索.md` | 试点选 memory 时同步边界、复用 embedding 和迁移路径 | P0/P1 |
| `docs/product/PRD/PRD-LLM-9-工具与Skill注册制及按需注入.md` | Capability RAG 接入后补 selector adapter 和诊断契约 | P3 |
| `docs/product/PRD/report/RAG-意图与召回压测报告.md` | 增加真实试点的脱敏质量/延迟结果，不覆盖离线基线 | P3/P4 |

### 当前明确不应修改或新建的文件

- 不在 `backend/agent/tools/global_search.py` 里直接堆 BM25、Embedding 和跨来源编排。
- 不在 `backend/agent/memory/store.py` 里承载所有来源的统一索引；memory 仍是一个 adapter/来源。
- 不把 `backend/agent/capabilities/index.py` 改造成 Knowledge RAG 索引；Capability Registry 与知识索引保持独立。
- 不在 `backend/agent/core.py`、`runner.py` 或各 IM gateway 中复制召回逻辑。
- 在存储方案确认前，不新建 pgvector/向量数据库专用服务，也不提交用户数据索引文件。

## 8. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 各来源摘要质量不一致 | 混合结果排序不稳定 | 先做单来源试点，再统一摘要协议 |
| 权限过滤发生在召回之后 | 可能泄露越权结果 | 必须先过滤 scope，再进入索引查询 |
| 内容更新与索引更新延迟 | 召回旧内容 | 保存版本和更新时间，旧版本先失效 |
| 文件抽取失败 | 文件无法被召回 | 保留文件名/元数据结果，抽取任务可重试 |
| 过早引入通用抽象 | 代码复杂且收益不明 | 前置条件完成前不进入实现阶段 |

当前已确认的决策：

- ✅ 首版默认 BM25，足以覆盖大部分明确查询；
- ✅ 中文使用词库分词，英文按单词切分；
- ✅ 保留字符二元组作为新词和错别字兜底；
- ✅ Embedding 作为补充召回，不默认覆盖 BM25；
- ✅ 不默认使用 LLM 重写查询或重排结果；
- ✅ 向量是缓存，不是主数据；模型切换需要按版本重建。
- ✅ `global_search`、`search_conversations` 和专用读取工具继续保留，不因 RAG 上线而删除。
- ✅ Capability Registry 与 Knowledge RAG 分开维护，不把工具 Schema 或 Skill 正文放进知识索引。
- ✅ 先做单来源闭环，再扩展跨来源；不以离线虚拟压测代替生产质量结论。

待确认：

- ✅ 首个试点来源确定为 Memory，具体落地见 `PRD-MEM-1`。
- ✅ 首个试点通过显式 `search_memory` 工具调用，RAG 层本身不主动触发 Agent 工具。
- 🔲 选择具体中文分词依赖，并确定动态词库的更新触发方式。
- 🔲 `IndexDocument` 的首版存储是复用业务数据库表，还是先使用 worker 可重建的本地索引；建议先复用数据库元数据和可重建索引，避免过早引入新服务。
- 🔲 内容变更后的 freshness SLA：同步使旧文档不可见、异步生成新版本，还是允许短暂旧结果；建议前者。
- ✅ 首版不使用独立 Ranking/Reranker；后续如重新评估，必须单独验证收益与延迟成本。
- 🔲 Embedding 是否使用远程服务、是否允许本地模型，以及向量/文本的留存和 TTL。
- 🔲 索引规模、P95 延迟和并发达到什么阈值后评估 pgvector/HNSW/独立搜索服务。
- 🔲 群聊、跨平台私聊和项目成员共享内容的默认 scope，尤其是“当前群”之外的历史消息是否允许被召回。
