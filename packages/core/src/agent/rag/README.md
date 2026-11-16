# Agent RAG

本目录按 Gugu 1.7.7 TypeScript RAG 职责组织：`adapters/` 投影来源文档，`ranking/` 执行 BM25/混合排序，`persistent-index.ts` 与 `persistent-writer.ts` 读写可重建索引，`rebuild-worker.ts` 消费持久任务，`scoped-search.ts` 组合授权、候选、向量和统一排序。Host 通过 `@gugu/core/agent` 导入来源工厂、持久读取器、Worker、受限查询与向量/embedding 契约；具体身份、scope、来源服务和传输仍由 Host 提供。

RAG 只使用 TypeScript 检索实现；Cython 是迁移期 Python 行为基准，不是 Node 运行时依赖。中文 tokenizer 保持 Jieba 词边界和 HMM=false 语义，实例由可信 Host 注入；未注入时拒绝检索。

迁移源为 Git tag `v1.7.7`（commit `14c544f1faf1193e8a073844af4a5d7a4872045c`）下的 `backend/ts/workers/rag`，仓库许可证为 Apache-2.0。旧 Worker 依赖 `@node-rs/jieba@2.0.1` 和 `ali-oss@6.23.0`；2.0 Core/Host 复用了 RAG 算法与适配逻辑，Jieba 仍由 Host 提供，OSS 依赖不迁入，因为 Host storage 使用授权 FS 端口。旧 Worker 协议、Data Runtime 和副作用责任不能直接沿用，已按 2.0 Core/Host 边界重接。

## 重建来源

| 来源 | 实现 | 读取边界 | 状态 |
| --- | --- | --- | --- |
| project | `project-source.ts` | Core 项目服务，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；Host 来源组经 SQLite 队列→Worker→正式索引回归；生产 Worker 已挂入 Host 启停生命周期，项目变更有 Host 持久任务生产者；受正式 PG 迁移门控，生产 PG 未验收 |
| calendar | `calendar-source.ts` | Core 日历读取端口，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；生产 Worker 生命周期已接入，生产 PG 未验收 |
| note | `note-source.ts` | Mind 便签读取服务，包含 note/suggestion | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；便签 create/update/delete/restore 在业务事务中排入持久任务，生产 Worker 生命周期已接入，生产 PG 未验收 |
| scheduled_task | `scheduled-task-source.ts` | 定时任务共享读取服务 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；已发现的 Host create/update/delete、一次性完成删除、项目回收/过期与工作区解绑写入排入 RAG 队列；Core 一次性任务删除、工作区解绑、日历提醒改期/禁用及 Undo/redo 现在复用 `scheduled-tasks/rag-index-job.ts` 在主事务中排队；Host 日历撤销/重做路径也有 PG 入队回归；本轮 Core 与 Host PG 事务回归尚未在 devserver 验收 |
| conversation | `conversation-index-source.ts`、`conversation-source.ts` | 持久重建按 owner 读取摘要/消息，保留 baseline、角色、群聊 scope 与相邻上下文；检索从历史事实表提供旧索引尚未覆盖的候选 | Core 来源和索引 Worker 已覆盖 SQLite；Web 用户消息准备与 Canonical 历史终态写入均在原 PostgreSQL 事务排入 owner 级全量会话重建，避免将 message ID 当成来源 ID；新增 PG 事务回归尚未在隔离 PostgreSQL 环境运行。生产 Worker 生命周期已接入，但 Agent Run 尚未装配，生产 PG 尚未验收 |
| canvas | `canvas-source.ts` | Mind `listForRag` 查询；owner、存活画布/项/节点约束，按稳定 ID 分页 | 临时 SQLite 已真实读取并经持久 Worker 写索引；画布和索引文本相关的便签/项/画布变更、删除与 Undo/redo 在业务事务中排入全来源或文档任务；生产 Worker 生命周期已接入；Python 投影差分和生产 PG 未验收 |
| knowledge | `knowledge-source.ts` | Host 注入的 owner 授权 FS 读取 Markdown 主数据；DB 仅保存可重建索引投影 | Core 来源保留 Python record/version/scope 语义，并经真实 SQLite 持久 Worker 写入索引回归；Web Host 的生产 RAG Worker 在迁移门控通过后注入受限 FS reader。`read_knowledge` Core 工具与 Web owner-only 搜索 port 已有真实索引 dispatch 回归，但未进入生产 Agent Run。Node knowledge 写路径尚未排入 RAG 持久队列，生产 PG 尚未验收 |
| memory | `memory-loader.ts`、`memory-scope-state.ts`、`memory-source.ts` | Host 以 owner 限定读取 `memory_reflection_cursors` 枚举重建候选；Core loader 从 owner-bound FS 读取 1.7.7 memory index/legacy 文件及 group/member 文件；完整 owner/scope 状态和 tombstone 由 SQL reader 复核 | Core memory 来源可投影到正式索引；生产 Worker 已注入 `memoryStorageRoot`。“清除记忆”路由在 owner `.agent` 删除成功后，会在同一事务递增 memory rebuild generation 并立即墓碑化旧持久投影，避免等待 Worker 期间继续召回已清理正文；普通 memory 文件更新事件仍未接入。可信 IM scope 授权和查询端口也未接入生产 Run，因此不是已完成的生产检索来源 |
| file | — | 旧版文件自动 RAG 索引按 2.0 决策退役；正文通过授权 FS 直读 | 退役；不把文件正文写入索引表 |

