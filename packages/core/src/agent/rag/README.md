# Agent RAG

本目录按 Gugu 1.7.7 TypeScript RAG 职责组织：`adapters/` 投影来源文档，`ranking/` 执行 BM25/混合排序，`persistent-index.ts` 与 `persistent-writer.ts` 读写可重建索引，`rebuild-worker.ts` 消费持久任务，`scoped-search.ts` 组合授权、候选、向量和统一排序。Host 通过 `@gugu/core/agent` 导入来源工厂、持久读取器、Worker、受限查询与向量/embedding 契约；具体身份、scope、来源服务和传输仍由 Host 提供。

Web 查询的短期 embedding 缓存由可信 Host 提供 owner。缓存摘要纳入实际端点、凭据、模型与向量尺寸，同一 owner 的相同查询在同一连接配置下可复用。凭据变更、端点变更或更换 owner 会重新执行调用。未传入 owner 的索引或记忆向量生成直接执行请求。缓存只保存摘要、向量及时间水位。

**当前接入与验收状态（2026-11-19）**：2.0 的 RAG、Agent Run 和后台任务均以 Node 为唯一运行时目标，不保留 Python 代理或双消费者兼容路径。生产 `main.ts` 创建 Web Agent Reconstructor/Run lifecycle，挂到 `createApp(agentChat)` 并启动 dispatch；Reconstructor 每个可信 lease 通过 `createWebAgentRagResources` 装配自动 RAG、生产 Core 工具 registry、`search_conversations`、`search_memory`、owner-bound memory/vector/embedding 与 Host 领域工具。自动 RAG 对 conversation 来源的引用时间通过同一可信 owner/session 查询时区并按历史消息格式投影。RAG Worker 仅在正式索引迁移已应用后启动，由 Node 独立消费。8 个可重建来源均有 Core/Host 投影：project、calendar、note、scheduled_task、conversation、canvas、knowledge、memory；旧 file 自动索引按 2.0 决策退役。Web 私聊 owner 反思由 Node Run finalizer 写入 Redis 持久队列，并由 Node Host 生命周期启动的模型分支/记忆 writer 消费；不复制聊天正文到队列。Core RAG **9 文件、70/70**；Host 来源、Worker、Jieba、资源与工具批次在隔离 PostgreSQL/Redis **48 通过、1 跳过**（Linux 安全原子写），完整 `startServer → HTTP/SSE → 持久 dispatch → Reconstructor → ToolRegistry` 的 `search_conversations` owner 隔离及索引召回 **1/1 通过**。未调用 Python 或真实外部 Provider。IM group/member scope 的实时反思与在线检索仍依赖相应可信平台 Host 能力；Web 不伪造群身份或授权。

当前树 Node 验收（2026-11-18）：Core RAG **9 文件、70/70**；Host RAG、lease、正式来源 Worker、迁移、Jieba 与检索 transport 定向批次 **53 通过、1 跳过、0 失败**，唯一跳过项为 Linux 安全原子写入；历史消息时间单测 **2/2**。另用临时 PostgreSQL schema、隔离 Redis DB、临时 Local 文件目录和合成 HTTP Provider 跑过真实 `startServer → HTTP → 持久 dispatch → Reconstructor → ToolRegistry → SSE` **1/1**：验证 `search_conversations` 与 `read_knowledge` 实际调用、owner 隔离、BM25 索引投影、按 ID 读取全文、异主 ID 安全 not-found、崩溃后恢复、带历史时间戳的新 Run 和取消确认门。Worker 来源回归使用临时 PostgreSQL 正式索引表及隔离授权文件；Core build、Web Host production typecheck 与 diff 检查通过。`save_knowledge`/`update_knowledge` 仅在 Linux 安全原子文件发布能力可用时装配；macOS HTTP/SSE 验收确认写工具不注册且知识版本不变。Linux 写入和索引刷新由 Linux 专项测试覆盖，本机本轮未验收该分支。未调用 Python 后端、真实付费或外部 Provider；旧实现不作为 Node 运行依赖。2.0 保持 Node 为唯一运行实现，不保留 Python bridge、fallback 或双运行时。

2026-11-19 Node-only 复验：Core RAG **9 文件、70/70**；Host RAG 工具端口、资源工厂、索引 Worker、Jieba、共享语料和 Agent 主链批次 **40 通过、2 跳过、0 失败**。两个跳过分别依赖 Linux 安全原子写和隔离 PostgreSQL/Redis；Core build、Web Host production build、`git diff --check` 通过。随后用临时 PostgreSQL/Redis 重跑 `startServer → HTTP/SSE → 持久 dispatch → Reconstructor → ToolRegistry`：初次请求被隔离 schema 缺少认证写门所需的 `data_import_jobs` 表挡住；测试夹具已补齐该表的最小查询列，生产 fail-closed 写门未改。重跑进入持久恢复路径，最终 PostgreSQL 扩展临时文件时报 `No space left on device`（运行前数据卷仅剩约 422 MiB），因此本轮主链记为**失败/未完成**，不计 RAG HTTP/SSE 通过。临时 PG/Redis 与数据目录已停止并清理。未运行 Python、未调用真实 Provider；Node 是唯一 2.0 运行路径，未添加 Python 兼容或回退。

2026-11-19 隔离资源重跑并通过，更新上段主链验收状态：Web Host RAG 定向批次在临时 PostgreSQL/Redis 下 **48 通过、1 跳过、0 失败**（唯一跳过为需要 Linux 安全原子写的知识写入适配器）；Core RAG **9 文件、70/70**。另以全新临时 PostgreSQL cluster/schema、临时 Redis、临时 owner 文件目录及本机合成 Provider 跑 `startServer → HTTP → 持久 dispatch → Reconstructor → ToolRegistry → SSE`，主链 **1/1 通过**：真实 Node Worker 建立两个 owner 的会话索引，`search_conversations` 只返回当前 owner 命中。无需真实付费/外部 Provider。`create_file`/`edit_file` Core 文件组 **74/74**，Host 文件工具实际调用 **3/3**，Web Host production typecheck 与 `git diff --check` 通过。临时服务已停止并清理；本轮未运行 Python，2.0 保持纯 Node 运行目标。此前失败记录保留为历史尝试，不再代表当前主链状态。

2026-11-18 当前工作区定向复验：Core RAG **9 文件、70/70**；Host RAG/lease/来源 Worker/迁移/Jieba/检索 transport **37 通过、1 跳过、0 失败**（跳过项为仅 Linux 可用的知识写入适配器）。`search_conversations` 的 owner 限定工具调用、正式 Jieba/BM25、最新会话命中、Runner→Provider 续轮及时间格式回归另有 **7/7** 通过；重建器/资源工厂批次 **2 通过、2 跳过**，其中一个依赖 Linux 安全原子写入，另一个依赖隔离 PostgreSQL/Redis。Web Host production `tsc --noEmit` 通过。当前环境未设置隔离 PG/Redis URL，因此本轮未执行完整 `startServer → HTTP/SSE → Reconstructor → ToolRegistry` 集成；此结果不覆盖上段已有的隔离服务主链记录。未运行 Python pytest、未调用真实 Provider。2.0 只走 Node 实现，Python 仅用于理解历史业务行为，不构成兼容目标或运行依赖。

