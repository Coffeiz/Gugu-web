# Gugu 2.0 迁移任务清单

> 更新：2026-11-16。本文维护实施顺序、当前状态、验收证据与未完成任务。目标架构和多端职责见[架构说明](Gugu-2.0-架构说明.md)；依赖替换盘点见[Python → Node 依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md)。
>
> **当前路线：先完成 Node Web/NAS 后端迁移，再基于稳定的共享 Core 推进桌面产品化。** Web 使用 Node Host + PostgreSQL；桌面使用 Electron + Node Core + 本地 SQLite。两端共享 Core 契约，但拥有不同 Host 和数据生命周期。迁移期间未具备完整 Node 命令的 Web 写路径继续整体走 Python，不双写。

> **2026-11-13 存储范围决策**：Gugu 2.0 Linux/NAS 自托管版只支持本地文件系统，Node WebUI 不迁移在线 OSS/S3 文件、附件或记忆存储 API（包括 OSS 直传/预签名 URL、对象配额和对象搬移）。既有 Node OSS 实现与历史验收记录仅作迁移过程证据，不构成 2.0 支持承诺；旧 OSS 数据迁移/导出路径仍需实现与验收，用户数据切换到 2.0 前必须完成数据盘点和去向确认。独立备份目标另行设计，SaaS 对象存储不在本决定范围内。

Agent 工具与技能正文的注册、配置和授权边界见 [Agent 工具与技能注册机制](Gugu-2.0-Agent工具与技能注册机制.md)；注册器存在不代表具体工具或 Host 已完成迁移。

## 执行顺序

1. **N0–N1：共享 Core 基线。** 已确定边界并完成项目/联系人数据切片；补齐性能预算和业务 schema/升级交接。
2. **N2：Node Web/NAS 后端。** 优先建立 Node HTTP Host，保持现有 API/SSE 契约，先迁移完整业务命令与 PostgreSQL 写路径。
3. **N3：扩展数据域与 Agent。** 按完整事务边界迁移会话、消息、任务、Provider、工具、RAG 等业务，逐步退役旧 Python 生产调用方。
4. **N4：桌面产品化。** 复用已稳定的 Core 业务能力，完成 Electron + 本地 SQLite、端侧能力和发行验收。桌面 UI 可提前做不依赖未稳定 Core 的准备，不提前切换业务写路径。
5. **N5：兼容收敛与 2.0 发布。** 确认无生产 Python 调用方后删除对应兼容代码；独立计算服务可继续保留。

## 5. 迁移 checklist

`[x]` 表示该项已有代码或明确交付证据；`[ ]` 表示未完成，部分已有基础也不勾选。实现完成、PR 合并、正式发行分别记录。不得用 CI 总数或目录存在推断业务等价。

### N0——边界与基线

- [x] 确定顶层 Core、端侧 FS/沙箱、桌面单用户和服务端多用户边界。
- [x] 确定 TS/Node 方向；当前使用 Node 26 LTS、pnpm 10.15、Kysely、Zod、better-sqlite3 与 pg，版本由 lockfile 固定。
- [x] 桌面切换到 Electron + TS Host 验证实现；复用 Vue 入口、独立 Node Core 和原生 Broker 边界，完整产品与发行另行验收。
- [x] 建立可移植 Domain/Contracts、独立 Core 包和依赖边界检查。
- [x] 保留 Python 参考实现及首批共享合成语料。
- [x] 建立现有 Node Core 对应 Python 行为映射与有意差异登记，见测试专题。
- [ ] 冻结冷启动、内存、包体、IPC 等待、读写 P50/P95、取消/恢复的同口径性能预算。

### N1——数据统一底座，先覆盖项目/联系人

- [x] 项目/联系人领域校验、应用服务与共用 SQL 仓储。
- [x] SQLite/PG Adapter、UoW、跨域提交/回滚、owner 隔离和项目 CAS。
- [x] UUID、UTC 微秒、列别名、归档/墓碑过滤与旧库互读的首批契约。
- [x] SQLite 显式初始化、备份升级、坏库/部分唯一约束拒绝及失败恢复。
- [x] 原子操作收据、冲突检查、重启后查询及未知结果恢复提示。
- [x] 修复满队列/并发关闭、非法收据参数、时间/编号边界；仓储与事务职责拆分，启用未使用代码检查。
- [x] 补充现有项目/联系人同逻辑回归、共用双库契约、Python 序列对照及 pytest 语义分层；最终门禁结果以 PR 为准。
- [ ] 完整业务 schema/Alembic 历史、升级与跨版本回滚策略交接。

**Projects/Clients 本轮收尾（2026-11-16）**：

- [x] 正式 SQLite schema 17 的项目更新回归：Core Web 更新用例经共享 Kysely 事务验证字段/null、阶段、归档、完成时间、owner/墓碑、空补丁、CAS 和失败回滚；桌面基础改名经实际 IPC/Worker 验证。
- [x] 核对联系人 SQLite/PG 共用实现与 Python 契约；补充码点长度、部分更新、删除/收据原子性和重开持久化，Web/桌面实际调用者均使用公开 Core 能力。
- [ ] 本轮 PostgreSQL 合同重跑：当前环境没有可用隔离实例或连接变量，未实测，不用历史报告、SQLite 或 mock 代替。

本机 Core 定向 6 文件 71/71、桌面项目/联系人 3/3、Python pytest 57/57；Core 生产构建及本切片定向 TypeScript 构建通过。完整测试类型检查和标准发现入口另有无关既存错误。旧文件目录改名、计数、文件引用/恢复/Undo、生产 schema 和部署不在本轮闭合范围，详见 [回归证据与边界](../devlog/2026-11-16-Projects-Clients共享Core回归收尾.md)。

### N2——Node Web/NAS 后端迁移

**Projects 文件共享层（2026-11-16，续接前述数据更新切片）**：

- [x] 项目文件计数读取统一到 Core，Web 项目列表/详情/计数和变更回执复用同一适配；保留 owner 与旧投影语义，不扫描文件库或假造缺失投影。
- [x] 文件相对引用的路径解码、逐段查询、scope 根和文件优先规则进入 Core；现有 Web 文件查询适配已接入，Host 保留 owner/scope 查询和旧 DTO。
- [x] 项目删除/恢复、逻辑恢复路径、项目 Undo/redo 和 journal 文件恢复决策进入 Core；现有 Web 接线通过薄事务/存储适配复用，物理文件访问留在 Host。
- [x] 临时 SQLite/真实临时文件验证同批恢复、冲突改名、事务失败补偿、owner/版本拒绝与 Undo/redo；Node Core 26/26、Host 有效子集 30/30、原 Python pytest 72/72、补充路径对照 12/12，Core 构建及定向类型检查通过。
- [x] PR #121 防覆盖修复：常规文件通过排他硬链接占用目标后才删除源，正向/rollback/journal 不再依赖检查后 rename；目标竞态、补偿冲突及 SQLite 删除/恢复/Undo/redo 事务回滚通过，Host 定向 62/62、相关 Python 15/15。没有目录原子不覆盖能力时明确拒绝目录移动，源目录保留；这项功能限制和 PG 未实测范围见[修复记录](../devlog/2026-11-16-PR121项目移动原子防覆盖.md)。
- [ ] 正式 SQLite 路径索引/计数投影、授权根和桌面文件端口生产装配；不新建旧文件对象 ID 体系来补齐此项。
- [ ] 隔离 PostgreSQL/完整多域 schema、完整认证文件 Undo 路由与跨进程 journal 验收；本轮无 PG，整站路由测试另因缺少图像依赖未加载，不计通过。

具体 Python 规则、实际调用链、夹具范围、已保留差异和 FS 依赖见 [共享层与验收记录](../devlog/2026-11-16-Projects文件计数引用恢复Undo共享Core.md)。这完成可独立的共享规则与现有 Web 接入，不代表完整 Local 文件库或桌面物理生命周期已迁移。

引导状态规则与事务仓储已移入 Core，Web Host 已接入 PostgreSQL 仓储；正式 SQLite schema 14 新增状态表及 owner 约束。隔离 SQLite 的引导及旧版升级回归 44 通过，覆盖版本 12/13 升级、冲突回滚和非空约束；另以临时用户态 PostgreSQL 运行 Core 双库合同 5/5、Host 路由与 PG 仓储 3/3、生产 startServer 鉴权与 PG 集成 1/1，Python 基线 3/3。Core 构建及当前树 Host 类型检查通过；先前类型检查曾被 Admin 测试缺失模块阻断。生产组合根测试使用 Fastify 注入，桌面调用方尚未验收。

反馈校验与双库仓储已移入 Core，Web Host 复用同一服务；SQLite schema 15 增加反馈表和 owner 约束。隔离 SQLite/PG 回归、Web 路由及生产 Host 鉴权和 PostgreSQL 组合根验证通过；桌面调用方尚未接入验收。Web Host 提交后读取邮件偏好并异步发送反馈通知；生产 Host→隔离 PG→本地 TLS SMTP 组合测试通过，测试使用 Core 源码映射和合成 schema，邮件模板样式未与 Python 逐项对齐，真实部署未验收。

**当前优先级调整：先完成已有跨端业务的公共化，再继续新增 N2 业务迁移。** 先盘点 Web Host 已实现切片，把桌面也需要的领域规则、完整用例和数据契约收敛到 Core；Web Host 保留 HTTP、认证、部署和注入。以现有 Python pytest 与已实现的 Node 行为为基线，按业务切片保留 PostgreSQL 路径、补齐 SQLite 适配及双库契约回归。PG 专属锁或查询、单端 Admin/认证和平台能力按职责保留专用实现；不机械迁移未实现能力或为了统一重写无关代码。公共化完成后再恢复剩余 N2 功能迁移，避免阻碍桌面复用。

**Web Host 组合根收敛**：当前 `apps/web-host/src/app.ts` 和 `main.ts` 集中了大量域路由注册与 Host 依赖装配。按架构说明逐域拆薄，不设行数门槛，也不进行一次性整文件重写。

- [ ] `app.ts` 保留 Fastify 实例、共享 HTTP 边界、健康检查与域插件挂载；按业务域提供 `modules/<domain>/routes.ts`，聚合该域现有路由，保持认证身份、HTTP 状态/错误和 Fastify 生命周期语义。
- [ ] `main.ts` 保留启动配置、共享连接资源、服务/Worker 启停与优雅关闭；把确有多项依赖或生命周期的域装配迁入可选的 `modules/<domain>/host.ts`，避免重复构造逻辑；不要求每个域都创建 Host 工厂。
- [ ] 每次只收敛一个业务域，保留旧 Python 基线和现有 Node 路由回归；确认模块插件和启动/关闭验证通过后再处理下一个域。不得引入通用 DI 容器或逐路由空壳层。

当前 N2 与 RAG 仍在修改 `app.ts`、`main.ts`；先完成各自进行中的功能切片，再按互不重叠的域逐步收敛组合根，避免并行搬动同一入口文件。

- [ ] 盘点并完成既有跨端项目、联系人、日历、Mind、Local 文件、工作区及相关 Undo 等可共享切片；事务、权限、幂等、失败补偿和提交后事件保持原有契约，SQLite 与 PostgreSQL 均通过相应隔离回归。
- [ ] 盘点并收敛 Agent 会话、Run、队列等已实现跨端规则及持久化端口；HTTP/SSE、Redis 协调及桌面 IPC 分别由 Host 适配，不以测试替身或路由注册代替接入。
- [ ] 对已存在的跨端工具复用 Core 领域用例与平台端口；工具注册、安全边界和 Host 装配职责分开，与其他公共化切片协调接口。

#### 已有业务跨端公共化清单

以下仅统计已有 Web 业务的共享工作，不代表整个 N2 或桌面产品完成度。勾选表示该项范围内的用例、正式双库适配和对应调用方均已接通，并按 Python 行为基线完成适用的回归；原型、单库实现或仅有路由不算完成。按业务切片增量交付，不为凑统一结构增加无必要的抽象。

Admin 专属 API 为服务端能力，当前 Web 使用 PostgreSQL，未来 SaaS 使用自身服务端适配，不要求 SQLite 或桌面 IPC。仅当某条规则或数据能力被普通业务或桌面实际复用时，才按对应跨端契约验证。桌面埋点采集与上传不属于 Admin 查询：其本地离线队列可使用 SQLite，服务端接收和聚合另行实现。

- [ ] 按架构说明将现有共享业务、用例和适用数据实现逐步按领域收敛到 `packages/core/src/` 对应模块；Web Host 的目标 `modules/` 保留 HTTP、平台适配和装配。同步迁移真实调用方、测试与包导出，移除确认无调用方的旧 Node 内部转发层；保留 Python 参考后端及既有对外行为、数据和运行时协议。

