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
| knowledge | `knowledge-source.ts` | Host 注入的 owner 授权 FS 读取 Markdown 主数据；DB 仅保存可重建索引投影 | Core 来源保留 Python record/version/scope 语义，并经真实 SQLite 持久 Worker 写入索引回归；Web Host 的生产 RAG Worker 在迁移门控通过后注入受限 FS reader，但 Node knowledge 写路径尚未排入 RAG 持久队列，生产 PG 尚未验收 |
| memory | `memory-loader.ts`、`memory-scope-state.ts`、`memory-source.ts` | Host 以 owner 限定读取 `memory_reflection_cursors` 枚举重建候选；Core loader 从 owner-bound FS 读取 1.7.7 memory index/legacy 文件及 group/member 文件；完整 owner/scope 状态和 tombstone 由 SQL reader 复核 | Core memory 来源可投影到正式索引；生产 Worker 已注入 `memoryStorageRoot`。“清除记忆”路由在 owner `.agent` 删除成功后，会在同一事务递增 memory rebuild generation 并立即墓碑化旧持久投影，避免等待 Worker 期间继续召回已清理正文；普通 memory 文件更新事件仍未接入。可信 IM scope 授权和查询端口也未接入生产 Run，因此不是已完成的生产检索来源 |
| file | — | 旧版文件自动 RAG 索引按 2.0 决策退役；正文通过授权 FS 直读 | 退役；不把文件正文写入索引表 |

Worker 只领取传入来源表覆盖的任务。缺来源的任务不会成功确认。删除/归档后来源返回空文档，由持久 writer 写墓碑；Worker 在同一事务中 fence generation 与租约，并记录任务结果。

## 查询和安全

`scoped-search.ts` 在读取索引前和返回结果前都调用 Host 授权端口；scope 必须由 Host 提供，不能由工具输入决定。向量读取和 query embedding 均为可选可信端口；版本不匹配或缺向量时保留词法结果。Web Host 的 owner-bound 向量文件读取器只允许旧版三个固定路径并限制文件大小，但尚未接入生产 Agent。

2026-11-16 回归补齐：统一 `createScopedRagSearch` 在 query embedding transport 抛错时保留已授权范围内的 BM25 结果；如果调用信号已取消，则仍传播取消错误，不把取消伪装成成功。版本匹配的 owner 向量也经过该搜索边界实际读取并参与 hybrid 排名。测试用确定性 Jieba、合成索引与模拟向量端口，未调用 Provider。

`knowledge_index_entries` 已进入 Core schema 17 的 SQLite/PostgreSQL DDL。SQLite v1-v16 通过显式备份迁移升级。Web Host 提供 `migrate:rag-index:check` 与 `migrate:rag-index:apply` 显式 PostgreSQL 迁移命令；迁移校验列、唯一键与 owner 外键，并允许认领结构兼容的旧 Python 表。命令尚未作为部署步骤运行。迁移回归已写入，但 devserver 缺少 `GUGU_WEBUI_TEST_DATABASE_URL`，本轮两个 PostgreSQL 场景均跳过，因此不能声称生产数据库已升级。

## 生产接入状态

以下条件全部完成后才能把 RAG 标记为生产迁移完成：PostgreSQL 安全迁移已应用并验收、全部可支持来源及更新生产者已接入、可信 scope 授权、向量读取和受控 embedding，以及从实际 Agent Run 调用链验收。Host 已声明 `@node-rs/jieba@2.0.1`（与 1.7.7 依赖版本相同），并提供包内 dict tokenizer adapter；会话工具回归使用真实 Jieba。该工具端口尚未由生产 Agent Run 组合。Node Web Host Worker 仅在 `checkRagIndexMigration` 返回 `applied` 时启动，`pending` 或检查不可用时关闭并记录脱敏状态；生产入口已注入 owner-bound knowledge reader 和 `config.storageLocalPath` memory storage root，因此可用来源包含 knowledge/memory。**当前 Python FastAPI 仍在应用启动时无条件启动 `start_rag_index_recovery()`，由 `agent.rag.pipeline` 使用旧 Cython pipeline 消费同一 `rag_index_jobs`；Node Worker 同时可能领取任务。两端使用相同任务状态、租约与 generation fencing 机制，设计上限制重复提交，但跨进程 PostgreSQL 竞争尚未验收，领取方仍由调度时序决定。因此实际执行者可能是 Python/Cython，也可能是 Node/TS，不能称作 TS RAG 已成为唯一生产消费者。**正式切换必须先有可控的消费者归属/停用策略，并验收旧 Python 消费路径已退出，再开启 Node-only 生产消费。Mind note/canvas、conversation 和 scheduled_task 的已发现 Node SQL mutation 已在业务事务中排入持久任务；knowledge 更新和 memory 写入仍缺 Node freshness producer。memory scope 枚举只限定待重建的 owner 数据，不授予检索权。`search_memory` 已有 Web owner-only 与可注入可信 IM scope resolver 的工具边界及临时回归，但生产 Run 尚未注入 IM context、scope resolver、embedding 和授权服务；`createAgentToolRegistry` 仍未进入生产 Agent Run 装配。Core 工厂、测试替身及工具注册本身不代表完整生产接通。