**历史接线记录（2026-11-17）**：Web Host `main.ts` 已将持久 `AgentChatService` 接入 `createApp`，并在可信 dispatch lease 的 Reconstructor resources 中组合自动 RAG、`search_conversations`/`search_memory` registry、owner-bound embedding、`read_knowledge`/`read_conversation` 及知识写端口。知识正文由 owner FS 读取，关键词仍走正式索引 BM25；同一 Run 还从 Host 显式注入共享 Core 日历写服务，开放 `create_event`/`update_event`。`save_knowledge`/`update_knowledge` 复用 Host owner FS 写入和持久 freshness job；Core 工具行为 **7/7**、Host 注册器/资源工厂调用回归 **8/8**，Core typecheck 通过。Python 知识、读取和工具 schema pytest **142/142** 通过，Cython 扩展仅编译在临时目录。最新 devserver Core build 通过，RAG 工具/资源和历史读取 Node 调用回归 **16/16**、Web Host production TypeScript 检查通过；Python 历史读取对应用例 **4 通过、62 deselected**。本轮回归使用隔离 SQLite/FS、合成 lease/Pool/Redis 与模拟 embedding/Provider；Python 使用临时数据和临时 Cython 构建。真实 PostgreSQL、Redis、外部 Provider 和进程重启恢复仍未验收。当时以 `AGENT__RAG_INDEX_WORKER_OWNER` 选择消费者；2.0 Node Host 已移除此开关。以下更早记录中“尚无 main.ts caller”只描述当时状态。

RAG 只使用 TypeScript 检索实现；Cython 是迁移期 Python 行为基准，不是 Node 运行时依赖。中文 tokenizer 保持 Jieba 词边界和 HMM=false 语义，实例由可信 Host 注入；未注入时拒绝检索。

迁移源为 Git tag `v1.7.7`（commit `14c544f1faf1193e8a073844af4a5d7a4872045c`）下的 `backend/ts/workers/rag`，仓库许可证为 Apache-2.0。旧 Worker 依赖 `@node-rs/jieba@2.0.1` 和 `ali-oss@6.23.0`；2.0 Core/Host 复用了 RAG 算法与适配逻辑，Jieba 仍由 Host 提供，OSS 依赖不迁入，因为 Host storage 使用授权 FS 端口。旧 Worker 协议、Data Runtime 和副作用责任不能直接沿用，已按 2.0 Core/Host 边界重接。

本轮对本地可读的 1.7.7 commit 做了逐文件/导出符号核对：旧目录 25 个 TypeScript 文件中，除组合根外的 24 个模块均映射到 Core RAG；`index.ts` 的 stdin/stdout 协议与存储/Worker 组合根由 Core Worker contracts 和 Web Host lifecycle/resource composition 替代。旧 `query-embedding.ts` 的 `QueryEmbeddingSettings/Outcome/Result`、`embedQuery` 分别收敛为 `RagQueryEmbeddingSettings/Outcome/Result`、`embedRagQuery(settings, text, transport, signal)`；旧设置里的 `pinned_ip` 被可信 Host 的统一 Node Provider transport DNS 校验和连接 pinning 替代，结果的 `http_status` 改为 Core 风格的 `httpStatus`。这是有意的边界重设计，不是漏迁；嵌入兼容回归仍覆盖 OpenAI/Bailian payload、尺寸/状态、缓存与取消。该检查只说明源码职责已映射，不把文件存在本身当运行验收；本仓库未发现把 RAG 来源误标为 1.7.8 的残留。

## 重建来源

| 来源 | 实现 | 读取边界 | 状态 |
| --- | --- | --- | --- |
| project | `project-source.ts` | Core 项目服务，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；Host 来源组经 SQLite 队列→Worker→正式索引回归；生产 Worker 已挂入 Host 启停生命周期，项目变更有 Host 持久任务生产者；受正式 PG 迁移门控，生产 PG 未验收 |
| calendar | `calendar-source.ts` | Core 日历读取端口，owner 限定 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；生产 Worker 生命周期已接入，生产 PG 未验收 |
| note | `note-source.ts` | Mind 便签读取服务，包含 note/suggestion | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；便签 create/update/delete/restore 在业务事务中排入持久任务，生产 Worker 生命周期已接入，生产 PG 未验收 |
| scheduled_task | `scheduled-task-source.ts` | 定时任务共享读取服务 | 临时 SQLite 和隔离 PostgreSQL 已经真实读取并经持久 Worker 写索引；已发现的 Host create/update/delete、一次性完成删除、项目回收/过期与工作区解绑写入排入 RAG 队列；Core 一次性任务删除、工作区解绑、日历提醒改期/禁用及 Undo/redo 现在复用 `scheduled-tasks/rag-index-job.ts` 在主事务中排队；Host 日历撤销/重做路径也有 PG 入队回归；本轮 Core 与 Host PG 事务回归尚未在 devserver 验收 |
| conversation | `conversation-index-source.ts`、`conversation-source.ts` | 持久重建按 owner 读取摘要/消息，保留 baseline、角色、群聊 scope 与相邻上下文；检索从历史事实表提供旧索引尚未覆盖的候选 | Core 来源和索引 Worker 已覆盖 SQLite；Web 用户消息准备与 Canonical 历史终态写入均在原 PostgreSQL 事务排入 owner 级全量会话重建，避免将 message ID 当成来源 ID；生产 Agent Run 已接入 `search_conversations` 的 owner-bound BM25 事实表查询。隔离 PostgreSQL 事务和 Run 重启恢复尚未验收 |
| canvas | `canvas-source.ts` | Mind `listForRag` 查询；owner、存活画布/项/节点约束，按稳定 ID 分页 | 临时 SQLite 已真实读取并经持久 Worker 写索引；画布和索引文本相关的便签/项/画布变更、删除与 Undo/redo 在业务事务中排入全来源或文档任务；生产 Worker 生命周期已接入；Python 投影差分和生产 PG 未验收 |
| knowledge | `knowledge-source.ts` | Host 注入的 owner 授权 FS 读取 Markdown 主数据；DB 仅保存可重建索引投影 | Core 来源保留 Python record/version/scope 语义，并经真实 SQLite 持久 Worker 写入索引回归；Web Host 的生产 RAG Worker 在迁移门控通过后注入受限 FS reader。`save_knowledge`/`update_knowledge` Core 工具及 Host owner-bound Markdown freshness 写端口已接入生产 Run 的 lease-bound registry；Core 工具 dispatch **7/7**、Host RAG tools/resources dispatch **8/8** 与最新 Web Host production typecheck 通过；真实 PG 尚未验收。删除仍因 registry 无确认门而不开放 |
| memory | `memory-loader.ts`、`memory-scope-state.ts`、`memory-source.ts` | Host 以 owner 限定读取 `memory_reflection_cursors` 枚举重建候选；Core loader 从 owner-bound FS 读取 1.7.7 memory index/legacy 文件及 group/member 文件；完整 owner/scope 状态和 tombstone 由 SQL reader 复核 | Core memory 来源可投影到正式索引；生产 Worker 已注入 `memoryStorageRoot`。生产 `clearAgentMemory` 先调用 `invalidateAgentMemoryRag`，在单个 SQL 事务中墓碑化旧投影、推进 settled generation 并清除旧租约，再删除 owner `.agent`，成功后才排入重建。Node Admin IM 记忆维护写入 group/member 文件前会撤回旧投影；文件变更后由 `changeAgentMemoryScopeAndEnqueue` 在同一 SQL 事务中推进对应 `memory_reflection_cursors.scope_version` 并排入完整 memory 重建，队列写入失败会回滚 revision。Web 私聊 owner 反思通过 Node Run finalizer、Redis 持久队列、Node 模型分支和 owner writer 更新记忆并刷新索引；本机 Linux 专用写入用例跳过，详见顶部验收状态。生产 Agent Run 已接入 Web owner-only `search_memory`、owner-bound 向量读取与可选 embedding；IM group/member scope 查询与反思仍需各自可信 Host 能力，不开放无授权替代路径 |
| file | — | 旧版文件自动 RAG 索引按 2.0 决策退役；正文通过授权 FS 直读 | 退役；不把文件正文写入索引表 |