- [x] 建立共享 Core、SQLite/PG 适配、事务和首批项目/联系人双库契约。
- [ ] **项目与联系人**：桌面已通过受限 IPC 接通项目列表/创建/重命名及联系人列表/创建/重命名/删除，真实 SQLite Worker 回归覆盖重启持久化；仍需补项目更新的正式 SQLite 覆盖，以及文件计数、引用、恢复和 Undo 等跨域路径，并核对联系人双库行为。
- [ ] **日历**：桌面已接通列表、创建、标题/日期编辑、软删除及 Undo/Redo，具名 IPC + Core Worker + 正式 SQLite 回归覆盖版本冲突、重启恢复和 RAG 队列；Web/Node 侧仍需完成 Agent 范围查询与提醒/后台消费链路验收。
- [ ] **Mind 与 Undo**：桌面便签列表、创建、更新、软删除及 Undo 已通过具名 IPC、真实 SQLite Worker 和重启回归；便签 Redo 尚未做同层持久化验证。桌面画布现已接通元数据 CRUD、画布便签列表/创建/正文编辑/从画布移除，以及画布条目位置更新；写入走受限 IPC、稳定操作收据、正式 SQLite 与共享 Mind Undo/Redo，Worker 回归覆盖版本冲突及重启后撤销/重做，工作台回归覆盖打开画布、创建/编辑正文和四向移动。当前 UI 仍是工作台列表与 Markdown 编辑表单，没有完整空间画布、拖放/缩放、引用放置或关系编辑；便签移除保留时间流内容。未集成原型不计为完成。
- [ ] **工作区**：已有声明管理及部分会话绑定用例进入 Core；补齐正式 SQLite 适配、Agent 工作区绑定、Local 权限和物理目录清理。
- [ ] **Local 文件**：明确授权根与相对路径身份，完成旧 ID 引用迁移、正式 SQLite 数据模型、文件授权、恢复和安全删除；回收站消费者须待删除安全边界与生命周期验收后接入。
- [ ] **Agent 会话与运行**：在已有列表、改名、消息定位、上下文刷新及待发送队列的基础上，完成消息历史、RunStore、运行身份与租约、孤儿恢复、队列事务和桌面 IPC 接线。
- [ ] **搜索**：在已有 Web PG 搜索和 SQLite 项目、联系人、活动来源基础上，补齐其他 SQLite 来源、兼容搜索语义及 Agent 工具调用。
- [ ] **定时任务与后台消费者**：在已有双库仓储和删除用例基础上，接通 runner、poller、执行和投递，完成租约、持久 fencing、重启恢复及关闭排空；RAG 等消费者分别验收。
- [ ] **工具与调用方**：让已有跨端工具复用 Core 用例及平台端口，接通实际注册和装配，并核对授权、确认、错误与提交后副作用。
- [ ] **公共化收尾**：逐项核对 PostgreSQL / 正式 SQLite、Web Host 及适用的桌面调用方，保留 Python 对照和必要回归；记录仍属于单端的能力及未覆盖边界，再继续新增 N2 功能迁移。

**桌面首批定向验收记录**：devserver Core 构建通过；`apps/desktop/tests/core-host.test.ts` 与 `preload.test.ts` 合计 30/30，覆盖项目/联系人、日历 Undo/Redo、便签/画布操作、外观偏好持久化和引导状态读取的真实 Core Worker/正式 SQLite 路径；`apps/web/tests/desktop/DesktopWorkbench.test.ts` 13/13，桌面与 Web 类型检查通过。Core 单测入口因当前工作区 `tests/suites.json` 与实际测试发现清单不一致而未能启动；该文件处于并行未提交修改中，本轮保持未改，也未跑全量测试。外观偏好和引导状态只读已由工作台调用；引导进度写入/重开与完整引导 UI 尚未接通。Windows/macOS 实际 Electron 窗口与打包制品验收、完整空间画布 UI、引用/关系编辑、文件授权根与旧库升级流程仍待处理。

**状态：进行中。** Node WebUI Host 和主要用户、项目、文件、日历、工作区、偏好、通知及部分 Admin/Agent 路由已接入。逐路由覆盖见[Node WebUI API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md)；历史测试与切片细节见[devlog 索引](../devlog/README.md)。旧版全量数量快照已过期，不作为当前完成率。

**Agent 本轮边界**：Agent 和 Mind 的 PostgreSQL 借用事务入口已共用连接互斥与事务控制检查，隔离 PG 合同 1/1、Agent Host 桥 2/2；调度监督器首次订阅失败时继续扫描并重试，定向回归 1/1。模型绑定在异步选择前固定运行身份并幂等释放，BYOK 定向 Node 5/5、Python 5/5。上述是组件回归；生产 Host 尚未装配聊天、可信模型配置及访问版本，附件媒体与孤儿恢复竞态仍未解决，不代表 Agent 执行链已接通。

管理员 Agent 用量查询已接入生产 Host 的 Admin 鉴权和 PostgreSQL；隔离 PG/Host 测试 5/5、Python 用量对照 5/5、Host 类型检查通过，真实部署尚未验收。

Agent 历史图片的 owner/session 限定两阶段读取已由 Core PostgreSQL 端口提供，并接入 Web 历史读取器；第二次读取在数据库内复核 8 MiB 总预算，旧数据中非对象项按 Python 行为保留。隔离 PG Core 合同与 Host 读取器→Harness 回放各 1/1、Harness 历史回归 58/58、Python 历史对照 12/12。实际聊天重建器尚未由生产入口装配，其他数据库方言和真实部署未验收。

Knowledge overview 已有要求迁移标记存在的 Core 只读子集，合成存储回归 2/2；真实存储、Host 和旧文档自动迁移尚未接入。Python 知识对照全量为 43 通过、1 失败：失败项需要本环境尚未构建的 Cython RAG 内核；排除该项后 43 通过、1 未选，不表示 RAG 已迁移。

个人记忆已有明确限定为规范小规模数据的 Core 读取规则，合成存储 Node 4/4、Python 记忆存储对照 19/19；真实存储和 Host 未接入，legacy 写回、超预算 embedding 与 Python 容错尚未实现，不能作为完整记忆服务。

RAG Host Worker 在生产 `main.ts` 启动前检查正式索引迁移，仅 `applied` 时启动，并于关闭时停止/等待。Worker owner 由 `startServer(env)` 的同一注入环境解析，避免测试或嵌入式 Host 使用的配置与 `process.env` 不一致；只有 `python`（默认）或 `node` 可选。首次 Worker 调用幂等地为无索引、无任务的 owner/source 建全量基线，不覆盖现存增量任务。生产来源集合现包括 project、calendar、note、canvas、scheduled_task、conversation、knowledge 和 memory；devserver 临时 SQLite 经生产 Host Worker 实际验证前七类来源索引正文，并确认 memory 在完整来源集合中，Worker 回归 **9/9**。knowledge 使用 owner-bound FS reader，memory 使用 `config.storageLocalPath` 与 SQL scope revision/tombstone reader。Mind、conversation 和 scheduled_task 的已发现 Node 写入事务会排入持久任务；Node 尚无 knowledge 写服务及普通 memory 写入/反思服务。Python 仍持有这些领域写入时，其 knowledge 资源事件和 `MemoryUpdated` 会写入共享持久 job；将 Node 配置为唯一消费者后，Python 实时事件路径现在只持久化 job，不再启动进程内索引 Worker，防止双消费者写索引。切换前仍须在两个服务统一设置 `AGENT__RAG_INDEX_WORKER_OWNER=node` 并重启，且先验收正式索引迁移和 Node 全来源能力；当前无部署切换证据。Host 锁定 `@node-rs/jieba@2.0.1` 并使用包内词典。`search_conversations` 按 Python 行为从 owner 限定会话事实表生成 BM25 候选，不走持久索引或向量；`search_memory` 有 Host 工具边界、scope resolver、版本匹配向量读取和可控 embedding 端口，但生产 Agent Run 尚未注入这些服务。当前缺口包括生产 Agent Run/工具注册装配、未来 Node knowledge/memory 写路径的新鲜度生产者、正式 PostgreSQL migration 验收和消费者归属切换；故 RAG 尚未全量生产接通。

共享队列消费者互斥回归（2026-11-16）：新增 Python 事件总线合同，分别验证 `python` 配置会继续触发本地 Worker，`node` 配置会持久化 knowledge job、跳过 Python Worker 且不留进程内 pending 副本；配置读取失败时 Python 消费者 fail closed。devserver 对应 Python 文件 **12/12 通过**；Node 持久 RAG Worker/全来源集合/正式索引表 SQLite 回归 **8/8 通过**。两组分别验证生产者开关与 Node 消费逻辑，没有连接真实 PostgreSQL，因此不等于部署切换或跨语言 PG 实验。

2026-11-16 Web Run 工具接线：`createWebAgentToolPorts` 现让持久 Web 重建器从同一 Host registry 发现已授权、配置允许的工具 schema，并将同一 registry `ToolPort` 交给 Harness；owner/session/run 从 dispatch lease 固定，执行时继续重新授权。临时 SQLite 的 `search_conversations` 实际注册器调用及撤权回归 **2/2 通过**。生产 `main.ts` 仍无 `agentChat`/`createWebAgentReconstructor` caller，因此该组件接线未计作生产 Agent Run 完成。

2026-11-16 RAG 回归复验：devserver 串行运行 Python RAG、conversation/search limits 与 knowledge search pytest **300/300 通过**；Core RAG 与 Mind freshness **10 个文件、63/63 通过**；Host 会话检索、memory scope/BYOK、Jieba、索引损坏恢复与 Worker **19/19 通过**。Node 测试使用临时 SQLite/FS、真实 Jieba 和合成授权、凭据、embedding transport、RunStore/Provider；没有调用真实外部 Provider。隔离 PostgreSQL 环境未配置，因此正式 PG 索引迁移与查询未验收；本结果只证明代码/行为回归，不证明 `main.ts` 已有 Agent Run 工具调用者或 Node Worker 已成为部署消费者。

2026-11-16 搜索调用链回归：Python `search_conversations` 的 20 条候选上限用例先通过 `enqueueAgentRagRebuild` 入队，经 Core 持久 Worker 重建会话投影并检查 generation 完成，再经真实 Host 注册器 dispatch 查询事实表来源；工具检索本身按 Python 语义使用 owner 限定 SQL BM25，不以持久索引作为召回。随后将来源消息改为 Python 不索引的 `tool` role，重建 generation 2 后旧持久投影消失，保护来源更新/删除后的索引收敛。Host SQLite 调用链集合 4/4 通过，测试数据库为每例新建临时文件。该验证覆盖 Node 队列消费与工具调用行为，仍不等于生产 Agent Run 已装配。

2026-11-15 更新：新增 `createMemorySearch` 组合 Core memory loader、scope/source/snapshot 过滤、版本匹配持久向量读取和统一 TS 排序，并把 `search_memory` 接入可配置 Core/Host 工具组。新增 Web owner-only Host 适配器，复用受限 memory FS 与 SQL scope-state reader；适配器支持由可信 Host 注入 BYOK resolver/受控 transport，省略时显式使用词法召回。Core memory dispatch/vector 4/4、Host Registry 16/16、Host 临时 SQLite/文件系统真实调用链 1/1、Host Agent/RAG 定向测试 26/26、Core typecheck/build、Host typecheck 通过。授权、快照、Jieba、embedding 与向量为合成回归依赖；Python pytest 缺失。IM scope resolver、生产 Agent Run 对会话与 memory 搜索资源的装配仍缺，故 `search_memory` 为已实现待接入，不代表生产检索完成；`search_conversations` 已有真实注册器/持久 RAG 临时库行为回归，仍缺生产 Run caller。

后续从 `v1.7.7` 的 `backend/ts/workers/rag/src/memory-loader.ts` 迁入 Core 查询期 memory 准备逻辑，保留 owner/group/member scope 检验、tombstone、snapshot 去重和模型版本向量加载；Core 4/4、owner-bound Host FS reader 1/1，Core 构建及新增 Host 文件定向严格类型检查通过。该 loader 不等于持久 memory 重建来源：真实 scope 枚举/授权、PG scope 状态端口和生产 Run caller 仍未装配，Python pytest 因环境没有 pytest 未运行。

Web 聊天准备现将可信来源写入加密调度载荷，worker 与重建器检查来源；旧载荷在确认无活跃 Harness 租约后进入现有版本冲突状态并保留数据，不根据会话历史来源推断。隔离 PG/Redis 调度及重建回归 5/5、Python 取消对照 11/11；这些测试仍使用合成 Provider/部分上下文，生产聊天入口尚未装配。账号状态仍按 Python 的请求认证语义处理，未新增运行中按版本中断。

Web 重建器在可信 Web 来源下按 Python 规则不加载 IM 记忆，即使会话原本来自 IM；相关隔离 PG/Redis 重建与绑定回归 2/2。用户记忆和知识存储仍需真实服务，不能把该 Web 分支当作完整上下文接入。

Harness 已支持可信工具适配器分别提供模型结果和原始展示结果，并在检查点中验证和恢复，旧检查点继续可读；定向回归 113/113。项目字段错误和实际幂等冲突的模型投影已通过合成 Provider 的 Host Runtime→隔离 PG 续轮 1/1；通用检查点恢复有独立回归，项目冲突专用重启验收以及生产工具注册与 Run 仍未接通。

