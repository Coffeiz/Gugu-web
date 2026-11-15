# Agent RAG

本目录按 Gugu 1.7.7 TypeScript RAG 职责组织：`adapters/` 投影来源文档，`ranking/` 执行 BM25/混合排序，`persistent-index.ts` 与 `persistent-writer.ts` 读写可重建索引，`rebuild-worker.ts` 消费持久任务，`scoped-search.ts` 组合授权、候选、向量和统一排序。Host 通过 `@gugu/core/agent` 导入来源工厂、持久读取器、Worker、受限查询与向量/embedding 契约；具体身份、scope、来源服务和传输仍由 Host 提供。

RAG 只使用 TypeScript 检索实现；Cython 是迁移期 Python 行为基准，不是 Node 运行时依赖。中文 tokenizer 保持 Jieba 词边界和 HMM=false 语义，实例由可信 Host 注入；未注入时拒绝检索。

迁移源为 Git tag `v1.7.7`（commit `14c544f1faf1193e8a073844af4a5d7a4872045c`）下的 `backend/ts/workers/rag`，仓库许可证为 Apache-2.0。旧 Worker 依赖 `@node-rs/jieba@2.0.1` 和 `ali-oss@6.23.0`；2.0 Core/Host 复用了 RAG 算法与适配逻辑，Jieba 仍由 Host 提供，OSS 依赖不迁入，因为 Host storage 使用授权 FS 端口。旧 Worker 协议、Data Runtime 和副作用责任不能直接沿用，已按 2.0 Core/Host 边界重接。

## 重建来源

| 来源 | 实现 | 读取边界 | 状态 |
| --- | --- | --- | --- |
| project | `project-source.ts` | Core 项目服务，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；Host 来源组经 SQLite 队列→Worker→正式索引回归；生产 Worker 已挂入 Host 启停生命周期，受正式 PG 迁移门控；生产 PG 未验收 |
| calendar | `calendar-source.ts` | Core 日历读取端口，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；生产 Worker 生命周期已接入，生产 PG 未验收 |
| note | `note-source.ts` | Mind 便签读取服务，包含 note/suggestion | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；生产 Worker 生命周期已接入，生产 PG 未验收 |
| scheduled_task | `scheduled-task-source.ts` | 定时任务共享读取服务 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；生产 Worker 生命周期已接入，生产 PG 未验收 |
| conversation | `conversation-index-source.ts`、`conversation-source.ts` | 持久重建按 owner 读取摘要/消息，保留 baseline、角色、群聊 scope 与相邻上下文；检索从历史事实表提供旧索引尚未覆盖的候选 | Core 来源和索引 Worker 已覆盖 SQLite；生产 Worker 生命周期已接入，Agent Run 尚未接入，PostgreSQL 尚未验收 |
| canvas | `canvas-source.ts` | Mind `listForRag` 查询；owner、存活画布/项/节点约束，按稳定 ID 分页 | 临时 SQLite 已真实读取并经持久 Worker 写索引；生产 Worker 生命周期已接入；Python 投影差分和生产 PG 未验收 |
| knowledge | `knowledge-source.ts` | Host 注入的 owner 授权 FS 读取 Markdown 主数据；DB 仅保存可重建索引投影 | Core 来源保留 Python record/version/scope 语义，并经真实 SQLite 持久 Worker 写入索引回归；Web Host 的生产 RAG Worker 在迁移门控通过后注入受限 FS reader，生产 PG 尚未验收 |
| memory | `memory-loader.ts`、`memory-scope-state.ts`（旧版读取/快照/向量准备及 SQL scope 状态） | Core 接收可信 owner/scope；Host 注入 owner-bound FS reader；SQL scope-state reader 仅读取完整 owner/scope key 的游标版本与 tombstone，不授予 scope 权限 | loader、SQL 状态查询和 Host 受限 FS reader 已实现并有隔离回归；尚未成为持久 Worker 来源或接入生产 Agent Run。群/成员 scope 枚举与授权端口未装配，不会用 owner 文件读取替代授权 |
| file | — | 旧版文件自动 RAG 索引按 2.0 决策退役；正文通过授权 FS 直读 | 退役；不把文件正文写入索引表 |