`journal` 仍出现在 ranker 的 source-quality 常量中，是保留的历史排序类别；1.7.7 TypeScript adapters 未定义 journal 来源生产者，因此它不是缺失的重建来源。不要把 ranker 能识别类型当作来源已接入。

Worker 只领取传入来源表覆盖的任务。缺来源的任务不会成功确认。删除/归档后来源返回空文档，由持久 writer 写墓碑；Worker 在同一事务中 fence generation 与租约，并记录任务结果。

当前索引任务由 Node Host 生产并由 Node Worker 消费；Web 私聊记忆反思也由 Node finalizer 入队并由 Node 后台模型分支和 owner writer 落盘。旧 Python 事件字段与队列行为只记录为历史格式，不接入 Node 消费路径，也不作为运行时兼容输入。Node Admin IM 记忆维护对 group/member 文件变更先撤回旧索引，再推进 scope revision 并排入完整 memory 重建。IM group/member 反思生产者须由相应可信平台 Host 单独实现后才能开放。

## 查询和安全

`scoped-search.ts` 在读取索引前和返回结果前都调用 Host 授权端口；scope 必须由 Host 提供，不能由工具输入决定。向量读取和 query embedding 均为可选可信端口；版本不匹配或缺向量时保留词法结果。Web Host 的 owner-bound 向量文件读取器只允许旧版三个固定路径并限制文件大小，已由 Web `search_memory` Run 使用；真实 PostgreSQL lease、Redis 与外部 embedding Provider 尚未生产验收。

memory RAG 查询的取消信号会沿工具 dispatch 传到 owner/IM scope 文件读取、scope 状态读取和三个向量文件读取；SQL scope 查询在执行前后检查取消，可选向量文件读取还会区分普通读取错误与取消。普通可选向量文件错误仍回退到 BM25，已取消的读取则继续传播取消，不能伪装成词法成功。Core `memory-search.test.ts` 在实际 `search_memory` registry dispatch 上验证挂起中的 owner 文件读取和向量文件读取都遵守取消。

`vector-reader.ts` 复用 1.7.7 向量文件解析生命周期：每次从授权 Host reader 读取当前文件，按 owner、文件种类和 embedding 版本缓存解析结果，以文件内容 SHA-256 变化失效，进程内 LRU 上限 8 且不设 TTL。该缓存只存解析后的派生向量映射，不替代 owner 路径授权或 freshness producer。`scoped-search.test.ts` 经实际 hybrid 查询验证文件更新后融合结果立即变化。

`search_conversations` 按历史 `ConversationAdapter.retrieve` 的业务语义保持独立的 BM25 事实表路径：Host `createCoreAgentConversationSearchPort` 调用 `createSqlRagConversationSearch`，SQL 在可信 owner 下排除群会话和非 user/assistant 消息、每个会话只取最新命中，再交给 TypeScript RAG ranker。它会搜索 baseline 之前仍留在事实表的历史，不读压缩后的持久索引；持久索引继续用于重建及其他 RAG 来源。工具已进入生产 Web Run registry，并在临时 SQLite/registry dispatch 和 AgentRuntime Runner 中验证；另经隔离 PostgreSQL schema、Redis、合成 Provider 的真实 `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` 调用链验证 owner 隔离和崩溃后恢复。Node 是唯一运行实现，不保留 Python 调用或运行时兼容层；真实部署、生产数据和目标环境重启恢复仍未验收。

`read_knowledge` 已有 Core 工具组和 Web Host 适配器：按 ID 读取时通过 owner-bound FS reader 解析完整 Markdown 正文和版本；关键词搜索经 `createSqlRagPersistentIndexReader` 与 `createScopedRagSearch` 读取持久知识索引，scope resolver、授权和时区由 Host 注入，并固定使用 BM25，与 Python `strategy="bm25"` 一致。关键词结果返回 ranker 的 `item.text`（标题、摘要和正文的共享预算投影），与 Python `as_public_result()` 一致；只有按 ID 读取返回完整正文。`createWebOwnerAgentKnowledgeReadPort` 明确将无 IM 上下文的 Web 请求限制在 owner scope；群 scope 不能从模型参数直接获得授权。保持 Python 参数语义：ID 与 keyword 同时提供时 ID 优先；空查询和 1–25 以外 limit 由 handler 返回固定错误，默认 limit=5。Core dispatch **4/4**、Host 临时 SQLite/FS 真实索引 dispatch **1/1**，回归覆盖参数错误、撤权、异主与越权 scope 拒绝、时间格式、BM25 结果和同条目 chunk 合并；验证旧向量文件或 embedding 端口不会影响该 BM25 工具。`save_knowledge`/`update_knowledge` 只在 Host 提供 owner-bound `knowledgeWrites` 时注册；生产 Run 已提供该端口且按同一 lease 显式授权，删除仍未开放。本轮新增写入/更新端到端工具 dispatch 用例尚待 devserver 验收。

2026-11-16 devserver 合并复验：Core `knowledge.test.ts` **4/4**、`source-adapters.test.ts` **8/8**（均使用只选目标文件的临时 Vitest 配置，配置已删除）；Host `conversation-tools-runtime-sqlite.test.ts`（含实际 Core Runner 的 `search_conversations` 续轮）**4/4**，`knowledge-tool.test.ts` **1/1**，owner knowledge store、持久 Worker/baseline、正式 Jieba **11/11**，Host 合计 **16/16**。Core build、Web Host production build 通过。Core 标准 Vitest suite 仍因另一会话未登记的 Skill 测试无法加载；Python pytest 环境缺失。Provider、RunStore、授权、scope 和 embedding 使用合成依赖；SQLite/FS 为临时数据，因此未验收生产 Agent Run、真实 PostgreSQL 或真实 embedding Provider。