本轮冻结源码的 Harness 与全部 Core Provider 定向回归共 10 文件、572/572 通过、无跳过；这是源码级回归，不代表生产 Host 或真实 Provider 已验收。

**跨端公共化进度**：日历创建、更新、删除用例已迁入 Core，Web Host 保留 PostgreSQL 适配；隔离 PG/生产 Host 回归 50/50、Python 对照 6/6，日历管理 list/get 也已委托 Core，正式临时 SQLite 8/8、隔离 PG/Host 3/3、Python 读取对照 5/5，Agent 范围查询仍待迁移。日历创建、更新和删除双库事务已接入 Core 和生产 Host；隔离 SQLite/PG 合同通过，生产 Host/Vite 验证幂等、提醒重排、越权、冲突、Undo/redo 和与现有 Host RAG 生产者混合并发；撤销执行器和 RAG 消费仍需独立验收。便签创建、更新、删除用例及 Undo 写入事务已接入 Core；各自 SQLite/PG 合同通过，生产 Host/Vite 在合成隔离 PG schema 验证创建、更新、删除、读取、越权、冲突及 Undo/redo，Python Mind 对照 39/39；画布创建、更新和删除已接入 Core 双库事务及生产 Host；隔离 PG 验证项目归属、跨 owner 拒绝、关联项和关系的 Undo/redo 与便签正文保留；画布其他操作和撤销执行器尚未完整公共化。Core SQLite schema 13 增加 SMTP 设置表并保留此前交互动作、通知和业务数据；工作区和文件授权字段尚受限，后台消费者及凭据交互尚未由建表接通；版本升级回归 40/40、桌面 Host 回归 15/15、Python 互读 2/2。SMTP 设置读写已接通 Core 双库和生产 Host，正式 SQLite/隔离 PG 合同 2/2、Host/Vite/隔离 PG 1/1、Python 对照 3/3；真实邮件与部署未验收。项目创建用例和事务适配器已接入 Core，SQLite/PG 合同回归 2/2，生产 Host/Vite 在合成隔离 PG schema 验证创建和幂等重放 1/1；项目更新用例也已迁入 Core，Host 的隔离 PG、临时 FS 和生产组合根回归 21/21；工作区声明创建/更新及列表已委托 Core，Host 隔离 PG 与相关 Python pytest 各 5/5；列表另有隔离 SQLite 原型 12/12、PG 1/1、Host 4/4、Python 19/19，详见 `docs/testing/node-agent-workspace-port.md`。工作区会话绑定、解绑和当前查询也已委托 Core，临时 SQLite 12/12、隔离 PG/Host 3/3、Python 19/19；声明删除已委托 Core，临时 SQLite 14/14、隔离 PG 4/4、Python 2/2，正式 SQLite 和物理目录清理未接通；通知中心已接入 Core 双库及生产 Host，隔离合同 2/2、Host/Vite/PG 1/1、Python 4/4。项目更新的正式 SQLite 数据路径已补充回归，见下方 Projects/Clients 收尾记录；旧文件目录/计数联动、工作区正式 SQLite 适配、Local ACL、完整生产 schema 和真实部署仍未验收。

Agent 会话改名、消息定位、会话列表、上下文刷新和待发送队列的现有 Web 用例已委托 Core；HTTP、认证与 Redis 状态仍由 Host 提供。隔离 PostgreSQL 和 SQLite 契约、相关 Web Host 与 Python 对照已通过。SQLite schema 6 增加会话、消息、批次和队列表，以及显式备份升级和 owner/会话约束；Core 定向回归 31/31、桌面 CoreHost 15/15、Python 互读 2/2。工作区绑定目前只允许为空，文件授权与桌面 Agent IPC 未接入，真实生产打包制品未验收。Core 队列公开读取已移除认领令牌和到期字段；队列与聊天发送尚未共享完整事务，Redis 活跃状态也不是数据库事务事实。消息媒体脱敏、群聊提及规则、群会话最近发言昵称查询及 Run 密文编解码已由 Core 共用；昵称查询正式 SQLite/隔离 PG 各 1/1、Host 11/11、Python 定向 6/6，当前 Bot 默认名及用户 Bot 配置名仍由 Host 补全；交互历史投影和活动令牌轮换已委托 Core 双库事务及 Node Host，隔离 PG/Host 9/9、Python 定向 4/4；实际消费、桌面调用与完整消息历史尚未接通。历史分页、孤儿恢复和完整 RunStore 尚未完成公共化。活动恢复叠加时间窗口可能对无关过期记录产生锁竞争，SQLite 为单写者，PG action 锁等待依赖数据库超时；既有 Python 与 Node 消费者间锁序差异仍需解决。现有孤儿恢复只检查旧 Redis 状态；真实 Node 恢复函数在隔离 PG/Redis 中与合成的新运行启动交错时，已复现清空新运行和删除其状态键。该实验未运行真实 Python 协程或完整 HTTP，也不是生产事故证据；接入 Node 租约前必须协调两端运行身份与回收协议并完成真实两端交错验证。

**共享 Core 冻结快照验证**：最新标准 unit 80 个文件 1491/1491；此前冻结快照的隔离 PostgreSQL 22 个文件 40/40，均无跳过或失败；Python 旧库互读 2/2。后续搜索归一化另经双库对照 3/3、Host 搜索 13/13 和 Python 30/30；上述结果不等于真实部署或所有调用方验收。

**通知与日历读取目录收敛**：通知 HTTP 路由迁至 `modules/notifications`，生产继续使用 Core 双库实现；旧 Host PostgreSQL 适配器及其旧目录已删除，原持久化测试改用 Core 适配器。隔离 SQLite/PG 合同 2/2、生产 Host/Vite/隔离 PG 1/1、Host 路由 4/4、Python 对照 4/4。日历列表与详情由生产 Host 直接装配 Core 读取用例及双库端口，旧 Host 重复查询已删除，写事务仍需的查询辅助保留；正式 SQLite 8/8、隔离 PG/Host 3/3、Python 管理读取 3/3，隔离 PG 综合持久化 1/1。两项均未验收真实部署；Agent 日历提醒聚合仍未接通。

**联系人 Host 目录收敛**：Web 联系人路由和身份/事务桥已迁至 `modules/clients`，真实读写复用 Core `ClientService`/双库仓储；桌面通过公开 Core 命令维护联系人。历史 PG/Vite 结果不替代当前验收，本轮正式 SQLite 共用合同、桌面具名 IPC 与 Python 结果见下方收尾记录；PG 本轮未运行，真实部署未验收。

**项目 Core 目录收敛**：创建、更新、读取和投影及相应数据端口已归入 `packages/core/src/projects/`，公开包子路径不变；旧 Core 内部路径及 Host 创建/更新转发已删除，实际调用方和测试使用新入口。Core 定向 73/73、隔离 PG 1/1、Host 项目与生产 Vite/隔离 PG 29/29、Python 工具及读取 28/28；真实部署未验收。跨领域共享事务和仓储仍保留在共享基础设施，项目文件操作与恢复不因目录迁移而算作跨端完成。

项目创建字段验证现在保留独立错误来源，同时保持 `invalid_request` 与 Web 422 映射；身份、幂等、取消及事务错误不归为字段错误。Core 定向 3/3、生产 Host/Vite/隔离 PG 的 422、409 和幂等回归 9/9。可信 Agent 调用使用同一事务先查 owner、幂等键和原始 fingerprint，未命中后才执行字段归一化；同键变更为非法字段时仍返回冲突，SQLite 合同 3/3、隔离 PG 1/1、工具真实 PG 与模型 wire 1/1。Web 保留现有预校验顺序；跨版本接管 Python 在途调用尚未支持，不能猜测旧收据身份。

**Undo 公共化**：Web Host 已整体委托 Core 统一 claim/状态机和 Mind 资源适配器，日历资源在同一事务调用现有 Host 适配器；旧 Host 状态机和 Mind SQL 已删除。项目适配器与 journal 已隔离测试，但生产 main 未注入项目存储，不能视为项目撤销已接通。生产 Host/Vite/隔离 PG 与跨资源回归 12/12，Core 正式 SQLite 3/3、隔离 PG 2/2，Python Mind 3/3；提交未知由模拟验证，真实网络中断、文件竞争与 SSE 实际投递未验收。SQLite Worker/NDJSON v2 和桌面具名 IPC 已接入 Mind Undo，状态与操作收据同事务、重放不重复事件，侧车以 `undo_mind_v1` 协商能力；Desktop 回归 21/21、Core IPC/stdio 11/11。真实 Electron 界面、Mind 正向编辑及其他资源本地适配仍未接通，不能视为完整跨端撤销。

**全局搜索边界**：现有 Web 路由已委托 Core，PG 的 11 类来源及 Host 隔离回归 14/14；SQLite 仅项目、联系人、活动三类可用。Core 现强制提供已支持与缺失来源列表；非空默认全来源查询缺项时在查询前明确报错，显式支持子集及空关键词保持可用。SQLite 定向 12/12、隔离 PG 对照 3/3、Python 19/19；桌面和 Agent 工具尚未接通，原生 SQL 非 ASCII 匹配、拼音/罗马音仍未完全对齐，真实部署未验收。

**安全事件过期清理**：Node Host 健康启动后启动清理器，默认一小时后首轮并每小时执行；关闭先等待在途清理再关闭连接池。隔离 PG/生产 Host 生命周期 3/3、Python 对照 1/1；真实部署未验收。

**回收站后台边界**：Node 清空回收站接口目前只写入持久任务，生产消费者仍是 Python worker，单独运行 Node 会停留在排队。现有永久删除路径存在目录组件替换窗口，不能安全装配 destructive 消费者；隔离 PG 租约/进度仓储回归 1/1、Python 对照 3 passed/6 deselected；逐项恢复、生产生命周期和真实文件删除尚未验收，独立进度事务不保证文件删除原子性。

**Local 跨端身份边界**：Web 兼容期文件和目录操作依赖 PostgreSQL 旧对象 ID；正式 SQLite 当前没有文件及目录模型，项目文件计数和文件引用因此不能按已接通计算。桌面目标以授权根与相对路径为身份，旧 ID 的引用迁移、恢复和授权边界仍待设计及验收；不得通过测试专用简化表冒充完整支持。

**定时任务边界**：一次性任务 Core SQLite/PG 仓储已通过隔离合同测试，但 runner、poller 和真实执行/渠道投递尚未接入 Host 生命周期；启动恢复、Redis 租约、关闭排空及 SQLite 跨进程租约均未验收。重复触发收据表不代表消费者已经运行。现有 Python 执行者在 Redis 租约续期失败后仍可继续执行，维护者重新获得锁并不能证明旧执行已停止；Node 列表读取的自动删除和判死已暂时停用，到期或疑似崩溃任务会保留供用户查看。隔离 PG/临时真实 Redis 的失租执行及持锁未提交启动等回归与相关 Node 测试 7/7、Python 基线 4/4。Python 自身列表清理和 worker reconcile 仍存在同类竞态，状态维护循环未接入 Node；需先统一执行、恢复与清理的持久 fencing/事务协议或完成明确的单执行者切换。

用户显式删除定时任务已接入 Core 双库仓储和生产 Host；正式 SQLite/隔离 PG 合同 1/1、Host/Vite/隔离 PG 与 Host 单测 2/2、Python 直接对照 1/1 和邻近规则 30/30。删除只移除记录，不保证停止已在途执行或副作用；真实部署与事件广播未验收。

Host 定时任务目录已由 `domains` 迁至 `modules/scheduled-tasks`，真实调用方和测试已更新，旧 Host 删除工厂及重复 SQL 已移除。隔离 PG/临时 Redis 的定向和生产 Host 集成 42/42，Host 类型检查通过；目录调整不改变上述消费者与执行安全边界。

定时任务 Web 列表已直接使用 Core 双库只读 reader，Agent 和 Web 分别投影、不恢复读时清理；正式 SQLite/隔离 PG 合同 2/2，生产 Host/Vite 与真实 PG/Redis 失租、启动中保护 3/3，Python 规则/工作区对照 40/40。SQLite 的工作区和文件授权引用仍受 schema 限制；真实授权、生产 Agent Run 和调度消费者未验收。

2026-11-16 N2 聊天附件生命周期：`POST /api/v1/agent/upload` 已按 Python 流式暂存接入 Core 规则、认证 Host、PG 容量事务和 Local 存储；`DELETE /api/v1/agent/attachment/{attach_id}` 接入草稿状态守卫、owner 行锁、共享 storage_key 锁和引用清理；`DELETE /api/v1/agent/attachments` 接入批量草稿事务、去重引用清理和可选 Redis 旧记录扫描。Core 暂存/删除/批清 9/9、Host 生命周期与隔离 RESP 适配 13/13、Core/Web Host build 通过。devserver 缺 pytest，Python 实跑未完成；Pool 是合成替身，隔离 RESP server 不等同真实 Redis，真实 PG/Redis 未验收，正式 SQLite 附件 schema 未接；Node 未接入 `pilk`，动态 Provider 音频原生格式与真实部署未验收。详见 Node WebUI API 清单。

