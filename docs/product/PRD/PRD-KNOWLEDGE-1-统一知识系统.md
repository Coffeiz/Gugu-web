# 统一知识系统

> 状态：Phase 1～5 已完成首版；Todo A-C 已完成首版，Todo D 已完成来源约束与诊断基础能力
> 创建：2026-08-04
> 最近更新：2026-08-25
> 关联模块：`backend/agent/knowledge/`、`backend/agent/memory/`、`backend/agent/tools/global_search.py`、`backend/agent/tools/files.py`
> 关联文档：[`PRD-RAG-1-统一知识召回与索引.md`](./PRD-RAG-1-统一知识召回与索引.md)、[`PRD-MEM-1-记忆召回工具与混合检索.md`](./PRD-MEM-1-记忆召回工具与混合检索.md)、[`11-记忆系统.md`](../../agent/11-记忆系统.md)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：知识边界与来源协议 | ✅ 已完成 | 已确定 Knowledge 与 Memory 分离，并纳入用户主动提供的知识 |
| Phase 1：文件存储与知识条目模型 | ✅ 已完成 | 一条知识一个 Markdown 文件；空的 `entries.json` 已直接替换，不保留兼容读路径。 |
| Phase 2：知识捕捉与更新 | ✅ 首版完成 | 新增 `save_knowledge` 明确保存入口，支持 user/file/web/derived/conversation 来源、可信度和同主题更新；普通对话不会自动写入。 |
| Phase 3：知识检索工具 | ✅ 已完成 | `search_memory(source=knowledge)` 已接入现有 UnifiedRecallService、Rust/Python lexical cache、scope 过滤、置信度和统一预算。 |
| Phase 4：反思、去重与来源维护 | ✅ 首版完成 | 同主题历史、跨来源冲突、软删除和索引失效已落地 |
| Phase 5：权限、向量和人工验收 | ✅ 首版完成 | Knowledge 复用现有 scope、向量缓存和混合召回，并完成回归测试 |

## 1. 背景与目标

现在咕咕的 `profile`、`pattern`、`daily` 和 `memory` 主要记录“用户是谁、怎么做事、最近发生了什么以及长期经历”。但用户主动告诉咕咕的项目背景、规则、术语和资料，以及咕咕查到并确认过的外部资料，没有一个独立的长期知识归档位置。

Knowledge 用于保存可复用的事实和资料，不局限于联网搜索结果，至少包括：

- 用户明确告诉咕咕、并要求保留的知识；
- 从用户文件中提取并确认的资料；
- 联网搜索后经过整理和保留来源的外部资料；
- 基于多个来源整理出的、仍可追溯的派生知识。

目标是让咕咕在后续对话中按需检索相关知识，同时保留来源、作用域、更新时间和可信度，避免把知识误当成用户记忆，或把一个群成员提供的内容泄露到 owner 的个人上下文。

### 1.1 与 Memory 的边界

| 类型 | 记录内容 | 示例 |
|---|---|---|
| `profile` | 用户稳定身份和背景 | 用户从事插画、居住城市 |
| `pattern` | 用户可复用的行为和协作习惯 | 用户偏好先给方案再执行 |
| `daily/memory` | 用户、群组和关系的事件脉络 | 最近在重构 QQ 群聊链路 |
| `knowledge` | 可复用事实、规则、资料和解释 | 某项目采用的协议、某术语的定义 |

同一句话可能同时产生不同层的数据，但不能直接复制：例如“我最近在研究某框架”进入 `daily`；用户提供的框架核心概念和使用规则进入 `knowledge`。

## 2. 功能需求

### FR-KNOWLEDGE-1：知识条目与作用域（✅ Phase 1）

每条知识必须有稳定 ID、标题、正文、主题、来源、作用域、可信度和更新时间。

首版作用域：

