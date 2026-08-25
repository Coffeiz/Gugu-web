# 记忆召回工具与混合检索 PRD

> 状态：Memory 召回、混合排序、IM scope 权限和历史会话统一检索已实现；ILIKE 策略仍待补充
> 创建：2026-08-04
> 最近更新：2026-08-25
> 关联模块：`backend/agent/memory/store.py`、`backend/agent/memory/embedding.py`、`backend/agent/tools/memory.py`、`backend/agent/rag/service.py`
> 关联文档：[`PRD-RAG-1-统一知识召回与索引.md`](./PRD-RAG-1-统一知识召回与索引.md)、[`11-记忆系统.md`](../../agent/11-记忆系统.md)、[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)

本 PRD 是 `PRD-RAG-1` 的首个单来源落地方案，只负责 Memory 来源和记忆专用
`search_memory` 工具。通用 `IndexDocument`、切片、索引版本、BM25/Embedding
基础设施、结果预算和诊断字段以 RAG-1 为准；本文件只补充记忆来源的字段映射、
IM scope 权限和工具行为。未来跨来源召回复用 RAG-1 的内部 Retriever/Service，
不新增 `rag_recall` Agent 工具，也不在本文件中复制通用索引实现。

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：owner 私聊记忆召回工具 | ✅ 已完成 | `profile`、`pattern`、`daily`、`memory` 已通过 RAG-1 Memory adapter 和 `search_memory` 接入；包含 BM25、结果预算、去重、snapshot 排除和 owner scope 隔离 |
| Phase 2：embedding 混合召回 | ✅ 已完成 | 使用同模型向量缓存与 BM25 做 RRF 混合；缺缓存、未启用或失败时退回 BM25；实际权重为 BM25 0.45、Embedding 0.55 |
| Phase 3：IM scope 权限 | ✅ 已完成 | `search_memory` 通过确定性的 IM context 解析 owner/member/unknown；支持当前群、本人可见群范围和跨群结果上限，禁止 member/unknown 读取 owner 私人记忆 |
| Phase 4：与历史 session 检索共用底层 | ✅ 已完成 | 新增 Conversation adapter；`search_conversations` 保留原工具返回协议和 `read_conversation` 边界，但搜索结果已复用 `UnifiedRecallService` 的 scope、confidence、去重和预算流水线 |
| Phase 5：自动化测试与灰度 | ✅ 已完成（RAG-4） | 权限、统一 confidence 排序、预算、多样性和无 embedding BM25 回退测试已覆盖；质量对照见 RAG 质量复测报告 |

阶段映射：Phase 1～3 是 RAG-1 的 Memory 单来源试点；Phase 4～5 对应 RAG-1
的查询边界、质量验证和灰度要求。公共契约变化时先更新 RAG-1，再同步本 PRD 的
Memory 映射，不另起一套协议。

## 1. 背景与目标

当前记忆系统会在每轮上下文构建时自动注入 profile、pattern、daily、summary 和 memory，但缺少一个由 Agent 主动调用的记忆检索工具。用户询问“以前提过什么”“上次讨论的方案”时，LLM 无法按需翻查更久或更具体的记忆。

本 PRD 新增 `search_memory` 工具：

1. 未配置 embedding 时，使用本地 BM25 进行关键词相关性召回。
2. 配置 embedding 时，使用 BM25 召回候选，再与向量 cosine 结果做混合排序。
3. owner 私聊可召回自己的个人记忆和授权范围内的群记忆。
4. owner 群聊默认只查当前群；明确指定跨群时才允许检索其他群，但不得把其他群原文直接公开给群成员。
5. member 在群聊中只能召回当前群记忆，不能读取 owner 或其他群记忆。

本 PRD 不替换 `global_search`，也不把 `search_conversations` / `read_conversation` 合并进记忆工具。三者可以共用底层排序组件，但数据源、权限和返回格式保持独立。

记忆来源不再维护独立的最低分、归一化或排序规则；统一交给
`backend/agent/rag/scoring.py` 和 `UnifiedRecallService`，工具层只负责参数、scope
和返回格式。

## 2. 功能需求

### FR-MEM-1：主动记忆召回（✅ 基础能力已实现，IM scope 待补齐）

新增 `search_memory` 工具，输入：

```json
{
  "query": "之前讨论过的部署方案",
  "scope": "auto",
  "source": "all",
  "strategy": "auto",
  "limit": 5
}
```

字段规则：