`knowledge-source.ts` 复用 `AgentKnowledgeReadStore` 的可信 Host FS 端口，读取 owner 命名空间的知识 Markdown 并生成 Python 一致的 summary、keywords/description revision、scope 和 metadata；Web Host 的 `createLocalAgentKnowledgeReadStore` 通过 `@gugu/fs/node` 拒绝路径越界和符号链接，并限量分页/读取。生产 `main.ts` 只在索引迁移状态为 `applied` 时创建该 reader 并传给 Worker；这使 knowledge 进入生产来源集合，不替代真实 PG/部署验收。

`memory-loader.ts` 来自 Git tag `v1.7.7` 的 `backend/ts/workers/rag/src/memory-loader.ts`，已迁入 Core 并由 `@gugu/core/agent` 导出。它保留 owner 索引与 legacy memory 文件读取、daily 投影、group/member scope 校验、scope tombstone、snapshot 去重、TTL/LRU 和模型版本匹配向量读取。`memory-scope-state.ts` 复刻旧 Data Runtime 的 scope revision 与 tombstone 查询，按 owner/platform/bot/scope type/scope ID 完整键读取；它只读取状态，不提供授权。Core 行为回归现覆盖 loader 四项和 SQL scope 状态一项，使用隔离 SQLite；Host 临时目录安全回归 1/1。Web Host 受限 local FS reader 只允许 loader 使用的 owner namespace key，并拒绝路径越界、未知文件和符号链接。Web owner-only memory adapter 已把 SQL scope-state reader 和 storage reader 组合起来，但 Web scope resolver 只返回 owner scope，因而不会触发群/成员游标查询；IM scope 枚举/授权仍须由可信 Host 提供。该 loader 是查询时 memory 准备逻辑，不代表持久 memory 重建来源或生产 memory 检索已接通。

`memory-source.ts` 复用同一 loader 将 owner 索引/legacy memory 文件及 Host 枚举的 group/member scope 投影成正式 RAG 文档。`createPostgresAgentMemoryIndexScopeReader` 仅从当前 owner 的 reflection cursor 中枚举 scope；Core 再按完整 scope key 读 revision/tombstone，已删除 scope 不产出索引文档。新增 Host Worker 用临时 SQLite、隔离 FS 和合成 cursor 验证 owner/group/member 投影确实写入正式表、异主内容与 tombstone 内容不写入；两个群拥有完全相同的原始 source/version/chunk 时也各自保留索引行，避免正式表唯一键覆盖跨 scope 文档。生产 `main.ts` 现在把 `config.storageLocalPath` 传入 Worker，memory source 已在生产来源集合中启用；这只补齐读取根目录与重建能力，memory 变更仍没有 Node RAG job producer，因此 freshness 尚未建立。

2026-11-16 共享检索质量语料：旧 Cython `build_text_index/search` 与 Node Core `createRagLexicalIndex` 共用 `docs/testing/fixtures/rag-relevance-corpus.json`，由旧版和 TS 各自使用正式 Jieba/HMM=false tokenizer。中文部署、南京天气、中英混合 GTA6、owner scope 四个有效查询两端均 Recall@3=1、MRR=1；无关查询两端均返回空列表；与 owner 查询词完全相同的 group-scope 干扰文档两端均被过滤。Python 用例 1/1、Node Host 用例 1/1 通过。该语料验证词法检索质量与 scope 裁剪，不覆盖正式 PostgreSQL、真实向量 Provider 或生产 Agent Run。

