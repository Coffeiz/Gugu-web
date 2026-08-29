# 咕咕 RAG 架构与检索链路

> 状态：当前实现说明
> 最近更新：2026-08-25
> 适用范围：Knowledge RAG、自动知识召回、显式记忆搜索、Capability RAG 边界

本文以当前代码为准，描述咕咕的 RAG 数据结构、召回流程、过滤规则、检索算法、缓存和注入方式。规划中的 Capability RAG 不得被误认为已经接入 Knowledge RAG 的运行时链路。

## 1. 总体边界

咕咕当前有两个独立的 RAG namespace：

| Namespace | 作用 | 当前状态 |
|---|---|---|
| `knowledge` | 召回记忆、项目和用户明确保存的知识条目 | 已接入统一召回服务；Knowledge 显式搜索已启用，自动注入仍按来源灰度 |
| `capability` | 根据用户语境推荐工具 | 已完成离线推荐探针，尚未接入 Agent Loop |

两者不能混库：

- Knowledge RAG 返回知识片段、引用和来源信息。
- Capability RAG 只返回工具推荐，不返回 Skill 正文或完整 JSON Schema。
- 工具权限、Skill 加载、Provider Schema 和工具执行不由 RAG 决定。

## 2. 模块结构

```text
backend/agent/rag/
├── models.py             # Scope、IndexDocument、RecallCandidate 等稳定契约
├── adapters/             # Memory、Project 等来源适配器
├── index_builder.py      # 从业务数据构建统一 IndexDocument
├── persistent_store.py   # knowledge_index_entries 持久化索引读写
├── index_cache.py        # TypeScript 词法索引、snapshot 文档缓存与 TTL/容量管理
├── ts_sidecar.py         # TypeScript worker 异步客户端
├── tokenizer.py          # 业务侧查询规范化辅助；词法分词由 TypeScript worker 负责
├── retriever.py          # 来源无关 Retriever 调度协议
├── service.py            # UnifiedRecallService 统一召回、融合和预算
├── scoring.py            # 已删除；归一化、RRF、置信度和多样性评分由 TypeScript worker 负责
├── hybrid.py             # 词法结果与已有向量缓存的混合排序
├── scope.py              # owner/group/member scope 与硬权限过滤
├── injection.py          # 自动召回结果编码为 history 消息
└── diagnostics.py        # 脱敏日志与 LoopScope RAG span
```

Capability Registry 位于 `backend/agent/capabilities/`，只提供工具/Skill metadata、授权快照和推荐适配，不复制 Knowledge RAG 的检索实现。

## 3. 端到端流程

```text
业务对象/记忆/项目
        ↓
Source Adapter / Index Builder
        ↓
IndexDocument + Scope + stable version/content hash
        ↓
持久化索引或 transient owner index
        ↓
scope-first 硬过滤
        ↓
TypeScript BM25 worker
        ↓
可选向量混合（只使用已有向量缓存）
        ↓
来源内归一化 → 跨来源排序 → confidence 过滤
        ↓
正文 hash 去重 / parent 限制 / 来源限制 / 多样性限制
        ↓
3000 字符上下文预算
        ↓
RecallResult / public result
        ↓
显式工具结果，或自动召回 history 消息
```

### 3.1 两个调用入口

`search_knowledge()` 是跨来源统一入口，当前注册 Memory、Knowledge 和 Project 三个 Retriever；自动召回、跨来源主动查询使用它。

`search_memory()` 保留记忆工具入口；传入 `source=knowledge` 时搜索 Knowledge 主数据，仍走同一套 `UnifiedRecallService`、scope、评分和预算。

自动召回位于 `build_automatic_rag_context()`：

- 每条用户消息最多按当前请求 scope 召回一次。
- 当前使用 `strategy="bm25"`，避免自动召回额外发起 embedding 请求。
- 每个 scope 等待最多 3 秒；超时只跳过该 scope，不阻塞主 Agent。
- 结果写入当前用户消息前的稳定 conversation/history 边界，不放入不稳定的 dynamic tail。
- 已经存在于 history 的知识 hash 不重复注入。

## 4. 统一数据契约

### 4.1 Scope

`Scope` 是查询硬边界，不由 RAG 从业务对象推导权限：

```text
owner  = 用户个人范围
group  = 平台 + bot + 群聊范围
member = 群聊 + 平台用户成员范围
```

Scope 关键字段：

- `owner_user_id`
- `platform`
- `bot_id`
- `group_id`
- `scope_type`
- `scope_id`

`normalize_memory_scope()` 负责规范化请求；`matches_scope()` 做文档匹配；`filter_authorized_documents()` 在候选融合前再次执行严格过滤。

### 4.2 IndexDocument

每个可检索文档或 chunk 包含：

- `document_id`、`source_type`、`source_id`
- `title`、`summary`、`content`
- `scope`
- `version`、`chunk_index`、`chunk_count`
- `parent_document_id`、`updated_at`
- 非公开 `metadata`

`chunk_id`、`content_hash` 和 `identity()` 用于稳定去重、索引 revision 和缓存失效。对外返回时不会暴露内部 scope 元数据。

