# 统一知识召回与索引（通用 RAG）PRD

> 状态：基础设施部分就绪，Knowledge RAG 尚未接入
> 创建：2026-08-04
> 最近更新：2026-08-23
> 关联模块：`backend/agent/memory/`、`backend/agent/tools/global_search.py`、`backend/agent/tools/conversations.py`
> 前置文档：[`PRD-MEM-1-记忆召回工具与混合检索.md`](./PRD-MEM-1-记忆召回工具与混合检索.md)、[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)
> 协作文档：[`PRD-LLM-9-工具与Skill注册制及按需注入.md`](./PRD-LLM-9-工具与Skill注册制及按需注入.md)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：数据源与权限协议 | 🟡 部分具备 | 各业务已有 ownership/scope 校验，但统一文档的 source、scope、版本和删除事件协议尚未落地 |
| Phase 1：内容摘要与分块接口 | 🔲 未开始 | 目前没有生产 SourceAdapter、统一摘要或分块产物 |
| Phase 2：统一索引管线 | 🟡 部分具备 | 已有记忆 embedding/cache 原语和离线 BM25；没有统一持久化索引、异步 upsert/invalidate 管线 |
| Phase 3：统一召回工具 | 🟡 能力侧部分具备 | `CapabilityIndex`、selector、injector 已建立注册与候选接口，但没有 Knowledge RAG 的 `rag_recall` |
| Phase 4：跨来源混合召回 | 🔲 待评估 | 多来源合并、去重、引用和上下文预算；首版不做独立 Ranking/Reranker |
| Phase 5：灰度与质量评估 | 🟡 离线部分完成 | 已有虚拟数据 BM25/Embedding 延迟压测；真实数据标注集、生产灰度和权限回归尚未完成 |

补充说明：已完成离线虚拟数据压测，结果见 [RAG 意图与召回压测报告](./report/RAG-意图与召回压测报告.md)。压测验证了 BM25、真实 Embedding 缓存和 LLM 意图判断的链路，但不等同于生产 Knowledge RAG 已经接入。

### 0.1 当前实现盘点

| 当前能力 | 现状 | 与本 PRD 的关系 |
|---|---|---|
| `global_search` | 基于业务表字段的精确/模糊对象搜索；便签可搜短正文，其余多数类型不搜文件正文 | 继续作为精确定位工具，不是统一 RAG |
| `search_conversations` / `read_conversation` | 按用户隔离搜索历史 session，并读取完整消息 | 继续作为历史会话检索和读取工具，不是统一索引 |
| `agent.memory.embedding` | 独立配置 embedding、模型 tag、向量生成、cosine 和失败退回词法；当前主要服务 memory/pattern | 可复用的向量基础设施，不代表已有跨来源索引 |
| `agent.capabilities` | `CapabilityIndex`、`RegistryCapabilitySelector`、`CapabilityToolContext` 已提供注册快照、权限交集和候选接口 | 是 PRD-LLM-9 的能力注册基础；当前 selector 没有 BM25/Embedding 召回，默认仍保留授权工具全集 |
| `bench_rag_virtual.py` | 离线虚拟文档 BM25、Embedding 和意图判断压测 | 评估工具，不是生产索引或召回服务 |
| Knowledge RAG | 未发现生产 `SourceAdapter`、`IndexPipeline`、持久化 BM25 index、`rag_recall` 或跨来源 retriever | 本 PRD 的主体仍待实施 |

当前边界：不能因为已有 `CapabilityIndex` 或 memory 向量缓存，就把 Capability RAG 或 Knowledge RAG 标记为完成。Capability Registry 与 Knowledge RAG 保持独立 namespace；前者负责能力元数据和 Schema 注入，后者负责用户知识片段召回。

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
- 不在本 PRD 之外重复实现工具候选筛选；Tool/Skill 注册协议和 Schema 注入由 `PRD-LLM-9` 负责。

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