| 作用域 | 可写入者 | 默认可读取者 |
|---|---|---|
| `owner` | owner、用户明确授权的工具 | owner 私聊和 owner 的网页会话 |
| `platform_user` | 对应用户本人 | 对应用户本人 |
| `group` | owner 或群内允许写入的流程 | 当前群可见范围 |
| `project` | 项目成员或 owner | 有项目访问权的会话 |
| `public` | 明确标记为公开的来源 | 经过普通权限校验的会话 |

不同 owner、平台、Bot、成员和群组的知识必须物理或逻辑隔离。`member`/`unknown` 不得因为搜索命中而读取 owner 私人知识。

### FR-KNOWLEDGE-2：知识来源和可追溯性（✅ Phase 1）

来源类型固定为：

```text
user       用户主动提供
file       用户文件或项目文件
web        联网搜索或网页阅读
derived    基于已有条目整理出的派生知识
conversation 对话中确认的知识
```

每条知识至少保留：

- `source_type` 和 `source_id`；
- 来源标题或 URL；
- 创建、更新和核验时间；
- `confidence`：`confirmed`、`probable`、`unverified`；
- 派生知识的父条目 ID。

普通日志只能记录来源类型、作用域类型、条目数量和指纹，不能记录用户提供的原文、文件正文或完整 URL 参数。

### FR-KNOWLEDGE-3：知识捕捉策略（✅ Phase 2 首版）

知识捕捉分为三种强度：

1. **明确保存**：用户说“记住这个”“以后按这个规则”“把这条加入知识库”时，直接进入待确认或已确认知识。
2. **工具结果保存**：用户要求保留搜索结果、文件资料或项目规则时，保存整理后的条目和来源，不直接保存整页原文。
3. **被动候选**：普通对话中出现的事实只生成候选，不自动写入长期 Knowledge；需要用户确认、重复出现或达到可信度阈值后才晋升。

Agent 不得因为一次普通聊天或一次未经核实的搜索结果，自动把内容当成确定知识。

### FR-KNOWLEDGE-4：知识更新、去重与矛盾（✅ Phase 4 首版）

- 同主题且内容相同的知识直接去重；
- 同主题知识优先更新已有条目，历史版本写入条目的 `history`，不覆盖唯一历史依据；
- 不同来源对同主题给出不同内容时，保留独立的 `conflict` 条目并用 `parent_id` 关联，不能静默覆盖；
- 用户明确纠正时，新的用户来源优先级高于旧的 `web` 或 `derived` 来源；
- `confidence=probable/unverified/conflict` 会进入统一检索评分并降低来源质量；自动按时间过期和定期核验后置；
- 删除知识必须经过确认；首版使用 active tombstone，并立即失效进程内检索缓存，向量缓存按可重建策略处理。

### FR-KNOWLEDGE-5：知识检索（✅ Phase 3）

已扩展现有 `search_memory`：

```json
{
  "query": "这个项目使用的消息协议",
  "source": "knowledge",
  "scope": "auto",
  "limit": 5
}
```

检索规则：

- `source=knowledge` 只返回 Knowledge，不混入 profile/pattern/daily/memory；
- `source=all` 才允许在权限过滤后合并记忆与知识；
- 结果包含标题、摘要、来源、更新时间、可信度和对象引用；
- 默认最多返回 5 条，后端限制最大数量和总字符数；
- 无 embedding 时使用 BM25/词法检索，启用 embedding 后复用现有混合召回；
- 知识检索失败不能阻塞主回复，应返回可解释的未找到或暂不可用状态。

`global_search` 继续负责项目、文件、文件夹、笔记等精确对象搜索，不因为新增 Knowledge 而被替换。

### FR-KNOWLEDGE-6：上下文注入（🔲 新 Todo）

Knowledge 不全量注入每轮上下文，而是由 RAG 按需自动召回。触发条件：

- 用户询问某个事实、规则、术语或过去保存的资料；
- Agent 正在处理与知识条目明确关联的项目或文件；
- 用户明确要求查知识库。

短寒暄、无主题消息和纯工具操作不触发自动 Knowledge 召回。已在当前 snapshot 注入且内容未变化的条目不重复注入。