Worker 只领取传入来源表覆盖的任务。缺来源的任务不会成功确认。删除/归档后来源返回空文档，由持久 writer 写墓碑；Worker 在同一事务中 fence generation 与租约，并记录任务结果。

## 查询和安全

`scoped-search.ts` 在读取索引前和返回结果前都调用 Host 授权端口；scope 必须由 Host 提供，不能由工具输入决定。向量读取和 query embedding 均为可选可信端口；版本不匹配或缺向量时保留词法结果。Web Host 的 owner-bound 向量文件读取器只允许旧版三个固定路径并限制文件大小，但尚未接入生产 Agent。

`vector-reader.ts` 复用 1.7.7 向量文件解析生命周期：每次从授权 Host reader 读取当前文件，按 owner、文件种类和 embedding 版本缓存解析结果，以文件内容 SHA-256 变化失效，进程内 LRU 上限 8 且不设 TTL。该缓存只存解析后的派生向量映射，不替代 owner 路径授权或 freshness producer。`scoped-search.test.ts` 经实际 hybrid 查询验证文件更新后融合结果立即变化。

`search_conversations` 按 Python `ConversationAdapter.retrieve` 保持独立的 BM25 事实表路径：Host `createCoreAgentConversationSearchPort` 调用 `createSqlRagConversationSearch`，SQL 在可信 owner 下排除群会话和非 user/assistant 消息、每个会话只取最新命中，再交给 TypeScript RAG ranker。它会搜索 baseline 之前仍留在事实表的历史，不读压缩后的持久索引；持久索引继续用于重建及其他 RAG 来源。Host 工具链已在临时 SQLite 经注册器 dispatch 和 AgentRuntime Runner 验证，真实生产 Run 尚未装配。

`read_knowledge` 已有 Core 工具组和 Web Host 适配器：按 ID 读取时通过 owner-bound FS reader 解析完整 Markdown 正文和版本；关键词搜索经 `createSqlRagPersistentIndexReader` 与 `createScopedRagSearch` 读取持久知识索引，scope resolver、授权、时区和可选旧向量/embedding 都由 Host 注入。关键词结果返回 ranker 的 `item.text`（标题、摘要和正文的共享预算投影），与 Python `as_public_result()` 一致；只有按 ID 读取返回完整正文。`createWebOwnerAgentKnowledgeReadPort` 明确将无 IM 上下文的 Web 请求限制在 owner scope；群 scope 不能从模型参数直接获得授权。保持 Python 参数语义：ID 与 keyword 同时提供时 ID 优先；空查询和 1–25 以外 limit 由 handler 返回固定错误，默认 limit=5。Core dispatch **4/4**、Host 临时 SQLite/FS 真实索引 dispatch **1/1**，使用正式 `@node-rs/jieba` 内置词典，并用临时旧格式 owner 向量文件和确定性 mock embedding 覆盖向量读取边界；回归还覆盖参数错误、撤权、异主与越权 scope 拒绝、时间格式、BM25 结果和同条目 chunk 合并。Host 适配器尚未接入生产 Agent Run，knowledge Node 写入与 freshness producer 也仍未就绪；因此不计作生产工具或完整来源迁移。