**主要缺口**：Agent 聊天生成与 SSE/取消、Mind 画布剩余跨端引用及撤销执行器、Worker/调度调用方、剩余 Admin/集成 API、真实服务集成和全量调用方切换。Node 已写入队列的 RAG job 仍由 Python Worker 消费。Linux/NAS 2.0 只支持 Local 文件存储；旧 OSS 数据迁移需在切换前另行验收。

**退出条件**：Web 必需 HTTP/SSE 与后台调用方在 Node 上行为等价；关键 PostgreSQL、Redis、文件系统路径完成隔离验收；默认 Web 流量切至 Node 后，再清理 Python Web 后端。Python API 不作为隐式回退。

- [ ] 盘点并迁移 Web 必需 API、Agent 工具、Worker/调度、撤销及其他写入口。
- [ ] 保持 HTTP/SSE、认证身份、错误/字段映射、事务和提交后副作用兼容。
- [ ] 完成真实 PG/Redis/文件系统的隔离、并发和故障路径验收。
- [ ] 所有调用方切换并验收后，移除对应 Python Web 写实现。

### N3——扩展数据域与 Agent 迁移

**RAG 目标**：复用 Gugu 1.7.7 TypeScript RAG 作为 Node/Core 唯一生产检索路径，不迁移 Cython 算法到 TS，也不保留双引擎线上选择。迁移时以当前 Python/Cython 行为回归和固定质量语料为基准，接入 Node/Core 授权来源读取、派生索引存储/重建及 ACL 过滤；具体验收见依赖迁移矩阵。RAG 来源文件正文按架构说明从授权 FS 直读，DB 不保存文件正文副本。

**当前 RAG 接入证据**：Core schema 17 已定义 SQLite/PostgreSQL `knowledge_index_entries` DDL，SQLite v1-v16 通过显式备份迁移升级新增该派生表。Web Host 有显式 `migrate:rag-index:check/apply` 命令，启动入口只在迁移返回 `applied` 后运行 Node 来源重建 Worker；knowledge 使用 `@gugu/fs/node` owner-bound reader。Python 与 Node 共用持久队列，并由 `AGENT__RAG_INDEX_WORKER_OWNER` 选择唯一消费者（默认 `python`）；配置为 `node` 时，Python 事件路径只持久化 job，不启动内存 Worker 或恢复消费者。两端已分别有配置分支和 Node Worker 回归，但没有跨进程 PostgreSQL 竞争或部署切换证据，因此 Node/TS 尚非已验收的唯一生产执行者。隔离 PostgreSQL 行为和部署迁移尚未验收，不能称生产数据库已升级。正式 Jieba `@node-rs/jieba@2.0.1` 已加入 Host 并装配包内词典；Host 会话工具测试以真实 Jieba 经注册器执行。`v1.7.7` 查询期 memory loader、scope revision/tombstone reader 和持久重建来源已迁入 Core；Web Host 在迁移通过后已将 owner-bound FS root 注入重建 Worker，memory 文件可以参与基线/重建。Memory 清理路由已在同一事务递增重建任务并墓碑化旧投影；普通 memory 文件更新与 knowledge 写入 producer 仍缺。新增的 `createPostgresAgentImMemoryContextReader` 按 owner/session/active-run 绑定当前入站消息和 owner 的 Bot 绑定，缺少 IM 身份时 fail closed；`createPostgresAgentMemorySearchPort` 将可信上下文、cursor scope 与 Core memory RAG 组合，Host dispatch 回归 5/5 且 Host 模块严格类型检查通过。查询使用模拟 Pool，尚无隔离 PG 验收，也未接入生产 Run registry。file 自动索引按 2.0 决策退役。生产向量/embedding 注入、生产 Agent Run 调用方仍未完成。切换完成前不得将 Node 队列写入或 Worker 启动记录为 TS-only 生产完成；消费者切换和旧 Python Worker 停用需单独验收。

- [ ] 会话/消息/附件引用、Canonical 历史与顺序规则。
- [ ] 待发消息队列按架构说明收敛为 Core 共用规则与存储/通知契约；Web 接入 PostgreSQL 和所需跨进程事件，桌面接入 SQLite、本地 Run 生命周期和 IPC 通知，不依赖 Redis。以现有 Python 队列与 pytest 为行为基线，分别验收消息顺序、认领冲突、停止后排队消息、通知丢失重读、重启恢复和发送结果未知时防重复；当前 Web PostgreSQL 部分实现不等于桌面或共享队列已完成。Steer 和跨设备同步另行设计。
- [ ] Run/Job、确认授权、租约、持久调度、outbox 和重启恢复。
- [x] 按 Python 原职责将原 Harness 实现归入 `agent/runner.ts`、`core.ts`、`context/`、`run/`、`interactions/` 和 `memory/`，保留独立 `providers/`、`tools/`；调用共用 Executor，删除旧目录与旧包导出，调用方及测试同步归位。该结构调整不代表工具迁移或平台后端验收完成。
- [ ] Linux/NAS MXC 执行后端通过多用户隔离验收后，将 Admin Shell 页面收敛为执行环境状态与安全策略管理；移除 Docker/Rootless/镜像和容器生命周期操作，保留全局启停、用户/Agent 授权、危险操作策略、资源配额、网络策略及执行审计。SaaS 不开放该管理入口。
- [ ] 按架构说明退出旧 Docker sandbox 专用 egress 网络和代理的部署依赖；盘点 `safe_egress` 配置、Admin API 和实际消费者后再清理或单独重设计普通代理配置，保留旧用户配置与数据。Host 普通请求走系统网络或可选代理，用户可控 URL 保留 DNS、连接目标与重定向安全校验。
- [ ] MXC 沙箱默认禁止出网；按具体平台与后端的实际能力和可信授权开放，无法落实策略时拒绝执行。Linux 多用户环境须实测公网、内网、loopback、DNS/重定向及跨用户服务边界；桌面平台分别验证。测试通过前不宣称隔离已生效，也不回退为无约束宿主出网。
- [ ] Provider/流式事件、工具、取消与背压；代码权限、confirm、URL 安全和脱敏边界。
- [ ] 原生 wire/thinking/signature、上下文压缩、反思及缓存/用量契约。
- [ ] 便签/画布/日历、长期记忆/RAG、媒体/Office 按依赖矩阵逐域迁移和验收。
- [ ] SaaS 数据同步、设备绑定/路由及受限任务转交。
- [ ] SaaS 旧 FS 的内容迁移、完整性与恢复验收，通过后退出兼容 FS。
- [ ] 旧 FS 兼容迁移验收后，退役以 DB `File` 行和物理对象清单互相比对为前提的 Admin 对账能力：幽灵/孤儿对象修复、对象导入及路径镜像迁移。改由存储健康、派生索引重建状态和必要的配额账本核对承担运维诊断；配额核对与文件对象对账分别设计。
- [ ] 移除“用户目录缺失即列入账号删除修复”的存储对账路径；账号生命周期必须由独立、明确的账号管理规则决定，不能由 FS 扫描结果推断。
- [ ] Mobile 可移植 Core 与独立 Host 的平台可行性验证。

#### N3 Agent Harness 专项（2026-11-13，Core 切片已实现并完成本轮回归）

本切片仅负责可移植 Harness，实现在 `packages/core/src/agent/`；不迁移具体 Provider 协议、工具业务、Web API 或桌面 Host。行为与逐项缺口见 [Harness 回归映射](../testing/node-agent-harness-parity.md) 和 [逐 Python 定义清单](../testing/node-agent-harness-parity.json)。

- 已实现源码切片：Canonical Area/批次与历史恢复、稳定附件引用 checkpoint、上下文并发准备、实际用量预算与压缩/分支、会话快照候选、反思原主请求快照；Run 启动/恢复/取消、交互与回执、顺序事件与背压、fenced CAS/outbox 端口、回复守卫与展示时间线。共用 Executor 协调器抽到可移植入口，原平台入口保留兼容导出，不加载第二条执行路径。
- 工具历史按实际派发和回执建立同批调用/结果；未启动的取消不写孤立调用。凭据由独立交互服务消费，Harness 只保存安全状态和回执。纯回复和守卫说明不重复作为工具 Canonical delta 提交；成功 final 的历史事务先于通知，Provider 错误不提交本轮 Canonical，取消只保存允许的中断增量。
- 压缩候选随 Run checkpoint 恢复，但只有成功收尾事务才推进会话摘要水位；失败/中断不提前应用摘要。原生 wire/私有推理、运行时前缀和媒体载荷不作为 durable context 写入；原主请求快照仅进程内保留，并绑定实际请求的模型、前缀、工具 schema 和 Canonical 身份。
- 标准 `createCanonicalHarness` 准备链已连接 owned 来源、并发工具发现/一次 RAG、可信能力过滤与目录分区、Canonical 组装；冻结选中名称/schema，并拒绝未开放工具。自定义完整 loader 缺少能力快照时明确失败，Host 不再需要复制此编排。
- 最近完整原生 Node 26 Core 快速层：30 文件、506 项通过、0 失败、0 跳过，包含全部 23 个 Harness 文件；测试源码类型检查通过。Python 基准随后在用户授权安装的普通 Ubuntu WSL 原生环境完成：76 文件、918 项通过、0 失败、0 跳过，4 条既有弃用警告。此前 Windows 的 `fcntl` 收集失败保留为环境历史，不计通过或跳过。
- 独立依赖仍需后续责任方接入：Provider 的归一流/原生投影与续接，Tools 注册表/权限/确认和业务收据，Data 的双库 owner 查询、租约续租/fencing/CAS、原子 history/receipt/outbox，Media/RAG 授权引用，以及反思/标题等独立 Job 和 Host 事件适配。测试中的明确 fake 仅验证编排契约，尚未接管生产 Agent。
- [x] 完成 76 文件、737 个 Python 定义的职责/TS 映射。复查修复 Skill 冻结、定时任务准备、工具目录过滤、空答重试及超限分类，修正历史依赖方向，补28项行为回归；Python本轮未改，沿用此前918项基准。
- [ ] 逐项完整等价仍未完成：149项已验收、232项部分覆盖、356项端口依赖；撤回此前“无必要回归缺口”的过强结论。接口和fake不算真实Provider/Tools/Data/Job/Host迁移。
- [ ] 独立适配器有真实验收证据后再讨论生产调用方切换。用户随后授权统一提交、推送和评审 PR；未授权 CI 或生产切换。

#### N3 Provider 专项（2026-11-13，Core 协议与 Harness 接线已实现，生产切换未验收）

- [x] 盘点 `backend/agent/providers/` 的 34 个生产模块、调用点及相关 pytest 定义，按协议规则、Harness 和 Host/Data/Tools/Media 职责分别登记落点与剩余工作。见 [逐项映射](../testing/node-agent-provider-parity.json) 和 [行为说明](../testing/node-agent-provider-parity.md)。
- [x] 实现 Chat Completions、Responses、Anthropic、原生 Ollama 的实际请求/流/非流解析，以及 DeepSeek、GLM/Coding、Qwen、MiniMax、MiMo、Local/Ollama 策略；不是空接口或 Python 回退。搜索、媒体上传和 ASR 协议通过受控传输执行，文件授权、探测/转码仍交独立 Media adapter。
- [x] 通过 `connectProviderHarness` 接入 Canonical 准备、工具轮、交互恢复和实际 wire 快照。保持 Harness 原有 18 文件树，协议/native thinking 留在 Provider；工具派发仍走共用 Tools/Executor。
- [x] 复查修复无输出超限恢复边界、非法工具参数检查点丢标记、首轮图片消费、私有输出后错误重放、取消原因泄漏、观测端口异常、连接配额泄漏，以及最终请求缓存指纹/能力门控。相应运行时回归保护失败、取消和恢复路径。
- [x] Python Provider 与相邻基准在用户授权的本地原生 Linux 隔离环境串行运行：43 文件、517 通过、0 失败/错误/跳过；不修改 Python、用户配置或调用生产服务。初轮缺 ffprobe 的一个跳过已补依赖并实际重跑通过；未在 devserver 复验。
- [x] 二次复查补齐生产反思追加/摘要 wire 转换适配、归一超窗恢复、截断摘要拒收、原始缓存断点继承、多行工具回执和清洗诊断；保持固定 18 文件树。环境代理/CA 与实际网络快照池键、兼容及 DashScope ASR 已实现，均有真实 Core 调用回归。
- [x] 最终 Core 快速层 943 项、Provider 专项 457 项、严格类型检查与构建通过；另选原 Python ASR 9 条通过，Python 本专题合计 526 通过、无跳过。414 去重定义保守登记为 227 已通过、35 部分覆盖、152 边界延后，47 生产消费者逐条记录配置来源和实际 Host 缺口。
- [ ] 真实生产接线仍未完成：可信 BYOK 凭据与目的地绑定、数据库摘要/水位事务、加密 reasoning 持久化、Redis 跨进程租约、Tools/RAG/Media 及 Web/IM/Worker 入口。不得把注入正确配置、内存 fake 或协议回归当成这些责任完成。
- [ ] 全量逐断言等价仍不成立。保留明确的部分覆盖和 Host/SDK DTO 差异；Node 已收到私有/工具片段后的缺块不重放属于安全收紧，不能记为与旧 SDK 所有参数等价。