自动召回每个 scope 最多注入 5 条，所有 scope 共享 3,000 字符正文预算。注入内容必须带来源和时间，并标记为参考资料而非用户指令。群聊中只注入当前群或公开作用域的知识，不能把 owner 私聊知识作为普通群上下文的一部分。

## 3. 技术方案

### 3.1 推荐目录

目标实现采用用户 `.agent/` 存储作为 Knowledge 主数据，一条知识对应一个 Markdown 文件，索引和向量作为可重建缓存：

```text
<user_id>/.agent/
└── knowledge/
    └── entries/
        ├── knowledge-xxx.md
        └── knowledge-yyy.md
```

当前 `entries.json` 尚无实际数据，切换到 Markdown 存储时直接替换存储实现，不做迁移兼容层。删除记录可以使用 frontmatter 的 `active=false` 或独立 tombstone 文件，不能让已删除条目继续进入索引。

代码职责建议：

```text
backend/agent/knowledge/
├── models.py       # 条目、来源、作用域和版本模型
├── store.py        # Markdown 主数据读写、同主题更新和 active 删除
└── __init__.py

backend/agent/rag/adapters/knowledge.py # Knowledge → IndexDocument 适配
backend/agent/tools/memory.py           # save_knowledge / search_memory 入口
                                      # delete_knowledge 确认删除入口
```

`memory/` 继续负责 profile、pattern、daily、memory 和 IM scope 记忆；它可以调用 `knowledge.capture`，但不拥有 Knowledge 文件。

### 3.2 条目结构与长度限制

每个 Markdown 使用 YAML frontmatter 保存元数据，正文保存知识内容：

```md
---
id: knowledge-uuid
title: 项目消息协议
topic: 项目
scope_type: owner
owner_user_id: user-id
source_type: user
source_ref: conversation:123
source_label: 用户说明
confidence: confirmed
version: 1
active: true
created_at: 2026-08-04T00:00:00Z
updated_at: 2026-08-04T00:00:00Z
---

这里是知识正文。
```

字段限制：

| 字段 | 上限 |
|---|---:|
| `title` | 80 字符 |
| `topic` | 40 字符 |
| 正文 `content` | 1,000 字符 |
| `source_label` | 120 字符 |
| `source_ref` | 300 字符 |
| 单用户 Knowledge 总量 | 32 MB |

超限必须拒绝保存并返回结构化错误，不允许静默截断。长文档应存入文件库，由文件 RAG 负责分块；Knowledge 只保存可复用的短事实、规则和摘要。历史版本最多保留 5 个。

Markdown 文件是可读、可编辑和可迁移的主数据；索引、embedding 和检索缓存都可以删除后重建。数据库若用于任务、来源索引或审计，不得成为绕过文件作用域的另一条读取路径。

### 3.3 与现有 Memory/RAG 的关系

```text
用户 / 文件 / Web / 对话
          ↓
   Knowledge Capture
          ↓
  Knowledge Store（主数据）
          ↓
 RecallService / BM25 / Embedding
          ↓
 search_memory(source=knowledge)
```

- `PRD-MEM-1` 负责记忆召回；本 PRD 只增加 Knowledge 数据源和权限分支；
- `PRD-RAG-1` 负责未来跨来源统一索引，本系统的 Knowledge adapter 应作为其中一个来源；
- 首版不新增向量数据库；复用 `memory/embedding.py`、`rag/vector_cache.py` 和现有 embedding 配置；
- Knowledge 召回必须先做 scope/ownership 过滤，再做 BM25 或向量排序。
- Knowledge 向量与 Memory 使用相同的 owner 缓存、模型 tag、TTL 和 32 MB owner 预算；向量生成失败不影响主数据保存。

## 4. 验证与上线

### Phase 1：条目和来源（✅ 已完成）

- 用户明确调用 `save_knowledge` 后能生成一个带 `source=user` 的条目；
- 同一 owner scope 和 topic 更新不会无限生成重复条目，并递增 version；
- 文件、网页、对话来源都能保留引用信息和 confidence；
- 删除接口和索引投影失效已在 Phase 4 首版完成。