- `query`：必填，由 LLM 提炼成适合检索的关键词或短语。
- `scope`：`auto`、`current_group`、`all_my_groups`、`private_memory`；后端必须按身份权限二次校验。
- `source`：`knowledge`、`profile`、`pattern`、`daily`、`memory`、`all`。
- `strategy` 规划为 `auto`、`bm25`、`embedding`、`ilike`。当前实现已支持前三者，
  `ilike` 尚未接入 Memory 检索器；`auto` 由后端按配置选择，`embedding` 未配置或不可用时退回 BM25。
  `ilike` 只做数据库子串匹配，不承诺语义相关性。
- `limit`：默认 5，后端强制限制为 1～10，不能由模型扩大上限。

默认建议使用 `auto`。只有排查召回、精确查找或离线对比时，才由 Agent 显式指定策略；
后端仍需强制执行 scope、结果数量、字符预算和超时限制。

返回结果包含：

```json
{
  "query": "部署方案",
  "results": [
    {
      "source": "memory",
      "scope": "private",
      "text": "...",
      "score": 0.82,
      "date": "2026-07-20"
    }
  ],
  "has_more": false
}
```

只返回必要片段，不返回完整 memory 文件；总字符数由后端预算限制，避免工具结果撑爆上下文。

### FR-MEM-2：无 embedding 时的 BM25 召回（✅ 已实现）

- 将 `pattern` 条目、`daily` 条目和 `memory.md` 分段作为可检索文档。
- 使用 BM25 对 query 和文档计算相关性。
- 返回 BM25 得分最高的候选，并过滤低于最低相关性阈值的结果。
- 对中文使用项目统一的分词或字符 n-gram 策略；不能依赖英文空格分词。
- 没有结果时返回空结果和可供 LLM 改写 query 的提示，不自动无限重试。

### FR-MEM-3：BM25 + embedding 混合召回（✅ 已实现）

当 embedding 已启用且存在同模型向量缓存时：

1. BM25 取前 20 个候选。
2. embedding 取前 20 个候选。
3. 合并候选集合并分别归一化 BM25 分数和 cosine 分数。
4. 按混合分数排序，默认公式：

```text
hybrid_score = 0.45 * bm25_rrf + 0.55 * cosine_rrf
```

5. 结果不足时用 BM25 结果补齐；不得因向量服务失败而阻塞当前回复。

权重和候选数量应配置在后端，不允许由 LLM 传入。后续可通过离线评估调整，不在首版暴露给普通用户。

### FR-MEM-4：召回范围与权限（✅ 已实现）

身份判断必须复用确定性的 `ActorResolver`，不能由模型、昵称或群内称呼推断。

| 场景 | 允许范围 |
|---|---|
| owner Web/私聊 | 当前群优先；可检索 owner 所属全部群，跨群结果最多 3 条 |
| owner 群聊 | 当前群优先；跨群只补充 1～2 条，不返回其他群原文 |
| member Web/私聊 | 当前群优先；只检索 member 仍属于的其他群公开记忆，跨群最多 3 条 |
| member 群聊 | 当前群优先；只补充 member 所属其他群公开记忆，最多 1～2 条 |
| unknown | 当前群允许公开的最小范围，不能读取 owner 记忆 |

所有读取必须带：

```text
owner_user_id + platform + bot_id + scope_type + scope_id
```

跨群结果不能把其他群的原文、成员信息、私有项目或附件直接输出到群聊。跨群结果
不额外调用 LLM 做实时摘要，直接使用索引中已有的摘要或短片段；Web/私聊最多返回
3 条群 RAG 结果，且同一群最多占 1 条。

### FR-MEM-5：与现有搜索工具的边界（✅ 已实现）

- `global_search`：搜索项目、文件、文件夹、日程、客户、便签等站内对象，继续保留。
- `search_conversations`：搜索历史 session，继续使用消息正文、标题和摘要查询。
- `read_conversation`：读取指定 session 的完整消息。
- `search_memory`：只搜索整理后的长期/近期记忆。

三类工具可以共用 `RecallService` 的 BM25 评分和结果预算，但每个工具独立做 ownership、scope 和返回内容校验。

## 3. 技术方案

### 3.0 与统一 RAG 的契约边界

Memory 文档进入统一索引时，按 RAG-1 的 `IndexDocument` 映射：

| Memory 字段 | RAG 字段 |
|---|---|
| `pattern` / `daily` / `memory` | `source_type=memory`、`source_id` |
| 记忆作用域 | `scope.owner_user_id`、`platform`、`bot_id`、`group_id` |
| 条目更新时间 | `updated_at` |
| 条目内容指纹 | `version` |
| 条目正文片段 | `summary` / `content` |