本次按用户后续授权统一提交并更新评审 PR，不切换生产入口、不触发 CI、不合并。最新 Node 数量以 Provider 映射的本轮验证记录为准。

### N4——桌面产品化与发行准备

**桌面首批实际入口（2026-11-15）**：当前桌面验证工作台已调用项目和联系人列表、创建及名称编辑，日历列表/创建/编辑/删除，便签增删改和画布基本便签/位置操作，并使用正式 SQLite、操作收据及适用的 Undo/Redo。外观偏好现由工作台加载与更新；Core 窄服务复用 `user_preferences` 正式 SQLite 仓储和 schema 17 owner 约束，只开放主题模式、Aero/Mono 样式、Ink/Cafe/Terra/Harbor/Grove 配色，不触发回复风格文本迁移。引导状态现可通过具名 IPC 由工作台读取并显示，但不提供进度写入、重开或完整引导界面；现有普通状态更新不接受 `enabled`，重开操作也不启用默认关闭的引导，需先明确桌面引导语义。devserver 本轮 CoreHost/Preload 定向 30/30、工作台组件 13/13，桌面与 Web 类型检查通过。真实 Electron 窗口与跨平台制品、完整空间画布 UI、引用/关系编辑、桌面 FS 授权根与旧库升级仍待验收；现有 `packages/fs` 只有受根目录限制的普通文件读取及文件暂存/恢复原语，Web Host 将其用于文件读取/回收清理，Core 工具依赖 Host 注入，桌面尚无调用方。它没有覆盖授权根授予/撤销、目录枚举、直接写入与原子替换，也不能替代 Web 文件库的 ID/元数据服务；不得用 Web 文件 ID 替代桌面路径身份。

联系人名称编辑与删除现由工作台经具名 Preload/IPC 调用 Core `clients.update`、`clients.delete`，使用正式 SQLite 和操作收据；删除按 owner 限定，确认前不写入，删除后刷新列表。devserver CoreHost/Preload 定向 26/26，真实 Worker/SQLite 删除及重启后不可见回归通过，工作台组件 9/9，桌面和 Web 类型检查通过。联系人名称以外字段、真实 Electron 窗口及跨平台制品尚未验收。

桌面日历已由工作台调用具名 Preload/IPC，接入 Core 列表与创建命令、正式 SQLite 读写和持久操作回执；创建同事务写入活动、RAG 索引任务及 Undo。devserver Core 构建通过，Core SQLite 合同 2/2、桌面 CoreHost 经真实 Worker 创建/列表/重启恢复 1/1、CoreHost/preload 23/23、工作台组件 6/6；隔离 PostgreSQL 用例未配置而跳过。桌面创建目前仅暴露标题和日期，编辑/删除、日历视图及真实 Electron 窗口未验收；版本升级由既有正式 schema 初始化/升级负责，仍需验证旧库迁移。项目/联系人与日历真实 SQLite 接入不代表笔记、画布、偏好和引导已由该界面接通。

桌面便签现已接通 Markdown 创建、列表、版本更新和软删除：Core 复用正式 SQLite 适配，写入借用外层事务并与 Undo、操作回执原子提交；桌面 IPC 受能力协商与字段白名单约束。devserver Core 构建通过，真实 Worker/SQLite 创建、更新版本冲突、软删除、重启恢复及 Undo 恢复回归通过，工作台组件 9/9（含删除确认、取消不写入、确认后刷新和撤销恢复）。桌面/Web 类型检查通过。未验收旧库升级、真实 Electron 窗口及完整渲染交互；便签尚无画布操作入口。

桌面外观设置已由工作台复用 `useTheme`，通过窄字段 Preload/IPC 写入 Core 正式 SQLite 偏好文档；读写只处理主题、样式和配色，保留其他历史偏好键，更新与操作收据同事务提交。CoreHost 定向测试覆盖字段拒绝、旧字段保留及重启恢复；工作台测试覆盖 IPC 更新与重启后界面恢复。引导状态已由正式 SQLite 仓储经只读 IPC 接入并展示；状态写入、启用/重开语义与完整引导 UI 仍未接通。

- [ ] 按架构说明设计并接入用户可控的桌面埋点采集和批量上传：可用 SQLite 实现受容量和保留时间限制的离线队列，上传故障不阻塞主流程；验证授权、关闭后停止上传、敏感字段排除和自部署目标配置。SaaS 接收、聚合与控制台在独立仓库规划，不以此要求实现桌面 Admin API。

**旧 Rust Host 的历史验证基础（不能视为 Electron 验收）：**

- [x] Rust Host 启动随包 Node，使用私有 NDJSON v2；SQLite 在 Worker 执行用例。
- [x] 单实例、能力白名单、帧/队列/超时限制、制品版本/架构/摘要校验。
- [x] Windows x64、macOS arm64/x64 的独立制品冒烟、Rust IPC/故障回归、平台构建；macOS app 内资源再次校验。
- [x] 制品装配包含 Node、生产依赖和许可证，不要求终端用户现场安装 Python。
- [x] Windows MXC 固定任务及有限隔离验证，失败不回退宿主执行。

**Electron 验证切片（实现与最终 CI/发行分别验收）：**

- [x] 固定 Electron 45.3.1、electron-builder 26.18.0、electron-updater 6.8.11；区分内嵌 Node 与独立 Core Node 26 的 ABI。
- [x] 实现拆分的 TS Main/Preload、可信来源/能力白名单、受限 UI 协议，并替换 Vue 桌面 bridge。
- [x] stdio 移入 `runtime/transport/`；通用 IPC 与命令/收据契约共用，不依赖 Electron、不自动切换。
- [x] 迁入有界 Core Host、完整性/版本/ABI 校验、参数快照、未知结果与操作 ID 恢复、单实例及退出/暂停回收。
- [x] 保留数据位置/稳定 owner，以 SQLite 独占连接阻止其他连接并行使用；不自动升级或创建空库掩盖兼容错误。
- [x] 实现 Executor 契约/策略/平台适配和 Host 注入边界，Windows 合成资料完成六项原生验证；诊断不修改 ACL。
- [x] 实现更新状态机及确认、停写、取消和失败路径回归；生产签名/更新通道另行验收。
- [x] 实现 package/smoke，Windows 独立目录包已验证创建/重启/收据/Renderer 隔离；三平台检查已接入 Runtime integration。
- [x] 活动依赖、桌面壳层和桥接已切换到 Electron；旧 Rust Host 不作为源码或依赖保留。

**共同产品与发行门槛：**

- [ ] 正式签名/公证、最低 OS 实机、干净离线安装、升级回滚、休眠/退出/多窗口验收。
- [ ] macOS 原生执行 Adapter 与 Windows 完整不可信负载矩阵。
- [ ] 端侧 FS、watcher、Secrets、PTY 和完整 Agent 的产品接入。

### N5——收敛与发行

- [ ] 当前 N2 继续在 `apps/web/` 维护 Linux/NAS Admin 独立入口；桌面和移动端不提供 Admin 页面，分别使用端侧设置与状态界面。未来 SaaS 控制台开始实施且功能、权限、发布及仓库边界明确后，再评估提取 `apps/admin/` 或独立私有控制台；该拆分不是当前 N2 或桌面可运行版本的前置条件。复用界面须以各 Host 的管理员认证和服务端授权为前提。
- [ ] 补齐 `packages/fs/` 的授权根授予/撤销、目录枚举、受控写入、原子替换与恢复能力，并建立独立 `packages/sandbox/`、迁移 Web Host 文件能力及 Core Executor 的可复用部分；Host 负责可信身份、授权根目录、执行后端与能力注入。当前 FS 包只有读取及暂存/恢复原语，尚无桌面调用方，不能记为端侧 FS 完成。
- [ ] 完成 FS 授权边界、直接读写、原子写入与恢复验收；Linux MXC 须完成多用户、进程、资源和网络隔离验收后才能启用。

- [ ] 按架构说明将 Vue 前端、Node Web Host、Electron Host 和共享 Core 迁入 `apps/web/`、`apps/web-host/`、`apps/desktop/`、`packages/core/`；目录搬迁与业务重写分开，更新 workspace、构建/部署、CI、测试清单和文档路径。
- [ ] N2/N3 生产调用方切换后清理 `backend/` 中已退役的 Python API/业务实现；仍需独立运行的 Python Worker 只有在确有独立生命周期时才迁入 `apps/python-worker/`，否则随对应 Host 收敛或一并退出。
- [ ] 将独立子项目 `loopscope/` 保持为自己的 workspace，不为了顶层目录形式统一而重排其内部包。
- [ ] 无生产调用方后移除对应 `compat/` 包、安装路径和重复依赖；保留仍需独立运行的计算服务。
- [ ] 旧 FS 数据完整性与恢复验收通过且 2.0 无生产调用方后，删除旧 DB↔FS 对账的 Admin 页面/API、对应测试与生成契约；保留有独立业务依据的配额账本核对和云同步运维能力。
- [ ] MXC 管理能力接替旧实现且 Linux 多用户隔离验收通过后，删除 Docker 专属 Shell Admin 字段、镜像/daemon/Rootless 与容器生命周期 API、UI 和测试；按 MXC 能力保留或重设计通用状态、启停、授权、资源/网络策略及执行中断管理，不迁移旧 Docker 接口语义。
- [ ] `gugu-saas` 独立构建、协议稳定，再评估闭源拆仓；Core 构建不依赖私有源码。
- [ ] 平台安全、可恢复升级和完整产品验收通过后发布 2.0。

<a id="core-test-parity"></a>

## 6. T1：Node Core 回归等价与测试分层

### 6.1 任务边界与交付

**目标**：为已经存在的 Node Core 行为补齐与当前 Python 后端同逻辑的回归，建立可独立运行的快速、集成和跨语言对照测试。先让这批 Core 的语义可验证，再覆盖 N2/N3 的 Web 与业务迁移。

**已落地**：显式分类清单、快速/集成/IPC/PG/parity/all 命令、共用 SQLite/PG 数据契约、42 组语料与 16 步维护序列、测试源码类型检查、根 fast/affected/分层和 CI 接入。覆盖仅针对已有 Node 切片，不代表全部 Python 领域已迁移。

- [x] T1.1 生成行为对照清单，记录 Python 用例/生产入口、Node 对应入口、契约断言、差异、标记、CI 及验收状态。
- [x] T1.2 补齐当前 Domain/Application 的合法、非法和组合状态分支。
- [x] T1.3 在临时文件 SQLite 和隔离 PG 上运行相同数据契约；补联系人更新/删除、所有者隔离及错误终态等缺口。
- [x] T1.4 扩充同输入对照、旧库互读、升级备份与恢复；保留独立期望结果，不仅把 Python 输出当真源。
- [x] T1.5 按下表标注测试类型，整理发现范围，落地分层及定向运行命令。
- [x] T1.6 接入根调度、affected/fast 选择、元数据/清单和现有 CI；证明每层实际收集了预期测试。
- [x] T1.7 接入差异/故障回归及完整 CI 矩阵；精确提交、两项必需 CI 和合并门禁结果统一记录在 PR。

本任务不以复制整个 pytest 数量或重写所有后端领域为目标。Python 独有的 Web 事务、文件联动和 Agent 工具能力若尚未迁到 Node，必须标为“待功能迁移”，不得写成已有 Node 等价覆盖，也不为凑测试偷偷增加一套不完整实现。

### 6.2 Python 与 Node 对照来源

详细对应关系、入口、运行类型及有意差异集中维护在 [Node Core 回归对照清单](../testing/node-core-parity.md)，不再在主文档重复维护测试文件表。

差异分为“已等价”“待补覆盖”“待功能迁移”“有记录的有意差异”。名称长度、数字归档等既有差异分别断言两端结果；不通过抹去 owner、排序、微秒、版本或副作用来制造等价。

### 6.3 与 pytest 相同的类型和分层选择

当前事实源为 [pytest.ini](../../backend/pytest.ini)、[pytest 收集规则](../../backend/tests/conftest.py) 和 [根分层调度](../../scripts/tests/run-test-tier.mjs)。pytest 目前通过下列标记组合分层，并没有一个必须叫 `unit` 的 marker；Node 应对齐其含义。

| 标记/维度 | 现有 pytest 语义 | Node Core 对应规则（已接入显式清单） |
| --- | --- | --- |
| 无慢速/边界标记 | 默认快速、隔离测试 | 纯领域、应用用例、隔离临时 SQLite/编码/迁移测试；不因文件名含 DB 就自动归外部服务 |
| `slow` | 执行较慢 | 显式成本标记；不是业务正确性等级 |
| `external_service` | 真实外部服务或真实系统 I/O 边界 | 真实 PG/后续 Redis 等，必须提供显式隔离连接 |
| `process` | 子进程、PTY/终端等运行边界 | Node Worker 生命周期、子进程、stdio、CLI；Python Golden 因实际启动参考进程也带此标记 |
| `e2e_support` | 为浏览器 E2E 提供环境/支撑 | 只有确实支撑 E2E 的 fixture/桥接测试才标注；普通 IPC 测试不冒充浏览器 E2E |
| `layer` | 元数据中的 L0/L1/L2 等层级 | 沿用现有 `test-metadata.json`；与运行依赖标记分开，不用 L1/L2 代替 marker 选择 |
| 对照/契约用途 | 可另记录行为来源 | Golden/parity、双库 contract 属于用途，可与 `process`/`external_service` 同时存在 |