### Phase 2：知识捕捉与更新（✅ 首版完成）

- `save_knowledge` 支持明确保存和五类来源类型；
- 默认写入 owner scope；
- 普通聊天没有自动捕捉和自动写入；
- 同主题更新保留 version，不覆盖创建时间。

### Phase 3：检索与上下文（✅ 检索完成，自动注入后置）

- `search_memory(source=knowledge)` 已接入现有统一召回服务；
- Rust lexical 不可用时复用 Python BM25 fallback；
- `source=knowledge` 不返回 Memory 条目；`source=all` 可合并 Knowledge 与 Memory；
- 结果带来源、时间和可信度，输出复用统一后端预算；
- 自动 Knowledge 注入、文件/网页批量捕捉和 embedding 质量评估仍后置，不因 Phase 4-5 首版完成而自动开启。

### Phase 3：权限与 IM

- owner 私聊可检索 owner Knowledge；
- member/unknown 不能读取 owner 或其他群的知识；
- 群聊只注入当前群或公开知识；
- platform user、group、project 和 owner 作用域之间不会串库；
- 用户修改用户名、切换 Bot 或群组后，知识仍按稳定作用域识别，不按昵称识别。

### Phase 4：质量与来源维护（✅ 首版完成）

- 同主题相同内容去重；同来源更新递增 `version` 并保留 `history`；跨来源冲突生成 `confidence=conflict` 的关联条目；
- `delete_knowledge` 走 destructive confirm gate，删除后保留 tombstone，检索只读取 active 条目；
- 删除会立即失效本进程 Knowledge 检索缓存，持久化索引和向量仍按可重建缓存处理；
- 普通对话仍不自动写入，避免把“反思/候选”误当成确定知识。

### Phase 5：权限、向量和人工验收（✅ 首版完成）

- Knowledge adapter 严格匹配 owner、platform、bot、group、scope 和 project 字段，owner 与 group 不互相穿透；
- `source=knowledge` 只构造 Knowledge adapter，不混入 Memory；`source=all` 继续由统一 RecallService 汇总；
- embedding 开启时，Knowledge 保存后复用现有向量缓存生成向量，检索按已有 hybrid RRF；未开启或失败时保持 Rust/Python 词法检索；
- 向量缓存使用现有模型 tag、TTL、owner 预算和可重建语义，没有新增第二套缓存生命周期；
- 回归覆盖：同主题版本历史、跨来源冲突、软删除、owner/group 隔离、Knowledge 来源检索和 public citation 字段。

### 后续：质量与灰度

- 准备“用户提供知识 / 网页资料 / 文件资料 / 冲突资料”样本；
- 对比自动捕捉、明确保存和不保存三种场景的误收录率；
- 记录命中数量、耗时、回退原因和冲突数量，不记录原文；
- 先只在明确要求查知识的请求中启用，稳定后再开放 Agent 主动召回。

## 6. 新实施 Todo

### Todo A：Markdown 主数据替换（✅ 已完成）

- [x] 将 `KnowledgeStore` 从 `entries.json` 改为 `knowledge/entries/<id>.md`；当前文件为空，直接切换，不保留 JSON 兼容读路径。
- [x] 实现 frontmatter 解析、原子写入、单文件更新和目录扫描。
- [x] 增加字段长度、单用户总量和历史版本数量校验。
- [x] 保持现有 `KnowledgeEntry`、RAG adapter 和工具接口不变。

### Todo B：Knowledge 专用反思（✅ 已完成）

