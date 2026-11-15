# Agent RAG

本目录按 Gugu 1.7.7 TypeScript RAG 职责组织：`adapters/` 投影来源文档，`ranking/` 执行 BM25/混合排序，`persistent-index.ts` 与 `persistent-writer.ts` 读写可重建索引，`rebuild-worker.ts` 消费持久任务，`scoped-search.ts` 组合授权、候选、向量和统一排序。Host 通过 `@gugu/core/agent` 导入来源工厂、持久读取器、Worker、受限查询与向量/embedding 契约；具体身份、scope、来源服务和传输仍由 Host 提供。

RAG 只使用 TypeScript 检索实现；Cython 是迁移期 Python 行为基准，不是 Node 运行时依赖。中文 tokenizer 保持 Jieba 词边界和 HMM=false 语义，实例由可信 Host 注入；未注入时拒绝检索。

## 重建来源

| 来源 | 实现 | 读取边界 | 状态 |
| --- | --- | --- | --- |
| project | `project-source.ts` | Core 项目服务，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；未接生产调度 |
| calendar | `calendar-source.ts` | Core 日历读取端口，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；未接生产调度 |
| note | `note-source.ts` | Mind 便签读取服务，包含 note/suggestion | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；未接生产调度 |
| scheduled_task | `scheduled-task-source.ts` | 定时任务共享读取服务 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；未接生产调度 |
| conversation | `conversation-index-source.ts`、`conversation-source.ts` | 持久重建按 owner 读取摘要/消息，保留 baseline、角色、群聊 scope 与相邻上下文；检索从历史事实表提供旧索引尚未覆盖的候选 | Core 来源和索引 Worker 已覆盖 SQLite；未接生产调度或 Agent Run，PostgreSQL 尚未验收 |
| canvas | `canvas-source.ts` | Mind `listForRag` 查询；owner、存活画布/项/节点约束，按稳定 ID 分页 | 临时 SQLite 已真实读取并经持久 Worker 写索引；Python 投影差分、PostgreSQL 和生产调度未验收 |
| memory / knowledge / file | — | 需要 Host 授权的本地 FS 或已迁移领域服务 | 依赖未就绪；不会以假内容补位 |

Worker 只领取传入来源表覆盖的任务。缺来源的任务不会成功确认。删除/归档后来源返回空文档，由持久 writer 写墓碑；Worker 在同一事务中 fence generation 与租约，并记录任务结果。

## 查询和安全

`scoped-search.ts` 在读取索引前和返回结果前都调用 Host 授权端口；scope 必须由 Host 提供，不能由工具输入决定。向量读取和 query embedding 均为可选可信端口；版本不匹配或缺向量时保留词法结果。Web Host 的 owner-bound 向量文件读取器只允许旧版三个固定路径并限制文件大小，但尚未接入生产 Agent。

`knowledge_index_entries` 已进入 Core schema 17 的 SQLite/PostgreSQL DDL。SQLite v1-v16 通过显式备份迁移升级。Web Host 提供 `migrate:rag-index:check` 与 `migrate:rag-index:apply` 显式 PostgreSQL 迁移命令；迁移校验列、唯一键与 owner 外键，并允许认领结构兼容的旧 Python 表。命令尚未作为部署步骤运行。迁移回归已写入，但 devserver 缺少 `GUGU_WEBUI_TEST_DATABASE_URL`，本轮两个 PostgreSQL 场景均跳过，因此不能声称生产数据库已升级。

## 生产接入状态

以下条件全部完成后才能把 RAG 标记为生产迁移完成：PostgreSQL 安全迁移、正式 Jieba 依赖、全部可支持来源装配与调度、可信 scope 授权、向量读取和受控 embedding，以及从实际 Agent Run 调用链验收。当前仍无 Node RAG 生产消费者或生产 Agent 装配；Core 工厂、测试替身及工具注册均不代表生产已接通。Host 单消费者调度器已新增，并经临时 SQLite 的真实队列、Core 持久 Worker 和正式索引表验证；但尚未装入生产组合根。正式 Jieba、知识/记忆可信来源、PG 来源回归和完整 Python 来源 pytest 对照仍未完成。

`search_conversations` 保持 Python 旧语义：有关键词时从当前 owner 的会话事实表直接检索并经统一 BM25 排序，不读历史持久向量；无关键词时列 owner 最近对话。该工具的 Node Host 适配器和实际工具 dispatch 已经临时 SQLite 验证，但还未接到生产 Agent Run。综合 RAG 才使用持久索引、向量来源与受控 embedding。

当前新增的临时 SQLite 回归经 Host 会话适配器和真实工具注册器 dispatch，验证 owner 由运行身份提供、群聊不参与关键词检索、OR/AND、空结果及正文 snippet；分词器使用固定切词替身。隔离 PostgreSQL 工具用例因测试库未配置跳过。它证明工具边界的本地行为，不证明 PostgreSQL 生产调用链、真实 Jieba、向量召回或 Agent Run 已接通。

Python 工具/pytest 和固定质量语料是行为基线。行为或安全差异需要在 `docs/testing/node-agent-tools-parity.md` 记录；合成授权、向量、embedding、时间和数据库只可作为隔离回归依赖，不能描述成真实平台验收。