Worker 只领取传入来源表覆盖的任务。缺来源的任务不会成功确认。删除/归档后来源返回空文档，由持久 writer 写墓碑；Worker 在同一事务中 fence generation 与租约，并记录任务结果。

## 查询和安全

`scoped-search.ts` 在读取索引前和返回结果前都调用 Host 授权端口；scope 必须由 Host 提供，不能由工具输入决定。向量读取和 query embedding 均为可选可信端口；版本不匹配或缺向量时保留词法结果。Web Host 的 owner-bound 向量文件读取器只允许旧版三个固定路径并限制文件大小，但尚未接入生产 Agent。

`knowledge_index_entries` 已进入 Core schema 17 的 SQLite/PostgreSQL DDL。SQLite v1-v16 通过显式备份迁移升级。Web Host 提供 `migrate:rag-index:check` 与 `migrate:rag-index:apply` 显式 PostgreSQL 迁移命令；迁移校验列、唯一键与 owner 外键，并允许认领结构兼容的旧 Python 表。命令尚未作为部署步骤运行。迁移回归已写入，但 devserver 缺少 `GUGU_WEBUI_TEST_DATABASE_URL`，本轮两个 PostgreSQL 场景均跳过，因此不能声称生产数据库已升级。

## 生产接入状态

以下条件全部完成后才能把 RAG 标记为生产迁移完成：PostgreSQL 安全迁移已应用并验收、全部可支持来源和调度、可信 scope 授权、向量读取和受控 embedding，以及从实际 Agent Run 调用链验收。Host 已声明 `@node-rs/jieba@2.0.1`（与 1.7.7 依赖版本相同），并提供包内 dict tokenizer adapter；`createCoreAgentConversationSearchPort` 默认使用它，会话工具端到端测试使用真实 Jieba。该工具端口尚未由生产 Agent Run 组合。Host 单消费者调度器和七类来源 Worker 已进入 `main.ts` 启停生命周期，只有 `checkRagIndexMigration` 返回 `applied` 才启动；`pending` 或检查不可用时 Worker 明确保持关闭并记录脱敏状态，Web Host 其他服务继续启动。knowledge reader 已由生产入口注入，但仍需真实 PG/部署验证，不能据此声称生产消费者已实际运行。`search_memory` 已有 Web owner-only 与可注入可信 IM scope resolver 的工具边界及临时回归，但生产 Run 尚未注入 IM context、scope resolver、embedding 和授权服务；memory 持久索引重建来源、PG 来源回归、Python pytest 对照和 Agent Run 工具注册装配仍未完成。Core 工厂、测试替身及工具注册本身不代表完整生产接通。

`knowledge-source.ts` 复用 `AgentKnowledgeReadStore` 的可信 Host FS 端口，读取 owner 命名空间的知识 Markdown 并生成 Python 一致的 summary、keywords/description revision、scope 和 metadata；Web Host 的 `createLocalAgentKnowledgeReadStore` 通过 `@gugu/fs/node` 拒绝路径越界和符号链接，并限量分页/读取。生产 `main.ts` 只在索引迁移状态为 `applied` 时创建该 reader 并传给 Worker；这使 knowledge 进入生产来源集合，不替代真实 PG/部署验收。