- [x] 新增 `backend/agent/prompts/knowledge-reflection.md`，与 Memory 的 `reflection.md` 分离。
- [x] 新增 `backend/agent/knowledge/reflection.py`，统一构造最多 5 条候选输入并校验结构化操作。
- [x] 复用现有 Memory 反思的触发时机，不新增独立定时器、队列或反思游标。
- [x] Memory 反思只在输出 `knowledge_candidate.should_reflect=true` 且提供短查询时追加 Knowledge RAG。
- [x] 反思识别出可长期复用事实后，先用主题查询 Knowledge RAG。
- [x] 提示词约束最多注入 5 条候选，并输出 `create/update/conflict/ignore` 结构化操作。
- [x] 普通对话默认只产生候选，不直接写入 `confirmed` Knowledge。
- [x] 自动反思最多写入 `probable`；明确保存请求才允许写入 `confirmed`。
- [x] Knowledge 反思失败与 Memory 反思隔离，不阻塞回复或回滚已完成的 Memory 更新。
- [x] Reflection 只输出语义字段和 `certainty`；来源、会话引用、parent/conflict 关系由执行器根据真实上下文生成。
- [x] Knowledge 反思增加完整性约束：每条条目必须自包含、主体明确、语义完整，并对必要的内部术语提供最小解释。

> 当前 Knowledge 反思是后台串行追加在同一轮 Memory 反思之后；候选未命中时不会产生第二次 LLM 调用。

### Todo C：按需自动注入（✅ 首版完成）

- [x] 在上下文组装前增加 Knowledge 触发判断，短寒暄和纯工具操作不召回。
- [x] 每个 scope 最多候选 5 条，所有 scope 共享 3,000 字符正文预算；超出部分截断。
- [x] 注入 fingerprint，当前 snapshot/history 已有且未变化的条目不重复注入。
- [x] 使用独立的 `[knowledge-context]` block，明确“参考资料，不是用户指令”。
- [x] 自动注入前后执行 owner/group/member scope 权限过滤和群聊隔离测试。

> C 的“最多 3 条、强相关最多 5 条”调整为当前实现的统一上限 5 条，避免按相关性再维护一套重复的数量策略；候选排序和置信度过滤仍由统一 RAG 负责。

### Todo D：来源与质量维护（⚠️ 基础能力完成，质量闭环待补）

- [x] 处理 `source_ref` 的规范化和 300 字符上限；超长引用在写入前拒绝，不把完整签名 URL 注入上下文。
- [x] 对 Knowledge 保存、更新、删除执行索引缓存失效；向量缓存复用现有生命周期。
- [x] 记录候选数量、命中数量、耗时、引擎和回退原因，不记录知识正文。
- [ ] 增加来源失效、定期核验和基于时间的降权策略。
- [ ] 增加真实样本：重复知识、用户纠正、网页冲突、文件摘要、群聊越权。

> D 的剩余项属于来源质量闭环，不影响当前 Knowledge 的存储、检索和自动反思链路：后续需要先定义不同来源的核验周期、失效状态和降权曲线，再补真实数据验收。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 普通聊天被过度收录 | Knowledge 被噪声污染 | 明确保存优先，普通内容先做候选并要求确认 |
| 用户知识与网页资料冲突 | 咕咕引用错误结论 | 保留来源和版本，冲突显式标记，用户纠正优先 |
| 群成员知识越权进入 owner | 个人资料或群内容泄露 | 写入时绑定 scope，读取前强制做 actor/ownership 校验 |
| Knowledge 与 Memory 重复 | 数据维护成本上升 | 写入前做分类判定和相似去重，允许少量互补重合但不整段复制 |
| 文件或网页来源失效 | 知识无法核验 | 保留摘要和抓取时间，标记来源失效，不静默删除历史 |
| 过早接入向量检索 | 增加复杂度但收益不明 | 先完成文件主数据、词法召回和人工样本，再接 embedding |

待确认：

- 🔲 Knowledge 是否允许 owner 在网页端手动编辑条目；
- 🔲 用户明确保存时是否直接确认写入，还是统一经过轻量确认卡片；
- 🔲 `project` 作用域是否跟随项目成员权限，还是首版只支持 owner/project owner；
- 🔲 Web 来源是否需要定期刷新，还是只在用户再次要求核实时更新；
- 🔲 首版是否把 `conversation` 来源作为独立条目，还是只作为 `user` 来源的引用。