2026-11-16 devserver 合并复验：Core `knowledge.test.ts` **4/4**、`source-adapters.test.ts` **8/8**（均使用只选目标文件的临时 Vitest 配置，配置已删除）；Host `conversation-tools-runtime-sqlite.test.ts`（含实际 Core Runner 的 `search_conversations` 续轮）**4/4**，`knowledge-tool.test.ts` **1/1**，owner knowledge store、持久 Worker/baseline、正式 Jieba **11/11**，Host 合计 **16/16**。Core build、Web Host production build 通过。Core 标准 Vitest suite 仍因另一会话未登记的 Skill 测试无法加载；Python pytest 环境缺失。Provider、RunStore、授权、scope 和 embedding 使用合成依赖；SQLite/FS 为临时数据，因此未验收生产 Agent Run、真实 PostgreSQL 或真实 embedding Provider。

2026-11-16 回归补齐：统一 `createScopedRagSearch` 在 query embedding transport 抛错时保留已授权范围内的 BM25 结果；如果调用信号已取消，则仍传播取消错误，不把取消伪装成成功。版本匹配的 owner 向量也经过该搜索边界实际读取并参与 hybrid 排名。测试用确定性 Jieba、合成索引与模拟向量端口，未调用 Provider。

`knowledge_index_entries` 已进入 Core schema 17 的 SQLite/PostgreSQL DDL。SQLite v1-v16 通过显式备份迁移升级。Web Host 提供 `migrate:rag-index:check` 与 `migrate:rag-index:apply` 显式 PostgreSQL 迁移命令；迁移校验列、唯一键、owner 外键及 schema 定义的全部检索索引，并允许认领结构兼容的旧 Python 表。已登记迁移若缺少索引、索引列不符或索引未就绪会被拒绝启动；认领旧表时会补建缺失索引。命令尚未作为部署步骤运行。迁移回归已写入，但 devserver 缺少 `GUGU_WEBUI_TEST_DATABASE_URL`，本轮两个 PostgreSQL 场景均跳过，因此不能声称生产数据库已升级。

2026-11-16 PostgreSQL 迁移结构校验补齐：已登记表现在必须包含 schema 中定义的全部 RAG 索引，且每个索引列序、`indisvalid` 和 `indisready` 均符合预期；旧 Python 表认领通过同一 DDL 补齐索引。Host migration typecheck 通过。两个隔离 PostgreSQL 集成场景因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，实际 PostgreSQL 结构仍未验收。

## 生产接入状态

以下条件全部完成后才能把 RAG 标记为生产迁移完成：PostgreSQL 安全迁移已应用并验收、所有当前写入方都有可靠 job 生产路径、可信 scope 授权、向量读取和受控 embedding，以及从实际 Agent Run 调用链验收。Host 已声明 `@node-rs/jieba@2.0.1`（与 1.7.7 依赖版本相同），并提供包内 dict tokenizer adapter；会话工具回归使用真实 Jieba。该工具端口尚未由生产 Agent Run 组合。Node Web Host Worker 仅在 `checkRagIndexMigration` 返回 `applied` 时启动，`pending` 或检查不可用时关闭并记录脱敏状态；生产入口已注入 owner-bound knowledge reader 和 `config.storageLocalPath` memory storage root，因此可用来源包含 knowledge/memory。**Python/Cython 与 Node/TS Worker 使用同一队列，且 Python 旧结果写入尚未具备与 Node 等价的租约 fencing，不能并行消费。两端统一使用 `AGENT__RAG_INDEX_WORKER_OWNER` 环境变量指定唯一消费者，默认 `python`。当 Python 仍负责 knowledge/memory 写入时，它现可作为共享任务生产者；配置为 `node` 后，Python 会持久化事件并停止本地实时 Worker，恢复器也不会启动。Node Worker 在该配置下还会 fail closed：未同时注入 knowledge reader 和 memory storage root 时拒绝启动，避免其接管共享队列后留下未消费来源任务。切换仍要求两个服务同值、重启和验证 Node 全来源可用；当前没有生产部署证据证明已切换，不能称作 Node-only 或 TS RAG 已成为生产消费者。**Mind note/canvas、conversation 和 scheduled_task 的已发现 Node SQL mutation 已在业务事务中排入持久任务；knowledge 和 memory 的 Node 写路径仍不存在，未来迁移写路径时需要同事务 freshness producer。memory scope 枚举只限定待重建的 owner 数据，不授予检索权。`search_memory` 已有 Web owner-only 与可注入可信 IM scope resolver 的工具边界及临时回归，但生产 Run 尚未注入 IM context、scope resolver、embedding 和授权服务；`createAgentToolRegistry` 仍未进入生产 Agent Run 装配。Core 工厂、测试替身及工具注册本身不代表完整生产接通。