`memory-loader.ts` 来自 Git tag `v1.7.7` 的 `backend/ts/workers/rag/src/memory-loader.ts`，已迁入 Core 并由 `@gugu/core/agent` 导出。它保留 owner 索引与 legacy memory 文件读取、daily 投影、group/member scope 校验、scope tombstone、snapshot 去重、TTL/LRU 和模型版本匹配向量读取。`memory-scope-state.ts` 复刻旧 Data Runtime 的 scope revision 与 tombstone 查询，按 owner/platform/bot/scope type/scope ID 完整键读取；它只读取状态，不提供授权。Core 行为回归现覆盖 loader 四项和 SQL scope 状态一项，使用隔离 SQLite；Host 临时目录安全回归 1/1。Web Host 受限 local FS reader 只允许 loader 使用的 owner namespace key，并拒绝路径越界、未知文件和符号链接。Web owner-only memory adapter 已把 SQL scope-state reader 和 storage reader 组合起来，但 Web scope resolver 只返回 owner scope，因而不会触发群/成员游标查询；IM scope 枚举/授权仍须由可信 Host 提供。该 loader 是查询时 memory 准备逻辑，不代表持久 memory 重建来源或生产 memory 检索已接通。

`search_conversations` 保持 Python 旧语义：有关键词时仅用 owner 限定的会话来源经 BM25 排序，不调用 embedding；无关键词时列 owner 最近对话。Node Host 的事实表适配器及持久索引适配器都经真实注册器 dispatch 在临时 SQLite 验证，使用真实 1.7.7 Jieba 词典及 HMM=false；但 `createAgentToolRegistry` 尚未进入生产 Agent Run 装配。支持向量的综合 RAG（如 `search_memory`）才读取版本匹配向量并调用受控 embedding。

当前新增的临时 SQLite 回归经 Host 会话适配器和真实工具注册器 dispatch，验证 owner 由运行身份提供、伪造 owner 参数无效、群聊不参与关键词检索、OR/AND、空结果、baseline 前仍保留的历史、字面 LIKE 元字符、授权拒绝不泄露正文及结果 snippet；分词使用真实 1.7.7 Jieba 2.0.1 和 HMM=false。隔离 PostgreSQL 工具用例因测试库未配置跳过。它证明工具边界的本地行为，不证明 PostgreSQL 生产调用链、向量召回或 Agent Run 已接通。

2026-11-15 后续：`memory-search.ts` 组合可信 `resolveScopes` / `authorize` 端口、snapshot、owner-bound storage、`prepareMemory`、可选 embedding 和共享 TS ranker；`tools/memory.ts` 提供 `search_memory` 参数 schema 与真实 dispatch 实现。Host registry 仅在显式注入完整 `MemorySearchPort` 时注册。Core dispatch 使用临时 memory index 和合成授权/scope/snapshot/embedding 做 4/4 行为测试，包含版本匹配向量文件进入 hybrid ranker；Web owner-only Host adapter 复用受限 FS reader 与 SQL scope-state reader。新增 `agent-memory-scopes.ts`，由 Host 注入可信 IM context，owner 限定查询 reflection cursor，并按 Python `resolve_memory_query_scopes` 规则处理 owner/member、current_group、all_my_groups 和范围上限；其临时 SQLite/FS 用例经过 Host 注册器真实 dispatch 验证跨群和同成员隔离。该回归同时发现并修复了 transient lexical index 的两个行为问题：已授权的 group/member 文档被重复 owner scope 过滤，以及不同 scope 的相同 source key 在索引 map 中相互覆盖。Core RAG 定向测试 9/9、Host RAG 定向测试 4/4 通过。Host embedding 仍可通过 `createPostgresAgentRagEmbeddingPort` 使用 owner credential resolver 和 Node 受限 Transport；BYOK gate 在凭据查询、解密完成和发送 embedding 请求前检查。测试只使用临时 SQLite/FS、合成 IM context/cursor/授权/凭据和 mock Provider；真实 PostgreSQL、密钥服务、Provider、生产 Agent Run caller 和生产 IM context 注入尚未验收。

Python 工具/pytest 和固定质量语料是行为基线。行为或安全差异需要在 `docs/testing/node-agent-tools-parity.md` 记录；合成授权、向量、embedding、时间和数据库只可作为隔离回归依赖，不能描述成真实平台验收。
