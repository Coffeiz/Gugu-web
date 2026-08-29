# 记忆召回工具与混合检索 PRD

> 状态：设计完成，待实现
> 创建：2026-08-04
> 最近更新：2026-08-04
> 关联模块：`backend/agent/memory/store.py`、`backend/agent/memory/embedding.py`、`backend/agent/tools/conversations.py`、`backend/agent/tools/global_search.py`
> 关联文档：[`11-记忆系统.md`](../../agent/11-记忆系统.md)、[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：owner 私聊记忆召回工具 | 🔲 待实现 | `pattern`、`daily`、`memory` 的 BM25 召回 |
| Phase 2：embedding 混合召回 | 🔲 待实现 | 配置 embedding 后 BM25 + cosine 合并排序 |
| Phase 3：IM scope 权限 | 🔲 待实现 | owner 跨群、member 当前群隔离 |
| Phase 4：与历史 session 检索共用底层 | 🔲 待评估 | 保持工具边界不合并，复用检索服务 |
| Phase 5：自动化测试与灰度 | 🔲 待实现 | 权限、排序、预算和无 embedding 回退测试 |

## 1. 背景与目标

当前记忆系统会在每轮上下文构建时自动注入 profile、pattern、daily、summary 和 memory，但缺少一个由 Agent 主动调用的记忆检索工具。用户询问“以前提过什么”“上次讨论的方案”时，LLM 无法按需翻查更久或更具体的记忆。

本 PRD 新增 `search_memory` 工具：

1. 未配置 embedding 时，使用本地 BM25 进行关键词相关性召回。
2. 配置 embedding 时，使用 BM25 召回候选，再与向量 cosine 结果做混合排序。
3. owner 私聊可召回自己的个人记忆和授权范围内的群记忆。
4. owner 群聊默认只查当前群；明确指定跨群时才允许检索其他群，但不得把其他群原文直接公开给群成员。
5. member 在群聊中只能召回当前群记忆，不能读取 owner 或其他群记忆。

本 PRD 不替换 `global_search`，也不把 `search_conversations` / `read_conversation` 合并进记忆工具。三者可以共用底层排序组件，但数据源、权限和返回格式保持独立。

## 2. 功能需求

### FR-MEM-1：主动记忆召回（待实现）

新增 `search_memory` 工具，输入：

```json
{
  "query": "之前讨论过的部署方案",
  "scope": "auto",
  "source": "all",
  "limit": 5
}
```

字段规则：

- `query`：必填，由 LLM 提炼成适合检索的关键词或短语。
- `scope`：`auto`、`current_group`、`all_my_groups`、`private_memory`；后端必须按身份权限二次校验。
- `source`：`pattern`、`daily`、`memory`、`all`。
- `limit`：默认 5，后端强制限制为 1～10，不能由模型扩大上限。

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

### FR-MEM-2：无 embedding 时的 BM25 召回（待实现）

- 将 `pattern` 条目、`daily` 条目和 `memory.md` 分段作为可检索文档。
- 使用 BM25 对 query 和文档计算相关性。
- 返回 BM25 得分最高的候选，并过滤低于最低相关性阈值的结果。
- 对中文使用项目统一的分词或字符 n-gram 策略；不能依赖英文空格分词。
- 没有结果时返回空结果和可供 LLM 改写 query 的提示，不自动无限重试。

### FR-MEM-3：BM25 + embedding 混合召回（待实现）

当 embedding 已启用且存在同模型向量缓存时：

1. BM25 取前 20 个候选。
2. embedding 取前 20 个候选。
3. 合并候选集合并分别归一化 BM25 分数和 cosine 分数。
4. 按混合分数排序，默认公式：

```text
hybrid_score = 0.6 * bm25_score + 0.4 * cosine_score
```

5. 结果不足时用 BM25 结果补齐；不得因向量服务失败而阻塞当前回复。

权重和候选数量应配置在后端，不允许由 LLM 传入。后续可通过离线评估调整，不在首版暴露给普通用户。

### FR-MEM-4：召回范围与权限（待实现）

身份判断必须复用确定性的 `ActorResolver`，不能由模型、昵称或群内称呼推断。

| 场景 | 允许范围 |
|---|---|
| owner 私聊 | owner 私人记忆；明确要求时可查该 Bot 下自己的所有群记忆 |
| owner 群聊，未指定跨群 | 当前群记忆 |
| owner 群聊，明确指定跨群 | 可以检索 owner 的其他群，但回复内容必须摘要化或提示转私聊查看 |
| member 群聊 | 当前群公开记忆 |
| unknown | 当前群允许公开的最小范围，不能读取 owner 记忆 |

所有读取必须带：

```text
owner_user_id + platform + bot_id + scope_type + scope_id
```

跨群结果不能把其他群的原文、成员信息、私有项目或附件直接输出到当前群。

### FR-MEM-5：与现有搜索工具的边界（待实现）

- `global_search`：搜索项目、文件、文件夹、日程、客户、便签等站内对象，继续保留。
- `search_conversations`：搜索历史 session，继续使用消息正文、标题和摘要查询。
- `read_conversation`：读取指定 session 的完整消息。
- `search_memory`：只搜索整理后的长期/近期记忆。

三类工具可以共用 `RecallService` 的 BM25 评分和结果预算，但每个工具独立做 ownership、scope 和返回内容校验。

## 3. 技术方案

### 3.1 检索文档构建

新增 `backend/agent/memory/recall.py`，负责：

- 将各记忆层转换为带 `source`、`scope`、`date`、`text` 的统一文档。
- 对 `memory.md` 按段落切分，对 daily 按条目切分。
- 对 pattern 使用条目文本和结构化重要度作为排序保底。
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

### Phase 1：owner 私聊

- BM25 无 embedding 时能召回包含关键词的 pattern、daily、memory。
- `limit` 超过 10 会被后端截断。
- 无结果时不调用第二次无限搜索。
- owner 只能读取自己的记忆。

### Phase 2：混合排序

- 同一批候选同时有 BM25 和向量分数时按混合分数排序。
- embedding 未配置、缓存缺失、服务 4xx/5xx 时均能退回 BM25。
- 不重复调用 embedding；单次 query 只生成一个 query 向量。

### Phase 3：IM 权限

- owner 私聊可查自己的跨群记忆。
- owner 群聊默认只查当前群，明确跨群后结果不泄露其他群原文。
- member / unknown 无法读取 owner 或其他群记忆。
- 不同 `owner_user_id`、平台和 Bot 的 scope 完全隔离。

### Phase 4：回归与性能

- 与 `global_search`、`search_conversations` 并行测试，确认工具职责不互相覆盖。
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

- 🔲 BM25 首版采用字符 n-gram 还是引入中文分词依赖。
- 🔲 混合权重 `0.6 / 0.4` 需用真实记忆样本离线评估后确认。
- 🔲 owner 群聊跨群召回的摘要脱敏格式需结合 IM UI 最终确定。
- 🔲 群组/member 记忆 scope 等待 `PRD-IM-3` 实现后接入。
