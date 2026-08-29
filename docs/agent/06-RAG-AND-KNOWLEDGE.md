# RAG 与 Knowledge 架构

> 本文描述当前 Gugu Agent 的知识召回、索引和上下文注入边界。RAG 负责从已授权来源召回候选，Knowledge 负责结构化知识的生命周期；两者都不直接替代权限系统或 Agent Loop。

## 1. 架构定位

```text
业务来源 / Memory / Conversation / Knowledge
                    |
            source adapter / projection
                    |
              Python RAG service
             /       |        \
       scope ACL   hybrid    injection
                    |
          Python index / TS lexical worker
                    |
             Context Assembly
                    |
               Agent Provider
```

- **Knowledge** 是可保存、可版本化、可追溯的结构化知识主数据。
- **RAG** 是召回链路，负责索引、检索、过滤、融合、排序和当前轮注入。
- **Memory** 是用户长期信息来源；Conversation、Project、File、Canvas 和 Note 是其他可检索来源，但各来源的统一 RAG 接入状态不同，见第 2.1 节。
- **Context Assembly** 只消费 RAG 返回的结构化结果，不自行查询数据库或复制权限逻辑。

## 2. 来源与适配器

当前 Python 侧通过 source adapter 把不同来源转换为统一 `IndexDocument`：

| 来源 | 作用 | 典型模块 |
|---|---|---|
| conversation | 检索历史对话和已持久化消息 | `rag/adapters/conversations.py` |
| memory | 检索个人、群组和成员记忆 | `rag/adapters/memory.py`、`memory/` |
| knowledge | 检索已保存知识条目 | `rag/adapters/knowledge.py`、`knowledge/` |
| project | 检索项目元数据和项目范围内容 | `rag/adapters/projects.py` |
| file | 检索已索引的项目文件 | `rag/adapters/indexed_sources.py`（`source_type=file`） |
| canvas | 检索画布上的节点、便签、关系和分组信息 | `rag/index_builder.py`、`rag/adapters/indexed_sources.py`（`source_type=canvas`） |
| note | 检索时间流普通笔记和 suggestion 节点 | `rag/index_builder.py`；显式工具仍走 `tools/mind.py` |

### 2.1 当前来源接入状态

“能够建立索引”不等于“已经接入统一 RAG”。当前实现状态如下：

| 来源 | 索引构建 | `search_knowledge()` | 自动跨来源召回 | 当前说明 |
|---|---:|---:|---:|---|
| conversation | 已完成 | 已接入 | 已接入 | 有 watermark，排除当前消息 |
| file | 已完成 | 已接入 | 可按配置启用 | 通过持久化索引和 TS lexical worker |
| canvas | 已完成 | 已接入 | 可按配置启用 | 画布节点及其关系作为 `canvas` 来源 |
| note | 已完成 | 已接入 | 默认接入，可按配置关闭 | 统一入口按 owner scope 检索 `MindNode` 的 note/suggestion chunk；`note_search` 继续保留节点关系查询语义 |
| project | 已完成 | 已接入 | 可按配置启用 | 使用项目检索器 |
| memory / knowledge | 已完成 | 已接入 | 已接入 | 分别由 Memory 和 Knowledge adapter 负责 |

普通时间流笔记现在已经接入统一检索入口；画布中的内容不应与普通笔记混淆，前者通过 `canvas` 来源参与统一召回，后者通过 `note` 来源参与统一召回。`note_search` 仍保留节点关系邻居和节点级详情语义，不能简单视为统一 RAG 的别名。

### 2.2 信息切块与 RAG 注入

不同来源共享同一套 chunk 契约，但按内容结构选择投影字段和父文档粒度：

| 来源 | 切块输入 | 默认切块方式 | 父文档 / 元数据 | 注入与展示 |
|---|---|---|---|---|
| conversation | 已持久化消息正文 | 按消息投影，再按通用段落/句子规则切分 | session/message、消息水位、角色和时间 | 自动召回受 watermark 约束；结果带 conversation citation |
| memory | profile、pattern、daily、长期记忆 | 按记忆条目或 daily 行拆分，再按通用规则切分 | 记忆类型、scope、版本 | Memory adapter 直接参与统一召回 |
| knowledge | KnowledgeEntry 标题、正文和来源 | 按 Markdown section，再按段落/句子切分 | entry、source、version、parent | Knowledge adapter 参与统一召回，保留来源 citation |
| project | 项目标题、描述、阶段和客户等字段 | 按项目投影字段组合后切分 | project、scope、更新时间 | Project adapter 参与统一召回 |
| file | 文件名、类型、项目/目录元数据和可抽取正文 | 元数据 + 文本正文按通用规则切分；不支持的文件仅保留元数据 | file、project、folder、version | File retriever 召回，正文由 Python 回填 |
| canvas | 画布节点正文、关系摘要和分组路径 | 节点投影后按通用规则切分 | canvas item、node、map、relation | Canvas retriever 召回，保留画布关系上下文 |
| note | 标题 + `content_plain`（无纯文本时使用 `content_md`） | 按空行拆段、句末标点/换行拆句；最多 1400 字符，120 字符 overlap | `note:<node_id>`、`chunk_index`、`chunk_count`、版本和内容指纹 | Note retriever 按 owner scope 召回；`note_search` 继续提供节点关系查询 |