2026-11-16 回归补齐：统一 `createScopedRagSearch` 在 query embedding transport 抛错时保留已授权范围内的 BM25 结果；如果调用信号已取消，则仍传播取消错误，不把取消伪装成成功。版本匹配的 owner 向量也经过该搜索边界实际读取并参与 hybrid 排名。测试用确定性 Jieba、合成索引与模拟向量端口，未调用 Provider。

`knowledge_index_entries` 已进入 Core schema 17 的 SQLite/PostgreSQL DDL。SQLite v1-v16 通过显式备份迁移升级。Web Host 提供 `migrate:rag-index:check` 与 `migrate:rag-index:apply` 显式 PostgreSQL 迁移命令；迁移校验列、唯一键、owner 外键及 schema 定义的全部检索索引，并允许认领结构兼容的旧 Python 表。已登记迁移若缺少索引、索引列不符或索引未就绪会被拒绝启动；认领旧表时会补建缺失索引。命令尚未作为部署步骤运行。迁移回归已写入，但 devserver 缺少 `GUGU_WEBUI_TEST_DATABASE_URL`，本轮两个 PostgreSQL 场景均跳过，因此不能声称生产数据库已升级。

2026-11-16 PostgreSQL 迁移结构校验补齐：已登记表现在必须包含 schema 中定义的全部 RAG 索引，且每个索引列序、`indisvalid` 和 `indisready` 均符合预期；旧 Python 表认领通过同一 DDL 补齐索引。Host migration typecheck 通过。两个隔离 PostgreSQL 集成场景因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，实际 PostgreSQL 结构仍未验收。

## 生产接入状态

以下条件全部完成后才能把 RAG 标记为生产迁移完成：PostgreSQL 安全迁移已应用并验收、所有当前写入方都有可靠 job 生产路径、可信 scope 授权、向量读取和受控 embedding，以及从实际 Agent Run 调用链验收。Host 已声明 `@node-rs/jieba@2.0.1`（与 1.7.7 依赖版本相同），并提供包内 dict tokenizer adapter；会话工具回归使用真实 Jieba。Node Web Host Worker 仅在 `checkRagIndexMigration` 返回 `applied` 时启动，`pending` 或检查不可用时关闭并记录脱敏状态；生产入口已注入 owner-bound knowledge reader 和 `config.storageLocalPath` memory storage root，因此可用来源包含 knowledge/memory。

**2.0 索引由 Node Worker 消费。** Web Host 在 PostgreSQL 索引迁移已应用且八类来源已装配后启动 Worker。Worker 声明租约和 generation，事务内替换投影并提交状态。部署 2.0 时先结束旧后端消费者，再启用新 Host。

**Node 生产装配已覆盖 RAG 查询、索引 Worker 与 Web owner 反思写入链。** `search_conversations` 按 owner 限定事实表做 BM25，不调用向量；`search_memory` 的 Web owner scope、活动 lease 授权、正式 Jieba、owner-bound 向量读取和可选 embedding 已进入生产 Run；知识自动索引及 `read_knowledge`/`save_knowledge`/`update_knowledge` 也按 lease 进入 registry。Web 私聊 Run finalizer 从同一 owner/session/run 下读取已提交用户消息，再向 Node Redis 队列写入消息 ID、模型身份和 scope 摘要；Node Worker 使用可信 PostgreSQL 来源、授权 Provider、owner 文件 writer、持久回执及 RAG generation 更新记忆。`main.ts → createApp(agentChat) → AgentChatService → dispatch worker → Reconstructor → RAG registry` 与 Node 反思 Worker 均由 Host 组合。未验收范围是目标部署上的 PostgreSQL migration、Redis dispatch/recovery、外部 embedding/聊天 Provider、重启恢复及实际切换；不依赖或回退至 Python。

2026-11-16 Web RAG 工具组合回归：`agent-rag-tool-ports.ts` 将 Python Web owner-only memory 与 `search_conversations` 事实表端口作为一个明确的 Host 组合提供给运行期工具注册器；隔离 SQLite/临时 FS 上通过真实 `createAgentToolRegistry` dispatch，验证两工具同批暴露、会话 Jieba/BM25 命中、memory owner 内容命中、异主文档过滤及旧向量文件 hybrid 召回，新增 Host 测试 **1/1**，会话/记忆/Run 绑定回归合计 **12/12**；旧 Cython rank/tokenizer 与共享语料 **31/31**，Python 搜索工具与迁移契约 **10/10**，Web Host production build 通过。PostgreSQL 专用事实表/持久索引回归 **2 项因隔离数据库未配置跳过、0 失败**。使用合成授权、snapshot、embedding transport 与凭据、临时数据；该组合尚未从生产 Agent Run resource factory 调用，因此不升级为生产已接入。

## 与 Python/Cython 的行为对照边界

`v1.7.7` 源码基线是 annotated tag `v1.7.7` 解引用后的 commit `14c544f1faf1193e8a073844af4a5d7a4872045c`，RAG 实现在 `backend/ts/workers/rag/src`，许可证 Apache-2.0。Node Host 与旧 Cython Python 都采用 Jieba `HMM=false`、ASCII token 处理、字母数字压缩和月份别名；但 Python 用 `rjieba`，Node 用 `@node-rs/jieba@2.0.1`。共享 tokenizer golden 和代表性语料通过不证明所有 OOV/Unicode 输入逐 token 相同，相关边界尚未有全量量化。

旧 Cython 检索语料与 Node Core 共享的固定词法语料目前有 5 个有效 query（含纯英文部署窗口查询），两边均 Recall@3=1、MRR=1；无关 query 为空，异 scope 同词干扰被过滤。这只证明代表性词法质量，不证明全库排序或向量质量等价。1.7.7 TS 的 BM25、confidence-v4、IDF rescore、top-k、置信区间和重复引用聚合在 Core 有对应回归；本轮新增的共享语料用例两端均已重跑通过，但不能据此推断全库或全部 tokenizer 输入的跨语言等价。

业务入口保留明确行为：`search_conversations` 查询 owner 限定事实表并用 BM25，不走持久索引或向量；`read_knowledge` 固定 BM25；只有支持综合召回的 memory 查询才读取匹配版本向量并可选调用 embedding。当前索引 Worker 和 Web owner 记忆生产流程均由 Node 承担；这不代表 IM group/member scope 已有生产者或平台授权。

Node RAG 的八类可重建来源是 project、calendar、note、canvas、scheduled_task、conversation、knowledge、memory；file 自动索引按 2.0 决策退役。Mind、conversation、scheduled_task 的已发现 Node SQL mutation 已在业务事务中排入持久任务，knowledge 的 Node 工具写入也会 tombstone/fence 后原子写文件并排入 freshness job。Node Admin IM 记忆维护接入 group/member 文件变更的索引撤回、scope revision 更新和重建排队；Web owner memory 由 Node 反思 Worker 写入。IM group/member 反思生产者仍需对应平台 Host 按授权能力另行装配。memory scope 枚举只限定待重建的 owner 数据，不授予检索权。Core 工厂、测试替身及工具注册本身不代表完整生产接通。

