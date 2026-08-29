# 统一知识系统

> 状态：设计完成，待评估
> 创建：2026-08-04
> 最近更新：2026-08-04
> 关联模块：`backend/agent/knowledge/`、`backend/agent/memory/`、`backend/agent/tools/global_search.py`、`backend/agent/tools/files.py`
> 关联文档：[`PRD-RAG-1-统一知识召回与索引.md`](./PRD-RAG-1-统一知识召回与索引.md)、[`PRD-MEM-1-记忆召回工具与混合检索.md`](./PRD-MEM-1-记忆召回工具与混合检索.md)、[`11-记忆系统.md`](../../agent/11-记忆系统.md)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：知识边界与来源协议 | ✅ 已完成 | 已确定 Knowledge 与 Memory 分离，并纳入用户主动提供的知识 |
| Phase 1：文件存储与知识条目模型 | 🔲 待评估 | 建立知识条目、来源、作用域和版本结构 |
| Phase 2：知识捕捉与更新 | 🔲 待评估 | 支持用户明确保存、文件导入和联网资料保存 |
| Phase 3：知识检索工具 | 🔲 待评估 | `search_memory` 增加 knowledge scope，必要时提供独立入口 |
| Phase 4：反思、去重与来源维护 | 🔲 待评估 | 处理重复、矛盾、过期和来源可信度 |
| Phase 5：权限、向量和人工验收 | 🔲 待评估 | 接入现有 RAG/embedding 能力并完成跨场景验证 |

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

### FR-KNOWLEDGE-1：知识条目与作用域（待实现）

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

### FR-KNOWLEDGE-2：知识来源和可追溯性（待实现）

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

### FR-KNOWLEDGE-3：知识捕捉策略（待实现）

知识捕捉分为三种强度：

1. **明确保存**：用户说“记住这个”“以后按这个规则”“把这条加入知识库”时，直接进入待确认或已确认知识。
2. **工具结果保存**：用户要求保留搜索结果、文件资料或项目规则时，保存整理后的条目和来源，不直接保存整页原文。
3. **被动候选**：普通对话中出现的事实只生成候选，不自动写入长期 Knowledge；需要用户确认、重复出现或达到可信度阈值后才晋升。

Agent 不得因为一次普通聊天或一次未经核实的搜索结果，自动把内容当成确定知识。

### FR-KNOWLEDGE-4：知识更新、去重与矛盾（待实现）

- 同主题知识优先更新已有条目，不按每次对话新增重复文件；
- 内容变化保留版本关系和来源，不覆盖掉唯一的历史依据；
- 新来源与旧知识冲突时标记为 `conflict`，不能静默覆盖；
- 用户明确纠正时，新的用户来源优先级高于旧的 `web` 或 `derived` 来源；
- 过期资料保留历史版本，但默认检索排序降低其权重；
- 删除知识必须经过确认，并级联处理向量、索引和派生条目。

### FR-KNOWLEDGE-5：知识检索（待实现）

优先扩展现有 `search_memory`：

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

### FR-KNOWLEDGE-6：上下文注入（待实现）

Knowledge 默认不全量注入每轮上下文，只在以下情况召回：

- 用户询问某个事实、规则、术语或过去保存的资料；
- Agent 正在处理与知识条目明确关联的项目或文件；
- 用户明确要求查知识库。

注入内容必须带来源和时间。群聊中只注入当前群或公开作用域的知识，不能把 owner 私聊知识作为普通群上下文的一部分。

## 3. 技术方案

### 3.1 推荐目录

首版采用文件作为 Knowledge 主数据，索引和向量作为可重建缓存：

```text
.agent/
└── knowledge/
    ├── entries/
    │   └── <scope>/<topic>.md
    ├── index.json
    ├── sources.json
    └── tombstones.json
```

代码职责建议：

```text
backend/agent/knowledge/
├── models.py       # 条目、来源、作用域和版本模型
├── store.py        # 文件主数据读写、版本与墓碑
├── capture.py      # 用户/文件/web/对话来源转知识候选
├── reconcile.py    # 去重、冲突和来源合并
├── recall.py       # Knowledge 检索适配，复用通用召回底座
└── prompts.py      # 提炼、确认和冲突处理提示
```

`memory/` 继续负责 profile、pattern、daily、memory 和 IM scope 记忆；它可以调用 `knowledge.capture`，但不拥有 Knowledge 文件。

### 3.2 条目结构

```json
{
  "id": "knowledge-uuid",
  "title": "项目消息协议",
  "content": "……",
  "tags": ["项目", "协议"],
  "scope": {
    "type": "owner",
    "owner_user_id": 1,
    "project_id": 19
  },
  "source": {
    "type": "user",
    "ref": "conversation:123",
    "label": "用户说明"
  },
  "confidence": "confirmed",
  "version": 1,
  "created_at": "2026-08-04T00:00:00Z",
  "updated_at": "2026-08-04T00:00:00Z"
}
```

正文文件是可读、可编辑和可迁移的主数据；`index.json`、embedding 和检索缓存都可以删除后重建。数据库若用于任务、来源索引或审计，不得成为绕过文件作用域的另一条读取路径。

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
- 首版不新增向量数据库；复用 `memory/embedding.py` 和现有 embedding 配置；
- Knowledge 召回必须先做 scope/ownership 过滤，再做 BM25 或向量排序。

## 4. 验证与上线

### Phase 1：条目和来源

- 用户明确说“记住这条知识”后能生成一个带 `source=user` 的条目；
- 同一主题更新不会无限生成重复条目；
- 文件、网页、对话来源都能保留引用信息；
- 删除条目后正文、索引、向量和派生条目不会继续被召回。

### Phase 2：检索与上下文

- `search_memory(source=knowledge)` 能在无 embedding 时返回关键词匹配；
- 配置 embedding 后能混合召回，服务失败时退回词法检索；
- `source=knowledge` 不返回 Memory 条目；`source=all` 遵守同一权限过滤；
- 结果带来源、时间和可信度，输出不超过后端预算。

### Phase 3：权限与 IM

- owner 私聊可检索 owner Knowledge；
- member/unknown 不能读取 owner 或其他群的知识；
- 群聊只注入当前群或公开知识；
- platform user、group、project 和 owner 作用域之间不会串库；
- 用户修改用户名、切换 Bot 或群组后，知识仍按稳定作用域识别，不按昵称识别。

### Phase 4：质量与灰度

- 准备“用户提供知识 / 网页资料 / 文件资料 / 冲突资料”样本；
- 对比自动捕捉、明确保存和不保存三种场景的误收录率；
- 记录命中数量、耗时、回退原因和冲突数量，不记录原文；
- 先只在明确要求查知识的请求中启用，稳定后再开放 Agent 主动召回。

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