- Capability RAG 只召回工具候选，不返回 Skill 正文。
- Skill 只提供短描述和关联 metadata；正文仍由 `use_skill` 或明确加载规则按需读取。
- 工具的完整 JSON Schema 不进入 RAG 文档，也不由 RAG 返回；候选命中后由 `PRD-LLM-9` 从 ToolRegistry 取 Schema。
- Capability RAG 与 Knowledge RAG 共用分词、BM25、Embedding、缓存和诊断基础设施，但使用独立 namespace、索引和结果类型。
- Runtime 必须先生成 admin、用户、平台、工作区和会话 scope 的授权视图；这些是硬安全边界，不由 RAG 复制或替代。
- RAG 返回的推荐只影响工具的优先顺序和提示，不改变授权工具全集，不能直接执行工具或绕过 dispatch、确认门和 ownership 校验。

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

## 4. 功能需求

### FR-RAG-1：异步摘要与分块（未实现）

源内容变更后由异步任务生成或更新摘要和检索分块，不在用户查询时临时读取全部原文。

- 内容 hash 未变化时不重复生成；
- 切片必须保持稳定边界；同一 `document_id + version` 不得因为任务重试产生随机 chunk 顺序；
- 删除、移动、权限变化必须产生索引失效事件；
- 摘要失败不能删除旧索引，保留上一个可用版本；
- 任务失败可重试，但不能无限重试。

### FR-RAG-2：无 embedding 的 BM25 召回（未实现；离线验证已完成）

- 所有 source adapter 生成的文档进入统一 BM25 候选池；
- 中文使用“通用分词器 + Gugu 动态领域词库”，并保留少量字符二元组作为新词/错别字兜底；
- 英文按空格和标点切分，统一小写；代码标识符、文件名和项目名按完整 token 保留；
- 中英文混合内容分别切分后合并索引词；
- 过滤低信息停用词，但不能删除项目名、文件名、Knowledge 标题等领域词；
- 查询先按 scope 过滤，再计算相关性；
- 返回 top-k 摘要和片段，并保留来源引用。

动态领域词库来源包括：项目名、笔记标题、文件名、Knowledge 标题、用户维护的术语和同义词。词库更新后只需重建受影响文档的索引，不要求修改原始内容。

压测脚本中的字符二元组和简化 BM25 仅用于离线验证，不能直接视为生产分词实现。

### FR-RAG-3：BM25 + embedding 混合召回（未实现；向量基础设施已具备）

- BM25 和 embedding 各取候选集合；
- 首版先并行召回并合并去重，不引入独立 Ranking 或 LLM Reranker；
- 结果顺序只使用 BM25/Embedding 本身的可解释分数、来源优先级和稳定时间顺序；不再增加额外模型排序层；
- embedding 未配置、缓存缺失或服务失败时自动退回 BM25；
- 查询默认直接使用用户原句，不先让 LLM 改写 Embedding 查询；
- 只有查询模糊、BM25 命中不足或明确需要语义扩展时，才考虑启用 Embedding；
- 向量是可重建缓存，模型切换后按 model tag 失效并重建；
- 缓存至少记录模型标识、维度、文本指纹和向量，不能把向量当作主数据。

### FR-RAG-4：统一召回工具（未实现）

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

### FR-RAG-5：权限和隔离（部分具备；统一索引前置过滤未实现）

- owner 私聊可检索自己有权访问的全部来源；
- owner 群聊默认限制当前群，明确指定跨群时仍不能直接公开其他群原文；
- member 只能检索当前群公开内容；
- 文件、项目、画布和日记必须复用各自的 ownership 校验；
- 不同 owner、Bot、平台、项目和群组的文档不能串库。

### FR-RAG-6：Capability RAG 工具软推荐（注册基础部分具备，RAG 召回未实现）

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
                         rag_recall      tool candidates
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

本阶段明确不做独立 Ranking/Reranker。此前测试显示额外 Ranking 会增加明显延迟，且没有带来足够的前 20 条质量收益。后续只有在新的标注集证明收益显著高于延迟成本时，才单独立项评估，不作为本 PRD 的默认能力。

### 5.3 上下文注入结构

RAG 结果不能写入 session snapshot、静态 system 或每轮固定的 dynamic tail。它属于当前用户问题的临时检索结果，应该沿用工具调用的消息边界：

```text
固定 system / session snapshot
        ↓
历史消息与已有 tool round
        ↓
当前 user message
        ↓
rag_recall tool_call
        ↓
rag_recall tool_result（摘要、片段、来源引用、更新时间）
        ↓
模型基于结果继续回答或继续调用工具
```

约束：