Web 持久重建器通过 `createWebAgentToolPorts` 把同一 Host 注册器用于 capability schema 发现和 Harness dispatch，并按 lease 固定 owner/session/run 身份；`search_conversations` 和 `search_memory` 已通过当前生产 `main.ts` Run resources 接入。真实 PostgreSQL lease/事务及进程恢复仍未验收；早期记录中“main.ts 仍未创建 `agentChat`”只代表当时的状态。

`knowledge-source.ts` 复用 `AgentKnowledgeReadStore` 的可信 Host FS 端口，读取 owner 命名空间的知识 Markdown 并生成 Python 一致的 summary、keywords/description revision、scope 和 metadata；Web Host 的 `createLocalAgentKnowledgeReadStore` 通过 `@gugu/fs/node` 拒绝路径越界和符号链接，并限量分页/读取。生产 `main.ts` 只在索引迁移状态为 `applied` 时创建该 reader 并传给 Worker；这使 knowledge 进入生产来源集合，不替代真实 PG/部署验收。

2026-11-16 Host 全来源回归：临时 SQLite 经生产 Host 来源工厂、持久 Worker 和正式索引表，实际重建 project、calendar、note、canvas、scheduled_task、conversation、knowledge 文档，并将 memory 包含在完整来源集合中；`rag-index-worker.test.ts` **9/9 通过**，Web Host production build 通过。owner/session/IM 索引 scope、文件系统、授权和数据库均用隔离 fixture；这不验证 PostgreSQL migration、外部服务或生产 Agent Run 调用方。

`memory-loader.ts` 来自 Git tag `v1.7.7` 的 `backend/ts/workers/rag/src/memory-loader.ts`，已迁入 Core 并由 `@gugu/core/agent` 导出。它保留 owner 索引与 legacy memory 文件读取、daily 投影、group/member scope 校验、scope tombstone、snapshot 去重、TTL/LRU 和模型版本匹配向量读取。`memory-scope-state.ts` 复刻旧 Data Runtime 的 scope revision 与 tombstone 查询，按 owner/platform/bot/scope type/scope ID 完整键读取；它只读取状态，不提供授权。Core 行为回归现覆盖 loader 四项和 SQL scope 状态一项，使用隔离 SQLite；Host 临时目录安全回归 1/1。Web Host 受限 local FS reader 只允许 loader 使用的 owner namespace key，并拒绝路径越界、未知文件和符号链接。Web owner-only memory adapter 已把 SQL scope-state reader 和 storage reader 组合起来，但 Web scope resolver 只返回 owner scope，因而不会触发群/成员游标查询；IM scope 枚举/授权仍须由可信 Host 提供。该 loader 是查询时 memory 准备逻辑，不代表持久 memory 重建来源或生产 memory 检索已接通。

2026-11-17 补充 prompt memory snapshot 的旧向量路径：Core `loadAgentMemoryContext` 将取消信号传给 embedding 与 owner-bound 向量读取；Host `createAgentMemoryVectorSearchFactory` 复用 RAG 固定 `.agent/pattern_vec.json` / `.agent/memory_vec.json` reader、BYOK resolver、RAG embedding adapter 与 Host transport。`createWebAgentRagResources` 现在在配置可信 embedding 且未显式提供其它向量服务时，自动用同一 resolver/transport 创建该 Host factory；显式 source 注入优先保留。超限 51 条 pattern 的端到端资源工厂回归验证同模型版本向量实际选中超额相关条目，并经真实 `search_conversations` registry dispatch；该测试使用临时 FS/SQLite、合成租约校验和模拟 Provider response。该 factory 目前仍没有生产 `main.ts` caller，因此不代表生产 Agent Run 已启用。

`memory-source.ts` 复用同一 loader 将 owner 索引/legacy memory 文件及 Host 枚举的 group/member scope 投影成正式 RAG 文档。`createPostgresAgentMemoryIndexScopeReader` 仅从当前 owner 的 reflection cursor 中枚举 scope；Core 再按完整 scope key 读 revision/tombstone，已删除 scope 不产出索引文档。Host Worker 用临时 SQLite、隔离 FS 和合成 cursor 验证 owner/group/member 投影确实写入正式表、异主内容与 tombstone 内容不写入；两个群拥有完全相同的原始 source/version/chunk 时也各自保留索引行，避免正式表唯一键覆盖跨 scope 文档。生产 `main.ts` 将 `config.storageLocalPath` 传入 Node Worker，memory source 属于正式来源集合；Node Admin IM 记忆维护在文件变更前撤回索引、变更后 bump scope version 并排队刷新。Web owner 记忆的内容生产由 Node finalizer、后台模型分支和 owner writer 完成；group/member 的 IM 反思需各平台 Host 独立提供可信能力。此处旧阶段日志关于 Python producer、共享消费者和未装配生产 Run 的描述均为历史状态，不是当前实现或兼容契约。

2026-11-16 初版共享检索质量语料：旧 Cython `build_text_index/search` 与 Node Core `createRagLexicalIndex` 共用 `docs/testing/fixtures/rag-relevance-corpus.json`，由旧版和 TS 各自使用正式 Jieba/HMM=false tokenizer。中文部署、南京天气、中英混合 GTA6、owner scope 四个有效查询两端均 Recall@3=1、MRR=1；无关查询两端均返回空列表；与 owner 查询词完全相同的 group-scope 干扰文档两端均被过滤。Python 用例 1/1、Node Host 用例 1/1 通过。该语料验证词法检索质量与 scope 裁剪，不覆盖正式 PostgreSQL、真实向量 Provider 或生产 Agent Run。

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

Node scheduled_task 的 create/update、显式删除、一次性完成删除、项目回收/过期、日历 Undo/redo 与工作区解绑现会在主数据事务内合并 `scheduled_task` 索引任务。Core 与 Host producer 保留首次及先前 pending source ID；删除由来源读取为空文档并写墓碑。devserver 隔离 SQLite 有效子集 **4 个文件、17 项通过、2 项 PostgreSQL 子测试跳过、0 项失败**，覆盖 Core calendar mutation、一次性任务、工作区删除和 scheduled-task 删除新鲜度。一次误将 PG-only 测试纳入命令时因缺少 `GUGU_CORE_TEST_POSTGRES_URL` 在套件加载阶段失败，排除后 SQLite 子集重跑通过。Host PG 与 Python pytest 未运行；本轮未重跑 typecheck/build。Mutagen 3 处生成目录冲突未 flush 或覆盖。**该次阶段记录时** knowledge 和 memory 仍缺 Node 写入端及 freshness producer；后续 knowledge 写入端已于 devserver Linux 经 Worker→正式索引链路验收，普通 memory 反思写入端仍未迁入 Node。

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