Web 持久重建器现在通过 `createWebAgentToolPorts` 把同一 Host 注册器用于 capability schema 发现和 Harness dispatch，并按 lease 固定 owner/session/run 身份；对应的真实临时 SQLite `search_conversations` dispatch 回归已通过。生产 `main.ts` 仍未创建 `agentChat` 或调用 `createWebAgentReconstructor`，所以这只完成了重建器内部的工具接线，不计作生产 Run 已启用。

`knowledge-source.ts` 复用 `AgentKnowledgeReadStore` 的可信 Host FS 端口，读取 owner 命名空间的知识 Markdown 并生成 Python 一致的 summary、keywords/description revision、scope 和 metadata；Web Host 的 `createLocalAgentKnowledgeReadStore` 通过 `@gugu/fs/node` 拒绝路径越界和符号链接，并限量分页/读取。生产 `main.ts` 只在索引迁移状态为 `applied` 时创建该 reader 并传给 Worker；这使 knowledge 进入生产来源集合，不替代真实 PG/部署验收。

2026-11-16 Host 全来源回归：临时 SQLite 经生产 Host 来源工厂、持久 Worker 和正式索引表，实际重建 project、calendar、note、canvas、scheduled_task、conversation、knowledge 文档，并将 memory 包含在完整来源集合中；`rag-index-worker.test.ts` **9/9 通过**，Web Host production build 通过。owner/session/IM 索引 scope、文件系统、授权和数据库均用隔离 fixture；这不验证 PostgreSQL migration、外部服务或生产 Agent Run 调用方。

`memory-loader.ts` 来自 Git tag `v1.7.7` 的 `backend/ts/workers/rag/src/memory-loader.ts`，已迁入 Core 并由 `@gugu/core/agent` 导出。它保留 owner 索引与 legacy memory 文件读取、daily 投影、group/member scope 校验、scope tombstone、snapshot 去重、TTL/LRU 和模型版本匹配向量读取。`memory-scope-state.ts` 复刻旧 Data Runtime 的 scope revision 与 tombstone 查询，按 owner/platform/bot/scope type/scope ID 完整键读取；它只读取状态，不提供授权。Core 行为回归现覆盖 loader 四项和 SQL scope 状态一项，使用隔离 SQLite；Host 临时目录安全回归 1/1。Web Host 受限 local FS reader 只允许 loader 使用的 owner namespace key，并拒绝路径越界、未知文件和符号链接。Web owner-only memory adapter 已把 SQL scope-state reader 和 storage reader 组合起来，但 Web scope resolver 只返回 owner scope，因而不会触发群/成员游标查询；IM scope 枚举/授权仍须由可信 Host 提供。该 loader 是查询时 memory 准备逻辑，不代表持久 memory 重建来源或生产 memory 检索已接通。

`memory-source.ts` 复用同一 loader 将 owner 索引/legacy memory 文件及 Host 枚举的 group/member scope 投影成正式 RAG 文档。`createPostgresAgentMemoryIndexScopeReader` 仅从当前 owner 的 reflection cursor 中枚举 scope；Core 再按完整 scope key 读 revision/tombstone，已删除 scope 不产出索引文档。新增 Host Worker 用临时 SQLite、隔离 FS 和合成 cursor 验证 owner/group/member 投影确实写入正式表、异主内容与 tombstone 内容不写入；两个群拥有完全相同的原始 source/version/chunk 时也各自保留索引行，避免正式表唯一键覆盖跨 scope 文档。生产 `main.ts` 现在把 `config.storageLocalPath` 传入 Worker，memory source 已在生产来源集合中启用；这只补齐读取根目录与重建能力，memory 变更仍没有 Node RAG job producer，因此 freshness 尚未建立。

2026-11-16 共享检索质量语料：旧 Cython `build_text_index/search` 与 Node Core `createRagLexicalIndex` 共用 `docs/testing/fixtures/rag-relevance-corpus.json`，由旧版和 TS 各自使用正式 Jieba/HMM=false tokenizer。中文部署、南京天气、中英混合 GTA6、owner scope 四个有效查询两端均 Recall@3=1、MRR=1；无关查询两端均返回空列表；与 owner 查询词完全相同的 group-scope 干扰文档两端均被过滤。Python 用例 1/1、Node Host 用例 1/1 通过。该语料验证词法检索质量与 scope 裁剪，不覆盖正式 PostgreSQL、真实向量 Provider 或生产 Agent Run。