- `rag_recall` 的完整结果只进入当前 round 的 tool result，不进入 snapshot；
- 后续 round 若仍需要该结果，由已有 tool history 继承，不重复拼装到 system reminder；
- 新 Run 是否保留历史由普通 conversation history/compaction 决定，不建立 RAG 专用永久快照；
- 结果返回摘要和有限片段，不返回原始文件二进制或全量正文；
- 工具 Schema 通过 provider 的 tools 参数注入，Capability RAG 的候选元数据不混入 Knowledge RAG 结果；
- 若未来增加自动召回，也必须复用同一个 `rag_recall` 结果结构，不能在业务入口复制一套 system 注入逻辑；
- LoopScope 只记录 namespace、source_type、候选数、命中数、耗时、版本和脱敏 digest，不记录完整敏感正文。

因此，RAG 不应该成为新的 `[system-reminder]` 来源。`[system-reminder]` 继续只承载 session snapshot 和确有必要的动态运行状态；知识检索结果使用标准 tool round，保证消息边界、缓存前缀和 compaction 语义稳定。

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

### Phase 1：单一来源试点

先选择记忆或对话作为试点，验证摘要、分块、索引更新和删除追踪，再扩展其他来源。

### Phase 2：多来源灰度

只对明确要求跨来源检索的请求启用 `rag_recall`，记录命中数量、召回耗时、回退原因和用户纠正，不记录原始敏感正文。

### Phase 3：正式接入

稳定后再让 Agent 在“查以前内容/相关资料”类请求中主动调用，保留现有专用工具作为精确查询和完整读取兜底。

## 7.1 按当前代码现状的实施 Todo

以下 Todo 只针对 Knowledge RAG；Capability Registry 的已完成部分由 `PRD-LLM-9` 继续维护，不在这里重复实现。

### P0：冻结边界和数据契约

- [ ] 确认首个试点来源，并只为该来源实现最小 `SourceAdapter`。
- [ ] 定义 `source_type/source_id/document_id/version/scope` 的稳定规则。
- [ ] 明确删除、归档、权限变化和内容更新的失效事件；旧版本必须先不可召回。
- [ ] 复用现有 ownership 工具完成“查询前 scope 过滤”，不在索引层自行推导权限。
- [ ] 明确索引文档只保存摘要/片段，不保存原始文件二进制、密钥或未脱敏聊天正文。
- [ ] 冻结切片参数、来源专用边界、`chunk_id` 规则和 tool round 原子性要求。

### P1：单来源词法召回闭环

- [ ] 实现一个可替换的 `SourceAdapter` 和统一 `IndexDocument`，先不接所有来源。
- [ ] 实现可测试的 BM25/中文分词组件；离线脚本中的简化实现不能直接复制到生产。
- [ ] 实现语义优先的切片器，验证目标/硬上限、overlap、稳定顺序和相邻 chunk 合并。
- [ ] 先采用数据库/本地可控存储完成 upsert、invalidate、按 scope 查询和版本去重。
- [ ] 增加 `rag_recall` 最小工具，只返回摘要、片段、来源引用、更新时间和分数。
- [ ] 为 scope、删除后不可见、版本更新和空结果增加自动化测试。

### P2：异步更新与查询预算

- [ ] 将摘要、分块和索引更新接入现有 worker/event 体系，保证幂等和有限重试。
- [ ] 为召回结果设置条数、字符数和单来源配额，避免把 RAG 变成上下文膨胀入口。
- [ ] 设定默认被动召回预算：最多 8 个结果、单来源最多 3 个、总输出约 6000～8000 字符；主动调用也必须受后端硬上限约束。
- [ ] embedding 只作为 BM25 的可选补充；失败、缺缓存或超时必须稳定退回 BM25。
- [ ] 记录脱敏诊断字段：namespace、source_type、候选数、命中数、耗时、回退原因和 index version。

### P3：多来源和质量验证

- [ ] 在单来源质量达标后，再接入第二个来源，验证去重、引用和跨来源排序。
- [ ] 建立不含真实敏感正文的查询—相关文档标注集，比较 Recall@K、Precision@K、延迟和越权率。
- [ ] 不在本阶段实现 reranker；如未来重新评估，必须以独立 PRD 和真实标注集证明收益。
- [ ] 对 `global_search`、`search_conversations` 和 `rag_recall` 的职责边界做回归测试。

