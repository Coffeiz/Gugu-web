# 统一知识召回与索引（通用 RAG）PRD

> 状态：未来规划，暂不实施
> 创建：2026-08-04
> 最近更新：2026-08-05
> 关联模块：`backend/agent/memory/`、`backend/agent/tools/global_search.py`、`backend/agent/tools/conversations.py`
> 前置文档：[`PRD-MEM-1-记忆召回工具与混合检索.md`](./PRD-MEM-1-记忆召回工具与混合检索.md)、[`PRD-IM-3-群组与成员记忆.md`](./PRD-IM-3-群组与成员记忆.md)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：数据源与权限协议 | 🔲 待评估 | 统一 source、scope、版本和删除语义 |
| Phase 1：内容摘要与分块接口 | 🔲 待评估 | 项目、日记、画布、文件、对话分别提供 adapter |
| Phase 2：统一索引管线 | 🔲 待评估 | 异步生成 BM25 索引和 embedding 缓存 |
| Phase 3：统一召回工具 | 🔲 待评估 | 直接返回摘要、片段和来源，不要求二次读取 |
| Phase 4：跨来源混合召回 | 🔲 待评估 | 多来源排序、去重、引用和上下文预算 |
| Phase 5：灰度与质量评估 | 🔲 待评估 | 离线样本、权限回归、召回质量和性能指标 |

补充说明：已完成离线虚拟数据压测，结果见 [RAG 意图与召回压测报告](./report/RAG-意图与召回压测报告.md)。压测验证了 BM25、真实 Embedding 缓存和 LLM 意图判断的链路，但不等同于生产 RAG 已经接入。

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
- 所有结果先经过 owner、project、group、platform-user 等 scope 权限过滤。
- 支持结果去重、来源引用、版本追踪和删除后索引清理。

### 2.2 非目标

- 不立即替换 `global_search` 的精确对象搜索。
- 不立即替换 `search_conversations` 的完整 session 读取能力。
- 不在当前阶段改造所有数据源或引入向量数据库。
- 不允许 RAG 绕过现有 owner/member/group 权限边界。
- 不把原始文件二进制直接塞入 LLM 上下文；文件必须先经过安全抽取和摘要。

## 3. 核心概念

### 3.1 统一文档

每个可召回单元统一为：

```json
{
  "id": "stable-source-document-id",
  "source_type": "project|journal|canvas|file|conversation|memory",
  "source_id": "业务对象 ID",
  "scope": {
    "owner_user_id": "...",
    "project_id": "...",
    "platform": "...",
    "bot_id": "...",
    "group_id": "..."
  },
  "title": "可展示标题",
  "summary": "短摘要",
  "content": "可检索文本片段",
  "version": "内容版本或 hash",
  "updated_at": "UTC 时间"
}
```

`content` 是检索和上下文注入的文本，不代表原始对象全文。原始对象仍由各业务模块负责保存。

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

## 4. 功能需求

### FR-RAG-1：异步摘要与分块（待实现）

源内容变更后由异步任务生成或更新摘要和检索分块，不在用户查询时临时读取全部原文。

- 内容 hash 未变化时不重复生成；
- 删除、移动、权限变化必须产生索引失效事件；
- 摘要失败不能删除旧索引，保留上一个可用版本；
- 任务失败可重试，但不能无限重试。

### FR-RAG-2：无 embedding 的 BM25 召回（待实现）

- 所有 source adapter 生成的文档进入统一 BM25 候选池；
- 中文使用“通用分词器 + Gugu 动态领域词库”，并保留少量字符二元组作为新词/错别字兜底；
- 英文按空格和标点切分，统一小写；代码标识符、文件名和项目名按完整 token 保留；
- 中英文混合内容分别切分后合并索引词；
- 过滤低信息停用词，但不能删除项目名、文件名、Knowledge 标题等领域词；
- 查询先按 scope 过滤，再计算相关性；
- 返回 top-k 摘要和片段，并保留来源引用。

动态领域词库来源包括：项目名、笔记标题、文件名、Knowledge 标题、用户维护的术语和同义词。词库更新后只需重建受影响文档的索引，不要求修改原始内容。

压测脚本中的字符二元组和简化 BM25 仅用于离线验证，不能直接视为生产分词实现。

### FR-RAG-3：BM25 + embedding 混合召回（待实现）

- BM25 和 embedding 各取候选集合；
- 首版先并行召回并合并去重，不默认引入 LLM 重排；
- 分数归一化后混合排序，具体权重通过离线标注集确定；
- embedding 未配置、缓存缺失或服务失败时自动退回 BM25；
- 查询默认直接使用用户原句，不先让 LLM 改写 Embedding 查询；
- 只有查询模糊、BM25 命中不足或明确需要语义扩展时，才考虑启用 Embedding；
- LLM 重排默认关闭，只作为低置信度、候选噪声较多或用户明确要求精排时的可选步骤；
- 重排只接收已经完成权限过滤和去重的有限候选，不接收全量文档；
- 向量是可重建缓存，模型切换后按 model tag 失效并重建；
- 缓存至少记录模型标识、维度、文本指纹和向量，不能把向量当作主数据。

### FR-RAG-4：统一召回工具（待实现）

未来提供 `rag_recall`：

```json
{
  "query": "这个项目之前讨论过的部署方案",
  "sources": ["project", "conversation", "file", "memory"],
  "limit": 8
}
```