持久索引读取遇到格式损坏的 `metadata_json` 时返回固定的 `RAG 索引元数据无效`，不传播包含原始内容的 JSON 解析异常。Host 临时 SQLite 回归经 Core 持久读取器复现损坏，再排入真实持久任务，由 Core rebuild worker 重写来源投影；任务到达 `ready` 后 snapshot 恢复可读。

2026-11-15 复验：Core `tests/agent/rag` 36/36；Host 当前定向集合 16/16（对话检索 4、记忆 scope/向量/BYOK 4、Worker 与正式索引写入 8），覆盖真实 Core/Host 工具调用边界及 Runner 续轮。Node 数据库和文件依赖均为临时 SQLite/FS；授权、IM context、凭据和 embedding transport 为合成依赖，Jieba 使用正式包内词典。Core build 与此前 Web Host 生产包 build 通过。正式 PostgreSQL 索引迁移用例 2 项因缺少隔离 PostgreSQL 而跳过；Python pytest 未运行。Node 用例通过不改变上文生产限制：生产更新事件生产者、memory Host 注入、真实 PostgreSQL 迁移验收和 `createAgentToolRegistry` 的 Agent Run 装配仍待接通。

2026-11-16 Mind 新鲜度闭环：Core `tests/mind/rag-freshness.test.ts` 5/5，连同 `tests/agent/rag` 共 41/41。临时 SQLite 覆盖 Mind 便签事务入队→持久 Worker→正式索引表、owner 隔离、事务回滚、删除墓碑/恢复，以及画布布局无变化不排任务、真实布局变化仅递增一次 generation。本轮重新执行的 Core 全量 `typecheck` 已通过；此前 `src/agent/tools/canvas.ts:191` 的类型阻塞已消失。此检查未证明 PostgreSQL 生产写入或 Agent Run 装配。Python pytest、正式 PG 迁移和真实外部 Provider 未验收。

同日 Host 复验：对话事实表/持久索引与 AgentRuntime Runner、memory scope/向量/BYOK、RAG 调度/Worker/基线 **16/16** 通过。测试使用隔离 SQLite/FS、正式 Jieba、合成 RunStore/Provider transport/授权/凭据，不调用真实 Provider 或 PostgreSQL。Python pytest 未运行。

本轮复验（2026-11-16）：本地 Core RAG + Mind 新鲜度定向回归 **8 个文件、41/41 通过**，Core 全量 `typecheck` 与 `build` 通过。Web Host 首次类型检查因 `@gugu/fs/node` 指向旧生成产物而报错；先构建已有 `removeLocalTree` 源码的 `@gugu/fs` 后，Host 全量 `tsconfig.build.json` 检查通过。Host RAG 定向测试本轮复跑 **16/16**。生产 memoryRoot 注入和 Agent Run 工具注册调用方仍受 Host 组合根共享编辑约束。

`search_conversations` 的 Python 来源适配器直接查 owner 限定的会话事实表，按 OR/AND、普通对话角色、非群会话和每条消息的匹配词数生成候选，再交给统一 ranker；它不读取持久索引或 embedding。Core `createSqlRagConversationSearch` 复用同一事实表语义和 TS ranker。Host 搜索与 AgentRuntime / Core Runner 续轮均使用这一 SQL RAG 来源，真实 1.7.7 Jieba 词典固定 HMM=false；调用链依赖为合成 Provider、RunStore、上下文和授权。持久索引仍用于来源重建及其他 RAG 查询，不被这个工具作为召回来源。`createAgentToolRegistry` 仍未进入 `main.ts` 的生产 Agent Run 装配。支持向量的综合 RAG（如 `search_memory`）才读取版本匹配向量并调用受控 embedding。

当前新增的临时 SQLite 回归经 Host 会话适配器和真实工具注册器 dispatch，验证 owner 由运行身份提供、伪造 owner 参数无效、群聊不参与关键词检索、OR/AND、空结果、baseline 前仍保留的历史、字面 LIKE 元字符、授权拒绝不泄露正文及结果 snippet；分词使用真实 1.7.7 Jieba 2.0.1 和 HMM=false。隔离 PostgreSQL 工具用例因测试库未配置跳过。它证明工具边界的本地行为，不证明 PostgreSQL 生产调用链、向量召回或 Agent Run 已接通。