与 pytest 一致：`process` 或 `external_service` 自动归入 `slow`。默认快速层选取 `not slow and not external_service and not process and not e2e_support`；集成层选取四项的并集。分类以依赖与隔离方式为准，清单/显式标记驱动执行，不依靠测试标题或模糊文件名猜测。

**当前测试目录：**

```text
packages/core/tests/
  unit/domain/                     # 规则、字段与阶段/待办
  fixtures/                        # 共享双库数据契约与独立合成维护序列
  unit/data/                       # 隔离 SQLite、编码、事务与显式迁移
  integration/postgres/            # external_service + slow
  integration/runtime/             # Worker/Node 进程/stdio，process + slow
  golden/                          # 现有 Python/TS 对照保留此目录，process + slow
```

原有断言随文件迁移保留；`tests/suites.json` 驱动发现和分类，元数据/清单与 CI 已更新。新增混合边界用例仍须拆分或显式分类，不能因标题或文件名误入快速层。

### 6.4 可执行命令

`test` 默认执行 unit 与 Node IPC；以下专用入口均已实现。`test:list` 输出去重后的文件/marker/layer 清单；`typecheck:tests` 检查测试源码。PG/Python 必须显式配置隔离连接/参考解释器，缺失即失败。

| 入口（`pnpm --filter @gugu/core`） | 选择集合 |
| --- | --- |
| `test:unit` | 与 pytest 快速表达式相同，不启动服务、Worker 或子进程 |
| `test:integration` | 四个边界 marker 并集，包含真实进程、PG 与 Python 对照 |
| `test:ipc` | Node Worker/进程/传输，不包含 Python/PG |
| `test:postgres` | 真实隔离 PG，共用数据契约；不以 skip 代替通过 |
| `test:parity` / `test:golden` | Python 对照、旧库互读与恢复 |
| `test:all` | 全部分类的去重并集，缺服务/空选择/未登记文件明确失败 |

根分层调度、`test:fast`、affected 和 CI 已同步接入。Linux 专用 Core job 承担完整双库/对照；桌面矩阵选择快速层及 Node IPC，并验证实际使用的 Host/制品。Electron Host/Preload/窗口/更新/故障回归和真实应用冒烟承担新壳验收；旧 Rust 源码保留归档。各 shard 的并集覆盖完整门禁，分类不替代权限、持久化和故障回归。

CI 若按 `unit`、`ipc`、`postgres`、`parity` 分片，不能再额外执行包含相同用例的 `integration`/`all` 后重复累加数量；按显式收集清单验证并集和交集。

### 6.5 T1 完成条件

- [x] 每个现有 Node Core 业务入口都有 Python 参考或独立契约；差异与未迁移项明确登记。
- [x] 同逻辑用例保护输入、结果及持久化副作用；正常、非法、权限、并发和恢复分支均有对应断言。
- [x] 类型分类、发现清单与元数据一致；每个分层命令报告收集结果并证明没有漏测/重复计数，空选择不能假绿。
- [x] 快速层不启动外部服务或子进程；显式 PG/对照命令不能因缺依赖而全部跳过后显示成功。
- [x] 同一契约已配置到临时 SQLite/真实隔离 PG 与必要 Python 对照；旧回归和安全断言保留，最终执行结果在 PR 按精确提交核验。
- [x] 根调度、CI、包 README、测试规范与实现状态同步；最终两 workflow 全绿是独立的 PR 合并门禁，不能用本清单代替。

## 7. 完成证据与维护规则