通用 `rag/chunking.py` 的默认规则是：优先按段落和句子边界切分；超长单句按固定窗口切分；相邻 chunk 保留有限 overlap。每个 chunk 都保留 `source_type`、`source_id`、`parent_document_id`、版本、序号和内容指纹，保证增量更新、去重和 citation 稳定。

所有来源统一经过以下注入链路：

```text
业务来源变更事件
        -> 增量重建来源 chunks
        -> TS lexical worker 建立/patch 来源索引
        -> search_knowledge(source=all 或 note)
        -> owner scope / ACL 过滤
        -> 按 parent document 去重并合并相邻高分 chunk
        -> 正文与 citation 回填
        -> 共享字符预算后注入 knowledge-context
```

注入时以 chunk 作为召回粒度、以父文档作为展示和去重粒度：同一来源命中多个相邻 chunk 时优先合并为一个结果，保留命中片段、来源和序号；不能因为 chunk overlap 把同一段内容重复注入。不同来源还必须分别补充 owner/ACL 隔离、删除后不再召回、版本更新、相邻 chunk 去重和自动召回回归测试。

Adapter 负责读取和投影，不负责扩大用户权限。业务对象的 ownership、scope 和可见性在进入检索器前已经确定。

## 3. 统一数据契约

RAG 内部以 `Scope`、`IndexDocument` 和 `RecallCandidate` 传递数据：

- `Scope` 表示 owner、平台、bot、群组、成员和业务 scope 的硬边界。
- `IndexDocument` 表示可检索的文档或 chunk，包含 source、version、chunk 和内容指纹。
- `RecallCandidate` 保留来源内 raw score、rank、normalized/fused score 和 confidence，避免把不同检索器的原始分数直接横向比较。

返回给工具或上下文时只暴露标题、摘要、正文、来源、版本、更新时间和 citation 等最小结构，不暴露内部 ACL 元数据、密钥或诊断正文。

## 4. Scope 与权限

```text
当前请求身份 / IM context
        -> 确定性 scope 解析
        -> owner / group / member scope
        -> source adapter 查询
        -> matches_scope 硬过滤
        -> 结果预算与去重
```

RAG 不信任模型自行传入的用户、群号或成员身份。Web 和 owner 私聊默认使用 owner scope；群聊根据 owner/member 身份和配置生成 group/member scope。跨群召回只有在明确 scope 且通过服务端 cursor/归属校验时才允许。

权限过滤必须发生在正文回填和注入之前。TS worker 只接收已经划定 scope 的索引请求，不负责 ACL、ownership 或授权决策。

## 5. 索引与 TS lexical worker

TypeScript worker 是固定 Node 制品，不是完整后端：

```text
Python 构建/投影 chunk
        -> JSONL replace / patch
        -> TS worker Jieba + ASCII entity tokenizer
        -> BM25 lexical search / score filter
        -> 稳定 candidate ID + score
        -> Python 回填正文和 citation
```

worker 使用 `backend/ts/packages/contracts/src/rag.ts` 作为协议契约，支持 `ping`、`replace`、`patch`、`search` 和 `score_filter`。`patch` 只同步发生变化的 chunk slot，文档版本变化不会让未变化 chunk 被误判为新文档。

worker 不访问网络、不输出业务正文、不做权限授权；运行时使用随制品发布的分词依赖，不能在 devserver 或 Docker 运行时临时编译 TypeScript。

### 5.1 TS 模块职责

TS 模块是 RAG 的确定性 lexical sidecar，职责限定在“索引操作和候选计算”，不承载业务语义。具体包括：

- **协议处理**：解析并校验 JSONL `ping`、`replace`、`patch`、`search`、`score_filter` 请求，返回稳定的结构化结果和协议错误。
- **索引维护**：按 owner/source 建立和替换索引，应用 chunk 增量 patch，维护 revision 与 candidate ID 的稳定映射。
- **文本处理**：执行 Jieba 中文分词、ASCII entity tokenizer、规范化和必要的 token 统计；不修改 Python 传入的业务正文。
- **词法检索**：执行 BM25 lexical search、候选截断、基础 score filter，并返回 candidate ID、原始分数和排序位置。
- **运行时隔离**：作为固定 Node 制品运行，不访问数据库、网络、文件业务存储或用户配置，不读取 API Key 和会话上下文。

TS 模块明确不负责：

- ownership、ACL、群组/成员 scope 和跨用户隔离；
- 判断来源是否允许被自动召回，或决定结果是否注入上下文；
- 正文、附件、citation 和业务对象的读取与回填；
- embedding 生成、向量数据库、Knowledge/Memory 写入和反思决策；
- 重试、取消、超时补偿、索引事件编排和数据库事务。

上述职责由 Python RAG service、source adapter、Context Assembly 和应用事件层完成。Python 侧必须在请求进入 TS worker 前完成来源范围划定，并在收到候选后再次执行 scope 过滤、正文回填、去重、预算控制和 citation 组装。