2026-11-16 共享来源投影用例：`docs/testing/fixtures/rag-conversation-projection.json` 现在同时作为 Python Cython projection 与 Core TS conversation adapter 的输入/期望基准，逐字段核对来源 ID、父文档 ID、标题、摘要、正文、版本、邻接上下文和 metadata，防止两个实现对同一历史会话产生不同持久索引。Core `source-adapters.test.ts` 定向回归 8/8 通过；对应 Python pytest 已新增，但当前本机和 backend 虚拟环境均未安装 pytest，尚未执行。此共享夹具只覆盖 conversation 来源投影，不替代生产 PostgreSQL 或 Web Agent Run 验收。

2026-11-15 后续：`memory-search.ts` 组合可信 `resolveScopes` / `authorize` 端口、snapshot、owner-bound storage、`prepareMemory`、可选 embedding 和共享 TS ranker；`tools/memory.ts` 提供 `search_memory` 参数 schema 与真实 dispatch 实现。Host registry 仅在显式注入完整 `MemorySearchPort` 时注册。Core dispatch 使用临时 memory index 和合成授权/scope/snapshot/embedding 做 4/4 行为测试，包含版本匹配向量文件进入 hybrid ranker；Web owner-only Host adapter 复用受限 FS reader 与 SQL scope-state reader。新增 `agent-memory-scopes.ts`，由 Host 注入可信 IM context，owner 限定查询 reflection cursor，并按 Python `resolve_memory_query_scopes` 规则处理 owner/member、current_group、all_my_groups 和范围上限；其临时 SQLite/FS 用例经过 Host 注册器真实 dispatch 验证跨群和同成员隔离。该回归同时发现并修复了 transient lexical index 的两个行为问题：已授权的 group/member 文档被重复 owner scope 过滤，以及不同 scope 的相同 source key 在索引 map 中相互覆盖。Core RAG 定向测试 9/9、Host RAG 定向测试 4/4 通过。Host embedding 仍可通过 `createPostgresAgentRagEmbeddingPort` 使用 owner credential resolver 和 Node 受限 Transport；BYOK gate 在凭据查询、解密完成和发送 embedding 请求前检查。测试只使用临时 SQLite/FS、合成 IM context/cursor/授权/凭据和 mock Provider；真实 PostgreSQL、密钥服务、Provider、生产 Agent Run caller 和生产 IM context 注入尚未验收。

2026-11-16 补充验收：devserver 隔离临时 venv 执行旧版 RAG pytest **279/279 通过**，`search_conversations` / `search_memory` 及工具 schema pytest **37/37 通过**；第一次全量运行的 1 个子进程失败仅因测试 venv 未安装 `compat/core-python`，安装该仓库包后单测与整组均通过。Core RAG Node 定向套件 **9 个文件、56/56 通过**；Host RAG/会话定向套件 **17 通过、6 跳过、0 失败**，跳过项均需隔离 PostgreSQL。Host 路径测试使用临时 SQLite/FS、正式 Jieba，以及合成授权、IM context、凭据、embedding transport 和 Provider；未连接真实 PostgreSQL、Redis 或付费 Provider。Host 生产包 build 通过。标准 Core Vitest 配置因并行会话新测试未登记 suite 清单而无法启动，本次以临时 RAG-only 配置运行，没有修改共享清单。

Python 工具/pytest 和固定质量语料是行为基线。行为或安全差异需要在 `docs/testing/node-agent-tools-parity.md` 记录；合成授权、向量、embedding、时间和数据库只可作为隔离回归依赖，不能描述成真实平台验收。

### Conversation 写入到 RAG 队列的事务闭环（2026-11-16）

Web 用户消息准备与 Canonical 历史终态写入现在调用 Host `enqueueConversationRagRebuild`，并与会话消息在同一 PostgreSQL 事务提交。该来源的索引覆盖 owner 的多个 session，因此任务使用空 `source_id` 和空 pending 列表触发全量来源重建；新增 generation 同时清除旧租约及细粒度 pending，避免遗漏新消息或把 message ID 误作文档 ID。caller 级 PG 测试验证消息事务回滚会一并撤销索引任务、失败不会额外推进 generation。