切片、索引失效、版本去重、结果条数/字符预算和诊断字段不在本 PRD 重新定义，
统一遵循 RAG-1。`search_memory` 可以复用同一 `RecallService`，但仍独立执行
Memory 的 scope 校验和结果脱敏。

### 3.1 检索文档构建

当前由 `backend/agent/rag/adapters/memory.py`、`backend/agent/rag/adapters/conversations.py`
与 `backend/agent/rag/service.py` 负责：

- 将各记忆层转换为带 `source`、`scope`、`date`、`text` 的统一文档。
- 对 `memory.md` 按段落切分，对 daily 按条目切分。
- 对 pattern 使用条目文本和统一 RAG 评分作为排序依据。
- 不记录用户原文到普通日志；诊断日志只记录 source、scope 类型、结果数量和耗时。

### 3.2 BM25 实现

首版可使用轻量 Python 实现或已批准的依赖，不引入独立搜索服务。必须：

- 支持中文字符 n-gram 或统一分词；
- 对短文本、重复词和长文本做长度归一化；
- 每次查询限制候选文档数和输出字符数；
- 纯函数可单测，便于未来替换为数据库全文索引。

### 3.3 embedding 混合

复用 `backend/agent/memory/embedding.py` 和现有向量缓存：

- 未配置或未启用：只走 BM25；
- 已启用但向量缺失：BM25 结果正常返回，并异步补向量；
- embedding 请求失败：本次退回 BM25，不影响主流程；
- 更换模型 tag 后，旧向量视为不可用，继续走 BM25，直到重建完成。

### 3.4 工具调用策略

LLM 只有在以下情况主动调用：

- 用户明确询问过去的记忆、习惯、决定或讨论；
- 当前上下文无法回答且可能需要历史信息；
- 用户要求“找出之前提过的内容”。

默认返回 5 条，最多重试一次 query 改写；无结果后明确说明未找到，不能编造记忆。

## 4. 验证与上线

### Phase 1：owner 私聊（✅ 已完成）

- BM25 无 embedding 时能召回包含关键词的 pattern、daily、memory。
- `limit` 超过 10 会被后端截断。
- 无结果时不调用第二次无限搜索。
- owner 只能读取自己的记忆。

### Phase 2：混合排序（✅ 已完成）

- 同一批候选同时有 BM25 和向量分数时按混合分数排序。
- embedding 未配置、缓存缺失、服务 4xx/5xx 时均能退回 BM25。
- 不重复调用 embedding；单次 query 只生成一个 query 向量。

### Phase 3：IM 权限（✅ 已完成）

- 自动 RAG 与显式 `search_memory` 共用 group/member scope 构造。
- owner Web/私聊最多补充 3 个群 scope；owner 群聊明确 `all_my_groups` 时最多补充 2 个其他群。
- member 只能读取当前发言人对应的 platform-user scope 和群公开记忆；unknown 不能升级为 owner。
- 不同 `owner_user_id`、平台和 Bot 的 scope 完全隔离。

### Phase 4：回归与性能（✅ 已完成）

- 与 `global_search` 的工具边界保持独立；`search_conversations` 已通过 Conversation adapter 复用统一召回服务，但 `read_conversation` 仍负责完整消息读取。
- Conversation adapter 的数据库候选查询只返回当前用户的消息，再进入统一 confidence、去重和结果预算流水线。
- 记录检索耗时、候选数、最终结果数和回退原因，不记录记忆正文。
- 单次工具调用总输出控制在上下文预算内。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 中文 BM25 分词质量不足 | 同义表达召回率低 | 首版使用字符 n-gram；后续用离线样本评估分词方案 |
| embedding 服务不可用 | 混合排序失败 | 始终保留 BM25 主路径，向量失败自动回退 |
| owner 在群聊请求跨群记忆 | 可能把其他群内容公开 | 默认当前群；跨群结果只摘要或引导转私聊 |
| 记忆文件规模增长 | 每次临时构建索引变慢 | 首版限制文档数；规模达到阈值后增加 per-scope BM25 缓存 |
| LLM 频繁调用工具 | 延迟和成本上升 | 工具描述明确触发条件，后端限制重试和结果预算 |

待确认：

- 🔲 Memory group/member scope 接入持久化索引与增量失效机制（后续索引规模优化，不阻塞 Phase 3/4）。
- 🔲 接入 `ilike` 策略，明确其仅作为精确子串回退，不参与语义混合排序。
- 🔲 评估是否将 `search_conversations` 的消息索引接入统一 Retriever；保持工具边界不合并。
- 🔲 补充显式 `search_memory` 的 IM 权限、scope、策略和跨用户隔离测试。