已完成项依据 [实现/复查 PR #118](https://github.com/Coffeiz/Gugu-web/pull/118) 及 `ca943c88` 的 [Runtime integration](https://github.com/Coffeiz/Gugu-web/actions/runs/42954592909)、[Docker release](https://github.com/Coffeiz/Gugu-web/actions/runs/42954595536)。该基线已通过 Core 22 条、对照 2 条、前端 982 条、后端 5526 条，以及旧 Rust Host + Node 的三平台数据制品验证；这是首批实现的证据，不是 Electron 已实现、全量迁移等价或正式发行的证明。

每次迁移只更新本文对应条目、测试映射与证据；新的详细排查过程写入 `docs/devlog/`。依赖矩阵只维护候选/采用与兼容门槛，历史归档不再维护实时状态。分支/PR 继续按 `v2.0` 路线推进；提交、推送、CI 触发和合并分别遵守仓库授权与发布规范。

### Agent 目录职责收敛补充（2026-11-14）

原顶层 `run-codec`、`run-store`、`history`、`attachments`、`message-shared`、`byok`、`pending-queue`、`ui-labels` 和三个 schema 草案目录已按职责收敛。正式 schema 位于 `interactions/`；设计和 SQL 草案迁到 `docs/refactor/agent/`，生产目录不再混放合同测试。公共导出和实际调用方直接采用新位置；事务借用直接复用共享数据实现。该调整不新增工具迁移完成项，不代表草案升级器或真实执行后端已验收；工具迁移继续暂停。

本轮 devserver 结构回归：Core 28 文件/458 项通过；Host 串行 8 文件/28 项通过、8 项缺隔离 PG 跳过；Core 测试源码、Core/Web Host 类型检查与构建通过。并行 Host 运行因资源压力中断后已串行复跑，不将中断结果计绿。真实 PG/Redis/平台执行仍未验收。

### Agent 工具迁移恢复（2026-11-15）

工具迁移已恢复。新增 `global_search` 完整注册器切片，委托共享搜索服务；Host 工厂按服务能力与授权显式开放，缺少请求来源明确不可用。Node 工具5/5、Host注册器10/10、Python搜索30/30通过，Core测试源码类型检查、Core构建及Host类型检查通过。Provider/RunStore/租约/上下文与Host来源使用明确替身，Core查询使用真实临时SQLite；生产main、真实PG/Redis和全来源组合未验收。状态为已实现待接入，总计10项；部分实现4项、依赖阻塞94项、退役/重设计1项，生产完成仍为0。详细证据见工具行为迁移清单。本轮按用户要求未与其他会话通信。

### 只读工具连续迁移与工具组整理（2026-11-15）

新增近期待办 `get_upcoming` 与回收站列表 `list_trash`，调用现有共享领域读取；Host按实际能力注册领域工具组，并可整组启停。项目工具集中到 `tools/projects.ts`、辅助端口归 `tools/projects/`，Skill使用归 `tools/meta.ts`，删除旧单工具文件路径并同步调用方、导出与测试。补充tools/skills开发规范README和总目录入口。

工具379、Skill28、Host15（含真实临时PG）、Python57项通过；Core源码/测试类型检查及构建、Host生产源码类型检查通过。Host全量测试类型检查首轮遇到未修改的Admin分析测试TS7022，后续类型标注更新后已复验通过；相关原始失败保留在工具行为清单。当前状态：已实现待接入12、部分实现4、依赖阻塞92、退役/重设计1，生产完成0。真实Redis、外部Provider与生产Run未验收，不据测试工厂宣称生产完成。

### 四组工具与共享用例连续交付（2026-11-15）

补齐日历活动/提醒范围查询、工作区owner关联名称与计数、完整总览统计、项目修改同事务定位/持久收据/CAS/Undo与目录协调；七工具统一经Host runtime和隔离PG进入Provider续轮。按旧Python领域工具组组织，calendar既有application目录保留；注册器按可信Host能力开放，缺服务或仅apply写原型不开放。生产main未装配，当前已实现待接入19、部分实现1、依赖阻塞88、退役/重设计1，生产完成0。

正式SQLite工作区schema、真实Redis/平台执行/生产Run仍未验收；项目跨文件系统未知提交仅查收据，缺证明不重试。Python旧ORM缓存回执与Node提交后回执差异已单列。最终测试与失败记录、共享端口说明见 [工具行为迁移清单](../testing/node-agent-tools-parity.md)。

本批最终：Core 29文件445通过、Host 5文件17通过（含真实临时PG）、Python 7文件61通过，均0失败/跳过；Core源码构建通过。Core测试源码仍有并行文件读取测试跨rootDir的TS6059，Host全量类型检查仍有并行调度/Admin/ES lib错误，未扩大范围改动这些文件或放宽检查。ripwire静态质量门仍受跨域克隆组影响未通过；diff与测试清单JSON有效。


### 项目阶段、笔记读取与Schema发现工具交付（2026-11-15）

连续新增8工具：项目add_stage/remove_stage/rename_stage/set_stages/update_stage、笔记note_search/note_get、元工具get_tool_schema。项目阶段共享纯用例补齐，复用同事务目标解析/CAS/Undo/收据；笔记共享读取补齐一跳关系、正文引用与微秒；元工具按当前可信注册器发现，缺后端或授权不显示目标。工具仍按projects/note/meta领域模块组织，Skill的Markdown头部注册方式不变。

当前已实现待生产接入27、部分实现1、依赖阻塞80、退役/重设计1，生产完成0。没有将共享接口、注册名称或替身验收当作生产完成。真实SQLite/PG、Host续轮和Python对照结果、共享端口及剩余限制见[工具行为清单](../testing/node-agent-tools-parity.md#项目阶段笔记读取与元工具连续迁移2026-11-15)。

本批最终验收：Node 30文件457、Host 5文件18（含真实隔离PG）、Python 3文件44项通过，均0失败/跳过；Core源码构建通过。本批范围ripwire delta gating=0，入口无不兼容调用。Core测试源码仍受既有文件测试TS6059阻塞，Host全量类型检查仍受并行导出与ES lib错误阻塞，未修改其他会话入口或放宽检查。收据持久化前的嵌套错误脱敏、重建恢复和跨注册器并发去重已验证；具体替身、未验收项与文件范围见工具清单。


### 工作区更新与画布列表工具闭合（2026-11-15）

实际完成update_workspace和canvas_list两个工具切片。工作区更新借用既有共享事务适配器，同事务同步目录显示名、读取完整owner结果并写持久调用收据；画布列表补齐共享分页/总数/owner项计数/视图及微秒投影。均通过真实Host runtime和隔离PG进入Provider续轮，保持工作区/画布领域工具组。canvas_get/search不计完成，生产main和正式SQLite工作区升级仍待接入。

累计已实现待生产接入29、部分实现1、依赖阻塞78、退役/重设计1，生产完成0。测试、失败原因、共享接口及替身范围见[工具行为迁移清单](../testing/node-agent-tools-parity.md#工作区更新与画布列表实际交付2026-11-15)。

本批验收：Node 33文件465项、共享声明双库1项、Host 5文件19项（含隔离PG）、Python 3文件38项通过，均0失败/跳过；Core构建和Host全量类型检查通过。Core测试类型检查仍有既有TS6059，静态扫描仍有4项跨域克隆门限，未放宽检查或扩改无关实现。临时数据已清理，工作区未提交，生产完成数仍为0。


### 画布详情、搜索和定位工具交付（2026-11-15）

连续完成canvas_get、canvas_search、canvas_focus_node；共享Mind补齐节点分页、独立关系快照/几何审计、关键词过滤/limit+1探测及精确定位查询。源实现集中在画布领域组，不新建单工具模块；读操作不修改布局。旧搜索对画布项墓碑的特殊语义按Python保留，未据此宣称全部历史问题已修复。

累计已实现待生产接入32、部分实现1、依赖阻塞75、退役/重设计1，生产完成0。具体回归、替身和构建产物并发问题见[工具行为清单](../testing/node-agent-tools-parity.md#画布详情搜索和定位连续交付2026-11-15)。

本批统一验收：Core 35文件467项、最终调整后2项、Host隔离PG五文件19项、Python四文件63项通过，均无跳过。Core生产构建通过；整树测试类型检查及质量扫描尚未全绿，具体错误、首次构建产物竞争和最终重跑证据见工具行为清单。生产装配、真实Redis/Provider和客户端定位仍未验收。


### 画布候选/创建与技能元数据目录（2026-11-15）

连续交付canvas_search_placeable、canvas_create、list_skills；复用共享Mind查询/创建及Markdown head定义，补齐owner元数据目录和借用外层事务的SQL适配。创建/Undo/持久调用收据共同提交，重建恢复不重复创建；工具按canvas、skill_management领域组配置，Host能力缺失不注册。技能管理列表包含停用用户项且不读正文，不代表HTTP Skill列表或用户技能写入已完成。

累计已实现待生产接入35、部分1、依赖阻塞72、退役/重设计1，共109；生产完成0。本批Core 38文件475项、Host隔离PG五文件20项、共享Mind PG合同1项、Python四文件79项通过，无跳过；Core构建和Host类型检查通过。Core测试类型检查仍有既有跨rootDir问题，质量扫描并非全绿。真实Redis/Provider、生产装配和正式SQLite文件/Skill表仍未验收；失败记录、文件与共享接口见[工具行为清单](../testing/node-agent-tools-parity.md#画布候选与创建技能目录连续交付2026-11-15)。


### 画布布局、视图移除和正文编辑（2026-11-15）

连续交付canvas_update_node、canvas_remove_node、canvas_update_note，统一在canvas领域组。共享Mind批量用例复用原条目/便签SQL写服务，后项失败整批回滚；补齐可信Host canvasEdits、同事务Undo/收据、重建恢复及旧节点墓碑语义。没有引入独立工具框架或单工具模块。

累计已实现待生产接入38、部分1、依赖阻塞69、退役/重设计1，共109；生产完成0。Core 39文件482项、Host隔离PG五文件21项、Mind共享PG合同1项、Python四文件64项通过，无失败/跳过；详细回归见[工具行为清单](../testing/node-agent-tools-parity.md#画布布局视图移除与正文编辑连续交付2026-11-15)。构建和Host类型检查通过；Core测试类型检查及整树静态质量仍有记录的限制。真实Redis/Provider、事件总线和生产Run装配未验收。


### 画布新增、引用放置和连接（2026-11-15）

连续完成canvas_create_note、canvas_add_node、canvas_update_anchor，并在共享依赖闭合后继续完成canvas_connect。工具集中在canvas组，Mind补齐共享世界坐标/水平端点及放置事务，复用原引用/条目/关系/画布SQL写服务与同事务Undo/收据；Host显式canvasPlacements、canvasRelations，缺能力不开放。

累计已实现待生产接入42、部分1、依赖阻塞65、退役/重设计1，共109；生产完成0。最终测试、真实后端与替身、类型/质量限制见[工具行为清单](../testing/node-agent-tools-parity.md#画布新增引用放置与关系连接连续交付2026-11-15)。最终Core 41文件493项、Host隔离PG五文件22项、Mind共享PG合同1项及Python四文件64项通过，无失败/跳过；初次SQLite并发合同超时及串行重跑已保留记录。真实Redis/Provider、生产Run装配、客户端渲染及正式SQLite文件能力未验收。旧项目/活动墓碑引用、项墓碑端点编辑和detached行为按Python保留，不以迁移声称这些语义已重设计。


### 普通笔记生命周期工具（2026-11-15）

连续交付note_delete、note_restore、note_undo，统一在note工具组。复用共享Mind CAS、恢复/软删和事务内目标选择，补齐借用外层事务、持久收据、双库恢复/Undo合同与微秒快照。Host显式noteLifecycle，缺能力不开放；恢复同一撤销调用只查原收据，不重新选择下一条gugu记录。

累计已实现待生产接入45、部分1、依赖阻塞62、退役/重设计1，共109；生产完成0。最终Core 43文件500项、Host隔离PG五文件23项、共享PG两文件2项及Python四文件78项通过，无失败/跳过。新增Host夹具的并发顺序错误及修正已保留记录；类型/质量限制及替身范围见[工具行为清单](../testing/node-agent-tools-parity.md#普通笔记生命周期连续交付2026-11-15)。生产Run/事件、真实Redis/Provider及完整笔记创建/追加用例尚未验收，未扩展永久删除或危险确认能力。

### 1.7.7 TypeScript RAG：会话持久来源补齐（2026-11-15）

Core 新增会话重建来源，复用旧版 baseline/角色过滤、摘要/消息投影、相邻上下文和群聊 scope；临时 SQLite 测试通过既有持久 Worker 写入正式索引表。对应 Core 会话/RAG 文件 **41/41 通过**，来源严格类型检查通过；Python pytest 未能运行（devserver 当前没有 pytest）。生产 Node 调度、可信 scope 来源、正式 Jieba/向量装配、PG 回归及 Agent Run 接通仍未完成，因此 `search_conversations` 仍不是生产完成。实现与未验收边界见[工具行为迁移清单](../testing/node-agent-tools-parity.md#会话索引来源与持久-worker-写入2026-11-15)。

Host RAG 单消费者调度器已接入 `main.ts` 的迁移状态门控，并经临时 SQLite 的真实队列、Core Worker 与正式索引表验证；首次部署还会为无既有索引/任务的来源建立基线队列。此次新增基线幂等与真实索引 `search_conversations` 后，Host 两个定向测试文件为 **9/9 通过**。正式 PostgreSQL/生产凭据和 Agent Run 真实资源装配仍待验收；详见[工具行为迁移清单](../testing/node-agent-tools-parity.md#首次-rag-索引基线与持久会话工具2026-11-15)。

2026-11-15 回归补强：Core 1.7.7 来源适配、confidence-v4/v1 排序、日期分词、受控 OpenAI/Bailian embedding 请求及 memory cache 定向用例 **26/26**，正式 Host Jieba 对照 Python tokenizer golden **2/2**，search_conversations dispatch、memory scope/向量和七类来源索引 Worker **13/13**；Core typecheck/build 通过。Host 全量 typecheck 仍被 user-list、BYOK、files、scheduled-task 测试中的类型错误阻断，RAG 用例无新增诊断。对应 Python tokenizer 与历史搜索 pytest 因 devserver 未安装 pytest 未能运行。Host 使用锁定 Jieba 和临时 SQLite/文件；memory 授权、scope、向量文件和 embedding 凭据/transport 仍为合成测试依赖。`createAgentToolRegistry` 仍无生产 Run 调用方、PG 测试库和生产 Provider 均未验收，故工具及 RAG 不能标为生产完成。

2026-11-15 补充 Runner 级验证：Host 临时 SQLite 用例现经真实 `createAgentRuntime` / Core Runner 发起 `search_conversations`，调用实际工具注册器、持久索引和正式 Jieba，并验证结果进入 Provider 续轮；该测试文件 **3/3 通过**。Provider transport、RunStore、上下文与授权使用合成依赖，因此只证明运行器调用链行为，不表示 `main.ts` 生产 Agent Run 已装配；正式 PG 和 Python pytest 仍未验收。

### 1.7.7 TypeScript RAG：Mind 来源事务新鲜度（2026-11-16）

Mind 便签 create/update/delete/restore、画布/条目/画布便签投影变更和 Undo/redo 现在在同一 SQL 事务排入 `rag_index_jobs`；全画布任务使用空 source ID 触发完整 canvas 来源重建，避免把 canvas 主键误传成 item 主键。布局更新统一由共享 SQL runtime 入队，无字段变化不增任务，批量操作不重复递增 generation。Core 真实调用链测试经 Mind SQL mutation→隔离 SQLite 队列→`createSqlRagRebuildWorker`→`knowledge_index_entries`，Mind RAG freshness **5/5**；与 Core RAG **36/36** 合计 **41/41**。Host 对话/Runner、memory scope/向量/BYOK、调度器/Worker/基线 **16/16**。本轮 Core 全量 `typecheck` 通过；Python pytest、隔离 PostgreSQL 和真实 Provider 未运行。

生产 RAG 仍未完成：`main.ts` 已在迁移门控通过时把 `memoryStorageRoot` 与 knowledge reader 注入 Worker；但尚无 production Agent Run 对 `createAgentToolRegistry` 的调用者。已发现的 project、calendar、Mind、conversation、scheduled_task 更新入口会写持久任务；knowledge、memory 尚无完整 Node 写入端或 freshness producer。Python FastAPI Cython Worker 与 Node TS Worker 仍竞争同一持久任务租约，尚未切换到 Node-only 消费；正式 PostgreSQL 迁移未应用/验收。详见 [RAG 模块说明](../../packages/core/src/agent/rag/README.md) 与[工具行为迁移清单](../testing/node-agent-tools-parity.md#conversation-写入到-rag-队列的事务闭环2026-11-16)。

2026-11-16 继续补齐 scheduled_task 写入面：Core 日历提醒改期/禁用、日历 Undo/redo、一次性任务完成删除和工作区解绑将索引任务放入主数据事务，共用 `scheduled-tasks/rag-index-job.ts`。Host task producer 同时保留初始及先前待重建 source ID。devserver 隔离 SQLite 有效子集 **4 个文件、17 项通过、2 项 PG 子测试跳过、0 项失败**；另一次误将 PG-only 文件纳入命令时因缺少 `GUGU_CORE_TEST_POSTGRES_URL` 在套件加载阶段失败，不计入通过数。Host PG 回归因缺少隔离库未运行，Python pytest 因无项目 `.venv/bin/pytest` 未运行，本轮未重跑 typecheck/build；Mutagen 3 处生成目录冲突未 flush、未覆盖。knowledge 和 memory Node 写入生产者仍缺失。

2026-11-16 补齐 Python `test_cython_rank.py` 中 Core 尚缺的排序选择契约：top-k、历史正文排除、重复引用、输出预算、精确置信阈值、低分回退及 diversity caps。devserver Core ranking 定向用例 **15/15 通过**，使用确定性 tokenizer；Python pytest 当前不可运行，本次不记实时跨语言差分，也不代表完整检索语料质量验收。详见[工具行为清单](../testing/node-agent-tools-parity.md#python-rag-rank-回归补齐到-core2026-11-16)。


链接按钮新增安全校验及可信投递端口原型；实际平台投递、持久恢复及Host装配未完成，仍记依赖阻塞。Node专项1项、Python基准49项通过，详见工具行为清单。

2026-11-16 RAG 本地追加复验：Core RAG/search/ranking **47/47**；Host direct-source 与持久索引工具分派、Runner 续轮、持久 Worker/基线及正式 Jieba **14 通过、2 个 PG 用例跳过、0 失败**。Python pytest 未执行（本机缺少 pytest 模块）。Node 回归使用临时 SQLite/FS 和合成 Provider/授权；不得据此认定生产 Agent Run、PostgreSQL 索引迁移或 Node-only 队列消费者已验收。剩余生产工作包括：主入口装配 `createAgentToolRegistry` 和 conversation/memory 可信端口、传入 memory storage root、补 Node knowledge/memory 写入触发器、确认并切换 Python/Cython 与 Node 队列消费者归属，以及隔离 PostgreSQL 与 Python 基准回归。

2026-11-16 补齐 1.7.7 原 `index-cache-service`、`snapshot-cache`、`rag-service` 生命周期回归：Core 新增 cache/service 真实调用契约 **6/6**，保护滑动 TTL、revision invalidation、scope隔离、失败重建和错误显式传播。devserver Core RAG/search/ranking **8 个文件 53/53**；Host search/Runner/Worker/Jieba **14 通过、2 项隔离 PG 测试跳过**；Core 与 Web Host build 通过，新增测试严格单文件 TypeScript 检查通过。Python pytest 环境缺失。v1.7.7 算法模块均有 Core 职责映射；当前生产未完成项是 Agent Run registry、生产 scope/embedding 装配、knowledge/memory Node 写入 producer、PostgreSQL migration 与 Python/Cython/Node consumer ownership。固定合成语料已完成所覆盖查询的跨版本对照；真实 PostgreSQL 和生产调用链仍未验收。详见 [RAG 工具行为回归](../testing/node-agent-tools-parity.md#177-rag-生命周期缓存服务回归补齐2026-11-16)。

2026-11-16 补齐统一检索的向量回归：`createScopedRagSearch` 在 embedding transport 错误时按 Python 行为退回 owner scope BM25，取消信号继续传播；同时验证版本匹配的向量文件通过实际 scoped search 参与 hybrid 重排。devserver RAG 定向合集 **9 个文件、56/56**；Core `typecheck` 与 build 通过。Host `search_conversations` 经真实 conversation adapter、持久 TS RAG、正式 Jieba、Core 注册器和 AgentRuntime Runner **4/4**。Core RAG 套件临时绕过测试发现配置，因为并行工作区新增的 `tests/scheduled-tasks/test-notify.test.ts` 尚未登记 `packages/core/tests/suites.json`；未修改该共享清单项。隔离 PG、Python pytest、生产 Run 装配和真实 embedding 服务仍未验收。详见[工具行为清单](../testing/node-agent-tools-parity.md)。

2026-11-16 devserver 补验与生产入口增量：Node Web Host 在 RAG migration `applied` 时将 `config.storageLocalPath` 同时注入 knowledge 与 memory 的 owner-bound reader；这启用生产 memory 重建来源，但不补 memory 更新 producer。旧版 RAG pytest **279/279**、search 工具/schema pytest **37/37**；Core RAG Node **56/56**；Host RAG/会话 **17 通过、6 个 PG 用例跳过、0 失败**；Host production build 通过。Python RAG 只使用临时 venv，Cython 扩展编译到测试临时目录。PG 测试因隔离库未配置跳过；真实 Provider/Redis未调用。仍未生产接通 Agent Run 注册器、可信 IM memory 查询授权/embedding、knowledge/memory Node freshness producer、Node-only 队列消费归属和 PostgreSQL migration。标准 Core Vitest suite 清单存在并行新测试未登记，本次用临时 RAG-only config 运行且未改对方文件。

2026-11-16 当前 Core RAG 复验：在 devserver 用 Vitest 标准配置显式选取 Core RAG 与 Mind RAG freshness 测试，**10 个文件、62/62 通过**（Core RAG 9 文件 57/57，Mind freshness 1 文件 5/5）。该结果复验 scope/owner、分词、向量降级、排序、缓存生命周期和 Mind freshness；不覆盖真实 PostgreSQL、外部 embedding、生产 Agent Run 或全量 Vitest suite。

2026-11-16 共享检索质量验收：新增旧版 Cython 与 Node Core 共用的中文/英文/混合查询语料。正式 Jieba 下，两个检索器的四个有效查询均 Recall@3=1、MRR=1；无关查询为空，与 owner 查询词完全相同的 group-scope 干扰文档均被过滤；Python pytest 与 Node Host 行为用例各 **1/1** 通过。该项关闭跨版本词法质量语料缺口；真实向量 Provider、隔离 PG、生产 Agent Run/授权装配、knowledge/memory freshness producer 和 Node-only 队列切换仍未验收。

2026-11-16 索引损坏错误边界：Host 临时 SQLite 经 Core 持久读取器读取非法 `metadata_json`，固定返回脱敏错误；排入的 RAG job 经 Core rebuild worker 重写来源投影、状态到达 `ready`，snapshot 恢复可读，定向 Node 测试 **1/1** 通过。损坏行不会被伪装为空召回；本项不代替 PostgreSQL 验收或 Worker 生产故障恢复验收。

2026-11-16 memory 向量键兼容：scope 隔离后的持久 memory parent ID 带命名空间，Core 现用来源元数据中的原始 `memory_parent_id` 查询 1.7.7 `memory_vec.json`，再按持久文档 ID 返回向量。devserver 临时副本的 scoped hybrid 行为回归 **4/4**，用例经实际 Core `createMemoryRagSource` 投影；严格 TypeScript 检查通过。真实 PostgreSQL、生产 embedding 和 Agent Run 注入仍未验收。

2026-11-16 Skills/MCP 目录生产接线：`GET /api/v1/skills` 默认工具目录与 `GET /api/v1/skills/tools` 已接 Node builtin catalog、Core owner 快照/配置摘要、Host MCP owner 配置与密文解包、固定目标 HTTP SDK discovery；停用时不外连，按旧行为保留健康服务部分结果，失败不提交不完整快照。Node Skills/MCP 合批 **37 通过、6 跳过**，Core/Web Host build 通过；Python pytest 环境不可用，隔离 PG 快照测试跳过，真实 MCP/部署未验收。MCP tools/load_status/reconnect 仍等待 Node Agent MCP runtime 状态与调用消费者；不以 Skills schema 快照冒充运行时加载或工具执行。

2026-11-16 MCP 管理 runtime 生产接线：Host `GET /api/v1/mcp/servers/{server_id}/tools`、`POST .../load_status`、`POST .../reconnect` 已接认证 owner、Core 配置读取及受控 HTTP MCP SDK，加载状态进入设置列表；配置更新/删除关闭并失效连接。runtime/route TDD 用例先因模块缺失失败，重试回归也先红后绿；新增完整 `createApp` 用户认证入口验证。Skills/MCP 定向合集 **39 项：35 通过、4 个隔离 PostgreSQL/Python 用例跳过、0 失败**；Web Host production build、Skills Core SQLite 合同 1/1 通过。Python 旧 handler 与 load_status 回归源码已对照，devserver `python3` 缺 pytest。stdio、Agent Run 实际 MCP 工具执行消费者、真实 PG/SQLite 部署、外部 MCP 服务未验收。

2026-11-16 新增 `read_knowledge` Core 工具组与 Web Host 持久索引适配：ID 精确读取通过 owner-bound FS 解析完整正文，关键词检索经正式 `knowledge_index_entries` 和 Host scope 授权；关键词返回 ranker 的共享预算文本投影，与 Python 公共检索结果一致。Core dispatch 4/4、Host 临时 SQLite/FS 注册器调用链本轮复验 1/1；Core build 在 devserver 通过。旧 Python pytest 因 devserver 缺项目 `.venv/bin/pytest` 未运行；Host 全量 typecheck 仍有其它测试类型错误。工具尚未进入生产 Agent Run，knowledge 写入/freshness producer 与 PostgreSQL migration 未验收，不标记为生产完成。Mutagen 自动同步本轮源码；验证前曾因 Core dist 尚未重建而失败，重建 Core 后 Host dispatch 1/1 通过。现有同步冲突在生成目录，未清理或覆盖。共享工作区 HEAD 在本轮期间由并行会话推进，本会话未执行提交。

同日续轮回归：Core `knowledge.test.ts` **4/4**、`source-adapters.test.ts` **8/8**（临时 Vitest 配置只选目标文件且已删除）；Host `search_conversations` SQL 事实表和实际 `AgentRuntime → Core Runner → registry dispatch → Provider` 续轮 **4/4**，`read_knowledge` registry/SQLite/owner FS **1/1**，owner knowledge store、持久 Worker/baseline、正式 Jieba **11/11**；Host 合计 **16/16**。知识用例曾配置匹配版本的临时 owner 向量文件和确定性 mock embedding；后续回归明确验证该知识工具不会读取向量或调用 embedding。Node Core build、Web Host production build 通过（该次续轮时）。Core 标准 suite 被共享工作区未登记的 Skill 测试阻断，Python pytest 未安装；测试未连接 PostgreSQL、Redis、真实 embedding Provider。生产 `main.ts` Agent Run 装配、knowledge/memory Node 写入 producer、PG migration 和 Node-only Worker 切换仍未完成。

2026-11-16 `read_knowledge` BM25 行为修正：对照 Python `_read_knowledge` 明确传入 `strategy="bm25"`，发现 Host 适配器此前仍会调用可选 embedding 并走 hybrid，但工具结果结构固定写 `strategy: bm25`。Host 注册器回归先红后绿；修复后的 Host knowledge、memory scope/BYOK、Worker 生命周期、Web Run 工具绑定合计 **4 个文件、17/17 通过**，knowledge 调用断言向量读取及 embedding 均未发生，同时保护 memory 向量召回和 Worker 队列行为；临时 owner FS、持久索引、正式 Jieba、owner 隔离与授权检查均覆盖。严格单文件 TypeScript 检查通过。Python pytest 因 devserver Python 环境缺少 pytest 未运行；Web Host production build 被共享并行改动 `packages/core/src/byok/vector-rebuild.ts` 的 TS6133 未使用变量挡在 Core prebuild，未触碰该文件。此项恢复知识工具行为一致，不影响 memory 的向量召回。生产 Agent Run 与正式 PostgreSQL 仍未验收。

2026-11-16 Skills/MCP devserver 复验：相关 Node 回归 **43 项：38 通过、5 个隔离 PostgreSQL/Python 用例跳过、0 失败**；Web Host production build 通过。测试前核对 Skills/MCP 生产源码与测试文件和本地哈希一致；首次从仓库根目录启动测试时因 `tsx` 按 cwd 解析失败，改在 `apps/web-host/` 执行后通过，不属于产品代码失败。devserver 缺少 `backend/.venv/bin/pytest`，Python 对照未运行。此复验没有补上 Node Agent Run 的生产工具注册消费者，也没有实现需要隔离 Broker 的 MCP stdio；真实 PG、SQLite schema、MCP 服务与部署仍未验收。

2026-11-16 MCP tools/call 参数兼容与外呼边界：Core MCP schema adapter 复用现有 `normalizeToolInput` 和 Python 兼容 `invalidInputResult`，Host 只对当前 owner 已启用且已发现的工具执行 SDK `tools/call`，校验失败返回 Python 形状 `tool_input_invalid` 且不外呼。Node Host 用例先因 adapter 调用契约不匹配红 **6 项**，接线后 **10/10 通过**；Core 新增归一化/错误投影合同 **3/3 通过**。devserver Core build、Web Host production build 通过；Skills/MCP 定向合集 **59 项：53 通过、6 个隔离 PostgreSQL/Python 用例跳过、0 失败**。旧 Python MCP E2E 源码确认调用前归一化、schema 校验、失败不发送请求；devserver 无 pytest，未跑 Python。当前 `main.ts` 仍无 production Agent Run/reconstructor 调用者，Host dispatch 尚无真实 Agent Run 消费端；stdio 需要隔离 Broker。正式 PG、SQLite schema、真实 MCP、部署均未验收，因此此项只记内部运行能力，不将 MCP tools/call 或动态技能标为生产 Agent 执行完成。

2026-11-16 Skills/MCP 与凭据交互 devserver 复验：`tests/mcp/*.test.ts` + `tests/agent-skills/*.test.ts` **42 项：40 通过、2 个隔离 PG 用例跳过、0 失败**；额外的 MCP secrets/交互消费 Host 测试 **3 项：1 通过、2 个隔离 PG 用例跳过**。Core MCP/Skills 目标文件 **34/34**，正式 SQLite 用户 Skill 合同 **1/1**；Core 与 Web Host production build 通过。源码哈希核对一致。Python pytest 因 devserver 无项目 `.venv/bin/pytest` 且系统 Python 未安装 pytest，未运行。`main.ts` 仅用 Agent tool registry 生成目录，没有 Agent Run dispatch 消费者；secrets 路由/恢复 Worker 同样未进入生产组合根，故不记为 MCP 执行或凭据恢复已接通。Core 默认测试发现仍被并行工作未登记的 suite 项阻断，本轮使用临时外置 Vitest 配置跑目标文件并在退出时删除；Mutagen 报告的冲突仅涉及旧生成目录，本轮未清理或覆盖。工作区其他未提交改动均保留，未提交或推送。


2026-11-16 `search_memory` 错误状态兼容：按 Python `UnifiedQueryRetriever` 对齐 fallback reason，未启用 embedding 为 `embedding_disabled`、显式 BM25 为 `lexical_only`、已配置但无可用向量为 `embedding_cache_unavailable`，成功 hybrid 为 `null`。Core 真实工具注册器 dispatch 用例先验证旧实现失败、修复后 **6/6 通过**；还覆盖 query embedding transport 失败时返回授权范围内 BM25、隐藏底层异常。使用合成 owner memory 索引/向量，未调用 Provider。Python pytest 本轮未运行；生产 Agent Run、真实 PostgreSQL/Redis 和外部 embedding 未验收。

2026-11-16 PostgreSQL RAG 索引迁移真实隔离验收：修复 `pg` 将系统 `name[]` 返回为字符串造成的误报，SQL 现把唯一约束列和检索索引列显式投影为 `text[]`。临时 PostgreSQL 集群中 `rag-index-migrate.test.ts` **3/3 通过**：空库建表与结构验收、旧 Python 表无损认领、幂等，以及结构损坏拒绝；集群已停止。生产库未连接或升级。RAG 来源投影、正式 Jieba、owner 向量读取/受控 embedding 已有实现；knowledge 与普通 memory 写入新鲜度仍缺 Node 写入方。`search_conversations` Host 工具/Runner 测试已存在，但 `main.ts` 尚未装配 Agent Run 或将 conversation/memory 工具端口传入生产重建器，因此不计作生产工具接通。Python pytest 本机缺模块未运行，真实 Redis/Provider 未验收。

2026-11-16 补齐管理员 LLM 静态能力预览：`POST /api/v1/admin/agent/llm-presets/capabilities-preview` 现由生产 App 的 Admin guard 保护，Host DTO 调用共享 Core Provider 能力快照。缺路由时 Host 测试先因 404 失败，接入后认证/参数限制/Ollama native 协议与 reasoning/额外密钥不回显 **1/1 通过**；Core Ollama native 输出与 Python `capability_snapshot` 实际函数输出一致，完整 Admin handler 对照因系统 Python 缺 `uuid6` 无法启动。Web Host production build 通过；全量 typecheck 被并行工作区其他测试与依赖类型错误阻断，Core Vitest 测试发现也因共享 `suites.json` 与当前文件不一致未启动。真实部署未验收。

2026-11-16 恢复 Core Skill 合同回归发现：将已有 `user-management-sqlite.test.ts` 从 `node:test` 接入 Vitest 并补齐 suite/元数据登记后，Skill SQLite owner/MCP关联合同与 Provider policy **134/134 通过**。Core 默认层现可启动，devserver 全量结果 **148 文件：140 通过、5 个行为失败、3 个 node:test 文件无 Vitest suite，0 项因清单发现失败**。行为失败具体涉及两条缺 `rag_index_jobs` 的 Mind SQLite fixture、一条本地 IPC capabilities 预期、一条 Undo 子进程找不到 Core `tsx`、一条 portable-boundary 对 `kysely` 外部依赖的结构断言；均未修改这些并行工作区代码。Node 全量回归仍未通过。

2026-11-16 memory Jieba 装配闭环：memory Host 搜索 factory 现在自行装配与 conversation 共享的正式 Jieba 单例，不再依赖其他工具先触发 tokenizer 初始化。临时 SQLite/FS 上经 `search_memory` 注册器实际 dispatch 运行中文“群消息”召回回归 **5/5 通过**。此回归防止 memory-only Run 首次查询因 tokenizer 未装配而失败；使用合成授权/snapshot/embedding，未访问生产 PostgreSQL 或 Provider，Python pytest 未运行。生产 Agent Run 仍未装配工具注册器。