截至该次工作快照，完整 1.7.7 RAG 来源投影已有 project、calendar、note、canvas、scheduled_task、conversation、knowledge、memory；正式 Jieba 和可选 owner-bound 向量读取/受控 embedding 也有实现。Node knowledge 写入与索引 freshness 调度已通过 Host 隔离 SQLite/FS 调用链；普通 memory 文件更新与反思 job producer 仍缺。`search_conversations` 仍走 Python 一致的事实表 BM25 路径，其他支持向量的 RAG 查询才使用正式索引及向量。该快照时 `main.ts` 未创建 `agentChat` 或调用 `createWebAgentReconstructor`，conversation/memory/knowledge 工具端口尚未进入生产 Run，所以工具、授权、scope 与向量的隔离回归不能记为生产接通。当时的 Python pytest 环境无 pytest 模块，本轮未运行；后续 pytest 与 Node 回归记录见下文。生产 PostgreSQL、Redis 和真实 Provider 仍未验收。

2026-11-16 devserver 当前树 RAG 复验：Core RAG Host `memory-tools-runtime-sqlite.test.ts` **5/5**、`conversation-tools-runtime-sqlite.test.ts` **4/4**、`rag-index-worker.test.ts` **9/9**、`rag-relevance-corpus.test.ts` **1/1**；Web Host 生产源码 `tsc --noEmit -p tsconfig.build.json` 通过。索引 Worker 测试使用隔离 SQLite/FS，相关性语料使用正式 Jieba；工具回归中的授权、IM context、凭据、embedding transport 和 Provider 为模拟依赖。Python pytest 因项目 `.venv/bin/pytest` 不存在未运行；生产 Agent Run、PG migration 部署、Redis 与真实 Provider 未验收。

2026-11-16 当前树再验：Core RAG **9 个文件、63/63 通过**；Host RAG 来源/Worker/Jieba、memory 授权与快照、`search_conversations` Runner 续轮及共享检索语料 **10 个文件、28/28 通过**。执行前对本次涉及的 73 个 Core/Host RAG 源码与测试逐文件核对 SHA-256，工作区与 devserver 完全一致。Node 测试使用隔离 SQLite/临时 FS；PG snapshot、授权/配置、RunStore、embedding transport 与 Provider 均为合成依赖。devserver 临时 Python 环境中的 Cython rank、tokenizer 和固定相关性语料 **31/31 通过**，Cython 编译产物位于临时目录；另有既有 `pytest-asyncio` loop scope 弃用提示。当前仍无 PostgreSQL 服务端，本轮未运行 PG 集成；Redis、真实 embedding Provider 和生产 Agent Run 也未验收。此结果只更新组件回归证据，不把现有 RAG 组合端口记为生产 Run 已接入。

同一隔离 Python 环境中，旧 `search_conversations` 工具行为与工具 schema 安全契约 `test_search_tools.py`、`test_tool_schema_security_contract.py` **33/33 通过**；覆盖 owner 历史检索、baseline 前消息、群/异主隔离、关键词参数和旧消息 ID 定位。Node 对应 Runner/registry 工具回归为上述 `conversation-tools-runtime-sqlite.test.ts`，使用隔离 SQLite 与模拟 Provider。该 pytest 集合加上 Cython rank/tokenizer/语料共 **64 项通过**；没有连接 Redis、PostgreSQL 或外部 Provider。

### Knowledge Node 写入与索引 freshness（2026-11-16）

Core `createKnowledgeWriteTools` 现经同一注册器提供 `save_knowledge`、`update_knowledge`，沿用 Python 的字段限制、同 topic 覆盖/来源冲突父子关系、关键词去重、版本历史、部分更新与 32 MiB 序列化预算；owner 与路径只取可信 Run identity/Host 注入。Host `createLocalAgentKnowledgeWritePort` 复用 owner FS store 与 `writeLocalFile`：首写先执行 Python `.timestamps-iso-v1` 迁移，再在事务中墓碑化旧 `knowledge` 投影并推进 generation（围栏在途 Worker），原子写 Markdown 后排入持久全来源重建；旧索引或不完整写入不会继续对搜索可见。删除工具保持关闭，直到 Core registry 接入 destructive confirm 门。

本机 macOS 回归：Core `knowledge.test.ts` **7/7 通过**，覆盖真实注册器 dispatch 的保存、owner 注入、同主题版本、更新历史、部分更新、错误参数和拒绝副作用，并逐字段往返验证 Python Markdown 的微秒时间戳；Host `agent-tool-registry.test.ts` **18/18**、`knowledge-tool.test.ts` 与 `rag-index-worker.test.ts` 合计 **10/10**，`knowledge-write-runtime-sqlite.test.ts` 的索引墓碑/在途 Worker generation fence **1/1** 通过。Linux 安全原子写在 macOS 的 1 项跳过，已于 devserver 补跑：Host knowledge-write + registry **20/20** 通过，包含旧时间戳迁移、owner FS 原子写、持久队列到正式索引表及异主拒绝。Python `test_knowledge.py` 因 pytest 缺失未运行；生产 `main.ts` 仍无 Agent Run caller，所以新写端口暂未生产注入；生产 PostgreSQL/Redis 与真实 Provider 未验收。

2026-11-16 devserver Linux 复验：SHA-256 确认 RAG/知识写入测试和直接依赖源码同步一致后，Core build 与 `knowledge.test.ts` **7/7** 通过；Host knowledge-write + registry **20/20**、memory/conversation/全来源 Worker **18/18** 通过。Linux 安全原子写端到端测试现在实跑通过。测试使用隔离 SQLite、临时 owner FS、合成授权/scope 与 mock Provider/RunStore/embedding；未连接 PG、Redis 或真实 Provider。对应 Python pytest 因项目 venv 和系统 Python 均无 pytest 未运行。生产 Agent Run、部署 migration 与 Node Worker owner 切换仍未验收。

2026-11-16 共享语料补充纯英文查询：增加 deployment window 文档及英文检索 query。Node Host 正式 Jieba/Core lexical 测试 **1/1**、Python Cython fixture pytest **1/1** 通过；两项均在 devserver 运行，Python 使用 `/tmp` 临时 venv，Cython 编译目录由测试临时目录提供。五个有效词法 query 目前均 Recall@3=1、MRR=1；无关结果为空，owner 同词 group scope 干扰被过滤。这个固定语料只验证代表性词法召回及 scope 裁剪；生产 Agent Run、真实 PG/Redis 和外部向量 Provider 仍未验收。

2026-11-16 生产 RAG registry 组合收口：新增 `createWebAgentProductionToolRegistry`，由单个工厂共同创建生产 RAG ports 与工具注册器，memory 授权闭包复核的正是实际分派所用 registry capabilities，避免 Host 手动拼成不同授权实例。Node Core RAG **9 个文件、63/63**，Host RAG 全来源/权限/FS/工具/Runner **10 个文件、28/28**，注册工厂与查询调用链子集占其中 **25 项**，均在 devserver 通过。Core 覆盖 rank/tokenizer/scope/loader/embedding/cache；Host 覆盖正式索引重建、损坏状态脱敏、owner-bound FS、真实 `registry.tools.dispatch`、`search_conversations` Runner 续轮、memory 授权/快照/向量召回及中英共享语料。Run lease、PostgreSQL 查询、工具配置、embedding transport 与凭据仍使用合成依赖；生产 `main.ts` 尚未调用该工厂或装配 Agent Run，故不计为生产工具已接通。Core package build 通过；Host 源码类型检查曾因解析到过期 `@gugu/core` dist 而失败，按两端源码 SHA 核对后重建 Core，Web Host `tsc --noEmit -p tsconfig.build.json` 通过，并在 build 后重跑 Host RAG **28/28**。