## 6. 检索策略

当前 RAG 支持 lexical、vector 和 hybrid 相关路径：

- lexical 使用 Jieba/BM25，适合低延迟自动召回和关键词明确的查询；
- vector 通过 embedding 与 vector cache 提供语义候选；
- hybrid 对多个来源候选执行归一化、融合、去重、质量和字符预算处理；
- source、scope、版本和内容指纹在融合前后都要保留，便于 citation 和诊断。

检索器只返回候选，不直接决定是否写入 Memory 或 Knowledge。低质量、空正文、越过 scope 或超过预算的结果在注入前丢弃。

## 7. 自动召回与显式搜索

### 自动召回

每条用户消息最多执行一次低成本自动召回，默认受 `search.rag_enabled` 控制，并使用当前消息之前的 conversation watermark：

```text
当前用户消息已落库
        -> 设置 before-message watermark
        -> 按请求 scope 召回
        -> 去重、过滤、共享字符预算
        -> 生成当前轮 knowledge-context
        -> watermark 恢复
```

自动召回失败或超时只跳过可选上下文，不阻塞主 Agent；后台任务必须自行收尾并释放数据库连接。当前消息不能被本轮自动召回再次注入。

### 显式搜索

`search_memory`、Knowledge 和其他搜索工具是模型明确选择的工具调用，结果进入 canonical tool round，具有完整结果和可追溯事件。自动召回的轻量上下文不能替代显式搜索。

## 8. Context 注入边界

RAG 结果在统一 Context Assembly 中进入本轮 turn batch 或 provider-only 动态上下文：

- 召回正文、来源和 citation 是当前请求事实，不自动成为长期 Memory/Knowledge；
- 已注入结果按内容指纹去重，避免历史和本轮重复注入；
- RAG 结果不能覆盖系统提示词、权限信息或工具 Schema；
- 结果的来源分数不是事实置信度，模型不得把 score 当作结论可信度；
- 自动召回只提供参考，不代表系统已经验证或执行了来源内容。

## 9. Knowledge 生命周期

Knowledge 主数据由 `KnowledgeEntry`、`KnowledgeScope` 和 `KnowledgeSource` 组成，保存标题、正文、主题、来源、confidence、version、parent 和历史版本。

```text
创建 / 更新
   -> owner scope 校验
   -> 内容与来源字段校验
   -> 同主题/同来源冲突处理
   -> version / history / parent
   -> 持久化 Markdown storage
   -> 索引更新事件
```

KnowledgeStore 使用用户隔离的存储前缀和 frontmatter；条目有长度、历史条数和总容量限制。相同内容不会重复写入；不同来源对同一主题产生冲突时保留冲突关系，不能静默覆盖事实。

Knowledge 的长期保存由显式工具或反思流程决定。RAG 召回只是读取当前可用内容，不代表内容自动升级为 confirmed Knowledge。

## 10. Memory、Knowledge 与 Conversation 的区别

| 类型 | 关注点 | 生命周期 |
|---|---|---|
| Conversation | 用户与 Agent 已发生的对话事实 | 会话历史，受 baseline/压缩管理 |
| Memory | 与用户、群组或成员相关的长期信息和模式 | 由记忆/反思流程维护 |
| Knowledge | 可引用的规则、资料、结论和来源 | 版本化、可追溯、可产生冲突 |

三者可以共享 RAG 检索基础设施，但不能在没有转换和归属校验的情况下互相当作同一种数据。

## 11. 缓存与增量更新

RAG 相关缓存包括索引 cache、snapshot cache、vector cache 和持久化 worker 索引。缓存 key 必须包含用户/来源/scope/版本等稳定身份；内容或结构变化时通过 revision、content hash 或 patch 失效。

资源变更由应用事件触发索引增量更新；worker 失败不能伪造索引已更新，Python 侧保留可重试或补偿路径。垃圾回收只清理确认不再被引用的索引或 chunk，不删除业务主数据。

## 12. 诊断与安全

应区分记录：

- 查询来源、scope 类型、候选数量和过滤原因；
- lexical/vector/hybrid 的耗时和分项分数；
- 是否注入、注入字符预算和去重数量；
- TS sidecar 可用性、超时、协议错误和索引 revision。

日志只能使用脱敏标识、digest、计数和结构化错误分类，不记录用户正文、附件名、完整 Knowledge 内容或凭据。对用户可见的错误应给出通用失败说明，详细原因进入受限诊断。

## 13. 当前限制与后续方向

- Capability RAG 与内容 RAG 是不同问题：前者推荐工具能力，后者召回知识内容，不能共用权限语义。
- TS worker 当前是 lexical sidecar，不负责 embedding、业务权限或正文存储。
- 自动召回默认低成本、可选且可超时跳过；显式搜索仍是完整查询入口。
- Knowledge 的 workspace/team scope、复杂冲突解决和更完整的质量评估仍需后续专题定义。
- 具体协议和阈值以 `backend/agent/rag/`、`backend/agent/knowledge/`、TS worker 测试和相关 PRD 为准。