### P4：灰度和规模升级

- [ ] 仅对明确的跨来源知识问题灰度调用 `rag_recall`，保留专用工具兜底。
- [ ] 根据文档量、P95 延迟、索引更新延迟和并发量，决定是否引入 pgvector/HNSW/独立搜索服务。
- [ ] 验证不同 owner、平台、bot、群组和项目 scope 的隔离；完成灰度开关和回滚方案。

## 7.2 文件变更清单

以下清单按“首个单来源试点 + 可扩展到多来源”的最小实现盘点。文件名是实施约定，不代表本轮立即创建；只有 P0/P1 决策确认后才开始落代码。

### 需要新建的 Knowledge RAG 核心文件

```text
backend/agent/rag/
├── __init__.py              # 对外导出召回服务和数据类型
├── models.py                # IndexDocument、Scope、RecallResult、IndexVersion
├── adapters/
│   ├── __init__.py
│   ├── base.py              # SourceAdapter 协议、摘要/分块/版本接口
│   └── <pilot_source>.py    # 首个试点来源的 adapter，确认来源后命名
├── lexical.py               # 生产 BM25、中文分词、领域词库和停用词边界
├── index.py                 # upsert/invalidate、版本去重和可重建索引访问
├── retriever.py             # scope-first 的 BM25/Embedding 混合召回
├── service.py               # 查询编排、预算限制、去重和引用组装
└── diagnostics.py           # 只记录脱敏召回指标，不记录正文
```

说明：`rag/` 是 Knowledge RAG namespace。Capability RAG 不在这里复制一套工具注册代码；它继续复用 `backend/agent/capabilities/` 的注册快照和 Schema 注入，未来只替换 selector 的候选来源。

### 需要新建的工具、任务和测试文件

```text
backend/agent/tools/rag.py                 # `rag_recall` 工具和参数/结果契约
backend/agent/tasks/rag_index.py           # 摘要、分块、upsert/invalidate 的异步任务
backend/tests/test_rag_models.py           # 文档、scope、版本和引用模型
backend/tests/test_rag_lexical.py          # 中文/英文/混合词法召回
backend/tests/test_rag_scope.py             # owner、项目、群组、平台隔离
backend/tests/test_rag_index.py             # 幂等更新、删除、旧版本失效、重试
backend/tests/test_rag_recall.py            # 工具输出、预算、空结果和回退
backend/tests/test_rag_adapters.py          # 首个来源 adapter 的摘要/分块契约
backend/scripts/bench_rag_<pilot_source>.py # 真实试点数据的脱敏评估脚本（可选）
```

`backend/scripts/bench_rag_virtual.py` 继续作为离线虚拟压测工具，不改造成生产服务；新建真实评估脚本也不能写入用户正文、附件名或可识别身份。

### 预计需要修改的现有文件

| 文件 | 修改内容 | 阶段 |
|---|---|---|
| `backend/agent/tools/__init__.py` 或工具注册入口 | 注册 `rag_recall`，不修改 `global_search` 的精确搜索语义 | P1 |
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

- 🔲 首个试点来源选择记忆还是历史对话。
- 🔲 首个试点是显式 `rag_recall` 工具，还是由 Agent 在特定意图下自动触发；建议先显式工具，便于观测和回滚。
- 🔲 选择具体中文分词依赖，并确定动态词库的更新触发方式。
- 🔲 `IndexDocument` 的首版存储是复用业务数据库表，还是先使用 worker 可重建的本地索引；建议先复用数据库元数据和可重建索引，避免过早引入新服务。
- 🔲 内容变更后的 freshness SLA：同步使旧文档不可见、异步生成新版本，还是允许短暂旧结果；建议前者。
- ✅ 首版不使用独立 Ranking/Reranker；后续如重新评估，必须单独验证收益与延迟成本。
- 🔲 Embedding 是否使用远程服务、是否允许本地模型，以及向量/文本的留存和 TTL。
- 🔲 索引规模、P95 延迟和并发达到什么阈值后评估 pgvector/HNSW/独立搜索服务。
- 🔲 群聊、跨平台私聊和项目成员共享内容的默认 scope，尤其是“当前群”之外的历史消息是否允许被召回。