2026-11-16 文件正文 DB 边界回归：正式索引写入器的 `replaceSource` 与 `replaceDocument` 均拒绝 `file` 来源，避免绕过 2.0 授权 FS 真源规则将文件正文持久复制进 DB。Core SQLite 持久索引/会话工具集成测试 **42/42** 在 devserver 通过；使用隔离临时数据库，未触及真实文件或用户数据。同期 Python/Cython rank、tokenizer、相关性语料、旧 `search_conversations` 与 schema 安全回归 **64/64** 通过。文件索引已退役，此测试只保护写入边界，不代表文件搜索工具已迁移。

同日生产 registry 子集补测：`createWebAgentProductionToolRegistry` 经正式 registry `dispatch` 同时调用真实 Core SQLite `search_conversations` 和 owner memory hybrid 检索，Host 隔离测试 **2/2** 通过。PG lease/session 授权、持久快照、embedding transport 与 Provider 凭据均为合成依赖，因此此项不是生产 Agent Run 装配证据。

2026-11-17 devserver 当前树复验：Core RAG 9 个文件 **63/63**；Host lease 授权、production registry、`search_conversations` facts/Runner 续轮、memory scope/向量、knowledge freshness、持久 Worker、正式 Jieba 和共享语料 **9 个文件、28/28**。Core build、Web Host 生产 tsconfig noEmit 检查通过；Host 回归在 Core build 后重跑通过。对应 RAG 源码、测试及 Python 基准文件哈希与 devserver 一致。Node 使用隔离 SQLite、临时 owner FS、合成 lease/snapshot/权限和 mock embedding/Provider；Python pytest 本轮未重跑，最近一次 Python 基准 **64/64** 见下方历史记录。`main.ts` 仍未创建生产 `agentChat`/`createWebAgentReconstructor` 调用者，因此实际 registry 与 Runner 测试仍不代表生产 Run 已接通；生产 PostgreSQL、Redis 和真实 embedding 未验收。

同日核对 `v1.7.7` 的 `backend/ts/workers/rag/src` 文件清单：除 `index.ts` 外，Core 中均有对应实现或按 2.0 分层后的替代实现。该单文件是旧 sidecar 的 stdin/stdout 协议、进程内状态和 Data Runtime/存储装配组合根；它没有作为第二套 Worker 迁入，纯检索、排序、memory 准备、source projection 与 cache 行为分别由 Core RAG 模块承接，持久索引和来源副作用则接入 2.0 Core/Host。故旧协议文件缺席是边界替换，不是遗漏算法源码；生产 Host Run 尚未装配的差距仍单独保留。

2026-11-17 并行工具注册器与 Core ranking 变更后的复验：逐文件 hash 确认 RAG Core 源码、RAG 测试、Host 注册器和 RAG 调用链测试与 devserver 一致。Core RAG 加持久会话集成 **10 个文件、105/105**，Host RAG 来源/Worker/Jieba/registry/search Runner **10 个文件、28/28**，Python/Cython 与旧 `search_conversations` pytest **64/64** 均通过。后端测试使用临时 venv；Node 使用隔离 SQLite/FS 和合成授权、RunStore、凭据及 embedding transport。生产 PostgreSQL、Redis、真实 Provider 与 `main.ts` Agent Run 仍未验收/接通。

同日 registry 组合回归：在生产 RAG registry 外包装当前 MCP ToolPort 后，真实 `search_conversations` dispatch 仍返回 owner 会话结果，动态 MCP 定义/调用也仍按 owner 与当前 signal 执行；Host 定向测试 **2/2** 通过。MCP 目录、授权、远端 runtime、lease/session 数据仍为合成依赖；这验证了两个 ToolPort 的组合接口，不代表 MCP 或 RAG 已进入生产 Agent Run。

同日 Python 基准复验：devserver 临时 venv 对 Cython rank、tokenizer、共享检索语料、旧 `search_conversations` 工具及 schema 安全契约执行 pytest **64/64 通过**。依赖、Python/Cython 构建与 bytecode 缓存均隔离在 `/tmp`，配置路径指向不存在的临时文件；未访问真实 DB、Redis、用户文件或 Provider。保留 pytest-asyncio fixture loop scope 与 Sudachi API 弃用提示。

同日补齐 Web Run 工具绑定组合回归：生产 RAG registry 先经过 `createWebAgentToolPorts` 的 schema 发现过滤，再以绑定 lease identity 实际 dispatch `search_conversations`；用例同时断言未配置的 `read_knowledge` 不会暴露。Host `agent-rag-tool-ports.test.ts` **2/2 通过**，在 devserver 先重建 Core 后执行。SQLite/文件系统为隔离临时数据，lease、PostgreSQL 授权/快照、配置和 embedding transport 为合成依赖。该回归覆盖生产 registry → Web Run 工具边界，不等于生产 `main.ts` 已装配 Agent Run；Python 基准未因本次 Node 测试改动重跑。

同日将 `conversation-tools-runtime-sqlite.test.ts` 的 Core Runner→Provider 续轮用例切换为调用 `createWebAgentProductionToolRegistry`，让生产 registry 工厂的 `search_conversations` 经实际工具 schema、Runner dispatch 和 Provider 续轮；与 Web Run 工具绑定用例合计 **6/6 通过**，两文件严格 TypeScript 检查通过。测试使用隔离 SQLite/FS 和合成 Provider/lease/config；会话搜索没有触发 memory PG 授权/快照。补跑 PostgreSQL 来源、队列及 migration 定向文件 **2 通过、6 跳过**，未配置隔离 PG 数据库，未连接真实 PG。生产 `main.ts` 装配与真实 PG/Redis/embedding 仍未验收，Python pytest 未重跑。

同日共享固定质量语料回归收紧：旧 Cython 与 Node Core/Host 都要求 Recall@3=1、相关结果 MRR=1、无关 query 返回空、owner scope 不包含 group 干扰项，并对相同索引重复查询断言 hit 顺序稳定。devserver Node 正式 Jieba/Core lexical **1/1**、Python Cython **1/1**。Python 只收集 RAG 子目录并使用隔离 `/tmp` venv；该固定小语料只约束代表性 query 的排序和重复查询稳定，不代表全库或向量排序等价，也不构成生产 Agent Run 验收。

2026-11-17 查询 embedding 短缓存按 Python 基准补齐：SHA-256 key 只包含 provider、model、dimensions 与归一化 query；只缓存成功向量，5 分钟 TTL、64 项上限，并向调用方返回副本。Node RAG **9 个文件、66/66**、Python embedding pytest **24/24** 在 devserver 通过；回归覆盖模型/维度隔离、失败不缓存和调用方不可修改缓存向量，mock transport 未访问真实 Provider。该缓存是进程级重建结果，不改变 RAG 工具尚待生产 Agent Run resources 接入的状态。