持久索引读取遇到格式损坏的 `metadata_json` 时返回固定的 `RAG 索引元数据无效`，不传播包含原始内容的 JSON 解析异常。Host 临时 SQLite 回归经 Core 持久读取器复现损坏，再排入真实持久任务，由 Core rebuild worker 重写来源投影；任务到达 `ready` 后 snapshot 恢复可读。

2026-11-15 复验：Core `tests/agent/rag` 36/36；Host 当前定向集合 16/16（对话检索 4、记忆 scope/向量/BYOK 4、Worker 与正式索引写入 8），覆盖真实 Core/Host 工具调用边界及 Runner 续轮。Node 数据库和文件依赖均为临时 SQLite/FS；授权、IM context、凭据和 embedding transport 为合成依赖，Jieba 使用正式包内词典。Core build 与此前 Web Host 生产包 build 通过。正式 PostgreSQL 索引迁移用例 2 项因缺少隔离 PostgreSQL 而跳过；Python pytest 未运行。Node 用例通过不改变上文生产限制：生产更新事件生产者、memory Host 注入、真实 PostgreSQL 迁移验收和 `createAgentToolRegistry` 的 Agent Run 装配仍待接通。

2026-11-16 Mind 新鲜度闭环：Core `tests/mind/rag-freshness.test.ts` 5/5，连同 `tests/agent/rag` 共 41/41。临时 SQLite 覆盖 Mind 便签事务入队→持久 Worker→正式索引表、owner 隔离、事务回滚、删除墓碑/恢复，以及画布布局无变化不排任务、真实布局变化仅递增一次 generation。本轮重新执行的 Core 全量 `typecheck` 已通过；此前 `src/agent/tools/canvas.ts:191` 的类型阻塞已消失。此检查未证明 PostgreSQL 生产写入或 Agent Run 装配。Python pytest、正式 PG 迁移和真实外部 Provider 未验收。

同日 Host 复验：对话事实表/持久索引与 AgentRuntime Runner、memory scope/向量/BYOK、RAG 调度/Worker/基线 **16/16** 通过。测试使用隔离 SQLite/FS、正式 Jieba、合成 RunStore/Provider transport/授权/凭据，不调用真实 Provider 或 PostgreSQL。Python pytest 未运行。

本轮复验（2026-11-16）：本地 Core RAG + Mind 新鲜度定向回归 **8 个文件、41/41 通过**，Core 全量 `typecheck` 与 `build` 通过。Web Host 首次类型检查因 `@gugu/fs/node` 指向旧生成产物而报错；先构建已有 `removeLocalTree` 源码的 `@gugu/fs` 后，Host 全量 `tsconfig.build.json` 检查通过。Host RAG 定向测试本轮复跑 **16/16**。生产 memoryRoot 注入和 Agent Run 工具注册调用方仍受 Host 组合根共享编辑约束。

`search_conversations` 的 Python 来源适配器直接查 owner 限定的会话事实表，按 OR/AND、普通对话角色、非群会话和每条消息的匹配词数生成候选，再交给统一 ranker；它不读取持久索引或 embedding。Core `createSqlRagConversationSearch` 复用同一事实表语义和 TS ranker。Node 另有 `createIndexedAgentConversationSearchPort`，用于验证持久索引查询，但它的 BM25 候选不等同于 Python 的 SQL 候选，不作为 Python 行为一致性的证据。工具每次最多请求 20 条 RAG 候选（上层按 session 去重），Host direct-source 和持久索引两种路径均有真实注册器 dispatch 回归；AgentRuntime / Core Runner 续轮用例现使用 Python 对应的 Core SQL RAG 来源，依赖为合成 Provider、RunStore、上下文和授权。两种路径使用真实 1.7.7 Jieba 词典及 HMM=false。`createAgentToolRegistry` 仍未进入 `main.ts` 的生产 Agent Run 装配。支持向量的综合 RAG（如 `search_memory`）才读取版本匹配向量并调用受控 embedding。

当前新增的临时 SQLite 回归经 Host 会话适配器和真实工具注册器 dispatch，验证 owner 由运行身份提供、伪造 owner 参数无效、群聊不参与关键词检索、OR/AND、空结果、baseline 前仍保留的历史、字面 LIKE 元字符、授权拒绝不泄露正文及结果 snippet；分词使用真实 1.7.7 Jieba 2.0.1 和 HMM=false。隔离 PostgreSQL 工具用例因测试库未配置跳过。它证明工具边界的本地行为，不证明 PostgreSQL 生产调用链、向量召回或 Agent Run 已接通。

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