## 5. 来源与索引

### 5.1 来源适配

来源适配器负责把业务数据转换为 `IndexDocument`，不负责跨来源排序：

- `MemoryAdapter`：profile、pattern、daily、memory。
- `ProjectAdapter`：项目摘要、阶段和重要字段。
- `index_builder.py`：对文件、便签、画布、日历、定时任务、对话等来源建立统一索引文档。

来源的 owner、群聊和成员范围必须在构建文档时写入 Scope。适配器不能绕过对象归属检查，也不能把二进制正文直接塞进上下文。

### 5.2 持久化索引与 snapshot 缓存

`knowledge_index_entries` 保存统一索引条目，负责：

- 按 owner 和 source type 查询文档。
- 记录 source、scope、version、content hash 和更新时间。
- 支持来源级替换、更新和删除。
- 通过最大 `indexed_at` 生成 owner 级 revision。

索引是可重建缓存，不是权限事实来源。权限变化时仍必须重新生成 scope 并执行过滤。

同一 `snapshot revision` 内，来源文档集合视为不可变：首次查询读取 Knowledge、Project
等来源并建立共享 TypeScript BM25 索引，后续查询直接复用完整索引，不再重复加载来源文档。
没有 snapshot 的显式请求使用 request 级缓存，不承诺跨请求复用。缓存和 LoopScope 诊断记录：

当 snapshot revision 变化时，业务层按稳定的 chunk slot（来源类型、父文档和
`chunk_index`，不包含可变版本号）对比前后文档集合，只向 TypeScript worker 发送新增/修改
chunk（`upserts`）和删除 chunk（`deletes`）。对外引用仍使用带版本的 `chunk_id`；worker
内部 slot 只更新发生变化的 chunk，因此同一文档只改一段内容时不会重建其它段。revision
以 patch 事务原子推进；patch 基线不一致时拒绝应用，避免把不同 snapshot 的内容混在一起。

- `document_load_ms`：来源文档读取与分块；
- `index_lookup_ms`：统一索引查找及必要的首次构建；
- `sidecar_search_ms`：TypeScript worker 的 BM25 查询；
- `score_filter_ms`：统一候选评分与过滤。

## 6. 过滤与筛选顺序

过滤必须先于排序和上下文注入，顺序不能反过来。

### 6.1 Knowledge RAG 硬过滤

1. **身份边界**：文档 owner 必须等于当前用户。
2. **Scope 边界**：platform、bot、group、scope type 和 scope id 必须匹配。
3. **来源过滤**：调用方指定 `memory`、`project` 或 `all` 时，只保留对应来源。
4. **Snapshot 去重**：已经完整出现在当前 snapshot 的内容不再重复召回。
5. **置信度过滤**：低于 `HARD_CONFIDENCE_FLOOR = 0.35` 的候选拒绝；优先保留达到 `PREFERRED_CONFIDENCE = 0.55` 的候选。
6. **正文 hash 去重**：相同正文只保留一份，其他来源引用合并到 citations。
7. **Parent 限制**：同一个 parent document 最多保留 3 个 chunk。
8. **来源限制**：同一个 source type 最多保留 3 条。
9. **多样性限制**：token Jaccard 相似度达到 0.85 的候选不重复保留。
10. **上下文预算**：最终注入总文本最多 3000 字符；超出时截断候选正文。

### 6.2 Capability RAG 硬过滤

Capability RAG 尚未接入运行时，但离线探针已经按以下边界验证：

1. 只从 Runtime 已生成的授权工具快照中推荐。
2. `enabled=false` 的能力不推荐。
3. 平台不匹配的能力不推荐。
4. 缺少所需权限的能力不推荐。
5. 低于推荐置信度阈值的能力不推荐。
6. 每轮默认最多推荐 5 个工具。

推荐为空时不隐藏任何授权工具，仍保留完整短描述目录。推荐只能改变顺序或提示，不能作为安全过滤器。

## 7. 检索算法

### 7.1 统一分词

`tokenizer.py` 使用 Jieba 处理中文，并保留以下规则：

- 英文、数字和下划线作为实体片段。
- 对英文数字组合补充紧凑 token，例如 `GTA 6` 与 `GTA6`。
- 中文保留 Jieba 词和完整原词，减少专有名词被拆散后的召回损失。

TypeScript lexical worker 接收已经规范化后的文档文本和查询，Python 负责文档映射、权限和生命周期管理。

### 7.2 TypeScript lexical worker

当前生产后端固定为 TypeScript worker：

- `backend/ts/workers/rag/src/index.ts` 负责倒排索引和词法查询。
- `backend/agent/rag/ts_sidecar.py` 负责异步协议、文档映射、Scope 二次过滤和生命周期管理。
- worker 不可用时按统一 RAG 错误边界返回错误，不切换到历史 Rust/Python 词法实现。

### 7.3 兼容与错误边界

兼容实现仅保留在历史评估代码和报告中，不进入生产检索路径；生产查询失败必须暴露结构化错误，不能静默回退为另一套排序逻辑。