2026-11-17 Local/Ollama 行为对齐：BYOK embedding resolver 只为这两个明确 Provider 标记 `allowLocal`；Host RAG adapter 将其传给 `embedRagQuery`，Node Provider Transport 只有在 Host 与单次请求两层都允许时才访问本机。生产 `main.ts` 使用的 `createAgentRagEmbeddingTransport` 开启 Host 能力上限，但 `embedRagQuery` 仅为可信配置中 provider 为 Local/Ollama 且 `allowLocal=true` 的请求打标；云端 Provider 即使配置 loopback URL 仍拒绝。Host memory tools/embedding **6/6**、Core Provider transport **38/38** 通过；前者使用合成凭据/mock transport，后者使用合成本机服务。

2026-11-17 memory 查询取消补齐：Core loader 将 `search_memory` dispatch 的 signal 传到 owner/IM scope 与向量文件读取，SQL scope 状态读取前后检查取消；可选向量读取只对普通 I/O 错误回退 BM25，取消继续传播。devserver Core RAG **9 个文件、68/68** 与 Core typecheck 通过。隔离存储/SQL及合成工具授权用于回归；Python 未重跑，本次只补 Node 取消语义，不改 Python 行为基准。生产 Run 仍由主装配链另行验收。

2026-11-17 Web 重建器 Provider 辅助端口生命周期：Core Runtime 把同一 Run Provider 的分支调用、摘要投影和反思投影交给 Host 资源绑定回调；重建后绑定失败会关闭已创建 Runtime 并释放配置绑定，避免留下 Provider 资源。Host 重建器定向用例 **2/2 通过**；整文件 **2 通过、1 跳过**，跳过项需要隔离 PG/Redis。该回调目前没有生产 `main.ts` 调用者，也未实现 Python 压缩/反思策略装配，不能计为生产 Agent Run/RAG 接通。

2026-11-17 Web RAG Run 压缩 Provider 适配：`createWebAgentRagResources` 现在可从已验证 Web binding 的 `compress_conv.md` 指令、模型身份、上下文/输出预算、scope、工具 Schema 与同一个 ProviderRuntime 装配 Core `createCompactionSummarizer`；摘要投影转换也由相同 ProviderRuntime 提供。缺少 `compress_conv.md` 时使用与 Python 一致的内置提示词回退；读取错误若不是文件不存在则继续失败。压缩器延迟到压缩实际触发时才校验输出预算并创建摘要投影，避免无效压缩配置阻断普通 Run。此前 devserver Core build、Web Host production tsconfig 检查通过；Provider binding、mock HTTP branch/compaction 与 RAG resource/search dispatch **3/3 通过**。使用合成配置、mock Provider、隔离 SQLite/FS；没有真实 PG、Redis、embedding 或外部 Provider 验收。`main.ts` 仍未装配 `agentChat`/dispatch/reconstructor caller，因此该切片仅补齐可复用 Run 资源，不能记为生产接通。

2026-11-17 Web 自动 RAG 生产 adapter：Host `createWebAgentProductionRagContextBuilder` 通过 lease 固定身份、检查 owner-context policy，并复查 PostgreSQL active run 与 dispatch token/fence/租约后，组合 Core 正式索引和 owner-bound 1.7.7 向量文件/embedding 查询；独立 `memoryEnabled` 快照开关不关闭自动 RAG，未配置或失败时保留词法回退。其真实 Core `buildRunRagContext` 行为回归使用临时 SQLite/FS、模拟 active-lease Pool 与 mock transport。此 factory 尚未由生产 `main.ts` Run resources 调用，不能算生产接入完成。

2026-11-17 Web 自动 RAG 准备端口：`createWebAgentRagContextBuilder` 通过 Web dispatch lease 固定 owner/session/run，使用正式持久索引、owner 授权、消息水位、confidence rank 和历史 hash 去重生成可回放 Canonical block；Core `buildRunRagContext` 到该 Host builder 的临时 SQLite 行为回归 3/3（召回、去重、拒绝、开关关闭和取消传播），Core scoped search 6/6。Core 的默认 Vitest 配置受并行工作区 suite manifest 漂移阻断，目标文件通过 `/tmp` 配置单跑。该 builder 尚未接入 `main.ts` 的 Agent Run reconstruction resources；生产权限/向量装配、PG/Redis 与真实 Provider 仍未验收。

2026-11-17 当前树 RAG/恢复回归复验：先检查 `gugu2-0` 同步状态，发现 3 个既有冲突未 flush；本轮涉及源码、测试和文档与 devserver 的 SHA-256 一致后，在 devserver 串行执行。Core build 通过，Core RAG **9 个文件、69/69**；Host RAG tool ports/resources、正式 Worker、恢复注册器和文件恢复适配器 **26 通过、4 个隔离 PostgreSQL 用例跳过、0 失败**；Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。Node 使用隔离 SQLite/临时 FS、合成 lease/Pool/embedding/Provider；真实 PG migration、Redis、BYOK/聊天 Provider 与生产进程恢复未验收。devserver `python3 -m pytest --version` 返回未安装 pytest，本轮 Python pytest 未运行。`/tmp` 临时 Vitest 配置已删除。生产 Run 已接 RAG；Node Worker 消费者仍默认为 Python，普通 owner memory 文件和反思任务仍由 Python 生产。

同日 Local/Ollama 生产 transport 当前树复验：BYOK/transport/Core embedding 相关源码与测试哈希和 devserver 一致；Host `agent-rag-transport.test.ts` 与 `memory-tools-runtime-sqlite.test.ts` **7/7** 通过。回归使用合成 loopback HTTP 服务，不连接真实 Provider；验证 Local/Ollama 被可信配置允许时可请求，而云端 Provider 指向同一 loopback 仍在发出网络请求前拒绝。此前 README 中“生产 `main.ts` 固定 `allowLocal:false`”为过时判断，现已更正为 Host 能力上限 + 每请求可信标记双门控制。

2026-11-17 Core RAG 整组复验：源码和测试目录哈希与 devserver 一致，Core build 成功，完整 RAG 目录 **9 文件、69/69 通过**；Host RAG port/context 文件 **3/3**。默认 Vitest 被共享 suite manifest 漂移阻断，使用临时 `/tmp` 配置执行；Host production typecheck 被既有 MCP SDK 缺包诊断阻断。该结果未触达真实 PG/Redis/BYOK Provider，自动 RAG builder 仍未由生产 `main.ts` Run/reconstructor 调用。

### PostgreSQL 首次切换到 Node Worker

应用 RAG schema 迁移并结束旧索引消费者。在目标 PostgreSQL schema 上运行 Web Host 的 `migrate:rag-index:queue-baseline` 补建既有数据。Web Host 在迁移就绪后启动 Node 消费者。

补建命令为现有用户的八种来源排入整来源重建，涵盖已有增量任务和旧索引的用户。任务与一次性迁移记录在同一事务提交。重复执行返回 `unchanged`。命令返回 `queued` 只表示任务已持久化，切换验收还需确认 Worker 消费结果。补建异常时事务回滚，可以重试。