后端强制限制返回数量、总字符数和可访问 scope。结果至少包含：

- 来源类型和对象标题；
- 摘要或相关片段；
- 更新时间；
- 可用于后续精确读取的对象引用；
- 是否还有更多结果。

### FR-RAG-5：权限和隔离（待实现）

- owner 私聊可检索自己有权访问的全部来源；
- owner 群聊默认限制当前群，明确指定跨群时仍不能直接公开其他群原文；
- member 只能检索当前群公开内容；
- 文件、项目、画布和日记必须复用各自的 ownership 校验；
- 不同 owner、Bot、平台、项目和群组的文档不能串库。

## 5. 技术方案

### 5.1 组件边界

```text
SourceAdapter → IndexDocument → IndexPipeline
                                      ↓
                           BM25 / Embedding Index
                                      ↓
                              RAG Retriever
                                      ↓
                              rag_recall tool
```

`global_search` 和 `search_conversations` 可复用底层候选排序或分词组件，但继续保留各自的精确查询和完整读取 API。

### 5.2 查询编排策略

首版按以下策略执行：

```text
明确、短、包含领域词的查询
  → 直接 BM25

跨来源或 BM25 命中不足
  → BM25 + Embedding 并行召回

范围不明确、需要判断 sources/scope 的查询
  → 可选 LLM 意图判断
  → 不默认改写原始查询
  → BM25 / Embedding 召回
```

LLM 意图判断只负责结构化 `sources`、`scope`、`need_current` 等路由信息。它生成的关键词不能覆盖用户原句；即使关键词为空，也必须保留原始查询继续召回。首版不引入 LLM reranker。

如果未来启用 LLM 重排，流程固定为：

```text
BM25 / Embedding 候选
  ↓ 权限过滤、去重、限制候选数
LLM 输出候选 key 顺序
  ↓ 校验 key，拒绝未知 key，缺失项按原召回顺序补回
上下文注入
```

重排必须保留原始召回分数和来源，不能让模型新增文档或绕过权限。输出不完整时不能中断整条 RAG 链路。

### 5.3 向量缓存与规模策略

- 文档向量由异步索引任务生成并缓存，查询时只生成一次 query vector；
- 小规模数据可使用本地 cosine 排序；
- 数据量扩大后再评估 pgvector、HNSW、FAISS 等索引，不提前引入向量数据库；
- Embedding 接口失败、限流或配置不兼容时，整条链路退回 BM25，不阻塞主 Agent。

### 5.4 索引更新

优先使用现有异步任务/事件基础设施：

- 数据变更发出 `rag.index.invalidate` 或 `rag.index.upsert` 事件；
- worker 负责摘要、分块和向量更新；
- 索引更新幂等，按 `source_id + version` 去重；
- 删除和权限变更必须优先使旧文档不可召回，再异步清理缓存。

首版不要求独立向量数据库；数据规模和查询延迟达到阈值后再评估专用索引服务。

## 6. 前置条件

通用 RAG 开始实现前，必须先完成：

1. 各内容源的摘要/正文读取边界稳定；
2. 统一 scope 和 ownership 契约；
3. 内容变更事件或可靠的增量扫描机制；
4. 文件文本抽取和安全校验；
5. 群组/member 记忆隔离（见 `PRD-IM-3`）；
6. 至少准备一批跨来源召回标注样本，用于比较 BM25 和混合召回质量。
7. 建立通用分词器、动态领域词库、停用词和同义词的配置边界。

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
| `--rerank-models` | 逗号分隔的 LLM 预设匹配词，例如 `deepseek,minimax` |
| `--query` | 自定义测试查询 |

缓存按 Embedding 模型标识和向量维度校验，模型切换后会自动失效。缓存文件已加入 Git 忽略规则，不应提交到仓库。

重排测试示例：

```bash
PYTHONPATH=. .venv/bin/python scripts/bench_rag_virtual.py \
  --docs 1000 \
  --embed-docs 0 \
  --top-k 100 \
  --rerank-models deepseek,minimax
```

当前压测中 BM25 排序约 12ms，DeepSeek 重排约 2.34s，MiniMax-M3 约 2.82s，上下文注入低于 1ms；重排没有改善前 20 条质量，因此首版不作为默认步骤。

### Phase 0：离线评估

- 为项目、日记、画布、文件、对话、记忆准备查询—相关文档样本；
- 对比 BM25、embedding 和混合排序的 Recall@K、命中率和延迟；
- 验证不同 scope 下不会出现越权结果。

### Phase 1：单一来源试点

先选择记忆或对话作为试点，验证摘要、分块、索引更新和删除追踪，再扩展其他来源。

### Phase 2：多来源灰度

只对明确要求跨来源检索的请求启用 `rag_recall`，记录命中数量、召回耗时、回退原因和用户纠正，不记录原始敏感正文。

### Phase 3：正式接入

稳定后再让 Agent 在“查以前内容/相关资料”类请求中主动调用，保留现有专用工具作为精确查询和完整读取兜底。

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

待确认：

- 🔲 首个试点来源选择记忆还是历史对话。
- 🔲 选择具体中文分词依赖，并确定动态词库的更新触发方式。
- 🔲 混合召回是否需要独立 reranker。
- 🔲 索引规模达到什么阈值后评估独立搜索/向量服务。