devserver 本轮复验：Host 会话准备/Canonical 写入、`search_conversations` Runner、RAG 调度与 Worker 定向集合 **22 通过、6 跳过、0 失败**；六项均需隔离 PostgreSQL。新增的全来源队列合并、generation/租约 fencing 和事务回滚用例包含在跳过项中，`GUGU_WEBUI_TEST_DATABASE_URL` 未配置。Web Host 生产源码 `tsconfig.build.json` 检查通过；包含测试的全量 `tsconfig.json` 有 16 项其他测试类型诊断，本次生产与测试文件均无诊断。devserver 上对应源码与测试 SHA-256 已和工作区逐文件相符；Mutagen 另外三处生成目录冲突未 flush、未覆盖。Python `test_rag_index_jobs.py` 与 `test_rag_phase5_convergence.py` 未运行：devserver 没有项目 `.venv/bin/pytest`。因此此切片的生产 PG 和 Python 回归仍未验收；它补齐 Node conversation 更新生产者，但不改变 Python/Cython 与 Node Worker 共用队列、实际 Agent Run 尚未装配工具注册器的状态。

### 定时任务变更进入 RAG 队列（2026-11-16）

Node scheduled_task 的 create/update、显式删除、一次性完成删除、项目回收/过期、日历 Undo/redo 与工作区解绑现会在主数据事务内合并 `scheduled_task` 索引任务。Core 与 Host producer 保留首次及先前 pending source ID；删除由来源读取为空文档并写墓碑。devserver 隔离 SQLite 有效子集 **4 个文件、17 项通过、2 项 PostgreSQL 子测试跳过、0 项失败**，覆盖 Core calendar mutation、一次性任务、工作区删除和 scheduled-task 删除新鲜度。一次误将 PG-only 测试纳入命令时因缺少 `GUGU_CORE_TEST_POSTGRES_URL` 在套件加载阶段失败，排除后 SQLite 子集重跑通过。Host PG 与 Python pytest 未运行；本轮未重跑 typecheck/build。Mutagen 3 处生成目录冲突未 flush 或覆盖。knowledge 和 memory 仍缺 Node 写入端及 freshness producer。

### Python rank 行为基准补齐（2026-11-16）

Core `tests/agent/rag/ranking.test.ts` 对照 Python `test_cython_rank.py` 固定了选择分段、无关结果排除、top-k、多样性门控、历史 hash、引用合并、输出预算、阈值与 v1/v4 评分。devserver 定向回归 **15/15 通过**；测试使用确定性 tokenizer 替身，Python pytest 本轮未运行，因此没有宣称实时 Python/TS 差分或完整语料质量等价。

2026-11-16 本地追加复验：Core RAG/search/ranking 定向测试 47/47；Host 搜索工具 dispatch、Runner 续轮、Worker/基线与正式 Jieba 14 项通过、2 项 PostgreSQL 用例因缺少隔离数据库跳过。Python pytest 因本机未安装 pytest 未运行。生产 Run 注册、可信 memory scope/embedding 注入、memory root、新来源写入触发器、PG migration 和 Node-only consumer 切换仍未完成。

### 1.7.7 生命周期回归映射（2026-11-16）

旧 Worker `index-cache-service.test.ts`、`snapshot-cache.test.ts` 与 `rag-service.test.ts` 的生命周期契约现由 Core `tests/agent/rag/service-cache.test.ts` 覆盖：索引/snapshot TTL 与 revision、显式失效、scope 隔离、失败后重建、查询错误语义。devserver 该文件 6/6，Core RAG/search/ranking 共 8 个文件 53/53；Core 和 Web Host build 通过。该组冻结时钟与 engine stub 测试不验证 PostgreSQL、Python/Cython 在线差分或固定质量语料。生产 Run 装配、scope/向量生产依赖、knowledge/memory 更新生产者、PG migration 和 Worker 唯一归属仍待完成。

2026-11-16 devserver 串行复验：Core RAG 与 Mind freshness **10 个文件、63/63 通过**；Host memory scope/BYOK、conversation Runner、索引损坏恢复、持久 Worker、Jieba 与共享相关性语料 **19/19 通过**；Python RAG、conversation parity/search limits 与 knowledge search 工具 **300/300 通过**。Host 使用临时 SQLite/FS 和真实 Core/Host 工具调用，授权、凭据、Provider transport、RunStore 和 Provider 为模拟依赖。Python 使用临时 venv（Cython 3.3.1、rjieba 0.2.2、OpenAI/Anthropic SDK），只测试 SDK 导入，不发送 Provider 请求、不读取凭据。隔离 PostgreSQL 未配置；标准 Core Vitest suite 因并行工作区有未登记的非 RAG 测试无法启动，本轮使用 `/tmp` 临时配置，未修改共享 suite 清单。生产 Run 装配、knowledge/memory Node 写入 producer、Node-only Worker 归属及正式 PostgreSQL migration 仍未验收。