### 7.4 向量混合

向量不是自动召回的必经路径：

- 只读取已有的 memory/pattern 向量缓存。
- 查询热路径不会为每个文档临时生成 embedding。
- 词法候选和已有向量候选分别产生 rank。
- 使用归一化 RRF 混合，默认词法权重 `0.45`，向量权重 `0.55`。
- 没有查询向量、没有向量缓存或没有有效向量时保留 BM25 结果。

### 7.5 置信度与稳定排序

候选 confidence 由三部分组成：

```text
confidence = 0.55 × fused_score
           + 0.25 × query_match
           + 0.20 × source_quality
```

没有有效语义词命中时，来源质量不能单独把候选抬过硬下限。

跨来源排序使用 fused score，更新时间、chunk id 和来源优先级只作为稳定 tie-breaker。调用方不能直接横向比较不同来源的 raw score。

## 8. 缓存、TTL 与失效

### 8.1 索引缓存

`KnowledgeIndexCache` 管理 TypeScript worker 的索引生命周期：

| 项目 | 当前值 |
|---|---:|
| TTL | 30 分钟，按最后访问时间续期 |
| 单 owner 容量 | 32 MiB |
| 全局容量 | 512 MiB |
| 缓存 key | owner + TypeScript worker + index/fingerprint |
| 并发构建 | 同一 key 使用 asyncio lock，避免重复建索引 |

缓存有效条件：

- 未超过 TTL。
- owner revision 未变化。
- backend 未变化。
- transient 文档 fingerprint 未变化。

超过容量时优先淘汰最久未访问条目，并释放 TypeScript worker 客户端。索引缓存失效不会改变数据库内容。

### 8.2 失效来源

- 持久化索引最大更新时间变化。
- 文档内容、版本或结构变化导致 fingerprint 变化。
- TypeScript worker 版本或协议变化。
- 显式 owner/source cache invalidate。
- TTL 到期或容量淘汰。

## 9. 注入与历史复用

Knowledge RAG 结果有两种出口：

### 显式工具

显式 `search_memory` 等工具返回结构化结果，进入普通 tool call/tool result history。模型可以根据结果继续行动。

### 自动召回

自动召回只在历史语义明显时触发，或按已完成的 IM scope policy 生成 group/member/owner scope：

- 结果编码为 provider-compatible history message。
- 结果放在当前用户消息附近的稳定 conversation 边界。
- 通过 content hash 去重，避免同一片段重复进入上下文。
- 失败、超时和空结果只跳过可选补充，不阻塞主 Agent。

自动召回不修改权限、不执行工具，也不把内部分数解释成事实置信度。

## 10. 诊断与 LoopScope

`record_recall()` 只记录结构化、脱敏指标：

- namespace、source type、mode。
- candidate count、hit count、accepted count。
- elapsed ms、fallback reason、index version。
- engine、cache hit、cache entries、cache miss reason。
- confidence、去重、parent/source/diversity 拒绝统计。
- scope type 和脱敏 scope digest。

禁止记录：

- 原始 query。
- 用户记忆正文、文件正文和群聊内容。
- owner、群号、平台用户标识。
- 完整检索结果和工具 Schema。

## 11. Capability RAG 当前边界

Capability RAG 使用独立 namespace，元数据来自 Capability Registry：工具名、短描述、类别、关键词、平台和关联 Skill metadata。

当前离线验证脚本：

```text
backend/scripts/diagnostics/capability_recommendation_probe.py
```

验证结果：

- 天气语境能通过关联 Skill metadata 推荐 `http_get`。
- 文件下载语境能推荐 `web_download`。
- 未授权 Shell 不会进入推荐。
- 模糊闲聊无推荐并回退完整目录。
- 画布语境已经能限定在画布工具，但同类动作排序仍需更细 metadata。

正式接入时必须复用 RAG 的分词、检索、缓存和诊断基础设施，不能在 `capabilities/selector.py` 重新实现一套 BM25。推荐默认最多 5 个，只改变优先顺序，不削减授权工具，也不返回 Skill 正文或完整 Schema。

## 12. 相关代码与测试

- 统一入口：`backend/agent/rag/service.py`
- Scope 过滤：`backend/agent/rag/scope.py`
- TypeScript worker 缓存：`backend/agent/rag/index_cache.py`
- TypeScript sidecar：`backend/agent/rag/ts_sidecar.py`
- 查询规范化：`backend/agent/rag/tokenizer.py`；分词、评分和过滤由 `backend/ts/workers/rag/` 负责
- 自动注入：`backend/agent/rag/injection.py`
- 诊断：`backend/agent/rag/diagnostics.py`
- Capability 离线推荐：`backend/scripts/diagnostics/capability_recommendation_probe.py`
- RAG 测试：`backend/tests/test_rag_*.py`、`backend/tests/test_knowledge_index_cache.py`

推荐验证命令：

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/diagnostics/capability_recommendation_probe.py
PYTHONPATH=. .venv/bin/pytest -q tests/test_rag_*.py tests/test_knowledge_index_cache.py
```