2026-11-16 memory Jieba Host 装配回归：`createWebOwnerMemorySearchPort` 现在独立装配与 conversation 相同的 `@node-rs/jieba` 2.0.1 包内词典实例；memory 工具的临时 SQLite/FS 实际 registry dispatch 用中文“群消息”查询验证正式切词，**5/5 通过**。这保护 memory-only Host 组合不会因忘记先创建 conversation 端口而在首次查询时报未装配。授权与快照仍由合成依赖提供；该端口尚未进入生产 Agent Run，Python pytest 与生产 PG/Provider 未验收。

共享队列消费者互斥（2026-11-16）：Python 的实时 RAG 事件监听曾无视 `AGENT__RAG_INDEX_WORKER_OWNER=node`，只关闭恢复轮询仍会由事件启动 Python 内存 Worker。修复后，Python 在 Node 持有消费者时只持久化共享 job，不留下进程内待处理副本；配置读失败也不会启用 Python 消费者。Python `test_rag_phase5_convergence.py` **12/12**、Host 持久 Worker/来源集 **8/8** 在 devserver 通过。前者用替身配置和持久任务端口验证事件分支，后者用临时 SQLite/FS 验证 Core 消费；未连接 PG，不证明服务部署切换。此修复允许安全选择唯一消费者，不代表生产 `main.ts` 已装配 Agent Run。

2026-11-16 当前树串行复验：Host `search_conversations` 事实表/Runner 续轮、`read_knowledge` 持久索引工具、memory scope/BYOK、持久 Worker/来源重建、正式 Jieba 与共享相关性语料共 **21/21 通过**。数据库和文件使用隔离 SQLite/临时 FS；授权、IM 上下文、凭据、embedding transport、Provider 与 RunStore 为合成依赖。未连接 PostgreSQL/Redis/真实 embedding Provider；因此这组回归验证 Core/Host 工具链行为，不证明生产 Agent Run 已装配或 Node Worker 已切换为唯一消费者。

2026-11-16 `search_memory` fallback reason 修正：按 Python 统一检索输出保留 `embedding_disabled`、`lexical_only`、`embedding_cache_unavailable` 和成功 hybrid 的 `null`。Core 真实工具注册器 dispatch **6/6 通过**；用例保护 owner 隔离、撤权、BM25 与版本匹配向量，并验证无向量、缓存缺失和 query embedding transport 失败时的降级字段及正常返回。测试使用合成 owner 索引/向量，不调用 Provider；生产 Agent Run、真实 PostgreSQL/Redis 与外部 embedding 仍未验收。

2026-11-16 隔离 PostgreSQL 迁移验收：真实临时 PostgreSQL 首次验证发现 `pg` 将系统 `name[]` 解析为字符串，迁移器按数组比较导致正式索引被误报为不兼容；唯一约束列与检索索引列现由 SQL 显式转成 `text[]`。`apps/web-host/tests/migrations/rag-index-migrate.test.ts` **3/3 通过**，覆盖空库创建、旧 Python 兼容表无损认领、幂等执行以及缺索引/缺唯一约束拒绝；Node `pg` 连接隔离临时集群，结束后已停止。此结果验证迁移实现，不代表任何生产数据库已升级。

截至同日，完整 1.7.7 RAG 来源投影已有 project、calendar、note、canvas、scheduled_task、conversation、knowledge、memory；正式 Jieba 和可选 owner-bound 向量读取/受控 embedding 也有实现。生产写入新鲜度仍缺 knowledge 与普通 memory 写入方；`search_conversations` 仍走 Python 一致的事实表 BM25 路径，其他 RAG 查询才使用正式索引及向量。当前 `main.ts` 未创建 `agentChat` 或调用 `createWebAgentReconstructor`，conversation/memory 查询端口尚未进入生产 Run，所以工具、授权、scope 与向量的隔离回归不能记为生产接通。Python pytest 当前环境无 pytest 模块，本轮未运行；生产 PostgreSQL、Redis 和真实 Provider 未验收。
