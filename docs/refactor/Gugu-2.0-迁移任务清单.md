# Gugu 2.0 迁移任务清单

> 更新：2026-11-18。本文维护实施顺序、当前状态、验收证据与未完成任务。目标架构和多端职责见[架构说明](Gugu-2.0-架构说明.md)；依赖替换盘点见[Python → Node 依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md)。
>
> **当前路线：先完成 Node Web/NAS 后端迁移，再基于稳定的共享 Core 推进桌面产品化。** Web 使用 Node Host + PostgreSQL；桌面使用 Electron + Node Core + 本地 SQLite。两端共享 Core 契约，但拥有不同 Host 和数据生命周期。2.0 的 API、Agent 工具、后台任务与执行入口统一迁入 Node。未完成的功能明确标为不可用；不保留 Python 回退、双写或双运行时兼容层。旧版数据升级、备份与恢复单独验收。

**Agent 文件工具方向调整（目标，未完成）**：通用文件 CRUD 计划收敛至受授权 Shell，替代能力验证前保留现有功能；不再以新增独立 CRUD 工具数量作为迁移目标。先盘点工具、Skill/Schema、注册器、调用方和数据影响，验证 MXC/Host 的用户隔离、授权根、危险操作确认、并发与失败恢复，以及适用的配额、Undo、事件刷新和引用行为，再逐项删除可替代的 Node 工具及接线。Office/PDF 提取、附件读取和文件展示/发送分别评估替代方式；业务工具继续保留业务事务。无 Shell 的平台不得假定具备任意命令能力。旧 Python 后端保留为行为参考；相关回归以旧版可观察行为为基准，不因目标调整将尚未验收的替代路径标记完成。

> **2026-11-13 存储范围决策**：Gugu 2.0 Linux/NAS 自托管版只支持本地文件系统，Node WebUI 不迁移在线 OSS/S3 文件、附件或记忆存储 API（包括 OSS 直传/预签名 URL、对象配额和对象搬移）。既有 Node OSS 实现与历史验收记录仅作迁移过程证据，不构成 2.0 支持承诺；旧 OSS 数据迁移/导出路径仍需实现与验收，用户数据切换到 2.0 前必须完成数据盘点和去向确认。独立备份目标另行设计，SaaS 对象存储不在本决定范围内。

Agent 工具与技能正文的注册、配置和授权边界见 [Agent 工具与技能注册机制](Gugu-2.0-Agent工具与技能注册机制.md)；注册器存在不代表具体工具或 Host 已完成迁移。

## 执行顺序

1. **N0–N1：共享 Core 基线。** 已确定边界并完成项目/联系人数据切片；补齐性能预算和业务 schema/升级交接。
2. **N2：Node Web/NAS 后端。** 优先建立 Node HTTP Host，保持现有 API/SSE 契约，先迁移完整业务命令与 PostgreSQL 写路径。
3. **N3：扩展数据域与 Agent。** 按完整事务边界迁移会话、消息、任务、Provider、工具、RAG 等业务，逐步退役旧 Python 生产调用方。
4. **N4：桌面产品化。** 复用已稳定的 Core 业务能力，完成 Electron + 本地 SQLite、端侧能力和发行验收。桌面 UI 可提前做不依赖未稳定 Core 的准备，不提前切换业务写路径。
5. **N5：移除 Python 后端并发布 2.0。** 在 Node 独立部署中验收业务入口、后台任务和恢复，再移除旧后端、Worker、兼容包及其部署依赖。

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

**Admin Shell MXC 状态、启停（2026-11-17）**：`GET /api/v1/admin/sandbox/status`、`POST /api/v1/admin/sandbox/enable`、`POST /api/v1/admin/sandbox/disable` 已接 `main.ts → createApp → Admin guard → MXC diagnostics/运行配置`。状态投影 MXC、Shell 和代理专用 egress，不暴露旧 Docker/sandboxd 字段；启用前验证隔离与当前网络策略并原子写 `sandbox.enabled`，失败不产生配置副作用；启停后逐用户发布终端入口刷新，停用还会原子关闭 Agent Shell 授权，MXC Shell 周期复核权限并中止在途命令，页面停用使用统一确认框。Node 沙盒路由及终端动态撤权回归 12/12，Web Host production TypeScript build 与 Vite production build 通过。前端全量 typecheck 仍被工作区桌面 Vue 依赖缺失和既有 MindToolbar 类型错误阻断；配额运行策略、真实 Linux MXC/代理及部署验收仍待完成。Python 基线已对照源码，pytest 本轮未运行，未声称 Python 等价。

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

**Admin 后端边界调整（2026-11-19）**：自部署的管理业务、PostgreSQL/Redis 适配收敛于 `apps/web-host/src/modules/admin/`，由 Web Host 负责管理员认证、连接和生命周期；未来 SaaS 管理后端在独立仓库设计。既有全局查询和 Redis 键不提供租户隔离。历史共享包的测试记录只证明当时的自部署行为，不代表 SaaS 能力。

Admin 专属 API 为服务端能力，当前 Web 使用 PostgreSQL，未来 SaaS 使用自身服务端适配，不要求 SQLite 或桌面 IPC。仅当某条规则或数据能力被普通业务或桌面实际复用时，才按对应跨端契约验证。桌面埋点采集与上传不属于 Admin 查询：其本地离线队列可使用 SQLite，服务端接收和聚合另行实现。

**Admin 更新 API 范围（2026-11-18）**：Node Web Host 的 2.0 制品由 Compose/NAS 管理器更新整镜像；旧 Python `standalone_app_bundle` 更新器所需的持久化 `/app` 应用包切换运行时不在 Node 制品中。Node 只提供管理员可见的部署状态说明，并对旧 app-bundle 模式 fail-closed；前端在 `enabled=false` 时隐藏操作面板，`/check`、`/preflight`、`/start` 和 rollback 路由不注册。对应 API 迁移表记录为“2.0 不迁移”，不再作为待迁移项。Node 状态路由与真实 `createApp` Admin 鉴权回归 3/3；Docker 与真实部署未验收。

- [ ] 按架构说明将现有共享业务、用例和适用数据实现逐步按领域收敛到 `packages/core/src/` 对应模块；Web Host 的目标 `modules/` 保留 HTTP、平台适配和装配。同步迁移真实调用方、测试与包导出，移除确认无调用方的旧 Node 内部转发层。2.0 的 API、Agent 工具、后台任务和执行入口统一由 Node 承担；Python 只作为迁移资料，不保留 Python 运行、桥接、兼容或回退路径，完成 Node 切换与验收后删除 Python 后端。

- [x] 建立共享 Core、SQLite/PG 适配、事务和首批项目/联系人双库契约。
- [ ] **项目与联系人**：桌面已通过受限 IPC 接通项目列表/创建/重命名及联系人列表/创建/重命名/删除，真实 SQLite Worker 回归覆盖重启持久化；仍需补项目更新的正式 SQLite 覆盖，以及文件计数、引用、恢复和 Undo 等跨域路径，并核对联系人双库行为。
- [ ] **日历**：桌面已接通列表、创建、标题/日期编辑、软删除及 Undo/Redo，具名 IPC + Core Worker + 正式 SQLite 回归覆盖版本冲突、重启恢复和 RAG 队列；Web/Node 侧仍需完成 Agent 范围查询与提醒/后台消费链路验收。
- [ ] **Mind 与 Undo**：桌面便签列表、创建、更新、软删除及 Undo 已通过具名 IPC、真实 SQLite Worker 和重启回归；便签 Redo 尚未做同层持久化验证。桌面画布现已接通元数据 CRUD、画布便签列表/创建/正文编辑/从画布移除，以及画布条目位置更新；写入走受限 IPC、稳定操作收据、正式 SQLite 与共享 Mind Undo/Redo，Worker 回归覆盖版本冲突及重启后撤销/重做，工作台回归覆盖打开画布、创建/编辑正文和四向移动。当前 UI 仍是工作台列表与 Markdown 编辑表单，没有完整空间画布、拖放/缩放、引用放置或关系编辑；便签移除保留时间流内容。未集成原型不计为完成。
- [ ] **工作区**：已有声明管理及部分会话绑定用例进入 Core；补齐正式 SQLite 适配、Agent 工作区绑定、Local 权限和物理目录清理。
- [ ] **Local 文件**：明确授权根与相对路径身份，完成旧 ID 引用迁移、正式 SQLite 数据模型、文件授权、恢复和安全删除；回收站消费者须待删除安全边界与生命周期验收后接入。
- [ ] **Agent 会话与运行**：共享 Run/Harness、Chat 生命周期、调度 worker/supervisor、恢复校验、事件重放与交互恢复编排已归入 Core；Web Host 提供认证 owner、PG/Redis 持久端口、Provider/工具授权绑定、HTTP/SSE 投影和服务启停。剩余会话/Run 持久数据适配、队列事务、跨版本孤儿恢复协调及桌面 IPC 仍未完成，不能据此声明完整跨端或 Python 等价。
- [ ] **搜索**：在已有 Web PG 搜索和 SQLite 项目、联系人、活动来源基础上，补齐其他 SQLite 来源、兼容搜索语义及 Agent 工具调用。
- [ ] **定时任务与后台消费者**：在已有双库仓储和删除用例基础上，Runner 业务规则已迁入 Core，Host poller/PG/Redis lease 适配器改用共享契约；仍需接入生产 Host lifecycle、真实 Agent 任务执行与渠道投递，完成持久 fencing、启动恢复和关闭排空；RAG 等消费者分别验收。
- [ ] **工具与调用方**：让已有跨端工具复用 Core 用例及平台端口，接通实际注册和装配，并核对授权、确认、错误与提交后副作用。
- [ ] **公共化收尾**：逐项核对 PostgreSQL / 正式 SQLite、Web Host 及适用的桌面调用方，保留 Python 对照和必要回归；记录仍属于单端的能力及未覆盖边界，再继续新增 N2 功能迁移。

**桌面首批定向验收记录**：devserver Core 构建通过；`apps/desktop/tests/core-host.test.ts` 与 `preload.test.ts` 合计 30/30，覆盖项目/联系人、日历 Undo/Redo、便签/画布操作、外观偏好持久化和引导状态读取的真实 Core Worker/正式 SQLite 路径；`apps/web/tests/desktop/DesktopWorkbench.test.ts` 13/13，桌面与 Web 类型检查通过。Core 单测入口因当前工作区 `tests/suites.json` 与实际测试发现清单不一致而未能启动；该文件处于并行未提交修改中，本轮保持未改，也未跑全量测试。外观偏好和引导状态只读已由工作台调用；引导进度写入/重开与完整引导 UI 尚未接通。Windows/macOS 实际 Electron 窗口与打包制品验收、完整空间画布 UI、引用/关系编辑、文件授权根与旧库升级流程仍待处理。

**状态：进行中。** Node WebUI Host 和主要用户、项目、文件、日历、工作区、偏好、通知及部分 Admin/Agent 路由已接入。逐路由覆盖见[Node WebUI API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md)；历史测试与切片细节见[devlog 索引](../devlog/README.md)。旧版全量数量快照已过期，不作为当前完成率。

**Agent 本轮边界**：Agent 和 Mind 的 PostgreSQL 借用事务入口已共用连接互斥与事务控制检查，隔离 PG 合同 1/1、Agent Host 桥 2/2；调度监督器首次订阅失败时继续扫描并重试，定向回归 1/1。模型绑定在异步选择前固定运行身份并幂等释放，BYOK 定向 Node 5/5、Python 5/5。`main.ts` 现已装配可信 Web Provider binding、Chat/Reconstructor、Core dispatch worker/supervisor、PG/Redis 持久运行时及 RAG/Skills/MCP 资源，并由 Host 启动/关闭生命周期管理；Agent Chat 定向 Host/服务/重建器回归本轮 11 通过、1 个隔离 PG/Redis 用例跳过，另一个 runtime 合批 10 通过、3 个隔离 PG/Redis 用例跳过。真实 PG/Redis/Provider、Python pytest 和部署仍未验收；交互的 PG/Redis 重启恢复、媒体附件和完整 Python 行为仍有缺口。

**Agent Runtime Core 边界（2026-11-18）**：跨端业务编排位于 `packages/core/src/agent/`：`runtime.ts` 组合 Harness/Chat/dispatch 生命周期，`chat-service.ts` 管 start/resume/wake/cancel/retry 与事件投影，`run/dispatch-{worker,supervisor}.ts` 负责队列消费与恢复扫描，`run/reconstruct.ts` 校验来源、消息锚点、checkpoint、授权版本和 Provider 作用域，`run/event-stream.ts` 负责有序持久事件重放；通用交互消费与恢复位于 `interactions/`。`apps/web-host/src/domains/agent-sessions/` 只装配 Web 认证身份、PG/Redis、可信 Provider/工具资源、HTTP/SSE 和进程生命周期；数据库读写、租约、订阅及外部凭据通过显式 Host 端口提供。该边界不把 Core 合同或合成端口当成生产验收。新增 Core Chat service 行为测试覆盖启动投影、idle resume、owner 拒绝和取消租约；`portable-boundary.test.ts` 将六个 Runtime 模块作为依赖闭包入口，约束共用编排留在 Core 且不加载 Host/平台驱动。devserver 标准 Core unit 配置下 Run、Interaction、Provider Runtime 与可移植边界 8 个文件 **77/77 通过**。生产 Web Chat/Run 和 HTTP Interaction Respond/Resume 已接入 dispatch 生命周期；隔离 PG/Redis 重启恢复、真实 Provider、Python pytest、桌面持久端口和部署仍未验收。完整媒体物化、历史语义与 Python 行为仍有明确缺口。

管理员 Agent 用量查询已接入生产 Host 的 Admin 鉴权和 PostgreSQL；隔离 PG/Host 测试 5/5、Python 用量对照 5/5、Host 类型检查通过，真实部署尚未验收。

Agent 历史图片的 owner/session 限定两阶段读取已由 Core PostgreSQL 端口提供，并接入 Web 历史读取器；第二次读取在数据库内复核 8 MiB 总预算，旧数据中非对象项按 Python 行为保留。隔离 PG Core 合同与 Host 读取器→Harness 回放各 1/1、Harness 历史回归 58/58、Python 历史对照 12/12。当前 `main.ts` 已把 Web Reconstructor 接入生产 Chat 生命周期；生产媒体上传/回放调用方仍未接齐，其他数据库方言和真实部署未验收。

Knowledge overview 已有要求迁移标记存在的 Core 只读子集，合成存储回归 2/2；真实存储、Host 和旧文档自动迁移尚未接入。Python 知识对照全量为 43 通过、1 失败：失败项需要本环境尚未构建的 Cython RAG 内核；排除该项后 43 通过、1 未选，不表示 RAG 已迁移。

个人记忆已有明确限定为规范小规模数据的 Core 读取规则，合成存储 Node 4/4、Python 记忆存储对照 19/19；真实存储和 Host 未接入，legacy 写回、超预算 embedding 与 Python 容错尚未实现，不能作为完整记忆服务。

RAG Host Worker 在生产 `main.ts` 启动前检查正式索引迁移，仅 `applied` 时启动，并于关闭时停止/等待。Node Host 独立生产和消费持久索引，不保留 Python bridge、fallback 或双引擎运行选择。首次 Worker 调用幂等地为无索引、无任务的 owner/source 建全量基线，不覆盖现存增量任务。生产来源集合包括 project、calendar、note、canvas、scheduled_task、conversation、knowledge 和 memory；knowledge 使用 owner-bound FS reader，memory 使用 `config.storageLocalPath` 与 SQL scope revision/tombstone reader。Mind、conversation、scheduled_task 与 knowledge 的已发现 Node 写入事务会排入持久任务；knowledge freshness 更新先撤回旧索引并围栏在途 Worker，再原子写主数据并排队。Node 私聊记忆反思已接入生产模型提取、持久发布和后台调度。Host 锁定 `@node-rs/jieba@2.0.1` 并使用包内词典。`search_conversations`、`search_memory`、查询期向量召回和 prompt memory snapshot 已由可信 Web Run resource factory 装入同一个 lease-bound ToolRegistry/Context Builder。**2026-11-19 当前验收**：`main.ts → Agent Chat/Run lifecycle → dispatch lease → Reconstructor → 持久 RAG Worker/索引读取 → ToolRegistry → search_conversations` 已接通；Core RAG 70/70。Host RAG/Run **51 通过、5 跳过**，使用临时 PostgreSQL cluster/schema、Redis、临时 owner 文件目录和本机合成 Provider；生产 HTTP/SSE 主链 1/1 通过，验证八类来源写入 PostgreSQL 正式索引、两 owner 隔离及工具续轮命中。Web Host production build 通过。跳过项包含 Linux 专用安全写入场景；临时依赖与合成 Provider 不代表生产部署或真实外部服务验收。旧条目中的“main.ts 无 caller”是迁移过程快照，不再代表当前状态。

2026-11-17 Web RAG owner 边界回归：生产 RAG 端口工厂将 `search_conversations` 的近期列表、检索与命中归属解析固定到 dispatch lease 的 owner；独立 Host 端口行为测试在 devserver **1/1 通过**，覆盖跨 owner 调用拒绝、取消优先传播和同 owner 大小写归一委托。测试使用合成端口，不访问数据库；它补强可复用 Host 边界，但不代表生产 `agentChat`/Run 装配完成，也不改变 Python Worker 默认消费的状态。

当前生产 Agent Run 由 `main.ts` 装配 `createWebAgentRunLifecycle`、`createWebAgentReconstructor` 与 `createApp({ agentChat })`，并在监听成功后启动 supervisor；真实资源来自认证 owner、事务内 `accessVersion`、可信 Provider binding、PG/Redis dispatch lease、上下文/RAG、Skills/MCP 与实际 ToolRegistry。Node Host 服务/重建器行为已定向回归，但隔离 PG/Redis 用例因未配置服务而跳过，Python pytest、真实 Provider、部署和 Node RAG 唯一 Worker 切换未验收。仍未装配的是 Agent Interaction Respond/Resume Worker；生产交互激活端口明确拒绝，图片/音频/视频/Office 当前消息物化及完整历史语义也未完成。不得把上述部分 Run 接线表述为完整 Agent Python 等价。

2026-11-17 Reconstructor 压缩授权时序修正：Provider 绑定发生在 `Harness.start` 获取 dispatch lease 前，故压缩工具 schema 与配置授权改为延迟到真实压缩时读取。Node 资源工厂回归 **1/1 通过**，Web Host production `tsconfig.build.json --noEmit` 通过；测试使用合成 Pool/lease/Provider 与临时 SQLite/FS。随后 `main.ts` 已完成 Web Agent Run 生产入口装配；真实 PG/Redis/Provider 与部署仍未验收。

2026-11-17 Agent 文本交互恢复增量：新增 Core `consumeInteractionText`，按 Python `consume_text` 处理 owner、过期状态先提交、自定义回答激活、密钥专用路由和 2000 字符边界；Host PostgreSQL adapter 在同一事务更新 prompt 并写入持久 Run 恢复队列，Fastify 新增 `/resume` 与 `/resume-text` 行为及错误映射。Core 用例先因模块不存在失败后 3/3 通过；Host 路由先因新路径 404 失败后定向回归 2/2 通过；Core build 与 Host production TypeScript 检查通过。Python 源码及 `backend/tests/agent/test_interaction_protocol.py` 已对照，但 devserver 无 pytest；两个隔离 PostgreSQL Host 测试因未提供隔离库跳过。Chat/Run lifecycle 现已进入生产组合，但 Interaction Respond/Resume 与恢复 Worker 仍未由 `main.ts` 装配，暂未接入生产调用链；正式 PG/SQLite 与真实恢复部署未验收。

共享队列消费者互斥回归（2026-11-16）：新增 Python 事件总线合同，分别验证 `python` 配置会继续触发本地 Worker，`node` 配置会持久化 knowledge job、跳过 Python Worker 且不留进程内 pending 副本；配置读取失败时 Python 消费者 fail closed。devserver 对应 Python 文件 **12/12 通过**；Node 持久 RAG Worker/全来源集合/正式索引表 SQLite 回归 **8/8 通过**。两组分别验证生产者开关与 Node 消费逻辑，没有连接真实 PostgreSQL，因此不等于部署切换或跨语言 PG 实验。

2026-11-16 Web Run 工具接线：`createWebAgentToolPorts` 现让持久 Web 重建器从同一 Host registry 发现已授权、配置允许的工具 schema，并将同一 registry `ToolPort` 交给 Harness；owner/session/run 从 dispatch lease 固定，执行时继续重新授权。临时 SQLite 的 `search_conversations` 实际注册器调用及撤权回归 **2/2 通过**。生产 `main.ts` 仍无 `agentChat`/`createWebAgentReconstructor` caller，因此该组件接线未计作生产 Agent Run 完成。

2026-11-17 Web Run ToolPort 身份边界：`createWebAgentToolPorts` 现于 `plan`、`dispatch`、`reconcile` 各自校验完整 dispatch lease owner/session/run；不匹配时分别拒绝计划、在 registry 调用前返回失败、或报告恢复状态未知，取消仍先传播。devserver 新增实际 ToolPort 边界回归 **1/1 通过**，使用合成 registry/lease。该防护不改变生产接入状态：`main.ts` 尚无 Agent Run caller，未连接生产 PG、Redis 或 Provider。

2026-11-17 `search_conversations` Runner 当前树复验：在源码、用例、Core dist 和 Node runner 哈希与 devserver 一致后，`conversation-tools-runtime-sqlite.test.ts` **4/4 通过**，覆盖实际 Host 工具注册器、owner 事实表 + Jieba/BM25，以及 Core Runner 将检索结果送入 Provider 续轮。测试用临时 SQLite 和合成 Provider；此结果不代表生产 `main.ts` 已装配 Agent Run，也未连接真实 PG/Redis。

同日 Python 行为基准复验：Cython rank/tokenizer、Python/TS tokenizer parity、固定相关性语料和 query embedding **69/69 通过**。测试前确认实现、用例和 golden 语料哈希与 devserver 相同；隔离 pytest venv，Cython 编译和 pytest 缓存位于临时目录，embedding 只用模拟与合成 HTTP。覆盖旧排序/阈值、分词一致、固定语料 Recall/MRR 和 embedding URL/重定向/错误脱敏边界；未连接真实 DB、Redis 或 Provider。此结果是 Python 行为基准，不改变生产 Run 尚未装配的状态。

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

**回收站后台边界**：Node 清空回收站接口目前只写入持久任务，生产消费者仍是 Python worker，单独运行 Node 会停留在排队。永久删除文件和文件夹已改为提交前暂存 Local 文件、PG 回滚后逆序恢复、提交后清理暂存；devserver 补偿行为回归 6/6 通过（另 1 个隔离 PG 用例跳过），Host TypeScript noEmit 检查通过。Node 仍保留 Python 的物理删除失败清墓碑语义；暂存缺少崩溃恢复日志且目录组件替换竞态未消除，不能视为安全删除完成或装配 destructive 消费者。生产 purge 消费者仍是 Python worker，单独运行 Node 会停留在排队；逐项恢复、生产生命周期和真实文件删除尚未验收，独立进度事务不保证文件删除原子性。

**Local 跨端身份边界**：Web 兼容期文件和目录操作依赖 PostgreSQL 旧对象 ID；正式 SQLite 当前没有文件及目录模型，项目文件计数和文件引用因此不能按已接通计算。桌面目标以授权根与相对路径为身份，旧 ID 的引用迁移、恢复和授权边界仍待设计及验收；不得通过测试专用简化表冒充完整支持。

**定时任务边界**：一次性任务 Core SQLite/PG 仓储已通过隔离合同测试，Runner 规则现已迁入 Core，Host poller、PG 仓储和 Redis lease 适配器已改用共享 Core 契约；但 poller 尚未接入 Host 生命周期，真实 Agent 任务执行/渠道投递未实现；启动恢复、Redis 租约、关闭排空及 SQLite 跨进程租约均未验收。重复触发收据表不代表消费者已经运行。现有 Python 执行者在 Redis 租约续期失败后仍可继续执行，维护者重新获得锁并不能证明旧执行已停止；Node 列表读取的自动删除和判死已暂时停用，到期或疑似崩溃任务会保留供用户查看。隔离 PG/临时真实 Redis 的失租执行及持锁未提交启动等回归与相关 Node 测试 7/7、Python 基线 4/4。Python 自身列表清理和 worker reconcile 仍存在同类竞态，状态维护循环未接入 Node；需先统一执行、恢复与清理的持久 fencing/事务协议或完成明确的单执行者切换。

用户显式删除定时任务已接入 Core 双库仓储和生产 Host；正式 SQLite/隔离 PG 合同 1/1、Host/Vite/隔离 PG 与 Host 单测 2/2、Python 直接对照 1/1 和邻近规则 30/30。删除只移除记录，不保证停止已在途执行或副作用；真实部署与事件广播未验收。

Host 定时任务目录已由 `domains` 迁至 `modules/scheduled-tasks`，真实调用方和测试已更新，旧 Host 删除工厂及重复 SQL 已移除。隔离 PG/临时 Redis 的定向和生产 Host 集成 42/42，Host 类型检查通过；目录调整不改变上述消费者与执行安全边界。

定时任务 Web 列表已直接使用 Core 双库只读 reader，Agent 和 Web 分别投影、不恢复读时清理；正式 SQLite/隔离 PG 合同 2/2，生产 Host/Vite 与真实 PG/Redis 失租、启动中保护 3/3，Python 规则/工作区对照 40/40。SQLite 的工作区和文件授权引用仍受 schema 限制；真实授权、生产 Agent Run 和调度消费者未验收。

2026-11-16 N2 聊天附件生命周期：`POST /api/v1/agent/upload` 已按 Python 流式暂存接入 Core 规则、认证 Host、PG 容量事务和 Local 存储；`DELETE /api/v1/agent/attachment/{attach_id}` 接入草稿状态守卫、owner 行锁、共享 storage_key 锁和引用清理；`DELETE /api/v1/agent/attachments` 接入批量草稿事务、去重引用清理和可选 Redis 旧记录扫描。Core 暂存/删除/批清 9/9、Host 生命周期与隔离 RESP 适配 13/13、Core/Web Host build 通过。devserver 缺 pytest，Python 实跑未完成；Pool 是合成替身，隔离 RESP server 不等同真实 Redis，真实 PG/Redis 未验收，正式 SQLite 附件 schema 未接；Node 未接入 `pilk`，动态 Provider 音频原生格式与真实部署未验收。详见 Node WebUI API 清单。

**主要缺口**：Agent 聊天生成与 SSE/取消、Mind 画布剩余跨端引用及撤销执行器、Worker/调度调用方、剩余 Admin/集成 API、真实服务集成和全量调用方切换。Node 已写入队列的 RAG job 仍由 Python Worker 消费。Linux/NAS 2.0 只支持 Local 文件存储；旧 OSS 数据迁移需在切换前另行验收。FileSync 的 watcher/DB 对账及 folder-doctor 管理能力按本架构说明退役，不纳入待迁移或 Core 公共化工作量。

**可独立分派的共享 Core 收尾**：Mind 画布剩余跨端引用与撤销执行器 SQLite 适配。先逐项核对 `backend/app/api/v1/mind.py` 对应旧 Python 行为和当前 `packages/core`/Host 实现，只补未共享的完整用例、事务/Undo 规则及 SQLite 适配；认证、Redis 广播、HTTP DTO 和物理 FS 留在 Host。不得重做已完成的画布创建/更新/删除，也不得触碰 Agent/RAG、Projects/Files、Admin 或 FileSync。提供定向回归和明确的未验证项。

**退出条件**：Web 必需 HTTP/SSE 与后台调用方在 Node 上行为等价；关键 PostgreSQL、Redis、文件系统路径完成隔离验收；默认 Web 流量切至 Node 后，再清理 Python Web 后端。Python API 不作为隐式回退。

- [ ] 盘点并迁移 Web 必需 API、Agent 工具、Worker/调度、撤销及其他写入口。
- [ ] 保持 HTTP/SSE、认证身份、错误/字段映射、事务和提交后副作用兼容。
- [ ] 完成真实 PG/Redis/文件系统的隔离、并发和故障路径验收。
- [ ] 所有调用方切换并验收后，移除对应 Python Web 写实现。

### N3——扩展数据域与 Agent 迁移

**RAG 目标**：复用 Gugu 1.7.7 TypeScript RAG 作为 Node/Core 唯一生产检索路径，不迁移 Cython 算法到 TS，也不保留双引擎线上选择。迁移时以当前 Python/Cython 行为回归和固定质量语料为基准，接入 Node/Core 授权来源读取、派生索引存储/重建及 ACL 过滤；具体验收见依赖迁移矩阵。RAG 来源文件正文按架构说明从授权 FS 直读，DB 不保存文件正文副本。

**当前 RAG 接入证据**：Core schema 17 已定义 SQLite/PostgreSQL `knowledge_index_entries` DDL，SQLite v1-v16 通过显式备份迁移升级新增该派生表；Web Host 通过 `migrate:rag-index:check/apply` 在标准 PostgreSQL 连接上显式创建 Node 派生索引，拒绝未登记的索引表。生产库待验收。启动入口只在迁移返回 `applied` 后运行 Node 来源重建 Worker；knowledge 使用 `@gugu/fs/node` owner-bound reader。2.0 由 Node Host 独立生产和消费持久队列；旧版业务数据导入后，可用 Node 基线命令安排来源重建。真实生产切换待验收。正式 Jieba `@node-rs/jieba@2.0.1` 已加入 Host 并装配包内词典；Host 会话工具测试以真实 Jieba 经注册器执行。`v1.7.7` 查询期 memory loader、scope revision/tombstone reader 和持久重建来源已迁入 Core；Web Host 在迁移通过后已将 owner-bound FS root 注入重建 Worker，memory 文件可以参与基线/重建。Core `invalidateAgentMemoryRag` 先事务性墓碑化索引并推进 settled generation/fence 旧租约，再允许 Host 删除 owner `.agent`，成功后再入队重建；生产 `main.ts` 已装配该必需端口。Host 隔离 SQLite/FS 回归验证 FS 删除失败时的旧索引隐藏和在途 Worker fencing。Node knowledge 写入工具和 freshness producer 已实现，`main.ts` 现将 owner-bound 写端注入 lease-bound Run registry；已有 Host 写入→Worker→索引回归 **20/20**，新增 Agent Run registry 写入测试在 macOS 返回 `unknown`，经源码确认其写入端依赖 `@gugu/fs/node` 的 Linux 目录句柄 `writeLocalFile`，因此该用例须在 Linux/devserver 同步一致后验收。普通 memory 文件更新 producer 仍缺。`createPostgresAgentImMemoryContextReader` 按 owner/session/active-run 绑定当前入站消息和 Bot 绑定，`createPostgresAgentMemorySearchPort` 组合可信上下文、cursor scope 与 Core memory RAG；生产 Run 已装配 `search_memory` 与 `search_conversations`，后者按 Python owner 限定事实表 BM25 路径。Host 行为回归使用合成 SQLite/FS/lease/Pool，不等于真实 PostgreSQL、Redis、外部 embedding 或 Worker 唯一消费者部署验收；file 自动索引按 2.0 决策退役。

**Python/Cython 对照边界**：Python tokenizer 使用 `rjieba`，Node Host 使用 `@node-rs/jieba@2.0.1`，二者均传 `HMM=false` 并保留 ASCII token、字母数字与空格压缩和月份别名规则；绑定不同，因此 golden 用例不证明全部 OOV/Unicode 输入逐 token 等价。固定检索语料当前覆盖 5 个有效词法 query（含纯英文查询），两侧 Recall@3=1、MRR=1，无关结果为空且跨 scope 干扰被过滤；这不代表全库排序或向量质量等价。`search_conversations` 保持 owner 事实表 BM25，`read_knowledge` 固定 BM25，memory 才走可选 hybrid/vector。完整差异与 Worker 执行归属见 [RAG 行为对照记录](../testing/node-agent-tools-parity.md#177-与-pythoncython-的对照范围及已知差异2026-11-16)。

- [ ] 会话/消息/附件引用、Canonical 历史与顺序规则。
- [ ] 待发消息队列按架构说明收敛为 Core 共用规则与存储/通知契约；Web 接入 PostgreSQL 和所需跨进程事件，桌面接入 SQLite、本地 Run 生命周期和 IPC 通知，不依赖 Redis。以现有 Python 队列与 pytest 为行为基线，分别验收消息顺序、认领冲突、停止后排队消息、通知丢失重读、重启恢复和发送结果未知时防重复；当前 Web PostgreSQL 部分实现不等于桌面或共享队列已完成。Steer 和跨设备同步另行设计。
- [ ] Run/Job、确认授权、租约、持久调度、outbox 和重启恢复。
  - Core 承载 Chat 启动、恢复与取消，以及 dispatch worker/supervisor、Run 重建、outbox 事件重放、交互动作消费及恢复、上下文组装。Web Host 装配 PostgreSQL/Redis、可信身份、配置、Provider 与进程生命周期。PostgreSQL claim 仅在 `waiting` 有可信交互收据或持久取消请求时选中运行。恢复时 Harness 继续核对 pending interaction 绑定。各危险工具仍按各自持久确认、事务和平台能力单独验收。
- [x] 按 Python 原职责将原 Harness 实现归入 `agent/runner.ts`、`core.ts`、`context/`、`run/`、`interactions/` 和 `memory/`，保留独立 `providers/`、`tools/`；调用共用 Executor，删除旧目录与旧包导出，调用方及测试同步归位。该结构调整不代表工具迁移或平台后端验收完成。
- [x] 将静态系统提示、动态上下文快照、记忆/项目/渠道格式及日期/时间提醒等纯 Agent 业务格式收敛到 `packages/core/src/agent/context/prompt-format.ts`；Web Host 只保留 owner 数据读取和可信策略注入，desktop/子 Agent 可复用 Core 导出。Core 行为测试 5/5、Web Host 消费回归 7 通过/1 跳过，Core typecheck 与 Host production noEmit 检查通过；跳过项需隔离 PG；未据此声称 Web Agent Run 已接通。
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

Web 主链补验覆盖 Node Host 正式启动、认证聊天、持久调度、模型协议、工具续轮与 SSE。自动 RAG 与正式索引迁移共用启动就绪状态，索引待迁移时普通聊天仍可建立。Core 将本轮实际生成的请求前缀绑定到同一 Run 的 Provider，省去首次请求误走恢复端口。Web Provider 的连接策略取当前 Host 的环境配置，BYOK 禁止访问本机网络。重建器从原 Run 加密 checkpoint 中固定的会话快照重建前缀，核对账号、会话、Run、模型、访问范围和原请求摘要后才允许续轮。缺少摘要或前缀已变化时进入版本冲突。隔离环境已验证独立 Node Host 在工具提交后被强制退出，第二个 Host 从同一 Run 的持久前缀续轮并由 HTTP/SSE 返回终态。测试将已退出进程的合成租约推进到过期边界。Node 从空 schema 初始化十张 Agent 基础表和九张运行表，覆盖账号与偏好、会话、消息、批次、待发送队列、提示、用量、附件元数据、RAG 重建任务，以及调度、检查点及交互恢复。会话复合外键约束提示、用量、队列与运行归属。`migrate:web-domain:apply` 从同一 Node schema 创建 Web 就绪检查和八类 RAG 来源所需的业务表。首次注册会在账号事务内建立默认工作区与基础文件配额，并由后续引导事务创建示例内容、记账及排入项目和日历索引重建。整站可选功能的持久表、旧版数据显式导入及生产部署仍需验收。

当前 Node Web Host 在正式索引迁移应用后独立调度 TypeScript RAG。旧条目中的跨运行时 Worker 选主及 Python 代理是历史记录。主站终端及独立 Admin 开发入口统一代理到 Node Web Host，旧版进程退出后再启动 2.0 服务，旧数据经显式升级或导入进入 Node。

- [ ] 当前 N2 继续在 `apps/web/` 维护 Linux/NAS Admin 独立入口；桌面和移动端不提供 Admin 页面，分别使用端侧设置与状态界面。未来 SaaS 控制台开始实施且功能、权限、发布及仓库边界明确后，再评估提取 `apps/admin/` 或独立私有控制台；该拆分不是当前 N2 或桌面可运行版本的前置条件。复用界面须以各 Host 的管理员认证和服务端授权为前提。
- [ ] 补齐 `packages/fs/` 的授权根授予/撤销、目录枚举、受控写入、原子替换与恢复能力，并建立独立 `packages/sandbox/`、迁移 Web Host 文件能力及 Core Executor 的可复用部分；Host 负责可信身份、授权根目录、执行后端与能力注入。当前 FS 包只有读取及暂存/恢复原语，尚无桌面调用方，不能记为端侧 FS 完成。
- [ ] 完成 FS 授权边界、直接读写、原子写入与恢复验收；Linux MXC 须完成多用户、进程、资源和网络隔离验收后才能启用。

- [ ] 按架构说明将 Vue 前端、Node Web Host、Electron Host 和共享 Core 迁入 `apps/web/`、`apps/web-host/`、`apps/desktop/`、`packages/core/`；目录搬迁与业务重写分开，更新 workspace、构建/部署、CI、测试清单和文档路径。
- [ ] N2/N3 将仍需提供的 API、Agent 与 Worker 接入 Node；在仅 Node 部署中验证业务、副作用、重启恢复和旧版数据导入，再删除 `backend/`。
- [ ] 将独立子项目 `loopscope/` 保持为自己的 workspace，不为了顶层目录形式统一而重排其内部包。
- [ ] 移除 `compat/` 后端兼容包以及 2.0 构建、部署和验收中的旧后端依赖；保留可独立执行的 Node 行为回归。
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

生产 RAG 已由 `main.ts` 装配 Web Agent Run 对 `createAgentToolRegistry` 的调用者，包含 `search_conversations`、`search_memory` 与 owner knowledge 读写端口；Worker 仍受迁移门控和 `AGENT__RAG_INDEX_WORKER_OWNER` 唯一消费者配置控制。已发现的 project、calendar、Mind、conversation、scheduled_task 更新入口会写持久任务；普通 memory 文件更新 producer 仍缺。Node-only 消费切换尚未验收；正式 PostgreSQL migration 已通过隔离 PostgreSQL **3/3**，但未应用/验收生产数据库。真实 PG/Redis/embedding、Agent Run 写入在 Linux 文件系统上的生产验证仍缺。详见 [RAG 模块说明](../../packages/core/src/agent/rag/README.md) 与[工具行为迁移清单](../testing/node-agent-tools-parity.md#conversation-写入到-rag-队列的事务闭环2026-11-16)。

2026-11-17 可信模型恢复边界组件已实现：配置快照、凭据版本和权限身份共同参与 checkpoint 恢复校验；临时文件/合成 Pool 回归 **1/1**，Core RAG **66/66**，Host RAG/registry **25/25**。它尚未由 `main.ts` 的生产 Run 使用；缺的仍是生产有效配置解析器、完整上下文/执行/聊天准备及 dispatch/reconstructor 组合，故生产 Agent RAG 继续标记为待接入。真实 PostgreSQL、Redis、外部 Provider、Python pytest 本轮均未验收；测试证据见[工具行为清单](../testing/node-agent-tools-parity.md#provider-snapshot-binding-增量2026-11-17)。

2026-11-16 继续补齐 scheduled_task 写入面：Core 日历提醒改期/禁用、日历 Undo/redo、一次性任务完成删除和工作区解绑将索引任务放入主数据事务，共用 `scheduled-tasks/rag-index-job.ts`。Host task producer 同时保留初始及先前待重建 source ID。devserver 隔离 SQLite 有效子集 **4 个文件、17 项通过、2 项 PG 子测试跳过、0 项失败**；另一次误将 PG-only 文件纳入命令时因缺少 `GUGU_CORE_TEST_POSTGRES_URL` 在套件加载阶段失败，不计入通过数。Host PG 回归因缺少隔离库未运行，Python pytest 因无项目 `.venv/bin/pytest` 未运行，本轮未重跑 typecheck/build；Mutagen 3 处生成目录冲突未 flush、未覆盖。knowledge 和 memory Node 写入生产者仍缺失。

2026-11-16 补齐 Python `test_cython_rank.py` 中 Core 尚缺的排序选择契约：top-k、历史正文排除、重复引用、输出预算、精确置信阈值、低分回退及 diversity caps。devserver Core ranking 定向用例 **15/15 通过**，使用确定性 tokenizer；Python pytest 当前不可运行，本次不记实时跨语言差分，也不代表完整检索语料质量验收。详见[工具行为清单](../testing/node-agent-tools-parity.md#python-rag-rank-回归补齐到-core2026-11-16)。


链接按钮新增安全校验及可信投递端口原型；实际平台投递、持久恢复及Host装配未完成，仍记依赖阻塞。Node专项1项、Python基准49项通过，详见工具行为清单。

2026-11-16 RAG 本地追加复验：Core RAG/search/ranking **47/47**；Host direct-source 与持久索引工具分派、Runner 续轮、持久 Worker/基线及正式 Jieba **14 通过、2 个 PG 用例跳过、0 失败**。Python pytest 未执行（本机缺少 pytest 模块）。Node 回归使用临时 SQLite/FS 和合成 Provider/授权；不得据此认定生产 Agent Run、PostgreSQL 索引迁移或 Node-only 队列消费者已验收。剩余生产工作包括：主入口装配 `createAgentToolRegistry` 和 conversation/memory 可信端口、传入 memory storage root、补 Node knowledge/memory 写入触发器、确认并切换 Python/Cython 与 Node 队列消费者归属，以及隔离 PostgreSQL 与 Python 基准回归。

2026-11-16 补齐 1.7.7 原 `index-cache-service`、`snapshot-cache`、`rag-service` 生命周期回归：Core 新增 cache/service 真实调用契约 **6/6**，保护滑动 TTL、revision invalidation、scope隔离、失败重建和错误显式传播。devserver Core RAG/search/ranking **8 个文件 53/53**；Host search/Runner/Worker/Jieba **14 通过、2 项隔离 PG 测试跳过**；Core 与 Web Host build 通过，新增测试严格单文件 TypeScript 检查通过。Python pytest 环境缺失。v1.7.7 算法模块均有 Core 职责映射；当前生产未完成项是 Agent Run registry、生产 scope/embedding 装配、knowledge/memory Node 写入 producer、PostgreSQL migration 与 Python/Cython/Node consumer ownership。固定合成语料已完成所覆盖查询的跨版本对照；真实 PostgreSQL 和生产调用链仍未验收。详见 [RAG 工具行为回归](../testing/node-agent-tools-parity.md#177-rag-生命周期缓存服务回归补齐2026-11-16)。

2026-11-16 补齐统一检索的向量回归：`createScopedRagSearch` 在 embedding transport 错误时按 Python 行为退回 owner scope BM25，取消信号继续传播；同时验证版本匹配的向量文件通过实际 scoped search 参与 hybrid 重排。devserver RAG 定向合集 **9 个文件、56/56**；Core `typecheck` 与 build 通过。Host `search_conversations` 经真实 conversation adapter、持久 TS RAG、正式 Jieba、Core 注册器和 AgentRuntime Runner **4/4**。Core RAG 套件临时绕过测试发现配置，因为并行工作区新增的 `tests/scheduled-tasks/test-notify.test.ts` 尚未登记 `packages/core/tests/suites.json`；未修改该共享清单项。隔离 PG、Python pytest、生产 Run 装配和真实 embedding 服务仍未验收。详见[工具行为清单](../testing/node-agent-tools-parity.md)。

2026-11-16 devserver 补验与生产入口增量：Node Web Host 在 RAG migration `applied` 时将 `config.storageLocalPath` 同时注入 knowledge 与 memory 的 owner-bound reader；这启用生产 memory 重建来源，但不补 memory 更新 producer。旧版 RAG pytest **279/279**、search 工具/schema pytest **37/37**；Core RAG Node **56/56**；Host RAG/会话 **17 通过、6 个 PG 用例跳过、0 失败**；Host production build 通过。Python RAG 只使用临时 venv，Cython 扩展编译到测试临时目录。PG 测试因隔离库未配置跳过；真实 Provider/Redis未调用。仍未生产接通 Agent Run 注册器、可信 IM memory 查询授权/embedding、knowledge/memory Node freshness producer、Node-only 队列消费归属和 PostgreSQL migration。标准 Core Vitest suite 清单存在并行新测试未登记，本次用临时 RAG-only config 运行且未改对方文件。

2026-11-16 当前 Core RAG 复验：在 devserver 用 Vitest 标准配置显式选取 Core RAG 与 Mind RAG freshness 测试，**10 个文件、62/62 通过**（Core RAG 9 文件 57/57，Mind freshness 1 文件 5/5）。该结果复验 scope/owner、分词、向量降级、排序、缓存生命周期和 Mind freshness；不覆盖真实 PostgreSQL、外部 embedding、生产 Agent Run 或全量 Vitest suite。

2026-11-16 共享检索质量验收：新增旧版 Cython 与 Node Core 共用的中文/英文/混合查询语料。正式 Jieba 下，两个检索器的四个有效查询均 Recall@3=1、MRR=1；无关查询为空，与 owner 查询词完全相同的 group-scope 干扰文档均被过滤；Python pytest 与 Node Host 行为用例各 **1/1** 通过。该项关闭跨版本词法质量语料缺口；真实向量 Provider、隔离 PG、生产 Agent Run/授权装配、knowledge/memory freshness producer 和 Node-only 队列切换仍未验收。

2026-11-16 共享语料英文查询补齐：在同一固定语料加入纯英文部署窗口文档与 query，Node Host 正式 Jieba/Core lexical 用例 **1/1**、旧 Cython pytest **1/1** 通过；Python 在 devserver 的 `/tmp` 临时 venv 运行，Cython build dir 由 pytest 临时目录提供，设置了 `/tmp` 配置路径，未读取运行配置或用户数据。当前五个有效词法 query 均 Recall@3=1、MRR=1；旧记录中的“四个”是新增英文例之前的结果。该用例检查英文 token 检索并保留 owner/scope 与空结果用例；不扩展为全库或向量质量等价结论。

2026-11-16 索引损坏错误边界：Host 临时 SQLite 经 Core 持久读取器读取非法 `metadata_json`，固定返回脱敏错误；排入的 RAG job 经 Core rebuild worker 重写来源投影、状态到达 `ready`，snapshot 恢复可读，定向 Node 测试 **1/1** 通过。损坏行不会被伪装为空召回；本项不代替 PostgreSQL 验收或 Worker 生产故障恢复验收。

2026-11-16 memory 向量键兼容：scope 隔离后的持久 memory parent ID 带命名空间，Core 现用来源元数据中的原始 `memory_parent_id` 查询 1.7.7 `memory_vec.json`，再按持久文档 ID 返回向量。devserver 临时副本的 scoped hybrid 行为回归 **4/4**，用例经实际 Core `createMemoryRagSource` 投影；严格 TypeScript 检查通过。真实 PostgreSQL、生产 embedding 和 Agent Run 注入仍未验收。

### 注意力评分沙盒 API（2026-11-16）

`POST /api/v1/dev/attention/score` 已接 Web Host 认证与严格 DTO，并调用 Core 完整 `attention-v3.0.7` 决策器及安全诊断投影；不回显输入正文。TDD 先因 scorer 模块缺失失败；追加 Python 边界场景后，未闭合且无换行代码围栏回归先红，按旧算法的保守截断修复后通过。devserver Core attention 套件 **5 文件 23/23**、Host 认证/DTO/真实 Core scorer **2/2**；另有六组 Python 纯算法与 Node Core 逐字段对照。Python 全部算法断言经直接 harness 运行而非 pytest，FastAPI handler 全用例未对照，故不声称完整 Python 等价。Core/Web Host build 在前序 attention 实现阶段通过；真实部署未验收。

2026-11-16 Skills/MCP 目录生产接线：`GET /api/v1/skills` 默认工具目录与 `GET /api/v1/skills/tools` 已接 Node builtin catalog、Core owner 快照/配置摘要、Host MCP owner 配置与密文解包、固定目标 HTTP SDK discovery；停用时不外连，按旧行为保留健康服务部分结果，失败不提交不完整快照。Node Skills/MCP 合批 **37 通过、6 跳过**，Core/Web Host build 通过；Python pytest 环境不可用，隔离 PG 快照测试跳过，真实 MCP/部署未验收。MCP tools/load_status/reconnect 仍等待 Node Agent MCP runtime 状态与调用消费者；不以 Skills schema 快照冒充运行时加载或工具执行。

2026-11-16 MCP 管理 runtime 生产接线：Host `GET /api/v1/mcp/servers/{server_id}/tools`、`POST .../load_status`、`POST .../reconnect` 已接认证 owner、Core 配置读取及受控 HTTP MCP SDK，加载状态进入设置列表；配置更新/删除关闭并失效连接。runtime/route TDD 用例先因模块缺失失败，重试回归也先红后绿；新增完整 `createApp` 用户认证入口验证。Skills/MCP 定向合集 **39 项：35 通过、4 个隔离 PostgreSQL/Python 用例跳过、0 失败**；Web Host production build、Skills Core SQLite 合同 1/1 通过。Python 旧 handler 与 load_status 回归源码已对照，devserver `python3` 缺 pytest。stdio、Agent Run 实际 MCP 工具执行消费者、真实 PG/SQLite 部署、外部 MCP 服务未验收。

2026-11-16 新增 `read_knowledge` Core 工具组与 Web Host 持久索引适配：ID 精确读取通过 owner-bound FS 解析完整正文，关键词检索经正式 `knowledge_index_entries` 和 Host scope 授权；关键词返回 ranker 的共享预算文本投影，与 Python 公共检索结果一致。Core dispatch 4/4、Host 临时 SQLite/FS 注册器调用链本轮复验 1/1；Core build 在 devserver 通过。旧 Python pytest 因 devserver 缺项目 `.venv/bin/pytest` 未运行；Host 全量 typecheck 仍有其它测试类型错误。工具尚未进入生产 Agent Run，knowledge 写入/freshness producer 与 PostgreSQL migration 未验收，不标记为生产完成。Mutagen 自动同步本轮源码；验证前曾因 Core dist 尚未重建而失败，重建 Core 后 Host dispatch 1/1 通过。现有同步冲突在生成目录，未清理或覆盖。共享工作区 HEAD 在本轮期间由并行会话推进，本会话未执行提交。

同日续轮回归：Core `knowledge.test.ts` **4/4**、`source-adapters.test.ts` **8/8**（临时 Vitest 配置只选目标文件且已删除）；Host `search_conversations` SQL 事实表和实际 `AgentRuntime → Core Runner → registry dispatch → Provider` 续轮 **4/4**，`read_knowledge` registry/SQLite/owner FS **1/1**，owner knowledge store、持久 Worker/baseline、正式 Jieba **11/11**；Host 合计 **16/16**。知识用例曾配置匹配版本的临时 owner 向量文件和确定性 mock embedding；后续回归明确验证该知识工具不会读取向量或调用 embedding。Node Core build、Web Host production build 通过（该次续轮时）。Core 标准 suite 被共享工作区未登记的 Skill 测试阻断，Python pytest 未安装；测试未连接 PostgreSQL、Redis、真实 embedding Provider。生产 `main.ts` Agent Run 装配、knowledge/memory Node 写入 producer、PG migration 和 Node-only Worker 切换仍未完成。

2026-11-16 `read_knowledge` BM25 行为修正：对照 Python `_read_knowledge` 明确传入 `strategy="bm25"`，发现 Host 适配器此前仍会调用可选 embedding 并走 hybrid，但工具结果结构固定写 `strategy: bm25`。Host 注册器回归先红后绿；修复后的 Host knowledge、memory scope/BYOK、Worker 生命周期、Web Run 工具绑定合计 **4 个文件、17/17 通过**，knowledge 调用断言向量读取及 embedding 均未发生，同时保护 memory 向量召回和 Worker 队列行为；临时 owner FS、持久索引、正式 Jieba、owner 隔离与授权检查均覆盖。严格单文件 TypeScript 检查通过。Python pytest 因 devserver Python 环境缺少 pytest 未运行；Web Host production build 被共享并行改动 `packages/core/src/byok/vector-rebuild.ts` 的 TS6133 未使用变量挡在 Core prebuild，未触碰该文件。此项恢复知识工具行为一致，不影响 memory 的向量召回。生产 Agent Run 与正式 PostgreSQL 仍未验收。

2026-11-16 Skills/MCP devserver 复验：相关 Node 回归 **43 项：38 通过、5 个隔离 PostgreSQL/Python 用例跳过、0 失败**；Web Host production build 通过。测试前核对 Skills/MCP 生产源码与测试文件和本地哈希一致；首次从仓库根目录启动测试时因 `tsx` 按 cwd 解析失败，改在 `apps/web-host/` 执行后通过，不属于产品代码失败。devserver 缺少 `backend/.venv/bin/pytest`，Python 对照未运行。此复验没有补上 Node Agent Run 的生产工具注册消费者，也没有实现需要隔离 Broker 的 MCP stdio；真实 PG、SQLite schema、MCP 服务与部署仍未验收。

2026-11-16 MCP tools/call 参数兼容与外呼边界：Core MCP schema adapter 复用现有 `normalizeToolInput` 和 Python 兼容 `invalidInputResult`，Host 只对当前 owner 已启用且已发现的工具执行 SDK `tools/call`，校验失败返回 Python 形状 `tool_input_invalid` 且不外呼。Node Host 用例先因 adapter 调用契约不匹配红 **6 项**，接线后 **10/10 通过**；Core 新增归一化/错误投影合同 **3/3 通过**。devserver Core build、Web Host production build 通过；Skills/MCP 定向合集 **59 项：53 通过、6 个隔离 PostgreSQL/Python 用例跳过、0 失败**。旧 Python MCP E2E 源码确认调用前归一化、schema 校验、失败不发送请求；devserver 无 pytest，未跑 Python。当前 `main.ts` 仍无 production Agent Run/reconstructor 调用者，Host dispatch 尚无真实 Agent Run 消费端；stdio 需要隔离 Broker。正式 PG、SQLite schema、真实 MCP、部署均未验收，因此此项只记内部运行能力，不将 MCP tools/call 或动态技能标为生产 Agent 执行完成。

2026-11-16 Skills/MCP 与凭据交互 devserver 复验：`tests/mcp/*.test.ts` + `tests/skills/*.test.ts`（现行目录名）**42 项：40 通过、2 个隔离 PG 用例跳过、0 失败**；额外的 MCP secrets/交互消费 Host 测试 **3 项：1 通过、2 个隔离 PG 用例跳过**。Core MCP/Skills 目标文件 **34/34**，正式 SQLite 用户 Skill 合同 **1/1**；Core 与 Web Host production build 通过。源码哈希核对一致。Python pytest 因 devserver 无项目 `.venv/bin/pytest` 且系统 Python 未安装 pytest，未运行。`main.ts` 仅用 Agent tool registry 生成目录，没有 Agent Run dispatch 消费者；secrets 路由/恢复 Worker 同样未进入生产组合根，故不记为 MCP 执行或凭据恢复已接通。Core 默认测试发现仍被并行工作未登记的 suite 项阻断，本轮使用临时外置 Vitest 配置跑目标文件并在退出时删除；Mutagen 报告的冲突仅涉及旧生成目录，本轮未清理或覆盖。工作区其他未提交改动均保留，未提交或推送。


2026-11-16 `search_memory` 错误状态兼容：按 Python `UnifiedQueryRetriever` 对齐 fallback reason，未启用 embedding 为 `embedding_disabled`、显式 BM25 为 `lexical_only`、已配置但无可用向量为 `embedding_cache_unavailable`，成功 hybrid 为 `null`。Core 真实工具注册器 dispatch 用例先验证旧实现失败、修复后 **6/6 通过**；还覆盖 query embedding transport 失败时返回授权范围内 BM25、隐藏底层异常。使用合成 owner memory 索引/向量，未调用 Provider。Python pytest 本轮未运行；生产 Agent Run、真实 PostgreSQL/Redis 和外部 embedding 未验收。

2026-11-16 PostgreSQL RAG 索引迁移真实隔离验收：修复 `pg` 将系统 `name[]` 返回为字符串造成的误报，SQL 现把唯一约束列和检索索引列显式投影为 `text[]`。临时 PostgreSQL 集群中 `rag-index-migrate.test.ts` **3/3 通过**：空库建表与结构验收、旧 Python 表无损认领、幂等，以及结构损坏拒绝；集群已停止。生产库未连接或升级。RAG 来源投影、正式 Jieba、owner 向量读取/受控 embedding 已有实现；knowledge 与普通 memory 写入新鲜度仍缺 Node 写入方。`search_conversations` Host 工具/Runner 测试已存在，但 `main.ts` 尚未装配 Agent Run 或将 conversation/memory 工具端口传入生产重建器，因此不计作生产工具接通。Python pytest 本机缺模块未运行，真实 Redis/Provider 未验收。

2026-11-16 补齐管理员 LLM 静态能力预览：`POST /api/v1/admin/agent/llm-presets/capabilities-preview` 现由生产 App 的 Admin guard 保护，Host DTO 调用共享 Core Provider 能力快照。缺路由时 Host 测试先因 404 失败，接入后认证/参数限制/Ollama native 协议与 reasoning/额外密钥不回显 **1/1 通过**；Core Ollama native 输出与 Python `capability_snapshot` 实际函数输出一致，完整 Admin handler 对照因系统 Python 缺 `uuid6` 无法启动。Web Host production build 通过；全量 typecheck 被并行工作区其他测试与依赖类型错误阻断，Core Vitest 测试发现也因共享 `suites.json` 与当前文件不一致未启动。真实部署未验收。

2026-11-16 恢复 Core Skill 合同回归发现：将已有 `user-management-sqlite.test.ts` 从 `node:test` 接入 Vitest 并补齐 suite/元数据登记后，Skill SQLite owner/MCP关联合同与 Provider policy **134/134 通过**。Core 默认层现可启动，devserver 全量结果 **148 文件：140 通过、5 个行为失败、3 个 node:test 文件无 Vitest suite，0 项因清单发现失败**。行为失败具体涉及两条缺 `rag_index_jobs` 的 Mind SQLite fixture、一条本地 IPC capabilities 预期、一条 Undo 子进程找不到 Core `tsx`、一条 portable-boundary 对 `kysely` 外部依赖的结构断言；均未修改这些并行工作区代码。Node 全量回归仍未通过。


2026-11-16 N2 Agent 会话删除：新增 Core 删除用例与 PostgreSQL owner 行锁事务适配、认证 Host `DELETE /api/v1/agent/sessions/{session_id}`，同事务结束该 owner 的 Agent 终端并显式删除附件/消息/会话，提交后 best-effort 清理未引用 Local 附件和 Redis 反思缓冲。先失败后通过的 Core 清理契约 3/3，`createApp` 认证/204/404/422 回归 1/1，Core build 通过。隔离 PG 测试库变量和 pytest 均不可用，Node PG 用例及 Python 实跑未验收；Web Host build 因并行未提交的 `chart-renderer.ts` 导入 `@gugu/charts/render` 缺失导出而失败；SQLite 不含该附件/终端表，真实 PG/Redis/部署未验收。当前共享工作区其他未提交修改均保留。

2026-11-16 memory Jieba 装配闭环：memory Host 搜索 factory 现在自行装配与 conversation 共享的正式 Jieba 单例，不再依赖其他工具先触发 tokenizer 初始化。临时 SQLite/FS 上经 `search_memory` 注册器实际 dispatch 运行中文“群消息”召回回归 **5/5 通过**。此回归防止 memory-only Run 首次查询因 tokenizer 未装配而失败；使用合成授权/snapshot/embedding，未访问生产 PostgreSQL 或 Provider，Python pytest 未运行。生产 Agent Run 仍未装配工具注册器。

2026-11-16 devserver 当前树 RAG 工具复验：Host `memory-tools-runtime-sqlite.test.ts` **5/5**、`conversation-tools-runtime-sqlite.test.ts` **4/4**，共 **9/9**。测试经正式 Jieba、临时 SQLite/FS、真实 Core Runner 和 Host registry dispatch，验证 memory-only tokenizer 装配及 `search_conversations` 事实表召回和 Provider 续轮；授权、IM context、BYOK 与 Provider 为模拟依赖。Python pytest 因项目 `.venv/bin/pytest` 缺失未运行；生产 Run、PostgreSQL、Redis 和真实 embedding Provider 未验收。

2026-11-16 devserver RAG 主链回归：Host memory/search 工具 **5/5**、conversation facts/Runner **4/4**、生产 RAG 调度器与持久 Worker **9/9**、固定相关性语料 **1/1**；Web Host 生产源码 TypeScript noEmit 检查通过。索引队列、正式索引表和 RAG 结果使用隔离 SQLite/FS；生产 Agent Run 尚未装配 registry/查询端口，工具测试的授权、IM 上下文、凭据、embedding 和 Provider 使用模拟依赖。Python pytest 因项目虚拟环境缺失未运行；真实 PG 部署、Redis、Provider 和 Worker owner 切换未验收。

2026-11-16 RAG locale 行为对齐：Core tokenizer、月份词项和 confidence 匹配改用 locale-independent `toLowerCase()`，与 Python `str.lower()` 保持同一归一化；Python 和 Node 测试共读 golden，新增 `Istanbul 与 I 事件`，并验证 `Istanbul` 不会因 locale-sensitive folding 错误匹配 `ıstanbul`。devserver Node Core RAG 之前的 tokenizer/ranking/scope **30/30**、本轮 confidence ranking **16/16**、Host Jieba/`search_conversations` **6/6** 通过；本轮 Cython rank+tokenizer pytest **30/30** 通过，Cython 扩展仅编译进 pytest 临时目录；共享中文/英文/混合语料 Node Host 与 Python Cython 各 **1/1**，Recall@3=1、MRR≥0.5、owner scope 无泄漏且无关 query 为空；Core 与 Web Host production build 通过。此项修正不改变生产接入状态：`main.ts` 仍未创建生产 Agent Run/reconstructor，真实 PostgreSQL/Redis/embedding Provider 未验收。

2026-11-16 跨端图表渲染包迁移：Mermaid/MathJax worker、共享 Mermaid 纯逻辑、SVG 样式和 CJK 字体归入 `packages/charts/`，Web 通过 package subpath 导入；Web Host 新增 `renderAgentCharts()` 可复用入口，不增加路由或声称已注册生产 Agent 工具。旧 Python IM 开发 worker 路径保留薄入口，生产镜像仍打包 Python fallback 路径。devserver charts 行为 13/13、Node Host 2/2、Web Mermaid 定向 20/20；Web Host 与 Web production build 通过。devserver 无 pytest 模块，`platform/deployment/test_embedded_deps_contract.py` 与 `platform/realtime/test_streaming_regressions.py::test_qq_tool_boundary_waits_for_chart_before_starting_new_stream` 未运行；Docker 镜像、真实生产 Host 装配和部署未验收，未运行 Docker 测试。图表能力属于共享渲染，不计入 BaseSkill 静态工具组数量。

2026-11-16 BYOK Admin 预设列表：`GET /api/v1/admin/agent/llm-presets` 已接 Admin guard、运行配置 Host reader 与 Core 只读投影；devserver Core **2/2**、真实 `createApp` 配置文件入口 **2/2**，Core/Web Host production build 通过。Python 字段和 Provider 能力实现已源码对照，pytest 环境缺失；Node 不复刻 Python 在读取旧 `ai` 时写回 `ai_presets` 的副作用，真实部署未验收。

2026-11-16 当前树 RAG 再验：Core `tests/agent/rag` **9 个文件、63/63 通过**；Host 来源/Worker/Jieba/工具及 Runner 调用链 **20 项通过、2 项因未设置隔离 PostgreSQL 跳过**；Python Cython rank、tokenizer、相关性语料和知识搜索工具 **39/39 通过**。该组验证算法、持久 Worker 和隔离 SQLite 上的 Runner 工具调用，不改变生产状态：`main.ts` 尚未装配 `agentChat`/`createWebAgentReconstructor`，真实 PostgreSQL、Redis、BYOK embedding 和生产 Agent Run 均未验收。Mutagen 冲突未处理。

2026-11-16 Web Run RAG 生产边界增量：新增按持久 Web dispatch lease 绑定的 RAG 工具端口工厂；memory 检索前后逐次复核 PostgreSQL `active_run_id`、当前 `search_memory` 配置、同一注册器授权、owner scope 与会话快照版本，Host 授权/快照及实际工具 dispatch 回归 **4/4 通过**。尚未生产接入：`main.ts` 没有 `agentChat`/`createWebAgentReconstructor` 调用方，也没有已验收的正式工具权限来源与完整 Run 资源组合；不可把该端口工厂标成生产工具完成。真实 PostgreSQL/Redis、Run stream/cancel、外部 Provider 和 embedding 仍未验收；详见 [工具行为回归](../testing/node-agent-tools-parity.md#web-run-的-rag-授权与持久快照边界2026-11-16)。

2026-11-16 生产 RAG registry 组合增量：新增 `createWebAgentProductionToolRegistry`，一次性创建真实 RAG ports 和其实际 dispatch 使用的授权 registry；devserver Core RAG **9 个文件、63/63**，Host RAG **10 个文件、28/28**。回归覆盖 Core rank/tokenizer/scope/loader/embedding/cache、Host 全来源正式索引重建/损坏脱敏/owner-bound FS，以及真实 registry dispatch、Runner 续轮、memory scope 与向量召回。测试使用隔离 SQLite/owner FS，以及合成 lease、PG query、工具配置、授权、snapshot、embedding transport 和 Provider。另在 devserver 临时 venv 重跑 Cython rank/tokenizer、共享检索语料、旧 `search_conversations` 工具及 schema 安全 pytest，**64/64 通过**，缓存/配置/构建路径隔离到 `/tmp`。Core package build 通过；Host 源码类型检查曾因解析到过期 `@gugu/core` dist 失败，按两端源码 SHA 核对后重建 Core，当前 Web Host `tsc --noEmit -p tsconfig.build.json` 通过，build 后 Host RAG 再验 **28/28**。这只是生产组合工厂，`main.ts` 仍无 Agent Run/reconstructor 调用者，因此工具仍标记为待 Host Run 接入；真实 PostgreSQL/Redis/Provider 和 Node 唯一 Worker 部署均未验收。Mutagen 既有冲突保持未处理。

2026-11-17 Agent memory prompt 向量适配：新增 Host owner-bound factory，复用旧 `.agent/pattern_vec.json` / `.agent/memory_vec.json` 固定路径、RAG embedding 端口和模型版本标签；Core memory loader 现在把取消信号传到 owner 文件/向量读取与 embedding 请求。Host 临时目录经实际 memory context loader 验证版本匹配向量召回、owner 交叉读取拒绝、BYOK 缺失时词法回退以及 Provider 请求取消，**3/3 通过**；既有 memory context Host 用例 **2/2**，memory store/injection Python pytest **23/23**，Core context 回归 **36/36**，Host RAG/Agent registry 相关回归 **36/36**。Web Host 生产源码 `tsconfig.build.json --noEmit` 通过；全量 `tsconfig.json` 仍被并行工作区中其他测试的 89 个 TS 诊断阻断，本切片源和测试文件无诊断。Embedding resolver、transport 是合成依赖，未触发真实 Provider；此 adapter 还未由生产 Agent Run resources 调用。`main.ts` 的 Run/reconstructor 接入、真实 PG/Redis 和唯一 Worker 部署仍未验收。

2026-11-17 RAG 查询 embedding 缓存对齐：Core `embedRagQuery` 补入 Python 旧行为中的 SHA-256 查询键、成功结果缓存、5 分钟 TTL、64 项上限和返回向量防修改；Node RAG **9 个文件、66/66**、Python embedding 基准 **24/24** 在 devserver 通过。Node 也回归了模型/维度隔离及失败响应不缓存。该改动只复用进程内查询缓存，未连接生产 Provider，也不改变 `main.ts` 生产 Agent Run 尚未装配的状态。

2026-11-17 Local/Ollama embedding 生产传输边界补齐：BYOK resolver 仅对明确标记的 `local`/`ollama` Provider 产生本地访问标记；`main.ts` 的共享 embedding transport 经 Host helper 开启 Host 级本地能力，但 Core `embedRagQuery` 仍只为这两种 Provider 设置单请求授权，Node transport 要求两个开关同时成立并固定 DNS 目标。Host resolver 行为 **2/2**、Host transport 实际合成 HTTP 调用 **1/1**、Core Provider transport **38/38**、旧 Python `test_rag_query_embedding.py` **24/24** 在 devserver 通过；Host 使用合成 PG 行/凭据和 loopback HTTP 服务，Python 用例走既有 mock/本机合成服务，均未访问外部 Provider。Node 用例还验证云 Provider 即使运行在允许本地的 Host transport 下也不能请求 loopback。该改动修复生产向量重建和未来 Run 复用该实例时拒绝旧版 Local/Ollama 地址的问题；尚未在生产 Agent Run 或真实本地 embedding 服务验收，`main.ts` Run 装配、真实 PG/Redis 仍未完成。

本轮 Web Host `tsconfig.build.json --noEmit` 失败，只有并行 MCP SDK 更新的 `src/modules/mcp/sdk-client.ts` 报错：未解析 `@modelcontextprotocol/client`；本轮 RAG Provider 文件无诊断。修复依赖后须重跑 Host 生产类型检查。

2026-11-17 RAG/Web Run 当前树定向复验：Core RAG **7 个测试文件、60/60**；Node 26.13 下 Host registry/Run scope、`search_conversations` Runner、memory 向量上下文取消、Web Chat 准备、全来源 Worker 和共享相关性语料 **27/27**。复验修正了一个用例之间共用 embedding cache key、导致取消测试未触发 transport 的隔离缺陷。数据使用临时 SQLite/FS，PG lease/snapshot、授权、凭据和 Provider transport 为模拟依赖；本轮未运行 Python pytest（临时环境不存在）。生产 Run 仍未由 `main.ts` 装配，真实 PostgreSQL migration、Redis、外部 Provider 和 Node 唯一 Worker 切换未验收，不升级 RAG 完成状态。

2026-11-17 Admin Agent 提示词 API 与 Run 消费接线：`GET /api/v1/admin/agent/prompts`、`GET /api/v1/admin/agent/prompts/{profile}`、`PUT /api/v1/admin/agent/prompts/{profile}` 已从未注册的旧 Host 原型迁入 `modules/admin/prompts`，并接入 `startServer → createApp Admin guard`；固定 profile 列表/占位符、`compress → memory_compress.md`、缺失正文、400/422 与元数据审计按 Python 路由及 `test_admin_prompt_files.py` 对照。此前 production build 曾因当时的共享依赖解析问题失败；当前 Web Host production build 已通过。Python `pytest` 本机缺模块未运行。随着 `main.ts` Agent Run 装配，提示词读取器现于每次上下文组装读取固定文件；新增真实 Admin Host PUT 后运行时读取新正文回归先因读取器模块缺失失败，接线后与 Admin prompt 测试 **4/4** 通过。Python `session_system.py` 每次读取当前文件的行为已对照，未运行 Python 测试。测试使用临时提示词目录，真实 PG/Redis、Provider 与部署尚未验收。未接触用户运行配置、未提交或推送。

2026-11-17 MCP Core SQLite 配置持久化：基于旧 `user_mcp_servers` 字段与 MCP Settings pytest 的 CRUD/owner 语义，在 Core 新增正式 SQLite v18 配置表、工具声明快照表和本地 owner 触发器；共享 create/list/update/delete 用例按 backend 分支保留 PG 行锁、JSONB 和 text cast 行为，并在 SQLite 保持本地事务、owner 键、JSON 文本与布尔存储。TDD 新 SQLite 合同先因 PG `::jsonb` 在 SQLite 执行失败，适配后 Core 行为 1/1；SQLite v17→18 迁移备份/重开/owner trigger 与既有 Core 数据 suite 合计 43/43 通过，Core strict typecheck 通过。旧 Python pytest 环境缺依赖，已读 handler/基线测试源码但未运行；隔离 PostgreSQL URL 未提供，真实 PG 合同跳过；Web Host 仍使用 PG，桌面 MCP route/runtime、外部 MCP 和真实部署未验收。

2026-11-17 Agent SSE 断连回归：路由把请求断连信号传入 Chat service 和持久 outbox 读取；断开关闭事件订阅，不取消已排队的后台 Run。Host service/HTTP route **9/9 通过**，Core build 通过；Host 生产类型检查仍被并行 MCP SDK 的 `@modelcontextprotocol/client` 缺失阻断，本批文件无诊断。该回归验证取消边界，不表示生产 `main.ts` Agent Run 已接通；PG、Redis、Provider 与生产装配仍待验收。

2026-11-17 RAG 当前树回归：Core RAG 目录 **9 文件、68/68**；Host 生产 RAG registry/授权快照与 `search_conversations` Runner **6/6**、RAG 索引生命周期/Worker/owner FS/向量及工具续轮 **34/34**、正式 Jieba/共享相关性语料 **3/3**；Python Cython rank、tokenizer、golden、相关语料和 query embedding **94/94**，旧 `search_conversations` pytest **8/8**、`read_knowledge` pytest **6/6**、memory service/unified query/group owner **23/23**。测试通过哈希核对后在 devserver 执行，Node 使用临时 SQLite/FS 和合成 PG/授权/Provider，Python 使用隔离 venv/Cython 临时目录。Core 默认 suite 受并行测试清单不一致影响，使用 `/tmp` 临时 Vitest 配置运行 RAG 测试，未改共享清单。额外 `memory-clear.test.ts` 因测试包无法解析 `kysely` 加载失败，已从 RAG 回归组剔除。RAG 仍未接入生产 `main.ts` Agent Run，且真实 PG/Redis/Provider 未验收。

2026-11-17 Web Chat preparation/RAG 短回归：devserver 与本地文件哈希一致，Chat preparation **6/6**、Host RAG registry/`search_conversations` 实际调用/Jieba/Runner **8/8**。这些用例使用合成 Pool、临时 SQLite/FS 和模拟 embedding；Python pytest 本轮没有可用环境，未重跑。聊天准备和 RAG registry 仍未由生产 `main.ts` Agent Run 调用；正式 PG/Redis、真实 Provider 与恢复 Worker 未验收。

2026-11-17 Web Agent 模型访问版本边界：调度准备事务现在可在最终 owner/session/run 建立后解析可信 `accessVersion`；无效摘要会阻止入队并回滚消息事务。配置化 Host Provider adapter 只读解析 BYOK 主密钥和提示词文件，并以合成配置验证模型变更会改变不透明版本。devserver Host 定向 Node **17 通过、0 失败、3 跳过**；相关旧 Python BYOK 目的地绑定 pytest **5/5 通过**。另复验 `search_conversations` 与 memory 真实 Core Runner/Host registry 临时 SQLite/FS 调用 **10/10 通过**，依赖中的 PostgreSQL lease/授权、凭据、embedding 与 Provider 为模拟。生产 `main.ts` 仍未装配 Chat/Run/Reconstructor，因此上述只是可复用边界和组件级调用链证据；生产 scope 来源、完整上下文、执行器、PG/Redis、真实 Provider 和 Worker 切换仍未验收。

2026-11-17 Web 自动 RAG 准备端口：新增 lease 绑定的 `createWebAgentRagContextBuilder`，从正式持久索引读取八类 Web 来源，强制 owner scope 二次授权、conversation 消息水位、Python `confidence` 选择及历史 `knowledge-context` hash 去重，并生成可回放的 Canonical block；Core `createScopedRagSearch` 增加可选 selection mode/hash 排除参数，原调用默认 `top_k` 不变。Host 临时 SQLite 正式索引经 Core `buildRunRagContext` 到自动 RAG builder 行为 **3/3**，覆盖召回/去重/拒绝、关闭开关不读索引和授权期间取消传播；Core scoped-search **6/6** 通过。使用临时 SQLite、合成 lease/授权，向量端口未启用。默认 Core 测试命令受共享 suite manifest 与发现集合不一致阻断，目标文件使用 `/tmp` 临时 Vitest 配置单跑。该 builder 尚未由 `main.ts` 的 Agent Run/reconstructor resources 调用，不计生产 RAG 接通；完整可信授权、向量凭据与 Provider 仍未在真实 Host 验收。

同日 Core RAG 当前树整组复验：`packages/core/src/agent/rag` 与 `packages/core/tests/agent/rag` 全目录哈希与 devserver 一致，Core build 后使用 `/tmp` Vitest 配置串行运行 **9 文件、69/69**；覆盖索引来源、tokenizer、ranking、scope、向量/embedding、缓存及 memory search。Host 正式临时 SQLite 经 Core `buildRunRagContext` 到自动 RAG builder **3/3**。Host production typecheck 仍被既有 `sdk-client.ts` 缺少 `@modelcontextprotocol/client` 阻断；Python 自动 RAG pytest 本轮未运行，devserver 无 pytest。真实 PostgreSQL、Redis/跨进程恢复、BYOK 向量和 Provider 未由本轮测试触达，生产 `main.ts` 仍未创建 Agent Run caller。

2026-11-17 IM 记忆维护 N2 API 接线：`POST /api/v1/admin/agent/memory/im-scopes/maintenance/model-preview` 与 `.../apply` 已在 Web Host 生产组合根接 Redis worker 状态、Core 消息与 revision 规则、Local 文件存储及受控 standalone Provider；apply 在群日报达到 Python 阈值后调用 Core 日期保留规则与 Host Provider 压缩器。既有 IM Node 回归 **33/33**，Skills/MCP 相关回归 **59 通过、5 跳过、0 失败**；本机当前树 Preview/Host **6/6**、Apply **5/5**、Core 预览规则 **3/3**，Web Host production build 通过。并发启动遇到旧 `done` 状态但锁仍占用时不得把旧响应冒充新任务；回归按此行为先失败后通过。Core 默认 Vitest 因其他并行测试文件与 `tests/suites.json` 清单不一致无法加载，本用例使用临时隔离 config 验证；没有改动对方测试清单。对应 Python handler/pytest 源码已读，本机 Python 环境无 pytest，未做 Python 实测。正式 PG/SQLite schema、Redis、真实 Provider 与部署未验收，不能据合成 schema 声称双库完成。

2026-11-17 Agent 上下文策略 Core 迁移：新增共享 `agentContextPolicy`，依据可信 source/actor role 复刻 Python `backend/agent/im/context_policy.py::policy_for`：Web 忽略遗留 IM role、只有 IM member/unknown 限制 owner 上下文并关闭连续桥接与反思；memory 开关仍由可信调用方配置传入。测试先因模块缺失失败，再通过 Core 定向回归 **2/2**，Core build 通过；对照旧 pytest `test_member_context_policy_does_not_load_owner_context`、`test_web_context_policy_keeps_full_context` 及 Telegram unknown 用例，当前未运行 Python pytest。此共享规则尚无生产 Chat resources 消费者，不表示 `/api/v1/agent/chat` 接通；Core 默认 suite 仍因共享工作区 6 个未登记测试阻断，本切片以临时定向配置验证并已删除临时文件。

2026-11-17 Web Provider 恢复范围契约修正：队列保存的 `contextScopeKey` 是可信上下文策略/模型/凭据/权限版本摘要；Core `accessScopeHash` 是由 owner/session/run、所选上下文策略与 scope key 计算的 checkpoint 访问摘要。此前 Web 绑定将二者混用，重建时会与 Core 计算结果不一致。Host Provider 快照现分别传递并验证两者，恢复同时拒绝任一范围变化；新增回归验证队列值与 Core 值不同，Node Host agent-config 定向测试 **12 通过、2 跳过、0 失败**。这只修正可复用绑定契约；`main.ts` 仍没有 Agent Chat/Run 装配调用者，生产 Agent RAG 调用链尚未完成。
2026-11-17 Web Run 重建范围回归：新增无真实服务的合成 Host 调用 `createWebAgentReconstructor`，持久 lease 中的 `contextScopeKey` 与由 Core 计算的 `accessScopeHash` 使用不同值并分别匹配，Harness 组装通过；该文件 2 通过、1 个 PG/Redis 集成用例按显式隔离服务跳过。测试使用合成 Pool、lease、Provider transport、来源和工具授权，不触达真实 DB/Redis/Provider。生产 `main.ts` 调用链仍未装配，不能据此声称生产恢复或工具已完成。

2026-11-17 Web Run MCP dispatch 配置复核：按 Python Web Run 在本轮配置工具集中发现 MCP schema 的基线，修补 Host ToolPort 在 MCP dispatch 时重读当前 owner/session/run 配置，并要求工具仍在当前 Web 会话授权名称中；配置撤销后不触达远端，身份或配置读取失败时拒绝。新增行为测试先红：未配置的 `mcp_places_lookup` 实际触发远端 dispatch；修复后配置缺失、正常调用、schema 发现后撤权 **3/3** 通过，既有 MCP ToolPort/重建器合测 **11 通过、1 个隔离 PG/Redis 跳过**。Python `backend/agent/gateway/web/generation.py`、MCP manager 与 run preparation 已核对，pytest 未运行。该 Host adapter 还未被生产 `main.ts` 装配；stdio MCP 需要持久隔离进程通道，现有 Node MXC 仅有一次性进程执行，未接入；真实 Chat、MCP 服务和部署均未验收。全 Host build 类型检查受并行修改的 `agent-rag-context.ts` 对 `selectionMode` 参数类型错误阻断，本切片相关测试源文件无失败。

2026-11-17 终端指标 N2 API：`GET /api/v1/terminals/metrics` 已接认证 Host → PostgreSQL owner preferences 与 MXC readiness → Core 页面 Shell 授权、owner 计数和 Python DTO 常量。按 Python `terminal_metrics`、`page_access` 实现及 `test_terminal_access.py` 用例对照；Core/Host 行为测试先因 Core metrics 模块缺失失败，完成后 **4/4 通过**，Core build 和 Web Host production `tsc -p tsconfig.build.json --noEmit` 通过。Python pytest 因本地无 pytest 未运行；临时 SQLite 仅验证 SQL owner 隔离/计数合同，正式 Core SQLite 终端表不存在，Host 生产入口只接 PostgreSQL。MXC 真实 Linux readiness、正式 PG、终端 Worker/PTY 生命周期和部署未实机验收；该 API 不代表其他终端接口已迁移。

2026-11-17 Linux MXC N2 执行适配增量：官方 Node SDK `1.0.1` 的 MXC 运行时包含 Linux Bubblewrap 后端；`packages/sandbox` 现将 Linux 能力探测限制为 Bubblewrap，并在执行请求中显式选择该后端，保留默认拒绝出网、拒绝 host loopback 和不继承宿主环境。新增 Node 行为回归先因缺少平台选择规则失败，接入后 **4/4 通过**，Sandbox TypeScript build 通过。devserver 当前 checkout 不含该仓库代码且未安装 MXC SDK，未在其上冒充验收；本切片尚未接入 Web Host Agent Run、实际 Linux 主机隔离或 PTY，不能据此宣称生产执行/终端 API 已迁移。

2026-11-17 Skills N2 校验修复：Skill `related_tools` 保存校验应验证工具名是否在静态注册目录中，不能用伪造 Run 身份的运行时授权结果代替。`main.ts` 已改为通过 registry catalog 提供内置工具名，MCP 名称仍按认证 owner 按需发现；新增回归先因目录读取入口缺失失败，接线后 Node Skill 校验/路由定向回归 **6 通过、0 失败、1 跳过**，MCP SDK/runtime/授权定向回归 **64 通过、0 失败、3 个隔离 PostgreSQL 用例跳过**。Python `user_skills.py` 的 `all_system_tool_names()` 行为已对照源码，本地没有 pytest，未做 Python 实跑；`gugu2-0` Mutagen 有 3 个冲突，未 flush 或在 devserver 运行不一致的代码。Host production typecheck 当前被并行改动的 Agent interaction worker 对 Core 导出缺失错误阻断，暂不能作为全量类型检查通过证据；真实 PG、MCP 服务、对话生产消费者和部署仍未验收。

2026-11-17 Agent Run 当前树复验：重新构建 `packages/core` 后，Core TypeScript build 与 Web Host production `tsc -p tsconfig.build.json --noEmit` 均通过；Agent Chat/dispatch/reconstructor/interaction/MCP 组合定向回归 **19 通过、6 个隔离 PG/Redis 用例跳过、0 失败**。先前类型错误由 Core `dist` 落后于已导出的源码造成，重建解决；这只验证共享组件和编译，不代表 `main.ts` 已装配 `agentChat`，也不代表实际 Agent Chat、Skills/MCP 对话消费链、真实 PG/Redis 或部署验收。

2026-11-17 `search_conversations` 时间偏移差分：Node 回归在工具 `execute` 边界覆盖 Python `datetime.fromisoformat` 的 offset 归一化，`+01:99`、`+01:02:99` 被接受，`+24:00` 与总偏移越界被拒绝；devserver 完整 Host SQLite/registry/Runner 文件 **5/5 通过**。Python 旧搜索工具 pytest 因 devserver 未安装 pytest 未运行；仅用 Python 标准库确认上述时间语义，不计作 pytest 验收。改动只增加回归与元数据/文档，没有改变工具运行逻辑。该差分不改变工具生产状态：`main.ts` 仍未装配 Chat/Run/Reconstructor 和完整可信上下文端口。

2026-11-17 Web Agent Run 生产接线续验：新增 Node→Python owner reflection Redis 队列桥，复用 owner/session 缓冲、互斥锁、idle 队列和阈值语义；读取用户输入时重新验证持久消息归属，写队列失败不回滚已完成回答。反思队列行为 5/5、RAG registry/resource/Worker 行为合计 22/22 通过，Web Host production TypeScript `tsconfig.build.json --noEmit` 通过；依赖为合成 Redis/Pool、临时 SQLite/FS 和模拟 embedding。当前本机 `python3 -m pytest --version` 因缺少 pytest 模块无法启动。该队列桥已由可复用 RAG resource factory 支持，但 `main.ts` 仍没有 `createWebAgentRunLifecycle`/`createWebAgentReconstructor` 调用及 `createApp({agentChat})` 装配，故不计生产 Chat/Run 完成；真实 PG、Redis、Provider 及 Python reflection Worker 未验收。

2026-11-17 Web RAG Agent 主链装配进生产入口：`main.ts` 现在在 Redis 配置存在时创建可信配置化 Provider binding、Web owner Context sources、RAG resources、PG/Redis dispatch lifecycle 和 Reconstructor，并传入 `createApp({agentChat})`；启动时开启 dispatch supervisor，Fastify close 时停止并 drain。当前暴露范围仅为 owner 授权、每次复验 dispatch lease 的 `search_conversations`/`search_memory`。没有正式 sandbox executor 时 Shell 默认拒绝；交互和当前 attachment/media materializer 不支持的输入明确不可用。定向 RAG+reflection **22/22**；Chat Host/route/Reconstructor **5 通过、1 跳过**（需隔离 PG/Redis）；production TypeScript build check 通过。测试仅使用临时 SQLite/FS、模拟 Pool/Redis/embedding/Provider，未连真实 PG/Redis/Provider；Python pytest 因本机未安装 pytest 未运行。因此状态从“无生产 caller”更新为“已接线，真实后端未验收”；Node RAG index Worker 仍默认服从 `AGENT__RAG_INDEX_WORKER_OWNER`，无 Node 唯一消费者切换证据。

2026-11-17 Web 自动 RAG 进入 Reconstructor 资源契约：每个 dispatch lease 的 Host resources 必须显式提供 `ragContext`，并由重建器注入 Core 标准 Run preparation。Host 自动 RAG 正式索引行为 **3/3 通过**；PG/Redis 重启集成未运行（隔离服务未配置）。`main.ts` 仍无生产 `createWebAgentReconstructor` caller，可信生产授权/上下文和 PG/Redis 主链未闭合，RAG 状态继续标为依赖阻塞，不计生产接入完成。

2026-11-17 自动 RAG 向量/租约授权 adapter 增量：新增生产 RAG context builder，将 owner 绑定的 1.7.7 向量文件与 Host embedding resolver 接入自动 RAG 检索；Web owner scope 要求可信 owner-context policy，并重查 PostgreSQL active run、dispatch token/fence 和租约有效期；不把独立的 `memoryEnabled` 快照开关误作 Python 自动 RAG 总开关。Node Host 调用回归 **3/3**，使用临时 Core SQLite/owner FS、模拟 active-lease Pool 和模拟向量 transport，覆盖正式索引召回、历史去重、跨 owner/session 拒绝、`memoryEnabled=false` 仍允许 Web 自动 RAG、关闭开关和取消。embedding 未配置/失败仍按旧版词法回退。生产 `main.ts` 尚未创建 Run/reconstructor caller，因此该项记为已实现待 Host Run 接入；正式 PG/Redis 和外部 embedding Provider 未验收。

同日自动 RAG 租约过期回归：在生产 builder 行为用例中将 active dispatch 查询从有效切换为失效，标准 `buildRunRagContext` 不注入召回结果并返回 `no_eligible_scope`；同组 Host 测试 **3/3** 通过。先恢复 `memoryEnabled` 门控的验证得到预期 **2 通过、1 失败**，恢复 Python 一致的策略后通过。测试仅用模拟 PostgreSQL Pool、临时 SQLite/owner FS 与模拟 embedding；Host production typecheck 当前被并行 terminals Core 导出和 MCP SDK 缺失挡住。此边界实现与回归不替代 `main.ts` Agent Run 装配，RAG 仍不能标为生产接入完成。

同日 Web 上下文格式化器增量：新增由 Host ContextData 驱动的 Web snapshot formatter，对照 Python `build_split` 转换项目、日历、笔记、文件、记忆、知识与渠道状态；显式保护 `loadOwnerContext` 与 `memoryEnabled` 数据边界。Devserver Node 定向测试 **2/2**；合成数据验证，不触达真实来源。`tsconfig.build.json --noEmit` 没有报告本切片文件错误，但仍被共享工作区未导出的 terminals Core 模块及缺失 MCP SDK 阻断。格式器尚未接入 `main.ts` Reconstructor resources，仍是生产 Run 的待接线组件。

同日 Core ContextSource Assembly 接入 Web formatter：`createAgentContextAssembly` 统一创建上述 Web formatter，不再要求 Host 自行提供 `dynamic` 拼装函数；devserver Context Assembly + builder 回归 **3/3**。这是 `ContextSourcePorts` 模块内部的真实组装，不代表生产 Host 已调用它；`main.ts` 仍没有 Agent Run/Reconstructor caller，Web PostgreSQL RAG 生产查询链尚未验收。

2026-11-17 终端只读 API 增量：`GET /api/v1/terminals/`、`GET /api/v1/terminals/{terminal_id}`、`GET /api/v1/terminals/{terminal_id}/events` 已接 Web Host 生产组合与 Core owner-scoped 查询；列表复刻 30 天关闭/孤儿清理、Agent 5 条上限与 DTO，详情复刻 owner/session/Shell gate，事件接口按 Python 30×500ms 轮询语义输出持久事件 SSE。新增 `PATCH /api/v1/terminals/{terminal_id}`，复刻名称截断/空白拒绝及提交后 terminals 更新通知。Core 终端套件 9/9、Host 终端套件 11/11，Core/Web Host production build 通过。旧 Python 路由与服务源码已核对；本地无 pytest，devserver checkout 与当前代码不同步，未宣称 Python 实跑。终端持久表生产只走 PostgreSQL；SQLite 合成表不代表正式双库。真实 PG/MXC/部署未验收，Node PTY/Agent 事件生产者及创建、输入、cancel、reopen、reset、terminate、WebSocket 生命周期仍未接通。

2026-11-17 Web RAG 同 lease 资源组合：新增 `createWebAgentProductionRagRunPorts`，一次装配正式索引自动检索及 `search_conversations`/`search_memory` registry，共用同一 dispatch lease、可信配置、owner 与 embedding 端口。`agent-rag-tool-ports.test.ts` 在 devserver **4/4 通过**，覆盖实际 registry dispatch、自动 RAG 查询和 lease 失效拒绝；测试使用隔离 Core SQLite、临时 owner FS、合成 PostgreSQL active-lease/config 端口，无真实 PostgreSQL/Redis/Provider。行为用例分别写入 Python-compatible owner RAG 文件索引和 Core 正式自动索引，避免把两条不同的 Python 行为入口误合并。此组件仍未由 `main.ts` 的 Agent Run 调用；当前 Mutagen 有 3 处 dist/node_modules 目录冲突，未执行 flush。Python pytest 未运行。
2026-11-17 Node Admin IM 记忆维护 RAG freshness：Node apply 的 group/member 主文件写入现在先撤回 owner 旧 memory 投影，再在文件变更后经 Core 单事务推进精确 scope revision、排入持久 memory 重建；中途写入失败也保持旧投影隐藏并刷新已触碰 scope。devserver 定向 Node 回归 **14/14**（apply 5/5、RAG worker/source 9/9，含队列写失败回滚与 tombstone scope 拒绝），Core/FS build 和 Web Host production `tsconfig.build.json --noEmit` 通过。全量 Web Host `pnpm typecheck` 有 **96 个测试目录类型诊断、0 个 src 诊断**；对应 Python `tests/im/test_im_memory_admin.py` 因 devserver 缺 pytest 未运行。测试使用隔离 SQLite/FS，不连接真实 PostgreSQL、Redis、embedding Provider。Mutagen 有 3 处旧目录构建产物/依赖冲突，但本轮验证的源码哈希一致。此项仅覆盖 Node Admin IM 维护写入者；普通 owner memory/reflection 生产者仍在 Python，Node Worker 需显式成为唯一消费者，Agent Run 主链尚未装配。

2026-11-17 Admin Agent 状态标签 API 部分接入：`GET/PUT /api/v1/admin/agent/state-labels` 接入生产 `createApp → Admin guard → Core 投影/清理 → Host 锁内原子配置写入`；Python `agent_admin.py` handler 源码已对照。TDD 行为测试先因路由模块缺失失败，接线后 **3/3**，覆盖认证、工具目录排序、空 overrides 默认值、422、清理默认值和保留其他配置段；Core build/typecheck 通过。Python 环境缺 pytest。当前 Node 目录只包含已注册工具，未覆盖 Python 全工具注册表；生产 Agent Run 仍未在 `main.ts` 装配。Host 当前全量 typecheck 被并行 `agent-web-reconstructor.ts` 的 Core 类型导出和 `provider` 字段诊断阻断，本切片无诊断；真实部署未验收。

2026-11-17 Web RAG Agent 主链复验更新：当前 `main.ts` 已将生产 `AgentChatService` 接入 `createApp`，由 PostgreSQL/Redis dispatch worker 调用 Reconstructor，再按可信 Provider selection/owner context/lease 装配 `search_conversations` 与 `search_memory` 注册器；Fastify 启动/关闭管理 supervisor 生命周期。Host production TypeScript 检查通过；RAG/reflection/Chat/route/Reconstructor/Worker 合批 **27 通过、1 个 PG/Redis 恢复集成跳过、0 失败**。测试使用临时 SQLite/FS 与合成 Pool、lease、Redis、embedding 和 Provider。Python pytest 缺少模块未运行；Mutagen `gugu2-0` 有 3 项同步冲突，未 flush。状态为“生产入口已接线、真实后端待验收”，不能表述为生产 PG/Redis/Provider 验收完成；Node RAG Worker 唯一消费者切换、Python pytest 基准及 schema/恢复真实服务验收仍在待办。

同日工具范围补记：当前生产 lease-bound registry 同时启用 `create_event`/`update_event`，写入复用共享 Core 日历服务与 Host 提醒目标解析；本机单独重跑 Host calendar ports、RAG resources、lease authorization 和 registry 测试 **34/34 通过**，但这组未与 28 项主链合批同时运行。范围因此为 `search_conversations`、`search_memory`、`create_event`、`update_event`；后两项真实 PostgreSQL/提醒投递仍待验收。不要将较早“仅两项 RAG”记录视为当前工具暴露清单。

同日 devserver Python RAG 基准补验：确认 12 个对应 pytest 文件与本地哈希一致后，在 `/tmp` 临时 venv 串行执行 Cython rank/tokenizer、tokenizer golden、固定相关性语料、旧 `search_conversations`、schema 安全、memory service/unified query、group owner、vector cache、retriever、hybrid，**118/118 通过**。配置环境变量指向不存在的临时 env/override 路径，Cython 产物与 venv 随命令退出清除；未访问真实 DB、Redis、用户文件或 Provider。结合 devserver Node production TS 检查通过、RAG/Run 合批 **27 通过/1 个 PG+Redis 用例跳过** 和日历/RAG/registry **34/34**，当前代码与 Python 基准哈希一致的部分已实测。真实 PG/Redis/Provider、进程恢复及 Node-only Worker 切换仍待验收；此前“本机缺 pytest”记录仅描述环境准备前状态。

同日 Skills/MCP 组合定向本地回归：Node 26.13 上跨状态标签、MCP Web Run 配置/授权/工具端口、MCP runtime routes 和 Skills 工具目录 10 个测试文件 **40/40**；使用本地合成 transport、认证 Fastify、配置临时文件和模拟 lease，不连真实外部 MCP。官方 SDK HTTP runtime 与组件级 MCP Run 链验证通过，但仍未由 `main.ts` 生产 Agent Chat/Worker 消费；Python pytest、真实 PG/Redis/SQLite Host、外部服务和部署未验收。Host 当前生产 typecheck 另受并行 `agent-web-reconstructor.ts` 类型/字段错误阻断，未借该组合回归宣称生产 Chat 完成。

2026-11-17 当前树 BYOK/Skills/MCP/安全出站定向合批复验：Node 26.13 **114 项，103 通过、0 失败、11 跳过**；跳过均需隔离 PostgreSQL/Redis。首轮 3 个 Agent Run 组合测试因 Core `dist` 落后于当前源码、缺少新导出而无法加载；按当前源码重建 Core 后，组合测试 **13 通过、1 个 PG/Redis 用例跳过**，合批重跑全绿。Web Host production `tsconfig.build.json --noEmit` 通过。预览启动竞态修复的模块回归 **6/6**、真实 `createApp` Admin guard 接线 **1/1**，Apply Host **5/5**、Core Preview **3/3**、Core Apply **4/4**；新竞态回归的先红后绿证据见 API 迁移清单。Mutagen `gugu2-0` 仍有 3 处冲突，本轮不 flush，使用本地 Node 环境验证。Python pytest 不可用；未连接真实 PostgreSQL/Redis、外部 MCP/Provider 或部署。管理及目录 API 有生产 Host 调用链，但生产 `main.ts` 仍没有 Agent Chat/Run caller，不能据此宣称用户对话已消费 Skills/MCP。

2026-11-17 Skills/MCP 当前树复核：本地 Node 26.13 运行 Skills 校验/列表/写入/删除、MCP 目录/SDK/runtime/routes 与 Agent MCP ToolPort **33/33 通过**；覆盖静态注册目录校验、owner 目录发现、禁用态不外连、凭据轮换缓存失效、schema/调用失败语义和取消传播。未修改 Python；旧 `user_skills.py` 的 owner、禁用态关联与 MCP 目录行为已按源码及既有 pytest 案例对照，devserver pytest 不可用。工作区同步仍有冲突，因此本次只在本地执行回归。`main.ts` 尚未组装 Agent Chat/dispatch/reconstructor，MCP ToolPort 与 Skill runtime 仍未被真实用户对话消费；不将组件测试升级为生产 Chat 完成证据。

2026-11-17 BYOK/安全出站当前树本地复核：执行 Host BYOK、Provider binding、MCP、Skills、安全出站 139 项，**118 通过、15 按隔离服务/平台条件跳过、6 未通过**。逐项检查失败原因为 macOS 不支持的 Linux 目录句柄密钥存储测试 4 项，以及未配置隔离 PostgreSQL URL 的生产入口集成测试 2 项；没有观察到断言指向业务结果的失败。该结果不能算全绿；相关 Linux 密钥文件保护和 PostgreSQL 生产入口仍需在 devserver 同步一致、资源隔离就绪后复验。因同步冲突本轮未在 devserver 执行，也未改测试或生产逻辑。

2026-11-17 BYOK/Skills/MCP/安全出站本地复验更新：当前树 Node 定向合批 **118 项，101 通过、0 失败、17 跳过**；其中 14 项仍依赖隔离 PostgreSQL/Redis/Python，另 3 项仅验证 Linux `openat` 密钥文件路径安全，已按平台能力在非 Linux 跳过且保留 Linux 原断言。Web Host production build 通过，`git diff --check` 通过。当前 `main.ts` 已装配 Agent Chat/dispatch/reconstructor，并将 Skills/MCP 接入 Agent Run；此前“尚无生产 Agent Chat caller”的两条 Skills/MCP 记录是装配前快照，不代表当前状态。Python pytest、隔离 PG/Redis、外部 MCP/Provider、完整 SQLite Host 与真实部署未验收；devserver 同步冲突未清理或覆盖。

2026-11-17 用户 Skill 正文 Core 查询增量：新增 `createUserSkillReader`，只按规范化 ID、认证 owner 对应数据分区、`enabled=true` 和 `source=user` 查询单条正文及摘要；测试使用临时 Core SQLite，覆盖同 ID 跨 owner、停用、来源伪造及 ID 大小写，定向 Skill 读取/管理 **3/3 通过**。测试首次因读取模块未实现失败；实现后因测试对“另一 owner 自有同 ID 记录”的预期写错再次失败，修正为验证只返回该 owner 自身内容后通过。Core 完整 build 当前被 `src/agent/run/tool-ports.ts` 的 `PreparationIdentity`/`RunIdentity` 类型不兼容阻断；该读取器尚未被生产 Chat SkillRegistry 消费，不能据此记为对话接通。devserver 仍有同步冲突，未在远端验证；Python pytest 未运行。

2026-11-17 终端命令 N2 接线：`POST /api/v1/terminals/{terminal_id}/input` 与 `POST /api/v1/terminals/{terminal_id}/cancel/{request_id}` 已由 `main.ts` 注入 Host command runtime，经过认证、Core owner/Shell 授权与事件事务、Redis 跨实例租约/取消标记、Local owner 工作区句柄和 MXC 命令执行；Redis/MXC 不可用时拒绝或返回 503。Node runtime/route/MXC 回归 **19/19**；请求级 egress 回归先因静默降级断网而失败，修复后验证 fail-closed。Python 终端路由、access 规则和对应 pytest 源码已对照，本地 pytest 环境不可用，未运行 Python 实测。当前仅 PostgreSQL Host 生产入口，真实 PG/Redis/MXC/部署未验收；PTY 创建、重开、重置、终止及 WebSocket 生命周期仍待迁移。

2026-11-17 RAG Agent Run 工具范围更正：lease-bound 生产资源现提供 `search_conversations`、`search_memory`、`read_knowledge`、`create_event`、`update_event`。新增的 `read_knowledge` 仅在 Host 注入 owner-bound 知识读取端口时启用，按 ID 从授权 FS 读取完整正文，关键词查询复用持久索引和 Core RAG，固定 BM25，与 Python 工具策略一致。Host 工具调用边界回归 **34/34 通过**，production TypeScript 检查通过；Python RAG/旧工具行为基准 **118/118 通过**。Node 用例使用隔离 SQLite/FS、合成授权/lease/PG/Redis 和模拟 Provider/embedding，Python 用例使用临时 venv/Cython 与隔离数据。真实 PG/Redis、Provider、提醒投递与重启恢复仍未验收；Worker 默认消费者仍为 Python。`save_knowledge`/`update_knowledge` 以及其余工具组仍未接入生产 Run。本补记修正较早记录中“只有四项工具”及“主链仍未装配”的历史状态，不代表生产服务验收完成。

2026-11-17 知识写工具生产 Run 接线增量：`main.ts` 现在将既有 `createLocalAgentKnowledgeWritePort` 与 owner knowledge store 一起注入 lease-bound RAG resources；Reconstructor 仅在获得该端口时启用 `save_knowledge`/`update_knowledge` 授权，配置过滤同步允许这两项。工具继续复用既有 Core 写工具、owner FS 原子写和 RAG freshness 队列，删除仍未开放。已新增真实 registry dispatch 写入→更新→回读用例与授权撤租回归，但该新调用链尚未执行测试或 production TypeScript 验收：Mutagen 目录冲突仍未 flush。先前 Host 写端口/Worker **20/20** 及 Core 工具 **7/7** 不覆盖此生产 Run 装配增量，不能记为新切片验收通过。

2026-11-17 Agent Runtime Core 当前树复验：Core 已承担跨端 Chat Run 生命周期、上下文 snapshot/request builder、dispatch worker/supervisor、interaction recovery；Host 只组合可信身份、Provider binding、PostgreSQL/Redis 持久端口、HTTP 事件投影和进程启停。Core Runtime 模块不依赖 Fastify、Host、PG 或 Redis。devserver Core build 通过；四个 Core 行为测试文件 **17/17 通过**；Host Chat service、Context Assembly、Runtime、Reconstructor 与 dispatch Harness **13 通过、2 跳过、0 失败**，跳过均需隔离 PostgreSQL/Redis。首次默认 Vitest 配置因共享 suite 发现/分类不一致而未启动；之后以 `/tmp` 临时配置运行所选 Core 文件，未改 suite 清单并已清理临时配置。源码与测试哈希和 devserver 一致；本轮未跑 Host production typecheck。合成端口回归和生产组合根源码不能证明真实 PostgreSQL/Redis claim、Provider、跨进程重启恢复或部署服务验收；这些仍待完成。

2026-11-17 知识写工具生产调用链验收：本地与 devserver 本次 8 个 TS 文件哈希一致，未 flush Mutagen。Core `knowledge.test.ts` **7/7**、Core typecheck 通过；Host RAG tool ports/resources registry 实际 dispatch **8/8**，覆盖写入→更新→owner FS 回读与 lease 撤销授权。Python 知识/读取/schema 基准 **142/142**，临时 venv 编译 Cython 两扩展后全组通过；首次一项失败仅因未构建测试扩展，已修正环境并原组复跑。Web Host production TS 检查有两项未改动 `sandbox-egress.ts` 的 `network_profile` 类型错误，本切片源码未报告诊断。回归使用临时 SQLite/FS、合成 lease/PG 授权与模拟 Provider；真实 PG/Redis/Provider、提醒投递和重启恢复未验收。

2026-11-17 `read_conversation` Web Run 接线：生产 `main.ts` 按可信 dispatch lease 提供 Core 会话领域的 owner 限定读取适配器；Reconstructor 只在实际获得该端口时显式开放工具，配置过滤器、tool schema 发现和执行授权同步。Node RAG/历史读取回归 **9 通过、2 个隔离 PostgreSQL 用例跳过、0 失败**，Core build 与 Web Host production TypeScript 检查通过；行为测试经真实 Core RAG production registry dispatch，但正文端口为合成数据。旧 Host PostgreSQL adapter 的 owner/limit/content/Unicode 测试本轮因无隔离 PG 跳过；Python `test_conversation_read_parity.py` 与 `test_tool_isolation.py` 本轮未运行。真实 PostgreSQL、Provider Run 和桌面 SQLite Host 未验收，状态记为部分实现。

2026-11-17 `get_current_time` Web Run 接线：Host 为每个可信 lease 注入 `new Date()` 时钟和 Core ContextData 的用户时区读取端口，只有端口存在时才加入工具配置及授权；执行忽略模型参数中的时区并沿用 Core 时间/星期/日期结果契约。Node 时间/历史/RAG 组合回归 **9 通过、2 个隔离 PostgreSQL 用例跳过、0 失败**，Core build 与 Web Host production TypeScript 检查通过；测试时钟、owner 时区和 lease 为合成数据。Python `backend/tests/agent/test_time_tool.py` 本轮未运行，真实 Provider Run 与 PG 用户时区读取未验收，状态记为部分实现。

2026-11-17 RAG/会话工具调用链复验更正：当前 `main.ts`/Reconstructor lease resources 已接入 `search_conversations`、`read_conversation`、`search_memory`、`read_knowledge`、`save_knowledge`、`update_knowledge`，并保留 `create_event`/`update_event`。Core build、真实 registry dispatch 的 Host RAG/历史读取 3 文件 **14/14**、Host production typecheck 通过；新增 `read_conversation` SQLite SQL reader 回归覆盖 Python 的 owner 限定、最近普通消息窗口、结构化消息排除、工具正文、空正文过滤和 Unicode 截断。Python 历史读取相关基准此前已通过 **4 项、62 deselected**，本轮未重跑。相关清单已按当前接线更新，不再沿用此前“main 无 Agent Run”或“知识写入未接线”的状态。测试仅使用临时 SQLite/FS、合成 lease/Provider/Redis 和 mock embedding；真实 PostgreSQL、Redis、Provider、桌面 Host、Node Worker 唯一消费者切换和进程重启恢复仍未验收。`gugu2-0` 有同步冲突，未执行 flush；本轮源文件与测试哈希逐项确认已在 devserver。

2026-11-17 RAG/知识工具当前 Run 回归复验：确认关键源码/测试与 devserver 哈希一致，Core build 后串行运行 RAG ToolPort、Web RAG resource factory、conversation Host runtime **12 项：10 通过、2 个隔离 PostgreSQL 用例跳过、0 失败**；Web Host production typecheck 通过。经实际 Core registry/resource factory dispatch 验证 owner `search_memory`、BM25 `read_knowledge`、owner Markdown `save_knowledge`/`update_knowledge`、历史正文工具的条件暴露，以及模型传时区由 Host trusted timezone 覆盖。Node 用例使用隔离 SQLite/FS、合成 owner/lease/Pool/Provider；真实 PG、Redis、embedding Provider 和部署服务未连接。Python RAG/knowledge 基准沿用近期已记录结果，本轮未重跑。四项工具状态按当前 `main.ts` per-lease 调用路径修正为部分实现；生产持久化与 Worker 消费者边界仍未验收。

2026-11-17 `list_events` / `get_upcoming` Web Run 接线：Core 工具使用 owner-scoped 日历活动+提醒读端口、项目 Core 服务、可信 Host 时钟/时区；main per-lease 资源提供 Kysely 端口，Reconstructor 仅按端口存在条件启用，并由当前 dispatch lease 授权。Node `agent-calendar-write-ports.test.ts`、`agent-rag-tool-ports.test.ts` **10/10 通过**，Core build 与 Web Host production typecheck 通过；Python `test_readonly_tool_migration.py::test_registered_upcoming_uses_context_day_and_scoped_live_resources` 和 `::test_registered_calendar_preserves_reminders_filters_and_owner` **2/2 通过**。测试源码/用例哈希在运行前与 devserver 一致；Python 测试使用临时 venv 和合成 SQLite/owner 数据。真实 PostgreSQL、Provider Run 和部署服务未验收，故两工具保持部分实现。

2026-11-17 `list_clients` / `list_projects` Web Run 接线：两者复用总是随 Core SqlDataRuntime 注册的 owner-scoped 只读工具；Host 仅允许这两个只读名称进入配置，并按同一 dispatch lease 复核执行。Node `agent-rag-tool-ports.test.ts`、`agent-calendar-write-ports.test.ts` **11/11 通过**，覆盖当前 owner 结果、异主数据隔离、Schema/registry 发现和失效 lease 拒绝；Core build、Web Host production typecheck 通过。Python `test_project_tools.py::test_list_projects_filters_status_and_archived`、`test_core_data_bridge.py::test_web_contact_compatibility_uses_shared_storage_and_owner`、`test_parallel_tool_policy.py::test_phase2_project_and_calendar_reads_preserve_user_scope` **3/3 通过**。Python 联系人覆盖源于 Core 共享服务/owner 基准，仓库未发现独立 list_clients Agent dispatch pytest。使用临时 venv、隔离 SQLite 和合成 owner；真实 PostgreSQL/Provider Run 待验收。

2026-11-17 `get_dashboard_stats` Web Run 接线：main per-lease resources 注入 Core `createKyselyDashboardCounter` 和可信 Host 时钟，Reconstructor 仅在两个端口均存在时加入配置，执行授权仍绑定当前 dispatch lease；统计 owner、软删和未来活动筛选复用 Core 端口。Node `agent-rag-tool-ports.test.ts` 在临时 SQLite 上显式创建最小 Host `files` 表，验证真实 registry dispatch、异主客户端/项目/文件排除、软删排除、未来日历计数和忽略模型 `owner_id`；合并 Node **11/11** 通过，Core build、Host production typecheck 通过。Python `test_readonly_tool_migration.py::test_registered_dashboard_counts_all_live_files_and_unbounded_future` 与本组日历/项目/联系人相关 pytest 共 **6/6** 通过。生产 PostgreSQL 与 Provider Run 未验收，状态为部分实现。

2026-11-17 `get_project` 与 `list_scheduled_tasks` 接入 Web Run：`get_project` 按 lease 注入 owner-scoped 文件概览，`list_scheduled_tasks` 复用 `createScheduledTaskQueries.agent`，按 Host 的 workspace/filesystem 能力投影；Reconstructor 只在真实端口存在时公开，并在每次 dispatch 复验 lease。隔离 SQLite 的真实 registry dispatch 验证 owner 项目及概览结果、独立定时任务读取、排除日历提醒和异主任务、忽略伪造 owner；Node Host 定向用例通过。Linux devserver 的 RAG resource FS 写回归通过，本机 macOS 不能执行该 Linux-only 写路径。Core 生产构建通过；Host 全量测试 tsc 仍有其它 Admin/Agent 测试错误。Python 项目旧基准此前 7/7，本轮无 pytest 环境未重跑；list_scheduled_tasks 按 `_list_scheduled_tasks` 与 `_to_dict` 代码对照，仓库无专属旧 Python dispatch pytest。真实 PostgreSQL、Provider Run 未验收；静态工具分类待接入32、部分实现27。

2026-11-17 `list_trash` Web Run 接线复核：main 按 lease 创建 `createAgentTrashListPort(pool, secretKey)`，Reconstructor 只在端口存在时公开工具，并按同一 lease 授权。Core/Host registry dispatch 用隔离回收站读端口验证 Python 的合并排序/限额/满额提示、owner 不能由模型参数覆盖，且没有文件副作用；Linux devserver RAG Host 测试通过。实际 PostgreSQL 回收站适配器的 Host 用例需要隔离 PG，本轮未运行；Python `test_readonly_tool_migration.py` 与 `test_agent_file_folder_parity.py` 本轮也未运行（两端 pytest 缺失）。因此只记生产接线已完成、真实 SQL/Provider 待验收，工具状态为部分实现；分类为待接入31/部分实现28。

2026-11-17 `restore_file` / `restore_folder` Web Run 接线：修复此前仅创建 Host 恢复端口、却未注入每个 Agent Run 的缺口。`main.ts` 现在按 lease 注入 `createAgentTrashRestorePort(core, fileRestores)`；Reconstructor 仅在端口存在时启用工具配置，配置发现和每次 dispatch 都复验当前 lease。Node RAG 注册器/dispatch 定向 **10 通过、0 失败**，授权撤销与两个工具 schema/结果均覆盖；Core 工具测试和 Host 文件恢复适配器测试另外运行。包含隔离 PostgreSQL 与临时磁盘的恢复端到端回归因未配置专用 PG 跳过；Python pytest 环境不可用，本轮未重跑基准。恢复工具由“已实现待接入”改为“部分实现”，当前工具分类待接入29/部分实现30。真实 PostgreSQL、Provider Run 与提交应答丢失恢复仍未在本轮环境验收。

同日 current-tree 验收：同步目录仍有三处既有冲突，未 flush；本轮文件哈希确认与 devserver 一致后，Core build 通过、Core RAG **69/69**、Host RAG/Worker/恢复回归 **26 通过、4 个隔离 PG 用例跳过、0 失败**、Host production typecheck 通过。Python pytest、真实 PG/Redis/Provider 和部署消费者切换尚未验收；临时 Vitest 配置已删除。

2026-11-17 `list_workspaces` / `get_workspace` Web Run 接线：main per-lease 注入 Core `createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(...))`；只有工作区读端口存在时，Reconstructor 才配置和授权两个只读名称。Node 合并实际注册器/dispatch 回归 **11/11**，覆盖停用工作区、项目关联名、异主列表过滤、异主详情不存在语义；Core build 和 Web Host production typecheck 通过。Python `test_readonly_tool_migration.py::test_registered_workspaces_keep_disabled_order_and_safe_related_names` 与 dashboard/calendar/project/client owner 基准共 **7/7** 通过。临时 SQLite 为 Host 工作区/文件表创建显式最小契约表；真实 PostgreSQL/Provider Run 未验收。

2026-11-17 `get_project` Web Run 接线：main 按 lease 提供 Host `createProjectFileOverviewPort(pool)`，Reconstructor 只有在文件概览端口存在时才把工具纳入配置；执行授权仍逐次复验同一 lease，项目数据由 Core owner-scoped 查询读取，文件统计复用 Host 已有 SQL 服务。配置/授权与实际 registry dispatch 回归通过；Linux devserver Host lease/registry 定向测试 **2/2**、RAG resource factory 含真实 owner FS 写入/回读 **1/1**，Core dashboard 行为 **5/5**。本机 macOS 运行 FS 集成测试时因 `packages/fs` 的 Linux-only 原子写边界拒绝而失败；同一源码哈希在 Linux devserver 重跑通过。Python 项目详情旧基准此前 **7/7**，本轮未能重跑（本地与 devserver 均未安装 pytest）。Host production build typecheck 通过；Host 全测试类型检查仍有其他 Admin/Agent 测试类型错误。真实 PG/Provider Run 未验收，工具状态更新为部分实现。

2026-11-17 `global_search` Web Run 接线：复用 Host 既有 PostgreSQL `GlobalSearchOperations`，通过 per-lease resource factory 注入 Core `global_search` 工具；真实端口存在才启用配置/授权，dispatch 每次校验当前 Web lease。Core 工具行为 **5/5**、Host RAG/历史/registry 回归 **15/15**、Web Host production typecheck 通过；Python `test_global_search.py` + `test_search_scenarios.py` **27/27**。Python 在临时 venv 使用 fakeredis/隔离 SQLite，Node 使用隔离 SQLite 和合成 lease；真实 PG/Provider Chat 未验收。此前 Core 默认 test-suite 入口受共享 `tests/suites.json` 差异阻断，未改分类清单，改用自动清理的 `/tmp` 临时 Vitest 配置只跑目标文件通过。global_search 状态从“已实现待接入”更新为“生产 Run 已接入、真实服务待验收”。

2026-11-17 Agent Web Run 联系人读写接线：生产授权将 owner-scoped `list_clients`/`list_projects` 纳入可信只读核心能力；Core 数据端口存在时，同一 lease 还开放 `create_client`/`update_client`，删除仍因 destructive 确认闭环未接而保持关闭。复用 `packages/core/src/agent/tools/clients.ts` 与原 Core 数据服务，无额外 SQL 业务实现。Core clients/global-search 行为 **21/21**，Host RAG/工具/历史/资源 registry dispatch **16/16**，Web Host production typecheck 通过；隔离 SQLite 工具调用验证伪造 owner 无效及创建→更新→列表读回。Python 全局搜索 pytest **27/27**、联系人 owner resolver **2/2**；旧 Python 无独立 create/update handler pytest，行为对照 `backend/agent/tools/clients.py`。测试使用临时 venv/fakeredis/隔离 SQLite 和合成 lease；真实 PostgreSQL、Provider Run 和部署未验收。工具状态清单按详细行复核为已实现待接入 **37**、部分实现 **22**、依赖阻塞 **49**、退役 **1**，共 109 项。

2026-11-17 `list_trash` 当前树复验：Core `tools/trash.ts` 经生产 RAG resource factory 和同一 dispatch lease 暴露；Web Host `main.ts` 注入既有 PostgreSQL trash reader，不含模型可指定的 owner。devserver Core build、Host production typecheck 通过；`agent-rag-tool-ports.test.ts` **10/10** 和 Python `test_registered_trash_keeps_top_level_microseconds_and_limit_warning` **1/1** 通过。Node 覆盖 Unicode `limit`、跨文件/顶层目录排序与合并限额、微秒精度、满额提示、伪造 owner 与无副作用；Python 使用临时 venv、隔离配置和 SQLite，参考实现未改。真实 PostgreSQL/Provider Run 未验收，保持部分实现。当前 109 项状态为：已实现待接入29、部分实现30、依赖阻塞49、退役/重设计1。

2026-11-17 `canvas_list` / `canvas_get` / `canvas_search` / `canvas_focus_node` / `note_search` / `note_get` Web Run 接线：main 按 per-lease 注入现有 Core `createSqlMindCanvasReader` 与 `createAgentMindReader`，不另写 Mind SQL 业务；Reconstructor 仅在对应 reader 存在时发布名称，发现和每次 dispatch 均校验同一 PostgreSQL lease。真实注册器调用回归 **11/11** 通过，覆盖六工具结果、异主画布/笔记隔离、lease 撤销、分页与节点数、焦点链接、关系边、原始物理行正文、正文引用 owner 校验及无副作用；临时 SQLite 夹具显式建立 files 领域表并以异主记录验证引用标签不泄露。Web Host production typecheck 通过。旧 Python 基准本轮未重跑（devserver Python 未安装 pytest）；行为按对应 Python mind/canvas 工具与共享 Core 的已覆盖合同核对。真实 PostgreSQL/Provider Run 未验收，六工具更新为部分实现。当前 109 项状态：已实现待接入23、部分实现36、依赖阻塞49、退役/重设计1；无工具记为完全完成。

2026-11-17 `canvas_search_placeable` Web Run 接线：复用 Core `createAgentPlaceableSearch` 的 owner-scoped 项目/文件/活动查询，不借全局搜索的分页或相关度语义；main per-lease 提供 PostgreSQL Core DB 读取端口，Reconstructor 只在端口存在时开放配置，dispatch 同样复验当前 lease。Host `agent-rag-tool-ports.test.ts` 最终 **11/11** 通过；实际 registry dispatch 使用合成 SQLite/隔离 lease 验证同 owner 文件结果、异主文件不泄露和无副作用。全量 Host production typecheck 当前报错在未触及的 `src/modules/terminals/pty-runtime.ts:51`（`release` 不属于 `MxcPtyLaunchSpec`），不是本工具诊断；真实 PostgreSQL/Provider Run 未验收。Python canvas 旧基准本轮未重跑（pytest 不可用），对应行为仍需真实 PG/Python 专项验收；本工具记为部分实现。当前 109 项状态：已实现待接入22、部分实现37、依赖阻塞49、退役/重设计1。

2026-11-17 `canvas_create` Web Run 接线：main 为每个 Agent lease 创建 Core `createCanvasCreationPort(core, publishCanvasChanged)`，复用 Mind 创建事务、Undo 与持久调用收据；Reconstructor 仅在 port 存在时加入工具 schema 和授权。Host `agent-rag-tool-ports.test.ts` **11/11** 通过，真实 registry dispatch 创建临时 SQLite 画布并断言 owner 记录、mutation receipt 和一次发布回调；另验证缺端口时不公开、撤销 lease 后拒绝。回调/数据为合成环境，真实 PostgreSQL、Provider Run 与通知可用性未验收。当前全量 Host typecheck 失败于终端模块 `create-operation.ts`/`pty-runtime.ts` 的并行类型变化（`@gugu/core/terminals/create` 导出缺失、`MxcPtyLaunchSpec.release` 不存在），本工具文件没有对应诊断；Python `test_mind_canvas_tools.py` 本轮未运行（devserver Python 无 pytest）。`canvas_create` 更新为部分实现；当前109项状态：已实现待接入21、部分实现38、依赖阻塞49、退役/重设计1。

2026-11-17 `update_workspace` Web Run 接线：main per-lease 注入 Core `createWorkspaceMutationPort(core)`，复用工作区声明更新、owner 校验和持久调用收据；只在 mutation port 存在时加入配置/授权，不改物理目录或路径。Host `agent-rag-tool-ports.test.ts` **11/11** 通过，实际 registry dispatch 修改当前用户工作区名称和启用状态，再经 `get_workspace` 读回，并断言异主工作区保持原值；授权用例覆盖缺 port 不开放和 lease 撤销。测试使用合成 lease、临时 SQLite 与最小 workspace schema；真实 PostgreSQL/Provider Run 未验收。当前全量 Host typecheck 仍被未涉及的终端模块错误阻断；Python workspace 专项本轮未运行（pytest 未安装）。`update_workspace` 记为部分实现；当前109项状态：已实现待接入20、部分实现39、依赖阻塞49、退役/重设计1。

2026-11-17 终端重开 N2 接线：`POST /api/v1/terminals/{terminal_id}/reopen` 已由生产 `main.ts → Fastify 认证 → Host PostgreSQL preferences/MXC readiness → Core owner/session/Shell/PTY 授权事务 → 提交后 terminals update` 接通。Core 行为测试先因缺少 reopen 用例模块失败，完成后 **2/2**；Core 终端套件 **27/27**，Web Host 终端回归 **44 通过、1 个隔离 PostgreSQL 用例跳过、0 失败**。已对照 Python `authorize_operation`、`pty_access`、`reopen_terminal` 与 `test_terminal_access.py`；本轮 pytest 未运行。临时 SQLite 验证不代表正式 PG/SQLite schema；真实 PG、Redis、Linux MXC、重开后 WebSocket PTY 启动及部署仍未验收。Web Host 全量 production typecheck 被并行 `agent-canvas-write-ports.ts` 类型错误阻断。

2026-11-18 Mind 画布编辑与笔记生命周期 Web Run 接线：`main.ts` per-lease 注入工具组级 `createWebAgentCanvasMutationPorts`，复用 Core 放置、布局/便签/关系编辑、普通便签软删/恢复/Undo、持久收据和 Mind 发布回调；Reconstructor 仅在真实端口存在时公开工具，并在配置与 dispatch 时复验同一 lease。Host `agent-rag-tool-ports.test.ts` **11/11** 通过：实际 registry dispatch 覆盖画布便签创建/更新、引用放置、关系连接和端点修改、布局更新、移除视图但保留来源节点、普通便签删除/恢复/Undo、缺端口关闭、异主拒绝和 lease 撤销。Core 放置/编辑/笔记生命周期行为 **31/31**、devserver Core build、Web Host production typecheck 通过。测试使用临时 SQLite、合成 lease/Pool、合成文件和发布回调；Python mind/canvas pytest、真实 PostgreSQL、Redis、Provider Run 与生产发布未验收。之前一次 Host 回归因新增写入改变原分页断言的记录顺序失败，调整测试调用时序后 **11/11** 通过。109 个静态工具当前为：已实现待接入 **10**、部分实现 **49**、依赖阻塞 **49**、退役/重设计 **1**；没有工具计为完整验收。

2026-11-18 项目创建/修改/阶段工具及 `get_tool_schema` Web Run 接线：`main.ts` 将共享 PostgreSQL `ProjectCreateRuntime` 与 Core `createDurableProjectMutationPort` 按 lease 注入工具注册器；修改和阶段操作复用既有 `createPostgresProjectUpdateRuntime`、Core 事务与收据。`get_tool_schema` 加入 Web lease 授权但只读取已授权注册器能力。Host `agent-rag-tool-ports.test.ts` **12/12** 通过，实际工具调用覆盖项目创建回读、状态/优先级、颜色、归档/反归档、阶段新增/改名/待办/整体设置/删除、Schema 查询和租约撤销；Core 项目创建/持久修改/阶段/注册器 **100/100**。Host 测试用临时 SQLite，项目 rename/file-count/publish 用合成端口；Core durable suites 的临时文件系统测试另覆盖目录改名、补偿与收据重放。Python pytest 未安装，真实 PostgreSQL/Redis/Provider Run 和生产目录副作用未验收。Web Host production typecheck 被 `main.ts:1720` AgentChatService.wake 及 terminals 的模块导出/`ws` 类型错误阻断，未报告本工具新增接线诊断。当前109个静态工具状态：已实现待接入 **0**、部分实现 **59**、依赖阻塞 **49**、退役/重设计 **1**，完整验收 **0**。

2026-11-18 终端创建、重开、reset/terminate 生命周期及 PTY WebSocket 生产接线：真实 `main.ts → Fastify auth → Host adapter → Core owner/session/Shell/PTY 事务 → PostgreSQL/Redis/MXC 适配` 接通 `POST /api/v1/terminals`、`POST /api/v1/terminals/{terminal_id}/reopen`、`POST /api/v1/terminals/{terminal_id}/reset`、`POST /api/v1/terminals/{terminal_id}/terminate` 与 `/api/v1/terminals/{terminal_id}/ws`。按 Python 路由/授权/生命周期与 WebSocket 源码核对 DTO、owner、Shell/PTY 权限、事件时序、状态保留及错误语义；新增 Core 用例均先因缺失模块失败再通过。最终 Core build 与终端套件 **31/31** 通过；Host production TypeScript 检查通过；本次直接涉及创建、PTY manager/runtime、重开、生命周期、WebSocket 与 egress 的 Host 回归 **21/21** 通过。Host 全终端目录 **50 通过、1 失败、1 跳过**：失败项是旁邻 sandbox-disable 测试的 POSIX config lock Node 26 运行时前置条件，本机 Node 为 v22.23.5；跳过项需隔离 PostgreSQL。Python pytest 未运行（本机 backend pytest 不存在）。Node 集成用临时 SQLite/socket/manager 和合成适配器，不足以证明正式双库 schema；真实 PostgreSQL、Redis、多 Host PTY 恢复、Linux MXC/PTY、出站代理及真实部署尚未验收。运行态 PTY 句柄仅由当前 Host 进程持有，reset/terminate 无法定位仍标 running 的其他实例句柄时 fail closed 返回 503 并保留 DB 状态；未改 Python 参考后端，所有变更留在工作区未提交。
2026-11-18 TS RAG 生产主链与当前树验收：生产入口现为 `main.ts → createApp(agentChat) → Web Run lifecycle → Reconstructor → createWebAgentRagResources → lease-bound RAG registry/context`；不能再沿用此前“main.ts 无 Run caller”的旧快照。正式索引迁移未应用时 Worker 不启动；Node Worker 仍须 `AGENT__RAG_INDEX_WORKER_OWNER=node` 且部署保证唯一消费者，默认 owner 仍是 Python。8 个来源已有 Core/Host 投影（project、calendar、note、scheduled_task、conversation、canvas、knowledge、memory），file 自动索引按 2.0 决策退役；普通 owner memory 文件更新和反思 producer 仍依赖 Python，尚未算 Node producer 迁完。Core RAG **9 文件、69/69**；Host RAG/Run/Worker/Jieba/向量/共享语料 **35 通过、1 Linux-only 跳过、0 失败**；Core 与 Web Host production TypeScript 检查通过。Node 隔离测试用临时 SQLite/FS、合成 lease/Pool/Redis/凭据和 mock embedding/Provider；Python pytest 本机不可用（最近隔离基准 **118/118** 为 11-17 记录）。真实 PG/Redis、真实 Provider、部署恢复和 Node 唯一消费者切换仍待验收。以上是 RAG 代码与装配状态，不作为生产后端切换或真实服务验收证明。
补充 Run 恢复边界回归：Web Reconstructor/持久运行集成 **2 通过、2 个需隔离 PostgreSQL/Redis 的用例跳过、0 失败**；覆盖可信 owner/session memory、取消与 scope/reconstruction 约束。真实 PG/Redis dispatch 与进程恢复仍待验收。

2026-11-18 `ask_user` 普通澄清接入生产 Agent Run：Main per-lease 工厂显式启用，当前 Run 配置过滤、工具发现和执行授权均绑定同一 lease；普通 choice/question 复用 Core interaction coordinator 与 Host PostgreSQL prompt/binding、响应及恢复队列。Host RAG/registry 行为测试 **13/13**、Core prompt-description **2/2**、Core/Host production TypeScript 检查通过。测试未连接真实 PostgreSQL/Redis/Provider；本轮 Python pytest 未运行。表单及 `user_sandbox` 授权仍不开放，`ask_user` 继续标为部分实现。详见[工具行为清单](../testing/node-agent-tools-parity.md)。

2026-11-18 `read_file` 普通文本子集接入生产 Web Run：Main 按 lease 注入文件端口，Host SQL 只按当前 owner 与未删除文件 ID 解析，校验 owner storage key 后使用 `packages/fs.openLocalFile` 在可信存储根内打开；授权配置缺少 Host 端口或当前 lease 时不允许发现/执行。Host 实际 registry dispatch 临时 FS 回归 **1/1**，Core 文件读取行为 **49/49**，Web Host production TypeScript 检查通过；Python pytest/真实 PG 未验收。媒体、历史附件、URL、批量、逻辑路径和 system scope 均仍未迁移，`read_file` 保持部分实现。详见[工具行为清单](../testing/node-agent-tools-parity.md)。

2026-11-18 `send_link_buttons` Web Run 接线：Main per-lease 注入 owner/session/run 匹配的 Web artifact delivery port，生产授权配置、工具发现与 dispatch 都复核当前 PostgreSQL lease；真实生产 registry dispatch 测试验证 URL/按钮结构进入 artifact、租约撤销即拒绝。此实现对应 Python `_send_link_buttons` 的 Web 分支；IM 网关、可信收件人/凭据、持久投递回执及生产服务验收仍缺，工具状态为部分实现。Host `agent-rag-tool-ports.test.ts` + `agent-tool-registry.test.ts` **38/38**，Core build、Web Host production TypeScript 检查及 `git diff --check` 通过；Python pytest 环境不可用，本轮未运行。

2026-11-18 Canvas/Note 配置过滤接线：将 Main provider tool-name 白名单移入既有 Web Agent tool registry 模块，并补入已经实现且由 per-lease 端口控制的 Canvas/Note 名称，修复“registry 有工具但 provider 配置过滤先行丢弃”的不可达断点。registry 最终仍按当前 Run 的领域端口和 dispatch lease 做授权。Host `agent-rag-tool-ports.test.ts` + `agent-tool-registry.test.ts` **39/39**，覆盖白名单拒绝未知名称及实际 Mind registry dispatch；Web Host production TypeScript 检查和 `git diff --check` 通过。Python pytest 不可用，真实 PostgreSQL、Redis 与 Provider Run 未验收。

2026-11-18 Web Run provider 工具白名单与 lease authorization 集合对齐：将联系人写入、项目创建/修改/阶段、工作区更新、`global_search` 等已装配名称加入 Main 配置过滤，并核对 63 个 authorization 名称全部可通过；本轮 `delete_client` 接入后共 64 个 authorization 名称全部可通过；未知名称仍会被过滤，最终发现和调用仍要求 per-lease 真实端口与授权。Host RAG/registry 行为测试 **39/39**，production TypeScript 检查通过；使用临时 SQLite 与合成 lease/端口，真实 PostgreSQL、Provider Run 和 Python pytest 未验收。

2026-11-18 Agent Web 凭据交互生产接线：`POST /api/v1/agent/interactions/{prompt_id}/secrets` 与 `/secrets/cancel` 现经认证 `createApp`、PostgreSQL 同事务适配和 Core secret interaction 用例；写入/取消后复用 dispatch supervisor 唤醒原 Run，恢复记录在锁内认领并交由 Core Harness.resume。字段定义边界先红后绿；Core/Host 定向回归 **6 通过、2 个隔离 PG 用例跳过**，Core build 与 Web Host production build 通过。Python `secret_prompts.py`、`mcp_credentials.py`、`mcp_secret_inputs.py` 与 `test_mcp_settings_api.py` 已源码对照，pytest 未运行。真实 PG/Redis/Agent Run、正式 SQLite、IM staging 多步输入、跨实例 MCP 缓存失效及部署仍未验收。该接线不表示 `/respond` 中 Python `workspace_delete` 和 `filesystem_authorization_grant` 命令副作用已迁移。

2026-11-18 `delete_client` Core 工具切片：沿用联系人工具组目录，新增 owner-scoped 单个/批量删除、精确目标快照、持久确认与事务 claim、目标行锁/版本复核和操作收据；Host 只有在可信确认及一次性 claim 端口齐备时才发现工具，配置过滤与 lease authorization 已加入工具名。Core `clients.test.ts` **20/20**，Host RAG/registry **41/41**；新增生产授权组合测试经真实 Core SQLite 注册器执行创建→确认等待→删除，并验证租约撤销后拒绝第二次删除。其他用例覆盖越权/缺失目标、批量结果、目标并发变化回滚、claim 拒绝与 Host 缺能力隐藏；Python 兼容回归还固定批量缺失 ID 错误和 `client_id=0` 名称回退。Python `test_confirm_gate.py -k "delete_client or batch_delete_grant"` **4 通过、37 deselected**；测试依赖安装在临时目录，使用不存在的临时 env 路径、内存 SQLite、fake Redis 与临时存储，未改 Python 代码。Node 测试使用临时 SQLite、合成确认/claim 和合成 PostgreSQL lease 查询；真实 PostgreSQL、Provider Run 和跨进程确认恢复未验收。Host production `tsc --noEmit` 本轮失败于共享工作区 `agent-interaction-command-effects.ts` 隐式 any 及终端 `ws` 类型缺失，本切片文件无诊断；`git diff --check` 通过。工具状态保持“部分实现”，不将合成事务等同真实 PG 验收。

2026-11-18 Agent Interaction 响应与恢复闭环更正：生产 `main.ts` 当前将 `agentInteractionRespond` 接入 `createApp`，恢复引用与 prompt/action 消费共用 PostgreSQL 事务，提交后唤醒 `createWebAgentRunLifecycle`；dispatch 在 waiting checkpoint 下锁内 claim，再由 Core `AgentRunner.resume` 恢复。工作区删除复用 Core `createWorkspaceDeleter` 与现有 PG transaction port；`filesystem_authorization_grant` 新增 Core owner/开关/幂等规则及 Host PG 授权/90 天安全审计适配，`confirm_code` 继续通过 Redis 一次性兑换。`respond`、`resume`、`resume-text` 及 secret submit/cancel 均进入这条生产装配链。交互 Node 回归 **29 通过、3 个隔离 PG 用例跳过**，Core 与 Web Host production build 通过；Python `test_workspace_delete_requires_explicit_confirmation`、`test_ask_user_can_request_fixed_filesystem_authorization`、`test_interaction_protocol.py` 及授权审计基线已对照源码，本轮 pytest 未运行。实际 PG/Redis/Run 重启恢复、正式 SQLite 与部署未验收；上方 11-17 的“尚未装配”记录是历史快照，按本条更正。

2026-11-18 TS RAG 主链定向复验：Core RAG **9 个文件、69/69**；Host RAG registry/资源、Reconstructor、持久 Worker/索引损坏恢复、owner memory store、Jieba 固定语料和 embedding transport 合批 **34 通过、2 跳过、0 失败**；跳过项需要隔离 PostgreSQL/Redis 重启环境与 Linux 安全原子文件写入。Web Host production TypeScript 检查通过。修复了生产 RAG 检索将可关闭 Node Provider transport 当作共享实例复用的问题：索引重建保留独立生命周期，检索每次 embedding 创建新 transport；新增 loopback HTTP 回归验证第一次查询关闭实例后第二次仍能取到真实向量（Host RAG 合批现为 34 通过）。Python pytest 本机不可用，最近隔离 Python/Cython RAG 行为组记录为 **118/118**（11-17），本轮未重跑。Node 使用临时 SQLite/FS、合成 lease/Pool/Redis 与 mock embedding/Provider；真实 PostgreSQL、Redis、Provider、部署恢复和 Node Worker 唯一消费者切换未验收。普通 owner memory 更新/反思生产者仍由 Python 执行。

2026-11-18 交互及定时任务回归：修复普通选择和问答选项的 `selected` 回执无法由 PG dispatch 恢复的问题。保留旧 HTTP 回执及选项内容，在进入 Core Harness 前映射为 `answered`。隔离 PostgreSQL 用例先因「交互恢复结果无效」失败，随后调度组 7/7。定时任务立即运行对照 Python `execute_task`，试运行拿锁后按 owner 复查启用及结束状态，失败的一次性任务交由正式重试流程。停用竞态在 devserver 先失败，修复后 Host 认证及正式临时 SQLite 回归 2/2，Redis 使用测试替身。Devserver Core build 通过，Host 生产类型检查报告终端 WebSocket 的 `ws` 类型声明缺失。本地 Web Host production build 通过。Python pytest 未运行。立即运行仍缺生产定时 Agent 执行器、渠道投递和 `main.ts` 装配。

2026-11-18 RAG 首次入队并发与 Agent 恢复复验。Core 启动扫描发现 owner/来源缺少索引及任务时，使用对应唯一键处理并发插入，保留先写入任务的来源 ID、待处理集合和 generation，并继续扫描其他来源。devserver 新增 SQLite 回归先复现唯一键失败，修复后 Worker 与会话搜索 **15/15**。临时 PostgreSQL 的队列与索引迁移 **6/6**，覆盖数据库中的真实事务锁竞争、迁移认领和不兼容表拒绝。临时 PostgreSQL/Redis 的 Agent 调度和重建 **5/5**，覆盖排队取消、后续 Run、outbox 重放、历史搜索工具续轮，以及 Provider 已开始后中断时的 unknown 恢复。修正了原调度夹具缺少交互表，以及重启夹具在 Provider 调用之前提前中断的问题，保留原有断言。该重建用例的历史索引使用临时 SQLite，Provider 为合成 transport。旧 Python 持久 RAG 队列 **3/3**，使用内存 SQLite 和 fake Redis。部署中的消费者切换、普通 owner 反思写入迁移和真实 Provider 验收仍待完成。

2026-11-18 定时任务飞书试投递：`POST /api/v1/scheduled-tasks/test-notify` 的飞书分支已由认证 Host 经 Core 通知计划、owner PostgreSQL 目标校验、凭据解密及安全 Node Provider transport 接入。群目标验证早于任意渠道副作用，发送前复查启用 Bot。先因缺少模块失败，devserver Core 与 Host 回归 7/7，本地生产构建通过。对照 Python `_resolve_im_delivery`、`deliver_to_channels` 和 `test_im_group_delivery_target_is_scoped_to_users_current_bot`，pytest 未执行。试投递采用飞书纯文本，旧 Redis 私聊地址回退、富文本卡片、推送会话历史、其他 IM 平台及真实部署仍待迁移或验收，定时任务 `/run` 生产 Agent 执行链尚未接入。

2026-11-18 Web 历史检索 PostgreSQL 调用链复验。Reconstructor 重启用例改用同一临时 PostgreSQL schema 存放两名用户的会话事实和正式索引。测试执行正式索引迁移，经 Host 会话入队与 Core Worker 生成索引，再经 Web RAG 资源和注册器调用 `search_conversations`。验证自己的历史进入 Provider 续轮、另一名用户的内容不可见，以及恢复、取消和重复执行边界。合并索引迁移、队列、Agent 持久运行和重启回归 **11/11**，使用临时 PostgreSQL、Redis 与合成 Provider。此记录覆盖上一轮 SQLite 历史夹具的验收缺口。真实 Provider 与线上 Worker 切换仍待验收。

飞书试投递回退增量：旧 `im` 别名使用已绑定的私聊地址，缺绑定时允许同 owner、同启用飞书 Bot 的 Redis 私聊记录；拒绝群地址、异 Bot 及非飞书记录。平台停用、Bot 更换或私聊绑定变化时，发送前拒绝继续。针对缓存回退先红后绿，devserver 合批 8/8，本地隔离 PostgreSQL 组 4/4，验证群的 owner/Bot 约束和真实信封解密。Redis 和飞书在测试中使用替身，Python pytest 与外部服务部署未验收。

2026-11-18 RAG 全量与增量任务合并。日历、笔记、画布与项目的写入路径现在保留尚未完成的整来源重建。期间发生写入时，队列推进 generation、撤销旧租约，下一轮按新资料重建整个来源。完成后后续写入恢复按实体更新。Python 在 Node 负责消费时也保留待执行的全量范围，Python 自己消费时沿用原行为。另统一了项目和日历提交后入队的 PostgreSQL 参数类型，修复使用 text 来源 ID 列时触发的 42P08。隔离回归覆盖 PostgreSQL、SQLite 和 Python 生产者。该修复处理已经排队的全量任务。切换已有环境时仍需通过正式重建流程补投影，并核实部署中的消费者归属。

微信试投递增量：`POST /api/v1/scheduled-tasks/test-notify` 从认证 owner 的 Redis 私聊路由取收件人和 context_token，按启用 Bot 限定并在发送前复查。Host 使用可信的固定 iLink 源站和安全传输，业务失败返回失败状态且不重发。对照 Python `owner_private_targets`、`ILinkClient.send_text` 及入站 context_token 回归。Devserver 合批 9 通过、1 个隔离 PG 跳过，本地隔离 PG 组 5/5，Web Host 生产类型检查通过。Redis 与 iLink 使用合成响应。真实服务、推送历史、其他未接 IM 渠道及定时 `/run` 的生产 Agent 链仍未验收或接入。

2026-11-18 Node RAG 接管补建。Web Host 现提供 `migrate:rag-index:queue-baseline`，要求 RAG schema 已应用、队列表位于同一 schema，且命令显式选择 Node 消费者。它为已有用户的八种来源排入完整重建，包括已有增量任务或旧索引的用户。队列更新和一次性记录共用 PostgreSQL 事务，并发重跑只提交一次，入队失败回滚。临时 PostgreSQL/Redis 的迁移、队列、持久运行、重启和会话工具续轮 **13/13**。端到端用例从接管补建任务构建会话索引，验证 owner 隔离。Provider 为合成依赖，线上切换与实际补建尚未执行。

QQ 试投递增量：`POST /api/v1/scheduled-tasks/test-notify` 已由 Host 复用 Core 的单群规则和旧 `qq_delivery` 字段，按 owner 与启用 Bot 验证群或私聊。旧 `im` 别名只允许同 Bot 私聊缓存。生产使用固定 QQ 鉴权及消息地址，沙箱仍用独立地址，消息无回执或业务失败时不报告成功。按 Python `_resolve_web_delivery_targets`、`send_c2c`、`send_group` 及旧群作用域用例源码对照。Devserver 先因缺适配器失败，合批 11 通过、1 隔离 PG 跳过；本地隔离 PG 组 6/6，Web Host 生产类型检查通过。使用合成 QQ 传输和隔离表，Python pytest、真实 QQ 配额与投递、Markdown 和投递历史仍未验收或迁移。Telegram 试投递与定时 `/run` 生产执行链仍未接入。

2026-11-18 八类来源的 PostgreSQL 接管消费验收。测试在临时 PostgreSQL schema 与授权文件根中创建两名用户，由补建命令排入 16 条任务，经生产 Host Worker 将项目、日历、便签、画布、定时任务、会话、知识和记忆全部投影到正式索引。验证了跨用户隔离和群记忆删除屏障。修复了无知识文件的用户缺少时间格式标记时错误重试的问题。空来源正常完成，非空旧目录仍要求先迁移时间格式，失败时保留已有投影。Host 合批 **23/23**，包括 PostgreSQL/Redis 恢复、迁移和 SQLite/临时文件知识工具写入；外部 Provider 为合成依赖。

定时执行准备增量：`/run` 的 Host 组合在租约内通过 Core 按 owner 读取任务内容、活动渠道及投递范围，保留授权工具、附件、工作区和文件系统授权引用。正式重试遇到旧多群记录时先于开始状态写入返回错误，保留上次失败状态。对照 Python `execute_task` 的活动目标过滤和单群边界。Devserver 的运行回归先失败，修复后 Core 8/8、Host 7/7，使用正式临时 SQLite 与合成 Redis。Core 构建受并行 IM、笔记和 Skill 工具类型诊断阻断，Host 定向运行使用该次生成的 JS。正式 PG、真实 Redis、Python pytest、生产 Agent/渠道投递和 `main.ts` 装配仍待验收或接入。

定时执行编排增量：Core 依据 Python `_run_agent_execution` 将定时提示词和 owner 快照传给 attempt 端口，只对已确认无副作用的失败重试一次。可能已有写入或异常时不重放，最终正文与保留的附件交给一次投递。Web Host run-now runtime 在任务租约内使用此编排。Devserver 新用例先因函数缺失失败，最终 Core 10/10、Host 7/7 和 Core build 通过。测试用合成 attempt/投递和 Redis，使用正式临时 SQLite；Python pytest 未运行。Host 生产类型检查受并行 main.ts 回执类型和终端 ws 声明缺失阻断。生产 Agent attempt、按固定收件人和附件投递的实现与主入口装配待完成。

定时结果文字投递增量：Host 从 Core 执行快照选取保存的 Bot 与收件人。飞书和 QQ 群要求 owner、Bot 和群会话一致，微信按相同 owner、Bot 和收件人更新 context_token。缺少有效的保存目标时不改发其他地址；旧任务没有保存目标时兼容同 Bot 私聊。网页、邮件及 IM 分别报告未投递的附件，避免一次性任务误判为完整送达。devserver 使用同版本 Core 源码合批 16 通过、1 个隔离 PG 跳过；Python 旧 pytest 在隔离环境串行通过 5 项；本地隔离 PostgreSQL 投递组 7/7，验证保存的飞书 Bot、owner 隔离和撤销群归属。使用合成 Redis 和服务响应。Host 生产类型检查仍受其他模块诊断阻断。`/run` 的 Agent attempt、主入口、附件、IM 推送历史和 Worker 尚未接通，SQLite 投递、真实服务和部署未验收。

定时结果邮件附件增量：Core 根据旧 Python 附件约束解析 owner 引用，去重并校验 5 件、单件 10 MB 和合计 25 MB，实际读取字节再次校验。Host 按 owner 查询有效文件，复用聊天附件下载器读取本轮产物，由 Nodemailer 生成普通 MIME 附件。附件异常时整封邮件不发送。devserver 新用例先因附件未接入而失败，最终 Host 合批 18 通过、2 个隔离 PG 跳过，Core 类型检查通过。以实际续租事件替代原续租用例的固定等待，保留原断言。隔离 Python 邮件附件及定时投递 pytest 17/17，本地隔离 PostgreSQL 验证有效文件、越权、软删除与跨 owner 路径。使用合成 SMTP 及本地 MIME 编码，SQLite 邮件投递和真实服务未验收。`/run` 仍待生产 Agent attempt 和主入口装配，IM 附件和推送历史仍待迁移。

定时 Agent 结果与工作区复核增量：Core 复用 Harness 定时模式，直接读取最终 checkpoint 的正文、附件和已确认的工具副作用，异主或不确定终态不投递、不自动重放。正式重试在租约内复用 owner 工作区及目标查询，停用、软删除与异主目录均在开始态写入前返回失败。devserver Core 先因缺少 Harness 调用而失败，修复后 78/78，Core 类型检查通过。隔离 PostgreSQL 先复现失效目录仍执行，修复后 Host 隔离 PostgreSQL/SQLite 2/2。旧 Python 定时执行与工作区 pytest 30/30。Harness 测试使用合成 Provider 和资源准备端口，Host 工作区测试使用隔离 PostgreSQL 表；生产定时主体的上下文、BYOK、工具授权、物理挂载与主入口尚待接线。

定时任务文件系统授权复核：在租约内以当前数据库记录核对任务指向的完整用户沙箱授权。验证 owner、主体类型和任务 ID、读写权限、作用域、有效期与撤销状态，同时检查功能开关和日历提醒限制。未绑定授权时不采用同主体的其他记录。隔离 PostgreSQL 先复现撤权后仍传旧授权 ID，修复后 Host 隔离 PostgreSQL/SQLite 2/2。devserver Core 15/15，旧 Python 工作区与授权 pytest 10/10。当前只验证执行准备，真实工具调度仍需在执行前重查权限。

定时群聊归属增量：Core 在租约内确认活动目标的平台、owner、启用 Bot 与群会话，传入可信群范围。保存目标解析复用到飞书、QQ 和微信结果投递。未选渠道的旧群不参与执行，失效或畸形群目标在 Agent 和投递之前返回错误。隔离 PostgreSQL 先复现异主群仍执行，修复后 Host PostgreSQL/SQLite 2/2，devserver Host 定向 18 通过、3 个隔离 PG 跳过，Core 立即运行 15/15、试投递 3/3，旧 Python 群上下文和投递目标 54/54。当时群记忆和群历史读取端口仍待此范围装配，SQLite 无 IM Bot 账户表，真实 IM 服务与生产 `/run` 尚未验收。

定时群记忆增量：Web Host 复用有界 Local 记忆读取，Core 按已验证的群范围检查删除标记、读取 summary/profile 并按 Python 格式拼到任务指令前。单份最多 50 条，公开记忆正文合计 3000 个字符。每次尝试重新读取，并在读取后复核群归属。隔离 PostgreSQL/Local 用例先因提示词缺少群记忆失败，修复后 Host 隔离组 2/2，覆盖跨 owner/Bot/群隔离、非公开文件排除及首次尝试结束后标记删除。devserver Core 15/15，Host 18 通过、3 个隔离 PG 跳过，旧 Python 群上下文 pytest 11/11。Core 全量类型检查受并行邮件模块的 parse5 依赖缺失阻断。生产 Agent 与主入口仍待接线。

定时群历史搜索增量：Host 执行准备向当前定时 Run 提供共享 `group_context_search`。Core 复用群历史 SQL 与成员匹配，查询前后复核任务、Run、owner、平台、Bot 和群；别名只从当前群的 members.json 读取，已删除记忆的文件不参与。隔离 PostgreSQL 先因工具未提供失败，修复后 Host 隔离组 2/2，覆盖跨 owner/Bot/平台/群隔离、结构化消息过滤、自动重查撤权和关键词组合。devserver Core 19/19、Host 18 通过和 3 个隔离 PG 跳过，Python 定向 5 通过、44 未选中。本次 Host 合批通过临时测试配置映射锁文件已有的 parse5，未改工作区依赖。后续已由生产 `main.ts` 定时运行入口装配并验证群搜索结果进入 Provider 续轮、失效目标在续轮前拒绝；Core 26/26、Host 8/8、旧 Python IM 102/102 的行为对照见回归清单。当前状态为“部分实现”：实时 IM Gateway 仍没有 `group_context_search` 调用方，外部渠道与生产部署未验收。

定时 Agent 模型绑定增量：Host attempt 采用由任务 owner 和任务 ID 派生的定时上下文身份，每次尝试生成新 Run ID。复用现有受控配置快照、PostgreSQL BYOK 解封及平台模型回落。按旧 Python 定时执行关闭推理状态续接，完成或准备失败都释放绑定，拒绝异主访问和释放后调用。隔离 PostgreSQL 先因缺适配器红灯，修复后定向 1/1。devserver Host 配置绑定及定时合批 22 通过、4 个隔离 PG 跳过，Python BYOK 对照 2/2。测试使用合成凭据与 Harness 终态，未调用真实 Provider。生产 Harness、任务上下文和 `/run` 入口尚待装配。

定时 Harness 增量：Host attempt 从同一任务 owner 模型绑定和准备端口构造实际 Core Agent Runtime。进程内 checkpoint 按单次 Run 校验身份、版本和所有权，退出后释放；不会给 Web 会话写入事件或聊天历史。拒绝已有会话消息和异任务授权主体，禁用交互等待与跨次续接。隔离 PostgreSQL 用例先因 Harness 缺失失败，最终通过真实模型驱动、合成 Provider 响应和工具续轮验证，非法上下文未发出模型请求。devserver Core 78/78，Host 18 通过、4 个隔离 PG 跳过，定向类型检查通过，旧 Python 定时执行与工作区 pytest 30/30。本地隔离 PG 1/1。真实任务用户上下文、工具资源及 `/run` 入口尚待装配。

定时用量结算增量：Host 复用 PostgreSQL Agent 账本与六小时额度窗口，按 task owner、绑定模型和实际 Harness 终态用量写入 `scheduled` 记录，`session_id` 与 `input_source` 留空，平台封顶与 BYOK 免封顶按旧 Python。失败后重试的两次模型调用分别结算，账本写入失败不重放工具或丢弃已生成结果。隔离 PostgreSQL 先复现定时耗用未入账，修复后定时与聊天用量组 5/5。devserver Core 12/12、Host 21 通过、5 个隔离 PG 跳过，定向类型检查通过。Python 定时执行及用量 pytest 32/32，Provider 输入输出为合成数据。生产上下文、工具和 `/run` 入口尚未接通。

2026-11-18 Agent 技能删除。Web 生产 registry 按租约启用共享技能管理组。用户管理技能需要确认，提示显示当前用户的技能名称和稳定 ID。确认后校验内容版本，确认认领、删除和操作收据同事务提交。咕咕管理的技能可直接删除，但仍在同一事务中复核 owner、当前 Run 租约和访问版本，提交后沿用技能刷新通知。隔离 PostgreSQL 回归覆盖两个分支、陈旧确认、撤权拒绝、跨 owner 与收据重放。Host 本轮覆盖 7 个独立用例，Python 定向基准 2 通过、21 未选中。Host 确认意图和授权事件使用合成依赖，真实 Provider 续轮与跨进程确认恢复仍待验收。

2026-11-18 笔记写入与索引调用链验收。生产 Web 注册器通过 PostgreSQL 活动租约分派 `note_create` 和 `note_update`，复用 Mind 写入、Undo、调用收据与持久 RAG Worker。回归覆盖旧结构化输入、可信时区日期、异主引用拒绝、混合编辑参数提示、过时行内容拒绝、收据重放、租约撤销，以及索引替换旧正文。Host 定向 15 项、Core 笔记 1 项、Python 笔记 6 项通过，另有 Python 8 项未选中。Core 构建通过，Host 类型检查仅剩终端 ws 类型诊断。使用临时 PostgreSQL、SQLite、文件目录与合成通知回调。真实 Provider 待验收。

2026-11-18 定时任务删除 Web 工具验收。生产 Host 按当前租约装配持久确认，摘要显示当前用户的独立任务名称和目标数量。隔离 PostgreSQL 测试经生产注册器执行工具，验证异主任务和日历提醒不可删、伪造回执无效、确认认领和 RAG 入队失败时全部回滚、操作回执可重放、重建后索引产生墓碑。Host 确认及定时任务合批 6/6，Core SQLite 1/1，旧 Python 确认回归 2/2（39 项未选中，Redis 使用替身）。已修复相邻 PG 测试对同一连接池的重复关闭。测试中的 Web 确认后投影和通知回调为合成依赖，未验证真实 Provider、Redis 通知或定时执行消费者。

同批复验 Web RAG 主链。隔离 PostgreSQL 的索引迁移、八类来源与事务队列测试合批 11 通过、1 项因未提供 Redis 跳过。随后使用临时 PostgreSQL 和 Redis 运行 Web Reconstructor、定时任务和确认回归，9 通过、0 失败、0 跳过，补验了 `search_conversations` 从正式索引进入合成 Provider 续轮以及运行重建。Node 索引消费者仍由部署配置显式选择，未执行线上切换。Core 构建通过，Host 生产类型检查剩终端 WebSocket 的 `ws` 声明问题。

2026-11-18 定时任务创建和更新的工具事务补验。Core 工具组通过公开导出复用 Web PostgreSQL 共享写入。跨 owner 工作区和附件从未知提交状态改为 Python 对应的安全业务错误。隔离 PostgreSQL 组合用例验证非法时间、微秒精度、失败后的任务/索引队列/收据回滚及同一调用的幂等重放，1/1 通过。Core 调度写入与删除 4/4 通过，旧 Python 调度与工作区 3/3 通过，另有 37 项未选中。生产 Agent 注册仍需可信定期消费者、投递和持久权限能力；本用例使用合成授权和通知。

2026-11-18 Web Agent 邮件工具接入。生产 Web Run 在启用持久确认时通过同一租约注册 send_email，复用 owner 账号或联系人邮箱、授权附件、SMTP 配置、模板和安全 HTML 清理。确认摘要包括掩码收件人、主题、正文长度与附件；确认认领与尝试收据同事务，恢复只读结果，SMTP 结果未知时不重发。隔离 PostgreSQL 条件下 Host 邮件及可信确认 7/7，Core 邮件 3/3，旧 Python 邮件与附件 27/27，均无跳过。测试使用合成已确认投影及合成 SMTP。已锁定的 parse5 通过 devserver 临时依赖链接完成复验，链接已清理。Core 构建通过，Host 生产类型检查仍有终端 ws 声明诊断。真实 SMTP 和定时自动化免确认仍待验收。

2026-11-18 知识删除接入生产 Web Run。Linux Host 在持久确认和操作收据可用时提供 owner-only delete_knowledge。确认认领、文件版本计划和目标索引撤回同事务；Markdown 原子标记停用，保留正文与历史。若文件写入后数据库提交失败，重新装配运行可按已批准的原操作与文件摘要恢复入队并重放收据。隔离 PostgreSQL、SQLite 和临时文件的 Host 知识/RAG 合批 4/4，覆盖伪造回执、单条撤回、保留其它知识、文件写入后 SQL 失败、收据恢复及禁止旧版本复活。旧版知识删除与拒绝更新 pytest 3/3，33 项未选中。确认 gate 的批准数据为合成依赖，实际 Redis 用户确认、Provider 续轮、进程级故障及混合版本写入未验收。Core 构建通过，Host 类型检查仍有终端 ws 声明诊断。

2026-11-18 知识删除可信确认复验。隔离 PostgreSQL 回归改用生产加密意图仓储和 lease 权限复核。强制计划事务失败时验证原意图未消费、文件仍活跃且索引保留；强制文件写入后的 SQL 失败时验证意图已认领、只撤回目标索引，并由重新装配的注册器恢复。Node 知识和 RAG 合批 4/4，旧 Python 知识全文件 36/36，无跳过。旧版 Cython 和 rjieba 仅在临时依赖目录中构建或安装。用户点击确认后的 Web 投影由测试构造，实际 Redis 确认入口及外部 Provider 未调用。

2026-11-18 项目删除文件移动日志。Core 将正向项目删除和恢复交给共享 PostgreSQL 日志适配器，在同一跨进程锁持有期间先记录文件 ID 和源、目标路径，再执行物理移动。恢复等待 Core 操作锁，依据真实删除调用收据选择方向，再用当前 owner 文件记录校验路径和软删状态。有冲突时保留路径及日志。Core build、定向 1/1、隔离 PostgreSQL 与 Local/Undo 合批 13/13、旧 Python 删除及确认 3/3（59 项未选中）。Core 定向运行使用临时 Vitest 配置绕过当前工作区测试分类清单漂移，原清单未改。生产 Agent 注册、孤儿恢复调度及与 Web 文件写入的并发验收仍待完成。

2026-11-18 项目删除接入生产 Linux Web Agent。Host 在文件日志 schema、持久确认和 Core 收据可用时按租约启用 delete_project。恢复 Worker 在启动和后台周期运行，关闭连接池前等待在途扫描，跳过执行锁和文件行锁，已有冲突不阻断其它日志。日志连接独立于业务连接，提交后发布在释放日志锁后运行。项目回收站和改名在物理变更前锁定对应文件记录；项目、日历和提醒的重建任务与级联删除及调用收据同事务。隔离 PostgreSQL、SQLite 和临时文件验证注册器调用、真实回收站移动、强制索引入队失败后的回滚、后台跳过锁及收据重放。Host 26/26，Core 1/1，旧 Python 3/3（59 项未选中）。用例使用合成确认 gate 与通知，没有连接真实 Redis 确认或外部 Provider。Core 构建通过，Host 生产类型检查仍报终端 ws 声明问题。

2026-11-18 定时任务 owner 上下文。Core 新增定时上下文加载，复用项目、日历、文件、IM 频道、偏好、记忆和知识概览；PostgreSQL 以已启用任务和 owner 校验读取主体，Local 按 owner 直读。知识注入标题与概览，任务消息仅供本次模型请求。Harness 冻结标准能力准备后的固定前缀、工具与技能目录及本轮时区时间，模型首轮和工具续轮读取同一版上下文。Core 用例先因加载器缺失失败，devserver 合批 15/15；本地临时 PostgreSQL/Local 用例先复现 Provider 丢失 owner 前缀和准备后的能力目录，修复后含聊天来源相邻回归 8/8。旧 Python 定时执行及群上下文 pytest 31/31，devserver 定向类型检查通过。隔离 PostgreSQL 使用精简表，IM 状态使用合成 Redis 值，工具目录和 Provider 传输使用合成数据。生产 /run 入口、定时专用工具授权、工作区物理挂载、调度 Worker、正式 SQLite 与外部服务仍待接入或验证。

2026-11-18 定时任务 Redis 租约接管回归。外层 Runner 将当前锁的校验传给执行编排与 Agent Harness。在模型尝试、失败重试、模型绑定解析、工具及其执行器、结果投递前检查锁 token；Redis 不可用时停止新的外部操作。Core 测试先复现旧执行仍投递或重试，修复后 devserver 合批 17/17。Host/Fastify 调度合批 8 通过、2 个隔离服务用例跳过，定向类型检查通过（临时配置映射锁文件中的依赖声明）。本地临时 PostgreSQL、正式临时 SQLite、Redis 和 Local 合批 11/11，无跳过，覆盖旧运行失租后保留新锁、禁止工具续轮与投递。Provider、IM 渠道和工具能力目录使用合成依赖。生产入口及真实部署尚待验收。

2026-11-18 公网文件下载接入 Web Agent。生产 Host 按租约公开 web_download，复用固定目标的安全出站、共享暂存、owner 目录/项目解析、Local 不覆盖发布和配额账本。提交前重验租约，文件、配额和调用收据同事务；回执中的 source_url 脱去查询参数及片段。隔离 PostgreSQL 和 Local 文件验证默认个人落点、项目文件夹推断、异主目录、拒绝重定向、流超限及取消、下载期间撤销租约、提交后断连及无网络重放。Host 8/8、Core 9/9、旧 Python 4/4。公网流为合成依赖，安全出站另经模拟代理验证。显式会话绑定工作区、真实远端和未提交时留下孤儿文件的自动清理尚待验收或实现。Core 构建通过，Host 生产类型检查剩终端 ws 声明诊断。

2026-11-18 定时只读工具与技能。Core 复用共享注册器发现和分派，按任务 owner、task ID、Run ID、Redis 租约及当前任务状态授权，无需交互会话。Host 装配时间、项目、联系人、日历、近期事项、定时任务、授权群历史及技能只读端口；任务中保存的工具名称不能自动开放未接入确认的写工具。技能通过 PostgreSQL owner 目录与启用状态读取正文，受限群历史仍独立校验群、Bot 与停用状态，相关工具 Schema 仅从当前任务注册器获取。先因缺装配失败，补齐后 devserver 路由及运行回归 3 通过、2 个隔离服务用例跳过；本地隔离 PostgreSQL、正式临时 SQLite、Redis、Local 合批 12/12，复用了真实时钟进入合成 Provider 的工具续轮。Python 定时执行及群上下文 pytest 31/31。生产 /run 入口、定时 MCP 调用、自动授权写入与工作区、定时 Worker 和真实部署仍待接入或验收。

2026-11-18 remember 的 PostgreSQL 和 Local 写入端口。Core 工具依旧负责模糊增删，Host 在 owner 锁下暂存档案并以持久摘要检查版本。文件写入后只完成原计划的收据和索引入队，旧计划不得覆盖更新的档案。pattern 删除或内容修改时撤回旧向量，保留仍匹配的缓存。数据库操作收据不复制记忆正文。隔离 PostgreSQL 和临时文件组合 1/1，Core 2/2、旧 Python 6/6。覆盖真实工具分派、画像旧格式、异主/撤权、符号链接、提交失败恢复、并发版本和非目标画像索引保留。权限端口使用合成数据；Python 反思与管理写入、Node 管理向量重建尚未共享同一写入权威，新 pattern 向量刷新及生产 Agent 注册待接入。Host 生产类型检查仍有终端 ws 声明问题。

2026-11-18 定时任务 MCP HTTP。Host 复用 owner 限定的持久工具目录和官方 Node SDK runtime，经同一任务租约将获准工具加入 Core 发现和分派。空授权列表只允许自动模式服务器，非空列表按保存的工具名筛选，历史显式授权被撤后不能在同一轮改走自动授权。握手结束且参数校验完成后，再复核服务器版本、确认模式、任务 owner、当前授权和 Redis 租约才发出 tools/call。断连保留未知执行结果。新回归先因工具未发现失败，后复现握手失租仍外呼，两处修复后本地临时 PostgreSQL、Redis、SQLite 和合成 HTTP 服务合批 28/28。devserver Node 24 通过、3 个隔离服务用例跳过，旧 Python 定时执行和 MCP manager pytest 30/30。定向类型校验被共享工作区并行修改的 MCP 管理符号缺失阻断，本切片文件未报告类型错误。没有调用外部 MCP 或启用 stdio。生产 /run 主入口仍待装配。

2026-11-18 Python owner 记忆写入并发基准补齐。读取有效 pattern 时不再写回旧快照。只有确认主文件缺失才迁移旧 facts，等待文件锁后重新读取当前数据。反思、remember 和 /forget 依据实际版本应用增删，冲突时在新版本上计算。已批准的管理维护遇到版本变化返回 409。增量向量发布重验其 pattern 版本，拒绝旧模型结果覆盖新缓存。旧 Python 记忆命令、档案、迁移及反思合批 82/82，使用临时目录和合成 Redis/embedding。跨进程 Python/Node 写锁和 Node 管理向量写入仍待统一，生产 Web remember 保持关闭。

2026-11-18 Node Web 管理向量重建已与 remember 写入端口共用 PostgreSQL owner 锁。模型请求在锁外，发布 pattern 或长期记忆向量前再次加锁并核对有效正文。若正文已变化，本次向量重建报告失败，保留更新后的缓存，并继续独立的正式 RAG 索引刷新。已有 pattern 主文件损坏时停止旧 facts 回填。Python 反思、压缩与维护程序的跨进程写入仍待纳入同一机制，新 pattern 的增量向量刷新也待接入，生产 Web remember 继续关闭。

重建及会话主链复验。Core 向量重建 4/4，Web Host 合批 16/16，Python 记忆存储、迁移、批量向量重建及 BYOK 55/55，无失败或跳过。Node 使用临时 PostgreSQL、Redis 和合成档案，验证偏好和长期记忆更新后拒绝发布旧向量、损坏主档案不会复活旧数据、持久会话索引更新，以及 Web Run 重启后仍能通过生产注册器检索授权历史。模型和向量生成使用合成依赖。Core 构建与 Web Host 生产类型检查通过，类型检查使用临时链接补齐锁文件已声明的 ws 类型。

2026-11-18 RAG 查询向量缓存按可信 owner、实际端点、凭据和模型请求配置隔离。同一 owner 的相同查询可以复用，换用户、端点或凭据后重新请求；生成记忆档案向量不参与查询缓存。Web remember 写入端口在持久收据提交后，复核授权并按需补齐当前模型缺失的偏好向量。若生成期间档案或缓存变化，保留更新版本；嵌入失败时保留已提交的记忆。Node 和 Python 仍需共用跨进程写入权威，生产 remember 保持关闭。

2026-11-18 Node 作为 2.0 Web RAG 的唯一索引消费者。已移除 Host 消费者选择和补建命令的 Python 配置依赖。索引迁移就绪后 Host 启动 Node Worker，来源不齐时拒绝启动。撤回 Python 共享写锁的过渡实现。Node `remember` 已装入 Web Run，由 Linux 安全文件写入、PostgreSQL 收据和 Node 索引 Worker 就绪状态控制启用。计划、发布和恢复按用户协调，档案导入或回滚活跃时拒绝新计划、保留待核对的恢复状态。已变化的档案任务版本阻止待发布计划重放。部署切换、生产配置和真实 Provider 尚未验收。

2026-11-18 Web Host 运行资产迁出后端目录。对话、定时任务、模型绑定版本读取、管理员提示词与 IM 维护使用 Web Host 随包的 10 份提示词，注册引导音频也由 Host 打包。部署定义复制 Host 的 `assets/` 与 `dist/`，编译后的资产读取器已在没有 `backend/` 的临时发布目录实际加载。Node 29/29，覆盖提示词热更新、Admin 权限、IM 压缩和预览、引导音频及隔离 PostgreSQL 下的注册和定时 Agent。Provider 使用合成依赖。完整生产部署和仍引用后端目录的配置、日志路径待处理。

2026-11-18 Web Host 运行配置、管理员日志和 BYOK 密钥位置已脱离后端目录。配置默认读取 Host 包内 `config.override.json`，日志默认读取 Host 包内 `logs/`，部署显式路径优先，Compose 继续使用挂载卷中的配置。BYOK 主密钥由部署环境或工作区外的显式文件提供，缺少密钥时凭据操作返回配置错误。先前已加密凭据需保留对应密钥。Node 配置锁保留原子写入和拒绝覆盖无效文档的行为。此轮没有读写运行中的用户配置或密钥。管理员旧服务重启入口及剩余后台任务仍待迁移。

2026-11-18 管理员服务重启改为 Node Host 进程内的后台任务生命周期。重启等待已启用的 RAG、定时任务、项目删除恢复和安全清理停止，再启动新实例。并发请求合并，Host 关闭期间停止接续启动，旧实例停止失败时保持失败状态。服务面板以本机生命周期显示后台任务；Node 网关控制未接入时显示离线并禁用重启。移除了读取旧进程启动环境、发进程信号和重新启动 Python 的入口。隔离 PostgreSQL/Redis 的 Host 定向回归 18/18，RAG 队列使用临时 SQLite，定时任务模型使用合成 HTTP Provider。生产部署及 Node 网关仍待验收。

2026-11-18 Web owner 反思使用 Node 独立 Redis 队列。已完成 Run 按标识去重入队，保留轮数阈值和闲置触发。领取绑定 owner 和 session，同一模型与访问作用域的连续回合组成固定批次；进程退出和租约过期后可按相同批次重新领取。回执核对租约和队首后才移除已处理回合，之后追加的回合继续按自己的阈值和闲置时间调度。会话删除原子撤除缓冲及活动索引。旧版临时反思缓存不参与 Node 消费。生产已有入队入口，Node 模型分支、记忆提交及后台循环尚未接通。

2026-11-18 Node owner 反思补齐档案发布端和批次恢复。Core 校验画像、模式、状态快照、日记和意图增量。删除仅接受档案条目原文，推断不降低用户亲述模式的来源，变化或删除的模式撤回旧向量。Host 使用 owner 锁和档案迁移版本保护发布，数据库收据只保留文件版本摘要，正文暂存在 Local 目录。消费者先恢复已有收据，确认发布后才移除 Redis 批次。旧计划遇到较新文件时保留新状态，并为当前档案重新入队 RAG 更新。可信生产模型分支、后台调度、长期记忆压缩、lens 和知识学习仍待接通。

后续将 Web 私聊反思装入 `main.ts` 的 Node 后台生命周期。Linux 安全写入、PostgreSQL 收据、Redis、记忆策略及正式 RAG 索引均就绪时开始收取回合，Admin 重启和 Host 关闭会停止并等待消费者。Redis 只保留消息定位和签名模型身份。消费者从 PostgreSQL 重读归属明确、已提交的私聊原文与回复，会话繁忙时延后，账号、会话归属或原模型授权不再有效时结束本批。分支计入用量，不加载工具，也不读取群聊和中间证据。写入经 owner 锁、持久发布收据和 RAG generation 复核。每个 Run 的签名单独验证，同一会话中模型预设、配置、凭据与访问范围版本相同的连续回合合批。超预算或缺少部分历史回合的批次在新建发布计划前缩短队首，仍有效的回合继续排队。后台工作收到停止信号时主动释放当前租约，保留回合和已写入的收据供重新启动恢复。单回合超预算时，Node 按发言角色和请求预算分段，逐次复核原证据、配额和租约，用原模型生成临时摘要后统一写入，摘要模式不执行画像或习惯删除。超出来源读取上限的文本、超出 16 段或最终仍无法容纳的回合，以及长会话重投影、群组/成员反思、长期压缩、lens 和知识学习仍有待完善。真实 Provider 与生产部署待验收。

2026-11-18 Web 生产入口接入 `POST /api/v1/scheduled-tasks/{task_id}/run`。配置 Redis 时，通过 Fastify 认证、Core 状态编排与任务租约运行实际 Agent Harness，共用 owner 模型配置、定时上下文和工具。结果与试投递共用站内、SMTP、飞书、QQ、微信适配器。Fastify 关闭时等待已超过 HTTP 等待时限的任务投递并释放租约，再关闭共享 MCP 运行时。启动测试先定位两套凭据取消路由重复注册，保留完整交互服务优先和早期兼容路径；然后确认 `/run` 缺路由时 404，接线后本地 PG/Redis 隔离真实 HTTP 1/1，含工具续轮、401/404、试运行不改任务状态、正式重试成功删除与索引队列、站内通知及用量。相关 Host 合批 10 通过、1 个需显式 Python 的独立凭据取消用例跳过。devserver Node 合批 6 通过、4 个隔离依赖用例跳过，定向类型检查通过；旧 Python 定时执行与投递目标、群上下文 pytest 74/74。使用精简 PostgreSQL 测试表和合成 Provider，不涉及正式生产数据。绑定工作区、自动发送邮件工具、Telegram 与旧 IM 别名预检禁止执行，普通 SMTP 邮件结果投递已装配。MXC、长期摘要、IM 附件和推送历史、真实外部服务、Node 定时 Worker、正式 SQLite/PG 完整迁移和部署仍待接入或验收。

2026-11-18 一次性定时 Worker 接入 Web Host。按旧 APScheduler 在具体到期时间调度，误点超过 1 秒跳过。持与试运行共用的 Redis 锁复核 owner、启用状态、开始时间及未执行状态，再在 Core SQL 更新中检验本次计划，防止改期或失败任务被旧回调自动重跑。未执行任务超过 120 秒后持锁清理并事务内入索引队列，超过旧版租约宽限且无锁的崩溃任务保留并标为可手动重试。关闭 Host 等待在途任务。新定时器用例先因一次性计划不触发失败，修复后 devserver Host 12 通过、2 跳过，Core 15 通过、1 跳过，定向类型检查通过。补验本地临时 SQLite 和 PostgreSQL 仓储 2/2、本地 PostgreSQL/Redis 生产入口 1/1，覆盖真实到期、站内投递、删除、崩溃标失败、旧计划不认领和对应索引任务。Python 调度规则及定时执行 pytest 50/50。Node 开关 `GUGU_WEBUI_ONCE_TASK_WORKER_ENABLED` 默认关闭，只适用于隔离校验或已确认 Python 不消费同一任务的环境。原 Python Worker 未修改、未停用。周期任务触发、周期终止和告知、正式部署的消费者切换尚待完成。

2026-11-18 周期定时 Worker 接入 Web Host，使用 `GUGU_WEBUI_REPEATING_TASK_WORKER_ENABLED`，默认关闭。Cron 和间隔触发复用立即运行的 Agent 与投递链，取得 Redis 任务锁后复核计划及 owner，按任务和触发时刻在 PostgreSQL 落库收据。失租后的投递被拒绝，结果未知的收据禁止自动重放。到期独立周期任务持锁清理并在同一事务内写入索引作业，保留关联日历的提醒。旧 APScheduler 的月末及跨年稀疏 Cron 已有回归。启动用例先因周期 Worker 未接线失败，Cron 用例先因月末表达式被拒绝失败。修复后 devserver Node 10/10、Host 定向类型检查通过，旧 Python 定时执行和计划规则串行 50/50。本地临时 PostgreSQL/Redis 生产入口 1/1，Core PostgreSQL/SQLite 4/4。模型服务使用合成 HTTP，应先应用已存在的触发收据迁移，并在启用 Node Worker 前停用处理同一批任务的 Python 调度器。任务自行停用及通知、SQLite Worker 完整链路、真实外部渠道和部署切换仍待验证。

定时结果投递在各渠道动作之前复核同一任务租约，网页持久化后、发布实时提示前再次验锁。新回归先复现邮件投递后失租仍尝试写网页通知。修复后 devserver 定向 10 通过、3 个依赖隔离服务的用例跳过，本地临时 PostgreSQL、SQLite、Redis 和生产 Host 组合 14/14，Host 定向类型检查通过。旧 Python 投递和 IM 管理合批 53/53。

BYOK、Skills、MCP HTTP 和安全出站统一复验。devserver Node 75 通过、5 项因缺隔离 PostgreSQL/Python 先跳过，旧 Python BYOK 草稿、MCP 设置和分派、用户 Skill、安全出站 95/95。四项隔离 PostgreSQL 用例随后通过，也验证了生产入口的动态代理试测及真实侧代理连接，合批 6/6。Skill 的 Python 对照补齐兼容包搜索路径，并使用独立临时配置和存储目录，devserver 定向 2/2。管理 IM 记忆预览与应用、BYOK 草稿与保存试呼的 Node 合批 23/23。外部 MCP、真实 Provider、stdio 和部署尚未验收。

周期任务自行停用实施前有两项直接依赖。结果与停用通知需要共用启动时确定的邮件和 IM 收件人快照，当前各渠道按次解析收件人。停用还需要在同一事务内按计划版本更新任务并撤销工作区授权，当前 Core 撤权入口自行开启事务。这些依赖补齐前，Worker 不提供 `stop_recurring` 工具，避免本轮成功即误停后续计划，或将关闭通知投给投递范围已变更的收件人。

生产 BYOK 草稿与保存试呼和安全出站配置互通已补验。devserver 的 startServer 启动测试使用临时 PostgreSQL、Python 正式 ORM 和本地合成 Embedding HTTP，确认草稿异主返回 404、无鉴权草稿不外带旧 Key、不写库且确实采用草稿模型与维度，已保存试呼按原模型使用解密凭据。另由旧 Python 消费者读取 Node 写入、更新及清除的临时代理凭据，保留其余配置段。生产入口合批 2/2。

2026-11-18 周期任务自行停用已接入可选 Node Worker。仅正式触发的独立周期任务提供 `stop_recurring` 意图工具。只有最终模型成功、所有配置渠道均收到结果且工具错误已解决时，才检查租约与任务版本并提交停用。PostgreSQL 停用、文件系统授权撤销和安全审计在同一事务内完成，SQLite 使用正式无沙箱授权的任务表。结果和停用通知使用启动时确定的邮件与 IM 收件人，IM 发送前仍复核归属。提交后独立发送关闭通知，通知失败保留停用状态。先分别复现缺停用事务、缺收件人绑定、缺模型工具和生产入口缺接线；修复后隔离 PostgreSQL/SQLite 的 Core 23/23，隔离 PostgreSQL/Redis 的 Host 合批 23/23。真实 Host 入口经合成模型验证正常停用和工具失败后保留计划。devserver Node 20 通过，4 个隔离服务用例已在上述 Host 合批补验，生产组合入口定向 TypeScript 检查通过。旧 Python 定时执行、工作区和授权串行 40/40。生产仍默认使用 Python Worker，真实外部服务与部署切换尚未验收。

2026-11-18 管理端用户记忆维护的共享 Core 已补齐只读快照、预览规划与应用改写计算。复用旧提示词、三轮多数票、跨批次 ID 和置信度保护，沿用六个源文件的字节版本。旧 Markdown 条目在 preview 与 apply 之间保持可重复定位，无须预览时写盘。准备应用会拒绝版本变更及损坏的行为模式或画像档案，沿用已确认的画像事件与日报条目，不重新调用模型。Node 先复现缺少规划与改写入口，以及损坏画像读取未拒绝；修复后 devserver Core 合批 13/13、定向类型检查通过。旧 Python 对照串行 54/54。迁移未开放两个 POST 入口，仍需 Redis 生产 Worker 与单次消费、Local 跨进程写锁与可恢复多文件发布、向量及 RAG 刷新，避免管理端得到无法执行的预览。

2026-11-18 管理端账号记忆维护完成 Web Host 生产接线。两个 POST 和状态查询走 Admin guard，Redis 按租约串行预览与应用，执行中的确认计划保留至完成。Core 暂存批准的改写和文件指纹，在共享 owner 锁下先写迁移目的地。Host 用 PostgreSQL 持久回执先撤回旧索引，再写文件并排入正式 Worker。Node 初始生产回归因缺路由返回 404，重复确认回归先因通用映射返回 422，修复后保持旧版 400，过期预览返回 409 且不覆盖并行编辑。Linux devserver 使用隔离 PostgreSQL、Redis、临时文件及合成模型执行生产和恢复测试 2/2，验证新画像经实际 Worker 入索引。Core 回归 14/14，相邻 Node 管理回归 10/10，旧 Python 串行 54/54，定向 TypeScript 检查通过。服务需要 Linux Local、Redis、数据库回执与已应用的 RAG 索引迁移。缓存移除与模式向量保留已覆盖，Embedding 自动补算、SQLite 完整链路及真实部署仍待验收。Python 与 Node 混合运行时沿用已有 PostgreSQL owner 写锁配置。

2026-11-18 管理端账号记忆维护补齐 Embedding 增量刷新。确认后使用该用户启用的 Embedding 凭据和受控 Node 传输，保留仍有效的模式与长期记忆向量，只补缺失或模型标记已变化的条目。生成在 owner 锁外，写回前复核正文及缓存版本。先复现 Core 缺长期记忆增量入口与生产确认无 Embedding 请求，修复后 devserver Core 合批 23/23，隔离 PostgreSQL、Redis 和 Linux Local 的生产与恢复测试 2/2，验证缓存命中、合成 Provider 503 保留已提交正文及已有向量。旧 Python 定向串行 54/54，本地定向类型检查通过。真实外部 Provider 和部署仍未验收。

2026-11-18 管理端 IM 记忆模型预览补齐 Redis 租约校验和游标追平兼容行为。启动和 Worker 使用同一租约在 Redis 原子发布状态与计划，租约被替换后不能清空或覆盖新计划。没有新增消息的 scope 仍按旧 Python 预览已有记忆。devserver 先复现旧请求失租仍启动，以及正式 Host 返回 scope 失败，修复后 Node 合批 26/26，旧 Python IM 管理和 BYOK 草稿串行 24/24。生产入口使用 Python ORM 表结构的隔离 PostgreSQL、真实隔离 Redis、Linux Local 与本地合成模型 HTTP。状态回执验证不含 scope 标识或记忆正文。正式 SQLite、真实 Provider 和部署仍待验收。

2026-11-18 定时任务接通预授权邮件工具 `send_email`。复用交互邮件的 owner 收件人、附件、渲染、SMTP 与持久尝试收据；普通聊天仍走用户确认。按旧 Python，手动试运行也继承任务保存的授权。定时 Run 调用时和发送认领事务内复查 owner、当前任务指令及授权，SMTP 前再验 Redis 租约。失去授权不会尝试 SMTP，投递结果未知后不能重放同一调用。Node 先复现生产接口直接拒绝已授权任务；devserver 和本地的生产入口各 1/1，使用隔离 PostgreSQL、Redis、合成模型和 TLS SMTP 验证手动试运行和一次性 Worker 到期路径。测试通过 PATCH 在 Host 启动后设置触发时刻，避免慢启动错过触发窗口。devserver Core 邮件、确认、工具注册和任务读取 51/51，Host 定时执行合批 7/7。生产入口定向 TypeScript 检查通过。devserver Python 定时投递和邮件串行 63/63。SQLite 覆盖 Core 收据，SMTP 使用合成 TLS 服务，真实账号、正式部署及定时 Worker 切换仍待验收。

2026-11-18 旧定时任务 `im` 别名接入结果投递。真实运行沿用 QQ、飞书、微信与网页的渠道回执，重复选择同一 IM 渠道只投递一次。Telegram 仍单独报告未接入，正式一次性任务有任一失败渠道便保持失败状态。微信试投递和实际运行读同一 owner 的私聊路由，新键优先并兼容旧 Redis 触达键。群路由和无效固定目标不会转投私聊。先复现生产入口直接拦截别名，以及已保存的旧微信私聊键无法触达。修复后 devserver Node 合批 16/16，含生产 Fastify、隔离 PostgreSQL/Redis、合成 Provider 和代理内的合成 TLS iLink。旧 Python 投递和目标兼容 pytest 53/53，定向 TypeScript 检查通过。外部 IM 服务、推送历史、附件、正式 SQLite Worker 与部署仍待验收或接线。

2026-11-18 定时 IM 文字推送接入原会话历史。两个 POST 入口按平台确认送达后共用 Core 会话追加。私聊优先沿用 owner 与 Bot 的可信 Web 绑定，群只写同 owner、平台、Bot 和群 ID。Core 在事务内分配消息序号，回滚时同时撤销序号和新会话。Host 提交后按 Python 键刷新 Redis 12 小时，使用条件更新保护并发的新绑定。先复现生产微信成功但无会话记录，修复后 devserver Node 10/10、Core 正式 SQLite 4/4、Python 历史对照串行 3/3，定向 TypeScript 检查通过。生产入口使用隔离 PostgreSQL 会话测试表、Redis 和 TLS iLink，验证私聊绑定、异主路由回退、试投递同会话追加。真实平台群回复、正式部署、附件与推送后历史裁剪待验收或接线。

2026-11-18 定时 IM 推送后接入共享会话历史保留。超过 2000 条且有摘要覆盖时，每批最多清理 500 条旧消息，使用锚点后的有效顺序，保留未覆盖历史、待处理消息和摘要。行锁检查 owner 和活跃 Run，忙碌会话留待下次维护。PostgreSQL 在消息事务内删除旧附件引用，提交后复用已存在的引用计数与 Local 删除适配器。已完结交互卡按剩余消息时间边界清理，活动卡保留。先复现渠道送达后旧消息未裁剪，修复后 devserver 生产入口 1/1、正式 SQLite Core 5/5、旧 Python 5/5，定向 TypeScript 检查通过。隔离 PostgreSQL、Redis、Linux Local 与合成 TLS iLink 验证无引用附件删除和共享文件保留。SQLite 覆盖消息规则，完整 Worker、外部 IM 与正式部署仍待验收。

2026-11-18 定时任务接通本轮附件产物与飞书投递。共享工具通过文件 ID、文件库名或现有聊天附件准备 owner 引用，在实际发送时重新校验 owner 和物理文件。邮件沿用现有 MIME 附件链。飞书复用固定 API 传输，按旧 Python 区分文件与图片及 30/10 MiB 限额，逐件复核任务租约、启用 Bot 和同一收件人。推送会话保留附件卡片。先复现邮件漏附件与飞书虚报成功，修复后 devserver Node 合批 16/16，Core 正式 SQLite 会话 5/5，旧 Python 定时投递和工具契约串行 76/76，生产入口定向 TypeScript 检查通过。通过实际 Fastify、PostgreSQL 测试表、Redis、本地文件与合成 TLS 飞书和 SMTP 验证 MIME 字节、异主拒绝、群附件部分失败及手动重试成功后任务删除。QQ、微信、Telegram 附件出口，URL 下载与 Shell 路径产物，正式部署与真实平台尚待接入或验收。

2026-11-18 定时 QQ 附件接入生产入口和共享分片协议。复用 owner 文件与聊天附件读取，使用 30 MiB 限额、QQ 散列字段、二进制 COS 上传、逐片确认和富媒体消息 ID 回执。分片前校验整份签名地址集合，限制到腾讯 COS HTTPS，Bot 凭据只发固定 API。限并发并在各阶段复核任务租约、Bot 和收件人，未知回执不在同一次运行内重试。先复现文字成功却没有 QQ 附件上传，修复后 devserver Node 16/16，旧 Python QQ 附件定向 5/5，生产组合入口定向 TypeScript 检查通过。联测使用隔离 PostgreSQL、Redis、合成本地模型及 TLS QQ/COS，覆盖有效分片、恶意地址拒绝、缺少消息 ID 与上传后撤权。真实 QQ/COS、微信与 Telegram 附件及部署仍待验收或接线。

2026-11-18 定时微信私聊图片、附件已接通。复用 owner 文件读取和 iLink 授权，Core 按 Python 协议生成 AES 密文与相应消息字段，CDN 限定官方 HTTPS 上传端点且不携带 Bot 凭据。可重试的 CDN 失败只重传同一地址的同一密文，最终消息未知时不自动重发。发送时按同一 Bot 和收件人刷新 context_token。先复现正文已发却无附件，修复后 devserver Node 合批 16/16、旧 Python 微信及定时投递 56/56、生产入口定向 TypeScript 检查通过。隔离 PostgreSQL/Redis 和合成 TLS iLink/CDN 验证解密后文件一致、图片与文件字段、非法地址、最新凭据和业务失败计数。真实微信与正式部署仍待验收。

2026-11-18 定时任务公网图片附件接入生产 `/run` 和共享 Worker 执行链。按旧 Python 下载契约处理图片类型、15 MiB 字节限额和最多三跳重定向，Host 每跳用当前安全出站设置重新校验并固定目标。暂存前复查租约与任务启用状态，使用 owner 限定的 PostgreSQL/Local 正式附件暂存。先复现定时邮件缺少远程图片，修复后 devserver Host 21/21、Core 5/5、旧 Python 流式下载与投递规则 51/51。合成代理、DoH、图片站与 SMTP 经实际生产装配验证图片尺寸和字节，私网跳转未建立隧道，下载期间停用未新增草稿。Node 一次性 Worker 正式到期后发送一封带远程图片的邮件并删除已完成任务。URL 产物的 IM 平台投递、正式 SQLite 和真实部署尚待验收。

2026-11-18 导出归档删除复验。修正隔离 PostgreSQL 测试夹具先删目标目录的问题，先复现 Linux 符号链接父目录被当成文件缺失并错误删除任务行。Host 改用共享的 Linux 普通文件删除，规则要求精确 owner/job 归档键，父目录访问锚定文件句柄。符号链接父目录或目录归档返回 503，并保留任务和原有内容。devserver 端口与生产测试 3/3，含实际 Fastify 认证、Python 生成的合成归档、隔离 PostgreSQL 和 Local。共享 FS 8/8，旧 Python 导出 API 5/5，FS 构建和定向类型检查通过。正式 SQLite、真实部署，以及归档删除后数据库提交失败的补偿仍待验证或处理。

2026-11-18 管理端工具状态标签接通 Web Agent。工具目录采用 Web 可配置工具名与旧 Python 短标签，保存时去除等于默认值的覆盖并保留无关配置。Core 在新工具卡出现时从管理员的候选标签中确定展示值，当轮 SSE 和持久历史沿用同一值，Web 对管理员覆盖优先渲染，历史默认仍按界面语言显示。先复现目录缺会话搜索、运行事件缺覆盖和界面只显示默认译文，devserver Core 64/64、Web 44/44，本地隔离 PostgreSQL/Redis 生产 Host 6/6，验证实际管理员写入至认证聊天 SSE 和历史读取，Python GET/PUT/Runner 直接对照及 pytest 19/19。联测禁用沙箱授权，Node 现有全新 schema 初始化未创建 filesystem_authorization_grants。启用授权的干净部署、动态 MCP 全局目录、准备与复查状态及正式 SQLite 仍待补验或接入。

2026-11-18 会话历史授权状态补齐空库迁移。新增 `migrate:filesystem-authorization:check/apply`，依赖 Node 基础账号表，参数与旧 Python Alembic 授权表一致。事务锁下迁移只执行一次，保留属主外键删除语义。先复现未建表时历史返回 500，建表后复现只读授权被误报为完整授权，修复后默认开启沙箱即可读取历史，且只投影当前 owner、当前会话有效的用户沙箱读写授权。devserver SSH 握手超时，使用本地临时 PostgreSQL/Redis，定向 25/25，Host 类型检查通过。旧 Python 授权定向 7/7；全文件另有三项模型交互用例受本地 Python 缺少依赖阻断。更大的生产聊天套件通过历史与进程恢复断言，恢复后发起新一轮时的取消场景提前返回生成错误，仍待定位。完整授权写入在现有隔离表回归通过；MXC 执行及真实部署未验收。

2026-11-18 Node-only RAG/Agent 收尾：2.0 继续使用 Node/Core 与 Host 作为唯一运行实现，不为旧 Python Worker、工具或反思生产者保留兼容入口。当前生产 `main.ts` 在 RAG migration 就绪后装配 Node 索引 Worker、可信 Web Agent Run、八类来源、Jieba、owner scope/lease 授权、`search_conversations` 与 `search_memory`；Linux Web Host 还装配 owner 私聊反思的 Run finalizer、持久 Redis 队列、Node Provider 分支、PostgreSQL 来源/回执、Local writer 和后台消费生命周期。Core RAG 本轮 **9 文件 70/70**；Web Host RAG/lease/反思队列/工具端口/重建器定向回归 **22 通过、8 跳过、0 失败**；生产 build 通过。新增 `agent-chat-main.integration.test.ts` 的真实 `startServer → HTTP → dispatch → Reconstructor → ToolRegistry → SSE` 入口因未配置隔离 PostgreSQL/Redis 跳过，故 Linux Run→owner 反思 Redis 入队断言尚未执行；8 个跳过均为隔离 PG/Redis 依赖。使用合成 Provider，不调用真实外部服务。真实部署、外部 Provider 与运行中数据切换仍未验收。桌面与 IM 的不同平台能力需各自由 Host 注入，不得因 Web 装配完成推定全端完成。

2026-11-18 会话文件授权空库生产链路补齐。扩展授权 Vite→Host→随机 PostgreSQL 回归，先使用正式 Node migrations 复现授权申请因 `security_events` 缺表返回 500；新增 `migrate:security-events:check/apply` 与 `migrate:terminal-sessions:check/apply`，分别对齐旧 Python 安全事件和完整终端会话/事件 schema、索引及 owner/session/workspace 外键。README 初始化顺序已更新。迁移实际经过 pending→applied→unchanged，并连续 5 轮验证双并发 apply 仅一条 applied、另一条 unchanged；Host 认证链路完成申请、无效码拒绝、确认、审计记录、PTY 终止及撤销；无效码无 grant 副作用，异主会话 404。红测后同一 Vite→Host→随机 PG 回归通过 1/1，相关 Node Host/PG/Redis 回归 8/8，Web Host production TypeScript 检查通过；旧 Python 授权服务对照 7/7。另 3 个模型交互 pytest 因本地隔离环境缺 FastAPI 未执行。devserver SSH 探测超时；真实 Redis 已由独立隔离 Redis 用例验证，真实服务部署、正式 SQLite schema 与 MXC PTY 仍待验收。

2026-11-18 Admin 安全事件 GET 查询迁入共享 Core。全局 `/api/v1/admin/audit-log/security-events` 与用户级 `/api/v1/admin/users/{user_id}/security-events` 保留 Fastify Admin guard、DTO 和通用错误映射，Core Kysely reader 负责时间窗、参数筛选、用户存在性、owner-scoped 排序/limit、字段投影和 UTC 时间格式；主入口 HMAC 由 Host 注入 Core，不暴露原始用户 ID。先因 Core reader 缺失使 SQLite 合同 2 项红灯，新增用例后 2/2；Node Admin 路由、Host app 与真实 startServer 隔离 PG 合批 31/31，含正式 `security_events` Node migration、未认证401、UUID/limit边界、异主404、HMAC、时间/过滤、元数据脱敏和 Python 字段投影。Web Host production TypeScript 检查通过。Python `test_ownership_security_events.py` 本地 1/3：两项记录事件用例未将 app 独立 DB 连接到 pytest fixture 数据库，只有纯 HMAC 用例通过；该文件不覆盖这两个查询 handler，因此不将其记作 Python API 对照。devserver SSH 超时；Core SQLite 合同通过，但 Web API 正式 SQLite 组装与真实部署未验收。

2026-11-18 管理员用户列表与风险用户聚合迁入共享 Core。`GET /api/v1/admin/users/` 的 owner 列表搜索、非 BYOK 周/6 小时用量、文件记录与 Local 配额账本优先级，以及 `GET /api/v1/admin/users/risk` 的展示窗口、五分钟动作阈值、冻结用户保留和 Python `updated_at` 排序由 Core Kysely readers 执行；生产 `main.ts → Fastify Admin guard → Core → PostgreSQL` 已接。TDD Core SQLite 2/2；Node Admin/Host、随机 PG schema reader 和实际 `startServer` 请求合计 38/38，Core build 与 Host production typecheck 通过。旧 Python handler/风险 pytest 已读但本地无 pytest，devserver SSH 先前超时，未运行 Python pytest；精简 SQLite 合同不代表正式 SQLite schema，真实部署未验收。

2026-11-18 Node-only Agent RAG 主链复验及历史时间修复：2.0 保持 Node/Core 与 Host 为唯一运行实现，不保留 Python Worker、工具或反思生产者的兼容入口。通过真实隔离 PostgreSQL schema、隔离 Redis DB、临时 Local 文件目录和合成 HTTP Provider，`startServer → HTTP → 持久 dispatch → Reconstructor → ToolRegistry → SSE` 生产调用回归 **1/1**，覆盖 `search_conversations`、owner 隔离、崩溃后恢复、新 Run 的历史时间戳和取消确认门。定位并修复 Host 未注入历史消息时间格式化端口导致有历史记录的 Run 在模型调用前失败；另修复 PostgreSQL RAG 队列以 Node 毫秒时钟判断 `CURRENT_TIMESTAMP` 新入队任务而短暂返回 idle 的竞态。Core RAG **9 文件 70/70**；Host RAG/lease/反思队列/工具/来源定向批次 **43 通过、3 跳过、0 失败**，历史时间 Node 回归 **2/2**；Web Host production build 通过。旧 Python pytest 未运行：当前本地环境没有 pytest 模块。Linux-only owner 反思 writer 和外部 Provider 未在当前平台/本轮验收；真实部署、生产数据切换与生产 PG/Redis 运行仍待验收。


2026-11-18 Node 工具迁移补验 `read_conversation`。生产 Web Run 在同一真实 HTTP/SSE 会话中先调用 `search_conversations`，再以返回的 session ID 调用 `read_conversation`，将 owner 限定的 PostgreSQL 正文送入下一轮合成 Provider；异主正文标记不会进入响应或模型请求。Core/Host Registry 经隔离 PostgreSQL 测试 **3/3**，生产 SQLite 工具路径 **5/5**，生产 `startServer` + PostgreSQL/Redis + 合成 Provider 的搜索→读取集成 **1/1**；临时服务与数据均清理。回归保护最近消息窗口、结构化消息过滤、空正文过滤、工具正文、Unicode 截断、owner 隔离、租约与真实 Harness 续轮。旧 Python 历史基准此前 **4 项通过、62 项未选中**；本轮环境未安装 pytest，未重跑。此项运行时实现和 Host 接线使用纯 Node，不添加 Python 代理、回退或双运行时兼容层；Python 仅保留为迁移期历史行为对照，最终删除时机仍由全量 Node 迁移与退出验收决定。


2026-11-18 `get_current_time` 生产工具调用补验。真实 `startServer` Run 调用 Node 注册器中的时间工具，可信时区来自隔离 PostgreSQL 的账号资料；合成模型传入 `timezone=UTC`，回执仍为账号配置的 `Asia/Tokyo`，并核验日期、星期、时刻及组合字段。该场景合并在历史搜索→读取主链测试中，隔离 PostgreSQL/Redis、合成 Provider，生产调用链 **1/1 通过、0 失败、0 跳过**。Node 主机已有实际时钟、owner 时区端口及调用时授权；Python 时间基准此前 **1/1 通过**，本轮未重跑。工具运行完全由 Node 实现，无 Python 代理或回退。


2026-11-18 `get_upcoming` 生产工具调用补验。与 `search_conversations`、`read_conversation`、`get_current_time` 合并在同一 Node Web Agent Run 集成中：近期安排走 Core 项目查询和 Host PostgreSQL 日历 reader，时区取账号资料，日期范围按工具参数计算；隔离数据库写入本 owner 与异主的合成事件，实际工具结果包含前者且排除后者。真实 `startServer` HTTP/SSE、PostgreSQL、Redis、注册器/ToolPort 与环回合成 Provider 集成 **1/1 通过**，历史搜索和正文读取后又分派时间与近期安排工具。Python `test_readonly_tool_migration.py::test_registered_upcoming_uses_context_day_and_scoped_live_resources` 此前 **1/1**，日历 owner 工具此前 **1/1**；本轮未重跑 pytest（本地未安装 pytest）。Node 2.0 不依赖 Python 运行或兼容层。


2026-11-18 `list_events` 生产工具迁移验收。实际 Node Web Agent Run 调用 Core 日历 reader 和 Host PostgreSQL 端口；隔离 PostgreSQL schema/Redis、合成 HTTP Provider 的真实 HTTP/SSE 测试 **1/1**。结果覆盖 owner 活动隔离、提醒聚合、停用提醒保留、渠道与 QQ 群模式投影，以及异主提醒/正文不泄漏。Core 日历工具行为 **5/5**，Host 日历工具组合 **2/2**。Python `test_registered_calendar_preserves_reminders_filters_and_owner` 此前通过记录存在，但本轮环境未安装 pytest，因此未重跑。迁移清单状态由“部分实现”改为“已完成并接入 Web”，当前静态工具计数为已完成并接入 5、已实现待接入 2、部分实现 79、依赖阻塞 22、退役/重设计 1。合成 Provider 和临时隔离存储用于验证；真实外部 Provider、生产部署、桌面/IM Host 与全量 Python 行为未验收。实现保持 Node-only，不添加 Python 代理或双运行时兼容。


2026-11-18 `list_clients` / `list_projects` 生产工具调用验收。隔离 PostgreSQL/Redis 中运行正式 `startServer` 与真实 HTTP/SSE；合成 Provider 通过模型协议分别触发联系人和项目列表，结果经生产 registry/dispatch 进入 Provider 下一轮，异主联系人和异主项目未泄漏。Core 联系人回归 **20/20**、项目回归 **12/12**、生产 Host 集成 **1/1**。Python 联系人共享存储 owner 基准、Agent 项目筛选和 owner 基准此前有 **3/3** 通过记录；本轮本地没有 pytest，未重跑。仅这两个只读工具由“部分实现”更新为“已完成并接入 Web”，项目/联系人写工具状态不变。总计 109 个静态工具：完成并接入 7、实现待接入 2、部分实现 77、依赖阻塞 22、退役/重设计 1。Node-only 运行实现，无 Python 桥接或回退；生产部署与真实外部模型未验收。


2026-11-18 继续完成 Agent 领域只读和联系人写工具。相同生产 Node Run 在真实 HTTP/SSE、随机隔离 PostgreSQL schema 与 Redis 中调用 `get_dashboard_stats`、`list_workspaces`、`get_workspace`、`create_client`、`update_client`；工具实际结果进入合成 Provider 后续请求，联系人创建及更新以数据库回读确认，owner 统计和联系人列表/项目列表不包含异主数据。Host RAG/lease/registry 测试 **15/15**，Core 领域读取 **5/5**、联系人 **20/20**，生产 Host 集成 **1/1**。Python 总览、工作区、联系人共享数据与 owner 基准此前有 **7/7** 通过记录；本轮环境没有 pytest，未重跑。将这五项更新为已完成并接入 Web，累计 109 个静态工具完成并接入 12、实现待接入 2、部分实现 72、依赖阻塞 22、退役/重设计 1。删除联系人与工作区更新仍保留在部分实现，不把确认和写入能力过度声明为完成。没有 Python 调用/回退层；合成 Provider 与隔离数据用于验收，真实生产部署未验收。


2026-11-18 `create_project` 生产工具验收。真实 Web Agent Run 按 Provider 工具协议调用正式 registry，通过 Core `ProjectCreatePort` 与可信 Host 身份写入隔离 PostgreSQL；测试回读确认只创建 owner 项目、旧版默认 `pending` 状态、高优先级小写归一以及默认三阶段/空待办。一次 PostgreSQL 测试 schema 中同时含合成异主项目；项目创建工具本身只按当前 owner 提交。Node Core 项目工具 **12/12**、真实 Host HTTP/SSE 集成 **1/1**。旧版 `test_project_tools.py` 创建默认阶段、优先级归一、自定义阶段待办与非法阶段基准此前随 **148 项合批通过**，当前环境无 pytest，未重跑。将 `create_project` 更新为“已完成并接入 Web”；更新、阶段管理、颜色、归档和删除继续按各自行为与授权边界独立验收。静态工具状态为完成 13、待接入 2、部分 71、依赖阻塞 22、退役/重设计 1，仍不含动态 MCP。Node-only 运行实现；Provider 为环回合成服务，生产部署未验收。


2026-11-18 项目写入工具生产调用验收续批。真实 Web Agent Run 使用可信 owner、持久 tool call 收据与 Core 项目事务，依次创建项目、更新摘要、设置 `teal` 语义色、归档项目；隔离 PostgreSQL 回读分别确认阶段/优先级、owner、摘要、既定渐变存储映射及 archived 状态。一次项目颜色断言最初误把 UI 语义色当作数据库物理色，现按 Core 预设映射重验；重验过程中 Core build 补出并行加入 main.ts 的忽略产物导出后生产 HTTP/SSE **1/1 通过、0 失败、0 跳过**。此前一轮创建阶段断言同样修正为检查持久格式中的标签/todo 后通过。项目工具 Node 旧回归 **100/100** 有既有记录，Python `test_project_tools.py` 创建/更新/颜色/归档行为有既有通过记录，本轮未重跑（环境无 pytest）。`create_project`、`update_project`、`set_color`、`archive_project` 均更新为已完成并接入 Web；工具总数统计为完成 16、待接入 2、部分 68、依赖阻塞 22、退役/重设计 1。阶段工具及删除继续逐项验收，不将端口接线算成完成。运行仅使用隔离 PostgreSQL/Redis、临时文件和环回合成 Provider，不包含真实外部模型、生产数据或部署验收；无 Python 兼容层。


2026-11-18 项目阶段工具组生产调用验收。真实 Agent Run 连续执行 `add_stage`、`rename_stage`、`update_stage`、`set_stages`、`remove_stage`，Host provider binding、ToolRegistry、可信 dispatch lease、持久项目收据与 Core 项目阶段事务全程实际工作。测试先添加/重命名阶段及待办，再通过 `key=s3` 替换阶段声明，最后移除临时阶段；PostgreSQL 回读验证阶段身份和待办 id/text/done 保留、当前阶段正确回退，没有修改异主项目。与创建/更新/颜色/归档写入合并的生产 Host 集成 **1/1**，Core 项目及阶段持久行为 **100/100** 有既有通过记录，Python `test_project_tools.py` 阶段相关 21 项及工具历史基准有既有通过记录；本轮因本机没有 pytest 未重跑。五个阶段工具从部分实现更新为已完成并接入 Web；静态清单达到完成 21、待接入 2、部分 63、依赖阻塞 22、退役/重设计 1。真实外部 Provider、生产部署与 Python 全量行为未验收。Node-only，无兼容层。


2026-11-18 `get_project` 生产工具闭环验收。真实 Web Agent Run 通过 Core 项目查询和 Host PostgreSQL 文件概览端口读取 owner 项目及文件统计；异主项目 ID 经过同一工具边界返回“不存在”，文件 reader 无跨 owner 调用。随机 PostgreSQL schema 中隔离的 `get-project-overview-postgres.test.ts` **1/1**，生产 Host 工具链集成 **1/1**；用例同时覆盖软删、项目/文件归属、非 project 文件空间、预取消、lease 撤销、查询期间取消后连接复用。Python 项目详情基准此前 **7/7**，本轮本地未安装 pytest，因此未重跑。`get_project` 状态由部分实现更新为已完成并接入 Web。当前静态工具状态：完成并接入 22、实现待接入 2、部分 62、依赖阻塞 22、退役/重设计 1，合计 109（动态 MCP 另计）。Node-only 实现；无生产部署/真实外部 Provider 验收。


2026-11-18 `get_tool_schema` 生产 discovery 验收。`startServer` HTTP/SSE 主链由当前可信 lease registry 执行 schema 查询，合成模型只请求 `list_events`，工具 discovery event 确认返回授权 schema 名称。Node Core 近邻行为 **6/6**，正式生产 Run/PG/Redis 合集成 **1/1**；Python `test_registered_schema_discovery_does_not_execute_requested_tool` 与 schema-selection 回归有此前通过记录，本轮 pytest 未重跑。此前 Node 真正接入 status 尚标为部分，本次检验表明生产实际调用边界已闭合，故更新为已完成并接入 Web。当前109个静态工具：完成23、待接入2、部分61、依赖阻塞22、退役/重设计1。临时隔离数据库和环回合成 Provider，无真实服务调用；2.0 不引入 Python bridge、fallback 或双运行时。

2026-11-18 `note_search` / `note_get` 生产调用闭环验收。隔离 PostgreSQL schema 和 Redis 中启动正式 Node `startServer`，合成 HTTP Provider 通过真实 HTTP/SSE、dispatch、Reconstructor 和 ToolRegistry 发起笔记搜索、详情读取及异主 ID 读取。工具结果验证 owner 搜索命中、异主内容不泄漏、详情保留物理行号及逐行内容，异主节点安全 not-found。生产 Host 集成 **1/1 通过、0 失败、0 跳过**；Core `note-reads.test.ts` 本轮 **6/6**；Python pytest 本轮未运行。两工具由部分实现更新为已完成并接入 Web。109 个静态工具当前状态：完成 **25**、实现待接入 **2**、部分实现 **59**、依赖阻塞 **22**、退役/重设计 **1**。仅使用临时隔离数据和合成 Provider，不含生产数据或真实外部调用；最终目标为纯 Node，未添加 Python 桥接、回退或双运行时兼容。

2026-11-18 `canvas_list` / `canvas_get` / `canvas_search` / `canvas_focus_node` 生产调用闭环验收。隔离 PG schema/Redis 下的正式 Node Agent Run 经 HTTP/SSE 和 ToolRegistry 执行四个画布读取工具；列表验证 owner 归属、活动项计数、视图字段；详情读取 owner 节点正文；搜索返回实际匹配；焦点链接指向正确画布项；异主画布返回安全 not-found。Core 画布读取/布局/工具测试 **5 文件 12/12**，生产 Host 集成 **1/1 通过、0 失败、0 跳过**。修正两项测试夹具/输出字段假设后完整复跑通过。Python pytest 本轮未运行。四工具更新为已完成并接入 Web，109 项状态：完成 **29**、待接入 **2**、部分 **55**、依赖阻塞 **22**、退役/重设计 **1**。合成 Provider 与临时隔离数据，无生产数据及真实外部服务；无 Python 桥接或回退，迁移目标仍为移除 Python 后端。

2026-11-18 `canvas_search_placeable` 真实 Web Agent 调用补验：Core 搜索经正式 HTTP/SSE Run 与生产 ToolRegistry 执行，隔离 PostgreSQL 同时包含 owner 和异主的项目；工具返回己方项目且排除异主结果。无写入副作用。生产 Host 集成 **1/1 通过、0 失败、0 跳过**，Core 画布组定向 **5 文件 12/12**。该工具与 `canvas_list/get/search/focus_node` 一并更新为已完成并接入 Web。静态工具分类为完成 **30**、待接入 **2**、部分 **54**、依赖阻塞 **22**、退役/重设计 **1**。Python pytest 本轮未运行；测试使用临时隔离 PG/Redis 和环回合成 Provider；最终运行目标为纯 Node。

2026-11-18 画布创建与编辑组生产调用闭环验收。真实 Web Agent Run 连续执行 `canvas_create`、`canvas_create_note`、`canvas_update_node`、`canvas_update_note`、`canvas_add_node`、`canvas_connect`、`canvas_update_anchor`；生产 ToolRegistry/dispatch 与 Core 共享 Mind 事务均实际调用，隔离 PostgreSQL 回读验证 owner 画布与便签创建、节点布局、便签内容/版本、项目引用放置、关系行及关系端点 JSON。Core 画布定向 **5 文件 12/12**，正式 Host HTTP/SSE + 隔离 PG/Redis 集成 **1/1 通过、0 失败、0 跳过**。七工具更新为已完成并接入 Web。当前109项：完成 **37**、待接入 **2**、部分 **47**、依赖阻塞 **22**、退役/重设计 **1**。Python pytest 本轮未运行；测试只用临时存储与环回合成 Provider，无真实外部调用，迁移目标为纯 Node。
2026-11-18 Node 定时任务 Telegram 结果投递：Core 固定 Telegram 官方 HTTPS `sendPhoto`/`sendDocument` multipart 协议并限制 50,000,000 字节；JPEG/PNG 小于等于 10,000,000 字节按照片发送，明确 400 才回退文件；Core 确认 Telegram 渠道也向 Agent 开放 `send_file`；Host 复用 owner 文件读取，发送前复核 Bot、平台、收件人、群会话和任务租约。`main.ts` 已将适配器装配到立即运行和可选 Worker，去除显式 Telegram 的整任务拒绝。首次 Host 回归因缺少附件发送能力而失败，修复后 Host 5/5、Core Bot API 9/9、Web Host production typecheck 通过。隔离 PostgreSQL/Redis 立即运行集成因本地未配置测试服务而跳过；Python `deliver_to_channels`、`_deliver_im_files` 及相邻 pytest 源码已核对，pytest 未运行。未迁移 Python MarkdownV2 和长消息分片；未连接真实 Telegram/代理，PG/Redis Worker、推送历史、SQLite 和部署尚未验收。

2026-11-18 `list_scheduled_tasks` 与 `update_workspace` 生产工具验收：正式 Node `startServer` 在随机 PostgreSQL schema、临时 Redis、临时文件目录和环回合成 Provider 下，经 HTTP/SSE/dispatch/ToolRegistry 调用两项工具。定时任务只返回 owner 的独立任务，排除日历提醒和异主任务；工作区更新同步工作区声明与目录显示名，同时保留物理目录键。生产集成 **1/1**，Core 定时任务/工具批次 **3 文件 7/7**。默认系统目录按既有安全规则禁止重命名，验收夹具使用非系统 owner 目录。Python pytest 本轮未运行；旧 Python 只作行为基准，不进入 Node 执行路径。109 项状态：完成 **41**、待接入 **2**、部分 **43**、依赖阻塞 **22**、退役/重设计 **1**。没有 Python bridge、fallback、双写或双运行时；真实外部 Provider、平台投递和部署仍未验收。

2026-11-18 `list_trash` 生产工具验收。正式 Node `startServer` 经 HTTP/SSE/ToolRegistry 查询隔离 PostgreSQL 回收站；夹具同时包含 owner 与异主的软删除文件，Provider 续轮只收到 owner 文件，微秒时间戳保持完整。Core `trash.test.ts` **4/4**，生产 Host 集成 **1/1**；此前 Python 回收站基准在隔离临时环境 **1/1** 通过，本轮未重跑（当前无 pytest/后端依赖）。状态更新为已完成并接入 Web。合并当前工具状态后：109 项完成 **43**、待接入 **2**、部分 **41**、依赖阻塞 **22**、退役/重设计 **1**。测试只用临时隔离服务和合成 Provider，无 Python 执行桥或外部服务调用。

2026-11-18 `restore_file` / `restore_folder` 生产工具验收。正式 Node Agent Run 经 HTTP/SSE/ToolRegistry 调用 PostgreSQL owner-scoped 恢复端口，在临时存储中恢复独立文件及顶层目录子树；回读确认文件与目录墓碑清除、原逻辑路径重建、正文可读，异主数据不变。生产 Agent Run **1/1**，`trash-restore-runtime-postgres.test.ts` **1/1**；隔离用例覆盖父目录仍在回收站、异主/缺失目标、并发、提交结果未知和重建收据不重做。Python pytest 本轮未运行，已对照 Python 旧工具的错误语义、父目录门和物理文件缺失行为；本机未安装 pytest/后端依赖。两工具状态更新为已完成并接入 Web；按当前迁移表合并后，109 项为完成 **46**、待接入 **2**、部分 **38**、依赖阻塞 **22**、退役/重设计 **1**。无 Python 桥接或外部服务调用。

2026-11-18 `note_create` / `note_update` 生产 Node Run 验收。正式 `startServer` 通过隔离 PostgreSQL、临时 Redis、HTTP/SSE、合成 Provider 和生产 ToolRegistry 实际创建普通 Markdown 笔记并追加正文；回读 owner、Markdown、纯文本投影和版本，确认实际持久副作用。Core `note-writes.test.ts` 与 `note-lifecycle.test.ts` **7/7**，生产 Agent 主链集成 **1/1**。测试依赖均为临时隔离服务，Provider 为环回合成实现；不调用 Python、不增加兼容桥接。静态工具状态合并当前清单：完成 **48**、待接入 **2**、部分 **36**、依赖阻塞 **22**、退役/重设计 **1**，合计109；真实外部 Provider 与生产部署未验收。

2026-11-18 `note_delete` / `note_restore` / `note_undo` Node 生产 Run 验收。正式 Node Agent Run 经 HTTP/SSE/dispatch/ToolRegistry 软删并恢复指定 owner 普通笔记，再撤销当前 owner 最近创建的咕咕笔记；隔离 PostgreSQL 核对 tombstone、版本、正文与异主数据不变。生产主链 **1/1**，Core `note-writes.test.ts` + `note-lifecycle.test.ts` **7/7**。测试只使用临时 PG/Redis/文件目录及环回合成 Provider，不调用 Python。三工具由部分实现更新为已完成并接入 Web；按当前清单：完成 **51**、待接入 **2**、部分 **33**、依赖阻塞 **22**、退役/重设计 **1**。

2026-11-18 `create_scheduled_task` / `update_scheduled_task` Node 生产 Run 验收。隔离 PostgreSQL/Redis 和正式 Node Agent Run 实际执行创建及更新；只创建停用的一次性任务，避免测试期间运行或投递。回读确认 owner、schedule_kind/start_at、渠道和指令；Host `task-writes-postgres.test.ts` **4/4**，Core `scheduled-tasks.test.ts` **1/1**，正式主链集成 **1/1**。工具由部分实现更新为已完成并接入 Web；109 项当前：完成 **53**、待接入 **2**、部分 **31**、依赖阻塞 **22**、退役/重设计 **1**。Node-only，无 Python bridge、fallback 或双运行时。真实邮件/IM 投递、工作区沙盒授权与生产部署未验收。

2026-11-18 `list_skills` / `use_skill` Node 生产验收。生产 Host Run 经正式 ToolRegistry 调用 `list_skills` 与 `use_skill`：目录依据 `packages/core/resources/skills` Markdown head 返回 S7 元数据、不带正文；加载 S7 后，正文实际进入后续 Provider 请求。Core Markdown frontmatter 注册 **2/2**、Host `agent-skill-tool-runtime.test.ts` **1/1**、隔离 PostgreSQL/Redis 主链 **1/1**。两工具状态更新为已完成并接入 Web；109项：完成 **55**、待接入 **2**、部分 **29**、依赖阻塞 **22**、退役/重设计 **1**。2.0 仅用 Node 读取 Node 自有技能资源，不保留 Python 桥接、回退或双运行时；真实部署未验收。


### 用户技能创建与更新生产接入（2026-11-18）

`create_skill` / `update_skill` 通过正式 Node Agent Run 和 ToolRegistry 执行，复用现有用户技能管理器与事务收据；隔离 PostgreSQL 回读验证 owner、稳定 ID、来源/启用状态和 Markdown 正文，更新后由 `use_skill` 续轮实际加载新正文。Core 技能写入/SQLite 回归 **3/3**、HTTP/SSE 生产主链集成 **1/1** 通过，使用临时 PostgreSQL/Redis 与环回合成 Provider。工具状态由部分实现更新为已完成并接入 Web。109 项：完成 **57**、待接入 **2**、部分 **27**、依赖阻塞 **22**、退役/重设计 **1**。2.0 使用 Node 作为唯一运行时，旧 Python 仅作行为语义参考，不保留桥接、回退或双运行时，最终目标为删除 Python 后端。


### 站内搜索与日历创建工具生产闭环（2026-11-18）

`global_search` 与 `create_event` 经正式 Node Web Agent Run 的 HTTP/SSE、lease 授权、ToolRegistry 和 PostgreSQL 业务端口执行。隔离 PostgreSQL 验证工具创建的日程可回读，随后共享站内搜索按 `event` 来源找到该日程；Provider 另传异主 `owner_id`，搜索结果仍仅含当前用户数据。无提醒输入时没有创建投递任务。生产主链 **1/1**，Core `global-search.test.ts` 与 `calendar-create.test.ts` 合计 **8/8**；临时 PostgreSQL/Redis 与环回合成 Provider，未调用外部平台或 Python。两工具状态更新为已完成并接入 Web。109 项：完成 **59**、待接入 **2**、部分 **25**、依赖阻塞 **22**、退役/重设计 **1**。

2026-11-18 Node-only RAG 与生产工具续轮复验：Core RAG **9 文件 70/70**，本轮 Host RAG/lease/正式来源 Worker/迁移/Jieba/检索 transport 批次 **53 通过、1 跳过、0 失败**；唯一跳过为 Linux 安全原子写入。另在临时 PostgreSQL/Redis 与环回合成 Provider 下实际运行 `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` **1/1**，覆盖 `search_conversations`、owner 隔离、Run 恢复，以及 `create_event → update_event → global_search` 的日程写入、更新、检索链。模型伪造的异主 `owner_id` 不改变搜索归属。Core build、Host production typecheck 与 diff 检查通过。该主链用例不传提醒；禁用 Web 提醒的附加探测返回提交状态未知，提醒主链不计验收，`update_event` 保持部分实现。本轮未运行 Python 后端或 pytest；Node 是 2.0 唯一运行实现，Python 后端是最终删除目标，不添加桥接、fallback 或双运行时。工具清单当前按 109 项计：完成并接入 **59**、已实现待接入 **0**、部分实现 **25**、共享/平台依赖 **24**、退役/重设计 **1**。


2026-11-18 `read_knowledge` Node 生产 Run 验收：隔离 PostgreSQL/Redis 与临时 owner FS 中，Node RAG Worker 从 owner 和异主 Markdown 建立正式索引；正式 `startServer` HTTP/SSE/ToolRegistry 经关键词 BM25 检索只返回当前 owner 的 ranker 投影，按 ID 返回 owner Markdown 全文，异主 ID 返回安全 not-found。Core `knowledge.test.ts` **8/8**，Host RAG/工具端口与 lease **16 通过、1 跳过**（Linux 安全原子写入），真实 Agent 主链 **1/1**。`read_knowledge` 更新为已完成并接入 Web；109 项当前：完成 **60**、待接入 **0**、部分 **24**、共享/平台依赖 **24**、退役/重设计 **1**。本轮未运行 Python 后端或 pytest，无 Python bridge、fallback 或双运行时。

### 知识写入工具平台能力门（2026-11-18）

真实 macOS Agent HTTP/SSE 回归发现 `save_knowledge` / `update_knowledge` 在缺少安全文件发布后端时仍被注册，导致工具调用结果未知。Host 现在仅在 Linux `writeLocalFile` 安全原子发布能力可用时装配写端口；macOS 回归 **1/1** 确认写工具未声明且 owner Markdown 未变化。Linux 写入和索引刷新继续由 Linux 专项集成测试验收；本机本轮无法验收该平台分支，故两工具保持部分实现。2.0 仅有 Node 运行路径，不加 Python 兼容、fallback 或普通文件写入降级。

### Agent 用户交互动作表 Node 迁移（2026-11-18）

Node `ask_user` 生产激活要求 `interaction_actions` 表保存选项 token 摘要；Agent Base migration 已建 `interaction_prompts`，但未迁移动作表。新增 schema migration，沿用 Agent migration ledger/checksum/结构验收，并提供 `migrate:interaction-actions:check`、`migrate:interaction-actions:apply`；应在 Agent Base 与 Web Domain schema 可用后执行 apply，再启用依赖持久交互的生产工具。隔离 `startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` 回归实际创建 owner/session 绑定的 choice prompt 与动作记录；Core RAG/interaction **131/131**、Host RAG tool ports **15/15**、主链 **1/1** 通过。MCP Secret store 清理由显式 Host 端口按 MCP 配置注入，不启用 MCP 时普通 ask_user 不访问该可选表。此次只验收等待态创建，不将 `/resume` 后 Provider 恢复续轮记为通过；ask_user 状态不升级。仅 Node schema/实现，无 Python bridge 或兼容回退。

2026-11-18 `ask_user` choice 持久恢复闭环复验：更新真实 Host 集成，经 HTTP `/resume` 提交动作 token，等待 PostgreSQL checkpoint 由 waiting 恢复至 completed，并验证后续 Provider 请求包含已消费选项、助手回复持久化。临时 PostgreSQL/Redis/schema 与环回合成 Provider 下正式 Agent 主链 **1/1 通过**。choice/question 的 Node Web 生产续轮已验证；`form` 与 `authorization=user_sandbox` 仍无 Host 能力，因此 `ask_user` 保持部分实现，109 项状态统计不变（完成并接入60、部分24、共享/平台依赖24、退役/重设计1、待接入0）。未运行 Python pytest；2.0 只走 Node，最终删除 Python 后端，不增加桥接或兼容回退。

2026-11-18 `update_event` 与 Node 日历提醒闭环：修复 PostgreSQL `timestamptz` 返回的短时区后缀解析，带提醒的事件创建不再错误返回未知结果。隔离正式 Web Agent Run 创建 owner 日程及启用/停用提醒，再更新标题和开始时间；校验提醒任务 ID、提前量、渠道和 enabled 保留，只有启用提醒的 cron/start_at 随活动改期，停用计划不变，标题投影更新。Core 日历创建/更新 **6/6**，`startServer → HTTP/SSE → dispatch → Reconstructor → ToolRegistry` 与临时 PostgreSQL/Redis 主链 **1/1**，Host production TypeScript noEmit 检查通过。更新工具状态为已完成并接入 Web；109 项当前：完成 **62**、待接入 **0**、部分 **22**、共享/平台依赖 **24**、退役/重设计 **1**。Python pytest 本轮未运行（本机无 `backend/.venv/bin/pytest`），真实 Provider、外部提醒投递和生产数据未验收。全路径 Node-only，无 Python 兼容桥、fallback 或双运行时。

2026-11-18 联系人与定时任务删除确认生产续轮：隔离 PostgreSQL/Redis 下的正式 Web Agent Run 分别调用 `delete_client` 和 `delete_scheduled_task`，确认 prompt 校验 owner/session/run 绑定；数据库验证确认前无副作用、token 消费后同一持久 Run 恢复并执行删除，定时任务路径同时验证 Redis 资源版本递增。Core 联系人 **20/20**、定时任务删除 **1/1**、Host RAG/lease **15/15**、正式主链 **1/1**、Core build、Web Host production typecheck 和 diff 检查通过。当前静态工具数 109：完成并接入 **64**、已实现待接入 **0**、部分 **20**、共享/平台依赖 **24**、退役/重设计 **1**。本轮未运行 Python pytest；运行和装配只走 Node，最终目标为移除 Python 后端，不增加兼容桥或双运行时。

2026-11-18 `delete_skill` Node 持久确认续轮闭环：正式 Agent Run 请求删除用户 Skill，隔离 PostgreSQL 确认提示与动作 token 绑定 owner/session/run；确认前保留 Skill，消费确认 token 后恢复相同 checkpoint、在业务事务中删除 Skill 并提交操作收据，随后向 Redis 发布 Skills 资源变更。Core `skill-management.test.ts` **2/2**、Host HTTP/删除 **1 通过、1 隔离 PG 子测试跳过**、临时 PostgreSQL/Redis/合成 Provider 的生产主链 **1/1**，Core build 与 Web Host production typecheck 通过。工具更新为已完成并接入 Web；109 项当前完成 **65**、待接入 **0**、部分 **19**、共享/平台依赖 **24**、退役/重设计 **1**。本轮不调用 Python，Node 继续作为唯一目标运行时。

2026-11-18 `delete_event` Node 确认删除生产验收：正式 Agent Run 经持久 PostgreSQL 交互确认，在隔离 PostgreSQL 中软删 owner 活动，并停用其两条提醒（包括此前停用的提醒）；确认前无副作用，确认 token 消费后同一持久 Run 恢复，Redis 日历资源版本递增。Core `calendar-delete.test.ts` **5/5**、隔离 PostgreSQL/Redis HTTP/SSE 主链 **1/1**、Core build 与 Web Host production typecheck 通过。工具更新为已完成并接入 Web；109 项当前完成 **66**、待接入 **0**、部分 **18**、共享/平台依赖 **24**、退役/重设计 **1**。本轮不运行 Python pytest、不接触真实外部提醒投递；Node 是 2.0 唯一运行实现，Python 后端仍是最终删除目标。

2026-11-18 文件工具组连续迁移：`edit_file`、`rename_file`、`copy_file`、`create_file`、`create_folder` 已进入 Core `files.ts` 工具组并接入 per-lease Host registry。创建目录复用 `FolderWriteOperations.create`，限定个人/项目/工作区目标并检查 owner/父目录授权；Core 文件组 **59/59**、Host 合成 lease/文件域端口和临时文件系统 **1/1**、Core build、Web Host production typecheck 与 diff 检查通过。Host 用例覆盖实际目录副作用及越权拒绝。创建文件的隔离 PostgreSQL 测试因测试 URL 未设置跳过；本组尚未验收真实 PostgreSQL 文件写入与完整 HTTP/SSE Run，故相关工具状态为部分实现。当前 109 项：完成 **69**、待接入 **0**、部分 **21**、共享/平台依赖 **18**、退役/重设计 **1**。所有执行与验收仅针对 Node 2.0，不做 Python 兼容或桥接。

2026-11-18 `move_items` 与 `rename_folder` Node 文件组切片：两项工具均进入 Core `files.ts` 和 per-lease Web Registry。`move_items` 只接收 ID 列表（文件与文件夹合计最多 50 项）及明确 personal/project 目标，按项复用文件 CAS 和文件夹树移动事务；`rename_folder` 按 folder ID 读取 owner 版本并委托 FolderWriteOperations CAS/Undo/PathMirror。Core 文件组 **61/61**、Host 文件工具 Registry **1/1**、Core build、Web Host production typecheck 通过；Host 用合成 Pool/文件服务验证修改副作用、过期版本拒绝和撤权。真实 PostgreSQL 与完整 HTTP/SSE Run 未验收；移动工具仍缺名称解析/Workspace 目标，文件夹重命名仍缺按名称定位与重名消歧。当前 109 项：完成 **69**、待接入 **0**、部分 **23**、共享/平台依赖 **16**、退役/重设计 **1**。Node-only，无 Python 运行桥接。
2026-11-18 `send_file` 已接入 Node Web Agent production Registry：Core 工具进入文件组，Host 按每个 dispatch lease 注入 owner 文件库/聊天附件解析和受控图片暂存；外部暂存前核对 owner/session/run/token/fence。Host adapter 经临时 SQLite 和真实临时文件验证 owner 读取、越界拒绝及 lease 失效时无暂存副作用；模拟图片响应与暂存验证有效租约产物。Host Registry/dispatch/lease 定向回归 **31 通过、6 跳过**（需要隔离 PostgreSQL），Core 图片/投递 **26/26**，Web Host production typecheck、diff 检查通过。真实 PostgreSQL、IM 投递和完整 HTTP/SSE Run 尚未验收，按部分实现记入 [`node-agent-tools-parity.md`](../testing/node-agent-tools-parity.md)。2.0 仅迁入 Node，不做 Python 兼容或桥接；Python 后端的最终移除仍需全量 Node 迁移与退出验收。
2026-11-18 `save_uploaded_file` Node 文件工具组已接入 production Web Agent Registry。Host 按当前 owner/lease 下载附件，复用正式文件上传配额、事务、Undo 和收据；支持 recent/latest、精确单个/批量附件，目标 personal/project。可信 workspace 会话绑定未就绪，故 workspace 不开放。Core 文件回归 **62/62**、Host 附件 adapter **1/1**、授权端口 **17/17**、Host Registry/lease 合批 **32 通过、6 个隔离 PostgreSQL 用例跳过**，Core build、Host typecheck 与 diff 检查通过。测试用合成上传事务服务和临时附件文件；真实 PostgreSQL 和 HTTP/SSE Run 未验收，迁移状态与明细见 [`node-agent-tools-parity.md`](../testing/node-agent-tools-parity.md)。只迁入 Node；不新增 Python 兼容或桥接。

2026-11-18 Node RAG 补齐 conversation 引用时间：生产 RAG 资源工厂默认从可信 owner/session 上下文读取时区，并通过统一历史时间 formatter 将持久索引的 UTC 消息时间投影到用户本地时间。Host 资源工厂实际调用 Core 持久索引和 RAG builder **1/1**，确认 `Asia/Shanghai` 输出分钟精度；Core RAG **70/70**，Host RAG/工具/来源 Worker/Jieba **44 通过、7 跳过**，生产 typecheck 通过。Host 测试使用临时 SQLite 和合成 lease/用户时区；隔离 PG/Redis 主链本轮未运行，既有生产主链验收记录不变。未运行 Python pytest 或外部 Provider。Node-only；Python 仅为最终删除目标，不构成兼容需求。

2026-11-18 `list_recent_attachments` Node 文件组切片：Core 严格空参数工具经 Core ToolRegistry 返回 owner 草稿与当前 Web 会话已挂载附件元数据；production Web Reconstructor/Main 按当前 lease 注入 PostgreSQL adapter，并只在端口存在时开放工具。Host adapter/真实注册器 dispatch **2/2**、RAG 工具/授权回归 **18/18**、Core 文件组 **64/64**、Web Host production typecheck 通过。Host 数据库与 lease 依赖为合成对象；已覆盖查询 owner/session、run 身份拒绝、取消和 lease 撤销、非 Web 来源拒绝、错误脱敏及旧版草稿年龄格式。附件媒体正文读取及完整 HTTP/SSE Run 尚未接入/验收，因此仍列部分实现；未运行 Python pytest。109 项状态：完成 **69**、待接入 **0**、部分 **26**、共享/平台依赖 **13**、退役/重设计 **1**。Node-only，Python 不在运行路径。

2026-11-18 `grep` Node 文件工具接线：Core 文件组按逐行字面量搜索、逻辑路径范围、上下文、Base64 省略、8 路有界读取及 128 KiB 结果预算输出命中；Host 查询只返回当前 owner 的活动 personal/project/workspace 登记文件，内容通过 `packages/fs` 授权根读取，路径不接受物理路径。生产 Main/Reconstructor、静态白名单、per-lease ToolRegistry 和复验授权已接通。Core `files.test.ts` **67/67**、Host adapter/dispatch **2/2**、Host 工具/授权/注册回归 **49/49**、Core build、Web Host production typecheck 和 `git diff --check` 通过。Node Host 用例用临时文件及合成 Pool；真实 PostgreSQL/HTTP-SSE Run 与全量 Python pytest 对照统一后续验收。当前工具总数 109：完成 **70**、待接入 **0**、部分 **26**、依赖共享能力或平台 **12**、退役/重设计 **1**。Node-only，无 Python bridge/fallback/双运行时。


2026-11-19 `create_workspace` Node 工具切片：Core 严格校验 directory/project/folder 互斥目标，经 Web per-lease Registry 和授权进入 Host；Host 复用现有 PostgreSQL 声明创建、Workspace 顶层目录创建和共享读取投影。Core ToolRegistry dispatch **2/2**、Host Registry→lease adapter 回归 **2/2**、RAG 权限/注册回归 **49/49**、Web Host production typecheck 通过。三类领域依赖使用合成服务，未运行真实 PostgreSQL 或 HTTP/SSE Run；现有创建服务没有 Agent 持久操作收据，故列为部分实现。Python pytest 未运行；2.0 只运行 Node，Python 是最终移除目标，不保留桥接或回退。109 项：完成 **70**、待接入 **0**、部分 **27**、共享/平台依赖 **11**、退役/重设计 **1**。

2026-11-19 `create_workspace` 持久调用回执补齐：Host adapter 注入 Core receipt runtime 与生产 Pool，校验当前 Web dispatch lease；按稳定 reservation/result operation ID 先持久预留、再调用共享 workspace creator、最后保存完整结果。重复调用/并发/进程恢复不重复创建；改参冲突和 reservation 后结果未知均保持 unknown，不伪报成功。Core ToolRegistry **3/3**、Host Registry→lease→SQLite receipt adapter **4/4**、Core build 通过。Node 测试用临时 SQLite、合成 Pool/lease 与领域服务；未验收真实 PostgreSQL 或完整 HTTP/SSE Run，`create_workspace` 仍为部分实现，工具状态计数不变。Node-only；没有 Python bridge/fallback。


2026-11-19 `delete_folder` Node 文件工具切片：Core 注册稳定 ID 的软删除工具；Web Host per-lease adapter owner 查询后调用既有 PostgreSQL `FolderDeleteOperations`，复用级联软删、文件移入 30 天回收站、Undo 和 PathMirror rollback。Core ToolRegistry 行为 **2/2**、Host adapter dispatch/lease **2/2**、授权/注册/RAG 合批 **52/52**、既有 `folder-delete-postgres.test.ts` **2 通过、1 个隔离 PostgreSQL 用例跳过**；Core build、Web Host production typecheck 和 `git diff --check` 通过。Host adapter 用合成 Pool/操作端口；按名称定位、批量原子删除、Agent 持久调用收据和真实 PostgreSQL/HTTP-SSE Run 未接入/验收。109 项当前：完成 **70**、待接入 **0**、部分 **28**、共享/平台依赖 **10**、退役/重设计 **1**。Node-only，不保留 Python 兼容或运行桥接。

2026-11-19 `save_uploaded_file` workspace 落点接入：Core 工具支持 `space=workspace`，Host 通过共享会话 Workspace reader 解析 owner 当前绑定或默认目录，上传事务重新锁定 session 并拒绝已重绑定的目录；不向模型暴露 workspace directory ID，也不回退到 personal。Core 文件工具 **67/67**、Host 附件 Registry dispatch **2/2**、Host 注册/授权合批 **50/50**、Web Host production build 通过。验证依赖为合成 Pool/Kysely query adapter、上传端口与临时附件文件；全量 Host typecheck 受本切片外既有测试类型错误阻断，真实 PostgreSQL 和 HTTP/SSE Run 未验收，状态仍为部分实现。Node-only，Python 仅作历史行为参考。

2026-11-19 `delete_file` Node 文件切片：Core 接受稳定 `file_id` 或 1-50 个唯一 `file_ids`，Web Host per-lease Registry/授权复用正式 `FileDeleteOperations` 单项或原子批量软删除，写入回收站、Undo 和变更通知。Core 文件工具 **68/68**；Host 删除工具组 **5/5**、附件保存 **2/2**、Registry/授权/生产端口合批 **56/56**；文件删除领域回归 **8 通过、2 个隔离 PostgreSQL 用例跳过**；Core 与 Web Host production build 通过。验证使用合成 Pool/领域端口；真实 PostgreSQL、磁盘事务和 HTTP/SSE Run 未验收；路径定位与 Agent 持久收据未接入，故列部分实现。109 项：完成 **70**、待接入 **0**、部分 **29**、共享/平台依赖 **9**、退役/重设计 **1**。Node-only，Python 仅作历史行为参考。

2026-11-19 `compress_files` / `extract_files` Node 文件组切片：Core `files.ts` 定义并校验两个工具；Web per-lease Host Registry/Main 注入正式 PostgreSQL/Local 文件归档操作，owner 与活动 dispatch lease 在业务事务内复核。复用同空间校验、512MB 压缩源限制、配额、ZIP/TAR 路径穿越防护、10,000 条目及 2GB 解压上限、重名保留与资源发布；结果维持旧工具字段及 100 项 ID 采样。Agent 工具调用以 owner/Run/轮次/tool-call ID 和参数指纹生成回执，并与归档/解压数据库副作用原子提交；恢复只读已提交回执，缺失时返回 `unknown`；提交应答丢失也保留 `unknown` 供 Run 收据恢复，不转成普通失败。Core 文件工具 **77/77**，Host 归档 lease/恢复定向回归 **5/5**，隔离临时 PostgreSQL 归档/解压事务回归 **1/1**，Core build 与 Web Host production build 通过。测试覆盖重复压缩/解压、COMMIT 应答丢失后 receipt 恢复且不重复副作用；合成 Pool 覆盖 lease 授权、回执构造和恢复结果映射。真实部署 PostgreSQL/磁盘、HTTP/SSE Run 恢复及执行中取消的生产集成仍未验收，两个工具维持部分实现。测试临时数据库、Storage 与 archive staging 均已清理。当前工具统计 **109 项：已完成70、待接入0、部分31、共享/平台依赖7、退役/重设计1**。未运行 Python pytest；Python 只作为历史业务参照，不是 2.0 运行、构建或验收依赖，最终目标删除 Python 后端。

2026-11-19 Node-only RAG 复验：确认正式 Host 已在每个可信 lease 中装配自动 RAG、`search_conversations`/`search_memory` registry、正式索引 Worker、八类来源、Jieba、owner-bound 向量与 Web owner 记忆写入链；不增加 Python 兼容、桥接、回退或双运行时。Core RAG **70/70**，Host 定向调用回归 **40 通过、2 跳过、0 失败**，Core build、Web Host production build 与 diff 检查通过。隔离 HTTP/SSE Agent 主链本轮尝试因测试 schema 未包含认证写门查询表而首次返回 503；只在该集成夹具中补了 `data_import_jobs` 最小列后重跑，流程进入持久恢复阶段，但隔离 PostgreSQL 在恢复期间因磁盘空间不足（仅剩约 422 MiB）报 `No space left on device`，本轮主链未通过。临时数据库/Redis/目录已清理；未运行 Python、未调用真实 Provider。该失败不计为 RAG 行为回归失败，也不计作生产主链验收；需要在有足够空间的隔离 PostgreSQL/Redis 环境重跑。


2026-11-19 `unlink_workspace` Node 工具切片：Core 工具组使用持久操作收据，工具调用先建立 owner 绑定的确认意图，确认后在同一收据事务复核 owner、名称和 kind，再复用工作区删除用例解绑声明、会话及普通任务；项目、目录、文件夹、文件和日历提醒保留。Web per-lease Registry、活动 lease 授权及 Main 装配已接通。Core 临时 SQLite ToolRegistry 行为回归 **7/7**（含原 workspace update 5 项），Host RAG/lease 回归 **21/21**、配置白名单/Registry 回归 **29/29**，Core build、Core typecheck、Web Host production typecheck 和 `git diff --check` 通过。确认依赖为合成凭据；真实 PG/Redis 确认恢复和完整 HTTP/SSE Run 未验收，因此 `unlink_workspace` 记录为部分实现。2.0 使用 Node-only 实现，不加 Python 兼容、桥接或回退；Python 仅保留为历史行为参考。当前 109 项：完成 **71**、待接入 **0**、部分 **32**、共享/平台依赖 **5**、退役/重设计 **1**。

2026-11-19 `delete_workspace_directory` Node 工具接入：Core 确认摘要绑定目录标识、显示名、物理目录键和文件/文件夹/会话/任务计数；Web per-lease Registry、授权白名单及 Main 装配复用现有目录预览和删除服务。确认先写持久预留收据，未知结果只读回执，不重放物理删除。Core 工作区 ToolRegistry **9/9**，Host RAG/授权/注册/目录删除 **51/51**，Web Host production typecheck 与 `git diff --check` 通过。工具状态由依赖阻塞更新为部分实现；测试使用临时 SQLite 收据、合成 lease/Pool/确认端口和目录操作服务，真实 PostgreSQL/Redis、磁盘事务及 HTTP/SSE Run 未验收。本轮 Core 全量 build/typecheck 受当前安装缺失的 `mammoth`、`fflate` 阻塞，未运行 Python pytest。2.0 只运行 Node/TypeScript，不保留 Python 兼容层、桥接或回退，最终目标删除 Python 后端。109 项：已完成 **71**、待接入 **0**、部分 **33**、共享/平台依赖 **4**、退役/重设计 **1**。

2026-11-19 `undo_last_action` Node 接入：Core `tools/undo.ts` 提供空参数契约；Host 按可信 owner/session/run 上下文选中并持久固定最近 Undo operation，复用既有 Node Core/Host Undo 状态机。每次操作复验 lease，确认工具 ID 不由模型提供；收据恢复在提交未知时仍定位同一个 operation。Core Undo 工具 **2/2**、Host Undo adapter **1/1**、工作区/RAG/Registry 合批 **53/53**、Web Host production typecheck 与 diff 检查通过。测试使用临时 SQLite、合成 Pool/lease 和 Undo 服务。Host 当前未给 Agent 撤销装配项目本地目录恢复存储，对应项目 Undo 明确返回不可用；真实 PG/Redis、完整 HTTP/SSE Run 未验收，工具列部分实现。本轮未运行 Python pytest；2.0 只运行 Node/TypeScript，不做 Python 兼容、桥接或回退，最终目标删除 Python 后端。109 项：已完成 **71**、待接入 **0**、部分 **34**、共享/平台依赖 **3**、退役/重设计 **1**。

2026-11-19 `undo_last_action` 项目存储补接：Agent 与 Web Undo 的 Main 装配现在传入既有 Node 项目回收存储和受授权根约束的目录移动端口，项目撤销具备本地文件恢复能力。Host Agent Undo 收据及项目 Undo/临时 SQLite/临时文件系统定向回归 **5/5**，Web Host production typecheck 与 `git diff --check` 通过。真实 PostgreSQL/Redis 和完整 HTTP/SSE Run 尚未验收，工具仍为部分实现；本轮不运行或依赖 Python，109 项状态数不变。

2026-11-19 `undo_last_action` 项目撤销工具路径补齐：虽然生产 Main 已注入 Node 项目回收存储和目录移动端口，Agent Host 端口仍硬拒绝 `projects` 资源；现已允许项目 Undo 经既有 Host 状态机执行，保持操作收据固定目标与 lease 复核。Agent Undo 路由及项目状态机定向 Node 回归 **4/4**；真实 PostgreSQL/Redis 与完整 HTTP/SSE Run 仍待统一验收，因此不升级工具整体状态。本次只运行 Node 测试，不接 Python 兼容层。

2026-11-19 `permanent_delete` Node 工具接线：Core `trash.ts` 严格要求 `all=true`，读取当前 owner 快照并通过持久 confirmation gate 请求用户确认；确认后 Web Host 复核 owner/session/run lease 及文件/目录 tombstone 摘要，以 Core SQLite/SQL operation receipt 去重，再复用 Host `startEmpty` 创建 owner purge job。既有 Node Worker 负责持久分批删除、租约恢复和进度发布。生产 Main、per-lease ToolRegistry、静态白名单及 RAG 发现/执行授权已接通；空回收站无确认/副作用，确认前不排任务。Core 回收站 ToolRegistry **6/6**，Host purge adapter 与既有 PG purge job 行为 **5/5**，Core build、Host production typecheck 和 `git diff --check` 通过。测试依赖为临时 SQLite receipts 与合成 Pool/lease/确认/job 端口；隔离 PostgreSQL、Redis 唤醒、完整 HTTP/SSE Run 尚未验收，故记为部分实现。当前 109 项：已完成 **71**、待接入 **0**、部分 **35**、共享/平台依赖 **2**、退役/重设计 **1**。2.0 仅运行 Node/TypeScript，不接 Python 后端。

2026-11-19 RAG 生产主链及回收站清空迁移复验：Node Web Host 增加正式 `trash_purge_jobs` schema migration 和 `migrate:trash-purge:check/apply`；启动时检查迁移状态，只有迁移已应用且 Linux 安全文件后端可用时才启用 `permanent_delete` 与清空 Worker。其他平台的 HTTP 清空入口显式返回 503，不创建无消费者的 job。隔离临时 PostgreSQL/Redis 上，正式 `startServer → HTTP/SSE → 会话写入 → conversation 索引 Worker → search_conversations ToolRegistry` **1/1**，验证 owner 内容可召回且排除异主；回收站 migration/job 行为、RAG Registry/工具及路由合批 **24 通过、1 跳过**，跳过项是 Linux 目录句柄安全暂存（当前运行平台 macOS）；独立路由/RAG/工具批次 **28 通过、1 个无隔离 PG 用例跳过**。Web Host production typecheck 和 `git diff --check` 通过。未运行 Python pytest、未调用真实付费 Provider 或部署服务；临时 DB/Redis/目录均已清理。`permanent_delete` 完整 HTTP/SSE 确认后恢复本轮仍未验收：探测中 confirmation 已消费但没有创建 purge job，checkpoint 最终呈 unknown，故工具保持部分实现，不宣称销毁调用链闭合。2.0 只运行 Node/TypeScript，Python 仅作历史行为参考并最终删除，无 Python bridge、fallback 或双运行时。

2026-11-19 付费搜索工具 Node 可用性切片：为 `deep_research` / `similar_image_search` 新增 Node 管理的 `search_usage` 迁移和 `migrate:search-usage:check/apply`；迁移会严格校验并登记结构匹配的既有用量表，保留已有额度记录，结构不匹配则拒绝。生产启动检查迁移状态，未应用时两项付费工具不进入 per-lease Registry；已存在的普通 `web_search` 不受影响。现有 Core provider/参数、Host 凭据解密、图片 owner 校验、活动 Run 授权、持久配额预留/结果收据和安全出站端口接入生产 Run。Node `agent-search.test.ts` 与迁移测试在临时 PostgreSQL、合成 Provider/图片依赖下 **9/9 通过**，覆盖真实工具 dispatch、owner/lease 隔离、并发配额及未知结果不重复付费外呼、迁移新建/安全接管/拒绝不兼容结构；Web Host production typecheck 与 diff 检查通过。未调用真实付费 Provider 或公网，不运行 Python pytest；真实账号凭据、外部服务和部署留待统一验收，两项继续按部分实现统计。2.0 只运行 Node/TypeScript，不新增 Python 运行桥或双运行时。

2026-11-19 `permanent_delete` 确认恢复闭环补齐：新增 Node migration `trash_purge_agent_operations`，以 owner 和稳定 Agent 操作 ID 将确认快照、purge job 与可恢复关联写入；job 与关联同 PostgreSQL 事务提交，结果写入收据前进程退出时可按同一快照/操作 ID恢复；若快照改变则不排任务。Agent ToolPort 在确认预留后首次 job 提交失败时，从持久预留读取确认快照并重试，同一操作重放读取同一个 job。定向 Host Node 测试 **7 通过、0 失败、2 跳过**，覆盖首次提交中断恢复、稳定 job 关联、快照漂移拒绝、owner 与确认门；跳过的 migration/Worker 集成均需隔离 PostgreSQL。Core build 通过；Web Host 全量 `tsc` 仍因其他 admin、scheduled-task 等测试类型错误失败，本次工具/迁移文件未出现在错误中。未验收真实 PostgreSQL/Redis、完整 HTTP/SSE Run 或部署，`permanent_delete` 仍列部分实现。全程 Node/TypeScript，不运行 Python。

2026-11-19 定时群任务启用共享 Node `search_memory`：复用 Core RAG memory loader、正式 Jieba 装配、共享工具契约和群 scope tombstone/revision 查询。每次执行按同一 scheduled task/run 重新核对已绑定 owner/platform/bot/group；后台任务没有当前 IM 发送者，故拒绝 owner 私人及跨群 scope，只在当前群进行 BM25 召回。真实 Core ToolRegistry 用例验证命中当前群正文、异主/异群不可见、范围撤销、owner/run 伪造和不允许的 scope；Core RAG/群工具 **13/13**，Web Host Runtime **3 通过、2 跳过**（缺隔离 PostgreSQL/Redis），Core build 和 Web Host production typecheck 通过。生产 PG/Redis 定时任务群主链未验收，`search_memory` 总体仍属部分实现；本轮不使用 Python。

2026-11-19 `read_file` 扩展 Node Office 文本读取：Web Host 继续用 owner-scoped 文件行解析和 `packages/fs` 授权根打开文件；Core 复用正式 Node Office 提取器读取 PDF、DOCX、XLSX/XLS、ODS、PPTX、ODT/ODP、RTF，30 MiB 单文档上限，结果仍按提取正文物理行号选择并受批量 64 MiB 上限约束。Core 文件/Office 回归 **92/92**，Host production ToolRegistry 实际读取临时 PDF **1/1**，Web Host production typecheck 通过。测试使用临时存储和合成 owner DB 查询；真实 PostgreSQL/HTTP-SSE Run 留待统一回归。未运行 Python。


2026-11-19 `edit_file` 补齐可调用编辑操作：Core `files.ts` 接受 owner 文件 ID 或文件库逻辑路径，支持全文替换、追加、查找替换、按行替换/删除及最多 20 项批次；数字行修改要求 `expected` 校验原文，范围重叠拒绝，批次逐项报告失败，任一写入结果未知时不伪报普通失败。Web Host 在当前 lease 下复用 owner 文件清单解析路径，再经 owner 文件查询和现有文件内容 CAS/Undo 事务更新。Core ToolRegistry **73/73**，覆盖行修改/删除、原文及重叠校验、批次部分失败、owner 隔离；Host per-lease Registry 真实临时文件行为 **1/1**；Core build 与 Web Host production typecheck 通过。测试使用临时目录、合成 Pool/文件清单/文件事务；真实 PostgreSQL 与完整 HTTP/SSE Run 留待集中验收。本轮未运行 Python pytest。


2026-11-19 `create_file` 批量与可信工作区目标补齐：Core 文件组支持最多 20 项创建并逐项返回成功/失败，每项派生稳定工具调用 ID 供 Host 收据去重；单文件 UTF-8 上限 256 KiB，按扩展名拒绝 PDF/Office 二进制伪写。Host workspace 目录从当前 owner/session 的可信绑定读取，上传事务锁定 session 后复核目录未变；不接受模型提供 workspace directory ID。Core files ToolRegistry **74/74**；Host create batch/文件字节/lease/独立收据/重放 **1/1**，既有 Host 单文件创建回归 **1/1**，Web Host production typecheck 通过。测试使用临时暂存目录、合成 Pool/上传事务；真实 PostgreSQL 与 HTTP/SSE Run 留待统一验收。Node-only，本轮未运行 Python pytest。

2026-11-19 RAG Node 生产主链复验收：Host RAG/来源 Worker/Jieba/资源组在临时 PostgreSQL 与 Redis 下 **48 通过、1 跳过**（Linux 安全原子写），Core RAG **70/70**。隔离临时 PostgreSQL cluster/schema、Redis、owner 文件目录和本机合成 Provider 上，真实 `startServer → HTTP/SSE → 持久 dispatch → Reconstructor → ToolRegistry` **1/1 通过**，验证 Node 索引 Worker、两个 owner 的隔离及 `search_conversations` 实际命中。本次通过覆盖此前受磁盘空间影响而失败的尝试；并非生产数据/外部 Provider 验收。文件工具 `create_file`/`edit_file` Core **74/74**、Host 实际调用 **3/3**，Web Host production typecheck 与 diff 检查通过。2.0 仅运行 Node/TypeScript，Python 不是兼容或运行目标。

2026-11-19 `read_file(attach_id)` 增加 owner 历史文本/PDF/Office 附件读取：Core 单项与批量 schema、来源互斥、UTF-8/行范围和 32/64 MiB 限制经实际注册器执行；Web per-lease adapter 按 owner 与附件 ID 查询 `chat_attachments`，随后经 `packages/fs` 授权根读取。Core `files.test.ts` **75/75**，Host Core Registry→Host adapter→临时附件文件 **1/1**；异主 Run 在查询前拒绝。历史图片/音频/视频仍需 Node 媒体解析与模型能力端口，URL 图片和 system scope 也未接入；不返回假成功。真实 PostgreSQL/HTTP-SSE Run 与部署验收留到统一阶段，本轮仅跑定向 Node 回归。

2026-11-19 `list_dir` Node 文件库路径与筛选切片：Core `list_dir` 支持 `file_path=/personal`、`/project/{项目名}`、`/workspace/{工作区名}` 文件库登记路径，拒绝宿主路径、越界片段及与显式空间/过滤字段混用；Core 最多规范化 8 个关键词并传递 OR/AND，Host PostgreSQL 浏览服务安全绑定关键词、返回准确过滤总数。Host per-lease 端口按可信 owner 精确解析项目、工作区和逐层文件夹 ID，再复用既有文件浏览服务；生产 Main 注入 PostgreSQL 池。Core 文件组 **77/77**；Host 实际 ToolRegistry→owner SQL/文件分页 SQL **3/3**，覆盖路径、查询、total 及异主 lease 在 SQL 前拒绝。测试 SQL 使用合成 Pool；真实 PostgreSQL/HTTP-SSE Run 留待统一回归。旧版 Shell `scope=logical` 用户根、system scope、偏移分页和全量文件夹列表语义未迁移，不开放宿主路径。

2026-11-19 `compress_files` / `extract_files` 持久调用收据补齐：Core 工具把稳定 Run 轮次与 ToolCall ID 交给可信 Host；Host 按 owner/Run/轮次/调用 ID/参数指纹生成收据，PostgreSQL 归档与解压服务将收据和业务变更放在同一事务。精确重试读取原结果；COMMIT 应答丢失返回 `unknown`，恢复只读收据、不重放文件副作用。Core 文件工具 **77/77**、Host lease/恢复行为 **5/5**、临时隔离 PostgreSQL 归档/解压/重复调用/提交未知恢复 **1/1**，Core build 与 Web Host production build 通过。使用临时 PostgreSQL cluster、schema、存储目录及合成 lease/Provider，临时目录已清理；没有运行 Python。正式部署数据库及完整 HTTP/SSE Run 验收仍未完成，两项维持部分实现。2.0 只有 Node/TypeScript 执行路径；Python 仅作历史行为参照，最终目标删除 Python 后端。

### Web Host 旧目录收敛

| 旧域 | 迁移边界 |
| --- | --- |
| terminals | 已并入 `modules/terminals/persistence/`。Host 保留 PostgreSQL、偏好和 MXC 接线，继续调用 Core 终端用例。生产入口、测试与测试元数据已更新。 |
| admin、auth、mind、files | 分别合并到现有同名模块。保留 Web 认证、协议、平台和数据库装配，逐用例检查 Core 的现有规则与事务。 |
| agent-config、agent-sessions | 模型配置归 Agent/BYOK 对应模块，运行装配归 Agent 会话模块。共享运行时和工具归 Core，避开并行工具修改。 |
| preferences、projects、workspaces | 按业务建立对应模块。跨端偏好、项目与工作区规则归 Core，Host 保留部署与授权接线。 |
| undo | HTTP 与 PostgreSQL 协调归 Undo 模块，复用 Core 状态机及领域适配，逐项确认项目恢复日志、文件存储及日历索引依赖。 |

终端目录迁移已在 devserver 核对移动文件、调用方及测试文件的内容摘要。Node 定向回归 27/27，Web Host 生产源码类型检查通过。该切片沿用已有 Python 行为对照，未复跑 Python，也未新增数据库、真实 PTY 或部署验收。

偏好模块已从 `domains/preferences/` 迁入 `modules/preferences/`。Host 保留 Fastify 路由、PostgreSQL、Local 文件与 SMTP 接线，复用 Core 偏好服务、校验和文件契约。Agent 上下文直接从 Core 引用文件契约。devserver 核对迁移文件及调用方摘要，偏好回归 21 通过、2 跳过，生产源码类型检查通过。未复跑 Python 或验收真实 SMTP、正式 SQLite 与部署。

Mind 的画布和便签读取及写入路由已并入 `modules/mind/`，与引用建议路由同域。Fastify 的认证、DTO 和错误映射仍由 Host 负责，共享读取、写入与 Undo 事务仍调用 Core。devserver 核对迁移文件、组合根和测试摘要后，Mind 回归 43 通过、9 跳过、0 失败，生产源码类型检查通过。隔离 PostgreSQL 用例未执行，本轮未复跑 Python 或验收部署。

Undo 已迁入 `modules/undo/`。Fastify 路由、PostgreSQL 事务协调、项目恢复日志和 Local 适配留在 Host，继续调用 Core Undo 状态机及领域适配。项目恢复 Worker 和记账事务、Agent Undo、文件适配及测试均改为直接引用新位置。项目恢复仍使用项目域的存储与路径移动实现，待项目域迁移时更新依赖。devserver 核对内容摘要后，Undo 定向回归 25 通过、15 跳过、0 失败，生产源码类型检查通过。跳过项依赖隔离数据库，本轮未复跑 Python 或部署联测。

Agent 模型配置已归入 `modules/agent/model-config/`。Host 保留配置快照、凭据解密、PostgreSQL 凭据读取和 Provider 绑定，继续委托 Core 已有配置与模型规则。生产、测试及元数据引用已切换，仍有两处会话使用量类型依赖，随 Agent 会话域收敛处理。devserver 内容摘要一致，定向回归 14 通过、17 跳过、0 失败，生产源码类型检查通过。未复跑 Python 或进行真实 Provider 联测。

工作区声明与绑定已迁入 `modules/workspaces/`，包含 HTTP 路由和创建、更新、读取、删除、绑定五个 PostgreSQL 适配器。组合根及 Agent 确认删除调用方已切换。继续复用 Core 声明和绑定用例，保留 Host 的可信身份、SQL 与事务装配。旧目录仅余两个 `workspace-directories.ts` 文件，保留其并行修改。devserver 核对本批文件摘要后，工作区回归 22 通过、9 跳过、0 失败，生产源码类型检查通过。未复跑 Python，也未验证正式 SQLite 或部署。

Admin 的 14 个路由、认证和服务文件已并入 `modules/admin/`，生产入口和测试直接引用新位置。保留现有 Fastify 管理权限、Core 委托及 Host PostgreSQL/配置适配。旧目录仅保留有并行修改的 `admin-config.ts`。devserver 核对内容摘要，生产源码类型检查通过，审计、安全事件、运维摘要、感知及提示词定向回归 24/24。完整 Admin 批次仍需确认退出结果，未复跑 Python 或验证部署。

项目 HTTP 路由及项目读取适配已迁入 `modules/projects/`。共享读取和文件数统计继续由 Core 提供，Host 保留认证、DTO 与 PostgreSQL 接线。生产入口、Agent 文件概览、旧项目更新和回收站调用方已切换。devserver 定向回归 13 通过、4 个隔离 PostgreSQL 用例跳过。修正相对引用后，生产类型检查仅剩并行 Agent 文件删除端口与 Core 类型不一致。项目写入、存储及恢复仍待分批迁移。

项目 Local 存储、路径移动、回收站路径元数据和提交后事件适配共五个文件已归入 `modules/projects/persistence/`。生产组合根和 Undo 恢复调用方已改用新位置。删除项目回收站的旧 Host 转发，调用方直接使用 Core 用例与契约。devserver 核对文件摘要后，存储、回收站、更新、事件及恢复日志定向回归 54/54。生产类型检查仍报并行 Agent 文件删除端口签名不匹配。未复跑 Python 或执行真实 PostgreSQL 恢复联测。

项目过期清理 Worker 入口已迁入 `modules/projects/`，生产组合根和测试直接引用新位置。PostgreSQL 清理及恢复适配保留在原路径，等待并行修改收尾。devserver 核对文件摘要，Worker 回归 3/3（默认关闭、停止等待在途恢复、锁释放后重试）；生产类型检查仍受 Agent 文件删除端口的签名冲突阻断。未复跑 Python 或真实 PostgreSQL 清理。

认证邮箱变更和密码重置已迁入 `modules/auth/`，继续复用现有 Core 规则和 Host PostgreSQL 事务。SMTP 发送适配由认证、偏好和反馈共享，迁入 `adapters/smtp-email.ts`。生产入口与测试引用已更新。邮箱变更和密码重置仍依赖旧认证域限流端口，随认证域后续切换。devserver SSH 在握手阶段超时，本批远端摘要核对及回归尚无结果。

认证限流已迁入 `modules/auth/rate-limit.ts`。登录、注册、邮箱变更、密码重置和 Redis 接线直接引用新路径，保留原有键、窗口和故障行为。静态引用核对及 diff 检查通过。devserver 验证已启动，整批结果待确认。

用户配额路由与 PostgreSQL 读取适配已迁入 `modules/auth/`，认证契约和组合根改用新路径。devserver 核对内容摘要后，首次配额及限流合批受 Core data-portability 构建产物缺失影响，隔离 PG 配额用例跳过。此前邮箱变更、密码重置和 SMTP 批次 17/17。已启动 devserver Core 重建及认证复验。

头像路由及 PostgreSQL/Local 适配已迁入 `modules/auth/`，生产组合根和测试直接引用新位置。用户响应和账号仓储仍引用旧认证域的现有实现。devserver 文件摘要一致，头像批次已启动，隔离 PG 头像用例跳过。此前 Core 重建完成，认证配额、限流、登录和注册验证码复验 22 通过、1 个隔离 PostgreSQL 用例跳过，生产源码类型检查通过。

注册邮箱解析已归入 `modules/auth/email.ts`。沿用注册专用长度及格式契约，注册与验证码路由直接引用。devserver 摘要一致，验证码回归 6 通过，注册 PostgreSQL 4 跳过。上一批头像回归 3 通过、2 个隔离 PG 用例跳过，生产类型检查因并行 Agent 文件删除端口缺少 `resolveFilePath` 声明失败。

账号仓储、注册事务、Redis 注册验证码及会话撤权适配已迁入 `modules/auth/persistence/`，旧认证 persistence 目录已删除。生产入口、头像、Redis 事件和验证码路由已切换。devserver 摘要一致，回归 12 通过、4 个隔离 PostgreSQL 用例跳过。生产类型检查仍仅报并行 Agent 文件删除端口缺少 `resolveFilePath` 声明。

2026-11-19 `delete_file` 逻辑路径 Node 切片：Core/Host 在真实 ToolRegistry 调用中支持 `file_id`、单个登记逻辑路径和批量 `file_ids`；逻辑路径由当前 owner 的文件清单精确解析，只可访问 `/personal`、`/project`、`/workspace`，拒绝宿主路径和 `..`，未匹配或不唯一时不调用删除。删除继续复用 owner/lease 复核、同事务持久收据、Undo 与回收站。Core `files.test.ts` **77/77**，Host ToolRegistry/文件删除 **8/8**，Web Host production build 通过。Host 端口为合成清单/Pool/删除服务；真实 PostgreSQL 与完整 HTTP/SSE Run 未验收，故维持部分实现。本轮未运行 Python pytest；Node-only，不保留兼容、桥接或回退。

批量文件及文件夹下载的两个 HTTP 路由与 PostgreSQL/Local ZIP 适配已并入 `modules/files/`。组合根与测试直接引用新位置，仍复用现有 owner 校验和受限文件读取。devserver 摘要一致，认证 ZIP 路由回归 1/1，两个隔离 PG 用例跳过。生产类型检查仍报 Agent 文件删除端口缺少 `resolveFilePath` 类型声明。

文件读取路由及 PostgreSQL/Local 读取适配已迁入 `modules/files/`。批量下载、附件工具及组合根等调用方已切换，继续复用 Core 授权读取及相对引用解析。devserver 核对文件摘要后，定向回归 9 通过、3 个隔离 PostgreSQL 用例跳过。覆盖属主、范围、路径穿越和符号链接边界。

2026-11-19 `rename_file` 登记逻辑路径 Node 切片：Core/Host 实际 ToolRegistry 支持 `file_id` 或 `file`，后者由当前 owner 文件清单经 lease 绑定后唯一解析，删除/改名均不接触宿主任意路径；版本 CAS、Undo 和文件更新复用既有 Host 文件域。Core 文件组 **77/77**、Host 文件工具生产 registry **1/1**、Web Host production build 通过。测试使用合成 owner 文件清单、Pool 和更新端口；真实 PostgreSQL/HTTP-SSE Run、旧版按名称消歧及扩展名规则未验收，故维持部分实现。本轮未运行 Python pytest，Node-only。

文件内容和冲突检查的 HTTP 路由及 PostgreSQL/Local 适配共四个文件已并入 `modules/files/`。生产和测试调用方已切换，现有路径锁和写入记录保持原样。旧路径引用及 diff 检查已完成，devserver 摘要与定向回归待返回。

2026-11-19 `copy_file` 登记逻辑路径 Node 切片：源文件可按 `file_id` 或 owner 文件清单经当前 lease 唯一解析的逻辑路径定位；拒绝宿主路径、越界和不唯一目标，随后复用现有文件复制领域事务、显式目标空间、keep_both、Undo 与 owner 校验。Core 文件组 **77/77**、Host 文件工具生产 registry **1/1**、Web Host production build 通过。测试依赖合成 owner 清单/Pool/复制端口，真实 PostgreSQL 与完整 HTTP/SSE Run 未验收，维持部分实现；本轮未运行 Python pytest，Node-only。

文件夹读取路由与 PostgreSQL 适配已并入 `modules/files/`，组合根及测试已切换。静态引用与 diff 检查通过。同步仍在应用变更，远端一度还存在旧文件，需待摘要一致后计入回归结果。

文件复制和元数据更新的 HTTP 路由及 PostgreSQL/Local 适配共四个文件已并入 `modules/files/`。组合根、Agent 调用及测试直接引用新位置，保留路径锁、物理补偿与配额记账接线。旧路径及 diff 静态检查通过，devserver 同步、摘要核对和回归已发起。

文件恢复的 HTTP 路由和 PostgreSQL/Local 适配已并入 `modules/files/`，生产入口与 Agent 回收站恢复均直接引用新位置。旧引用检查与 diff 检查通过，devserver 正在同步及验证。上一批文件夹读取摘要核对发现组合根与本地不同，测试未启动，待同步收敛后重新核对。

文件夹写入路由与 PostgreSQL 适配已并入 `modules/files/`，生产和 Agent 调用方直接引用新路径，保留现有事务与本地路径补偿。静态引用及 diff 检查通过。文件内容上一轮回归执行期间同步切换了组合根依赖，出现旧路径导入失败，不能作为行为验证。已发起摘要核对后的文件域合批复验。

2026-11-19 `move_items` 文件逻辑路径 Node 切片：Core 与 Web per-lease Registry 支持文件 ID/登记逻辑路径逐项移动，Host 复用 owner 文件清单解析和既有 CAS/文件夹移动服务；歧义或不存在的路径按单项失败返回，不影响其他项，宿主路径及名称猜测拒绝。Core 文件组 **77/77**、Host 文件工具生产 registry **1/1**、Web Host production build 通过。测试使用合成 owner 清单、Pool 与文件域端口；真实 PostgreSQL/HTTP-SSE Run 尚未验收，维持部分实现；本轮未运行 Python pytest，Node-only。

文件 ID、属主存储键和大小展示辅助函数已归入 `modules/files/`。调用方统一直接引用新位置，旧导入目录的属主限制保持原样。devserver 摘要核对后定向 12/12；前一批文件路由合批 33 通过、8 个隔离 PostgreSQL 用例跳过。合批生产类型检查仍受并行 Agent 复制、重命名、删除端口类型不匹配阻断。

Local 路径变更适配与文件夹路径规划已迁入 `modules/files/`。所有调用方直接引用新位置，保留事务补偿、属主边界与不覆盖行为。devserver 摘要一致，路径规划、Local 操作与文件夹写入定向回归 13/13。上一批生产类型检查因 Agent 文件端口签名不匹配失败，本批类型检查尚待结果。

文件配额记账、配额扫描及现有文件写入路径锁适配已迁入 `modules/files/persistence/`。保留事务与旧路径锁行为，调用方直接引用新位置。devserver 核对文件摘要后，配额及正文写入回归 5 通过、1 个隔离 PostgreSQL 用例跳过，当前 Web Host 生产源码类型检查通过。

Agent 会话的敏感交互定位、消息定位、消息历史和工具详情路由共五个文件已迁入 `modules/agent-sessions/`。认证及 HTTP 映射留在 Host，共享查询继续使用 Core。首次回归发现工具详情路由漏迁同目录依赖，补齐后 devserver 摘要一致，定向回归 8 通过、2 个隔离 PostgreSQL 用例跳过，生产源码类型检查通过。消息历史的旧持久适配留待会话存储迁移。

2026-11-19 工作区工具参数验证修正：Core `create_workspace` project/folder 目标 ID、工作区读取/更新/解除绑定 `workspace_id` 统一要求正安全整数；零/负 ID 在 dispatch 参数边界拒绝，不触达 Host。Core 定向回归 **11/11**、Core build 通过；工具状态分类不变，本轮未运行 Python pytest，Node-only。

会话改名和上下文刷新已迁入 `modules/agent-sessions/`。生产组合根与测试已切换，继续委托 Core 会话用例及 PostgreSQL 仓储。devserver 文件摘要一致，定向回归 8 通过、2 个隔离 PostgreSQL 用例跳过，生产源码类型检查通过。

Agent 会话列表、界面标签与命令路由、标签覆盖配置和待处理队列的查询、领取与更新已并入 `modules/agent-sessions/`。Host 保留可信身份和配置接线，沿用现有共享用例。devserver 核对文件摘要，定向回归 22 通过、6 个隔离 PostgreSQL 用例跳过，生产源码类型检查通过。

会话授权路由、凭据交互路由及持久运行 SSE 重放适配已迁入 `modules/agent-sessions/`。组合根和既有运行生命周期已切换引用。授权及凭据持久化仍引用原实现。devserver 核对摘要后定向回归 9 通过、1 个隔离 PostgreSQL 用例跳过，生产源码类型检查通过。

凭据交互 PostgreSQL 适配与可信交互描述已归入 `modules/agent-sessions/persistence/`。生产组合根、凭据路由和确认调用方已切换，保留配置版本复核及事务边界。devserver 核对摘要后，定向回归 2 通过、2 个隔离 PostgreSQL 用例跳过，生产源码类型检查通过。

会话文件授权的 PostgreSQL 服务和 Redis 确认码适配已与路由统一归入 `modules/agent-sessions/`。生产组合根、消息历史与 Redis 命令类型引用已切换。devserver 核对文件摘要后，授权回归 6 通过、3 个隔离 PostgreSQL/Redis 用例跳过，生产源码类型检查通过。

Agent 用量账本 PostgreSQL 适配已迁入 `modules/agent-sessions/persistence/`，聊天、反思、定时执行及模型配置调用方已切换。devserver 摘要一致，用量定向 3 通过、2 个隔离 PostgreSQL 用例跳过。本批生产类型检查受组合根的 `TrustedPromptPorts.filesystemAuthorizationEnabled` 接线缺失阻断。

运行启动、PostgreSQL 租约及 Redis 取消适配已归入 `modules/agent-sessions/persistence/`。生命周期与测试已切换。devserver 核对摘要后定向回归 8 通过、4 个隔离 PostgreSQL/Redis 用例跳过。生产类型检查发现并行授权工具的 Core 导出和调用签名差异，以及新增调用方仍引用旧授权路径。旧引用已更新，完整类型检查需复验。

推理状态加密、PostgreSQL 状态存储和孤儿运行恢复已归入 `modules/agent-sessions/persistence/`。组合根和推理桥接调用方已切换。devserver 核对摘要后，回归 3 通过、4 跳过（隔离 PostgreSQL 或带 cryptography 的 Python）。生产类型检查仅剩并行授权工具的 Core 导出和调用签名差异，上一批旧授权导入错误已消失。

会话规范历史 PostgreSQL 读取与历史基线锁已归入 `modules/agent-sessions/persistence/`。上下文读取、规范写入与测试改用新路径，未改动历史投影或锁逻辑。静态旧路径及 diff 检查通过，devserver 摘要与定向回归待返回。推理桥接仍有未提交改动，留待后续迁移。

2026-11-19 `ask_user` 完整用户沙箱授权交互接线：Core 工具调用 Host 注入的授权端口；生产 Host 绑定当前 Web dispatch lease、授权开关和 owner/session 现存 grant。等待交互由可信 Host 固定授权范围和确认/取消动作，禁止自由文本输入；确认复用既有 PostgreSQL grant 与安全审计事务。Core 交互 **21/21**，Host 注册/授权/提示定向组 **56 通过、3 跳过**，授权副作用组 **7 通过、4 跳过**，Web Host production build 通过。全量 Web Host typecheck 仍受既有测试源码类型错误阻断；隔离 PostgreSQL 端到端授权提示/响应未在本轮运行。`ask_user` 仍部分实现（通用表单及端到端服务验收未完成）。本轮不运行 Python；Python 是 2.0 删除目标后端的历史行为参考，Node 为唯一实现，不设兼容层。

交互所属会话查询、交互消费事务及上下文快照效果适配已迁入 `modules/agent-sessions/persistence/`。组合根、交互响应、运行时与测试直接引用新位置。首次远端摘要检查时同步尚未应用这三个文件，未运行回归，需在同步完成后复验。

群聊提及名称的 Host 解析适配已迁入 `modules/agent-sessions/persistence/`，消息历史继续调用共享 Core 查询。静态检查通过。devserver 首次摘要检查时新文件尚未到达。上一批交互与历史切片复核时仅组合根 `main.ts` 摘要不一致，Mutagen 报告暂存文件权限设置失败，未以该工作树执行组合回归。

聊天附件认领、待处理队列绑定和聊天准备的 PostgreSQL 适配已迁入 `modules/agent-sessions/persistence/`。当前 Web 聊天准备组合直接引用新路径，保留既有 owner、事务及 RAG 入队接线。静态检查通过，devserver 同步及回归已发起，待结果。

会话 RAG 重建任务和 IM 记忆索引变更适配已归入 `modules/agent-sessions/persistence/`。注册播种、重播种、聊天准备、历史写入及生产入口统一引用新位置，保留现有事务入队和清理语义。静态检查通过，devserver 核验待返回。

RAG 索引 Worker 和重建装配已归入 `modules/agent-sessions/`，生产入口直接引用新位置。Worker 生命周期及 Core 索引行为保持原样，仍依赖旧目录的三个工具适配，待其迁移时切换。静态检查通过，devserver 文件摘要、回归和类型检查待返回。

反思证据处理、PostgreSQL 来源、Local 写入及工作装配的四个 Host 文件已迁入 `modules/agent-sessions/persistence/`。模型和 Redis 队列适配保留并行改动，仅更新调用方引用。静态检查通过，devserver 摘要及反思回归待结果。

Web 用户令牌、Cookie/CSRF 认证与退出路由已归入 `modules/auth/`。生产入口、用户仓储及测试直接引用新路径。静态检查通过，devserver 首次摘要检查时两个新文件尚未同步，未启动登录/退出回归。

消息物化、历史引用、关联引用、总览查询、上下文主体、IM 渠道、提示文件及消息时间八个 Host 上下文文件已迁入 `modules/agent-sessions/context/`。Core 查询与上下文规则沿用现有实现，仍在编辑的上下文装配、来源、偏好和附件读取留原位。静态检查通过，devserver 摘要核对及回归待结果。

登录、当前用户、注册和注册验证码路由已归入 `modules/auth/routes/`，移动的三个文件此前仅有本次迁移引入的 import 改动。生产入口、注册事务与测试已切换。旧认证域仍保留并行修改的契约、用户响应及资料路由。静态检查通过，devserver 文件摘要核对与回归待结果。

项目更新、回收站事务与删除恢复 Worker 已迁入 `modules/projects/`。移动前核对差异仅有本目标引入的引用调整。生产入口和测试直接引用新位置，旧项目域仅余带并行修改的过期清理 PostgreSQL 适配。静态检查通过，devserver 摘要和回归待返回。

归档路径校验、大小限制和 MIME 处理已移至 `modules/files/file-archive-rules.ts`。现有归档事务仅更新导入路径，保留并行修改。静态检查通过，devserver 摘要核对与归档规则回归待返回。

RAG Worker 使用的 Local 记忆索引、PostgreSQL 索引范围和 Jieba 初始化适配已并入 `modules/agent-sessions/tools/`。RAG Worker 的三个旧工具依赖已切换，同时更新定时执行、记忆上下文以及会话检索调用方。静态检查通过，devserver 回归待结果。

MCP 会话工具的运行准备与执行授权已归入 `modules/agent-sessions/tools/`。重建器和测试已切换引用。Host 的工具端口装配及 dispatch 租约类型暂仍引用旧位置。静态检查通过，devserver 验证尚待结果。

MCP 工具端口已迁入 `modules/agent-sessions/tools/`。会话重建、定时任务、运行准备和生产端口均切换引用，旧注册器只作为现有类型依赖。静态检查通过，devserver 定向回归仍待同步和验证结果。

MCP 生产端口随工具端口归入 `modules/agent-sessions/tools/`。移动前核对原差异仅为本轮旧路径调整，生产入口及回归改用新位置。静态检查通过，devserver 回归尚待结果。

邮件、画布写入、飞书链接按钮的 Host 适配已迁入 `modules/agent-sessions/tools/`。组合根与测试引用已切换，沿用既有 Core 工具规则及 Host 平台边界。静态检查通过，devserver 摘要及行为回归待结果。

Agent 定时任务写入、记忆写入和 RAG 向量查询的 Host 适配已归入 `modules/agent-sessions/tools/`。生产入口、记忆检索及测试已切换引用，继续使用 Core 与现有 BYOK、定时任务适配。静态检查通过，devserver 摘要及定向回归尚待结果。

日历写入及提醒目标、IM、知识及索引存储、项目工具、RAG 运行上下文及工具端口和确认身份共九个未修改的 Host 文件已迁入 `modules/agent-sessions/tools/`。生产与测试引用已切换，保留其他工具的并行改动。静态检查通过，devserver SSH 在握手阶段超时，本批回归未启动。

上下文装配、来源、偏好及推理状态桥接已迁入 `modules/agent-sessions/` 对应子目录。移动前确认四个文件差异均为此前迁移引入的引用调整。旧 context 仅剩有并行修改的附件读取。静态检查通过，devserver SSH 握手超时，本批回归未启动。

运行存储、Web 聊天准备、反思模型及 Redis 队列装配已迁入 `modules/agent-sessions/persistence/`。四个文件原差异仅为本轮导入调整，生产及测试调用方已切换，未改事务和队列行为。静态检查通过，devserver SSH 握手超时，本批回归未运行。

可信交互意图存储和交互命令事务效果已迁入 `modules/agent-sessions/persistence/`。移动前核对两文件差异仅为本目标导入路径调整，生产入口、确认工具及测试已切换。静态检查通过，devserver 摘要和定向回归待结果。

项目文件概览、会话检索、RAG 上下文、记忆搜索和回收站恢复的五个 Host 工具适配已迁入 `modules/agent-sessions/tools/`。原差异仅有本目标引入的 import 调整，生产与测试直接引用新位置。静态检查通过，devserver 摘要及回归待结果。

Web 与 Agent 共用的 PostgreSQL 回收站读取适配已迁入 `modules/files/persistence/`。生产入口、Agent 工具及测试已切换，旧回收站路由仍作为类型依赖。静态检查通过，devserver 回归尚待结果。

Agent 工具确认适配已迁入 `modules/agent-sessions/tools/`。组合根、知识写入、定时任务和测试引用已更新，保留现有事务、可信意图及确认门。静态检查通过，devserver SSH 握手超时，未运行本批回归。

旧目录余量复核：Admin 1、Agent 会话 39、认证 3、文件 11、项目 1、工作区 2。扫描 Web Host 生产及测试 TypeScript 的相对 `.js` 导入，当前均有对应源文件。剩余文件没有发现仅由本轮路径调整产生的差异，工作区目录删除仍含并行快照复核逻辑。devserver SSH 握手仍超时，Mutagen 尚在应用变更，待同步后继续运行回归。

项目过期清理 PostgreSQL 适配已随 Worker 归入 `modules/projects/`，保留原有 schema readiness 检查。生产入口、测试及元数据改用新路径，旧项目目录已移除。文件回收站事务仍由旧文件域提供。静态检查通过，devserver SSH 仍在握手阶段超时，项目清理回归待复验。

Admin 运行配置路由已归入 `modules/admin/`，保留现有 Redis/PG 连通性响应差异。生产入口和配置锁、能力 schema 测试改用新路径，旧 Admin 目录已移除。静态检查通过，devserver 同步与回归待结果。

工作区目录路由与 PostgreSQL/Local 适配已迁入 `modules/workspaces/`，保留 Agent 确认删除时的目录快照复核。生产入口、Agent 调用方及测试引用已切换，旧工作区目录已移除。静态检查通过，devserver 内容核对和回归待结果。

认证契约、用户响应映射和资料路由已迁入 `modules/auth/`，保留已有 DTO 及写入门禁相关改动。生产入口、终端与测试引用已切换，旧认证目录已删除。静态检查通过。工作区目录批次因远端缺少新文件未启动回归，认证批次仍待验证。

归档 HTTP 路由及 PostgreSQL/Local 事务已迁入 `modules/files/`，原有工具收据与提交结果未知处理随实现保留。Web 入口、Agent 端口和测试直接引用新位置。静态检查通过。认证批次因远端缺少三个迁移文件未启动回归，归档批次仍待结果。

文件浏览 HTTP 路由与 PostgreSQL 分页适配，以及回收站 HTTP 路由，已迁入 `modules/files/`。生产和测试调用方已切换，保留已有筛选、分页及回收站路由逻辑。旧路径扫描和 diff 检查通过。devserver 已能执行摘要命令，远端仍缺少两个新浏览文件，未启动本批回归。回收站写入及清除 PostgreSQL 适配仍在旧目录。

上传与删除 HTTP 路由及 PostgreSQL 适配已归入 `modules/files/`。正式入口、注册种子文件、Agent 工具与测试直接引用新位置，保留现有收据和事务逻辑。旧路径、Web Host 相对导入及 diff 检查通过。devserver 摘要核对超时，本批未运行行为回归。旧文件域剩余近期有并行修改的回收站写入与清除适配。

Agent 消息历史 PostgreSQL 读取已迁入 `modules/agent-sessions/persistence/`，保留现有展示时间线的 JSONB 兼容处理。重新核对上下文装配、来源、偏好和 Web 聊天准备的四组重复文件，确认解析后的导入与代码等价后移除旧副本。生产入口和测试引用已切换，相对导入及 diff 检查通过。devserver 缺少新历史读取文件，本批行为回归未启动。

2026-11-19 `create_folder` 持久调用闭环补齐：Core 将 owner/session/run/round/call 与严格验证后的文件夹目标传给 Host；Host 复核当前 dispatch lease，先写 SQLite reservation，再复用 `FolderWriteOperations.create`，最后保存完整结果。重复 dispatch/恢复仅读结果，改参和结果未知不再次创建。Core 文件组 **77/77**，Host 生产 ToolRegistry→Host adapter→临时 SQLite receipts/真实临时文件域用例 **1/1**，Web Host production typecheck 通过。测试使用合成 Pool/lease/FolderWriteOperations；未验收真实 PostgreSQL 与完整 HTTP/SSE Run，仍列部分实现。Node-only，不使用 Python 运行桥接。

Agent 会话的规范历史写入、Redis Provider 续接、交互激活、投影与恢复、运行派发共六个 Host 适配已迁入 `modules/agent-sessions/persistence/`。生产、测试和派发测试元数据均切换，保留既有事务和租约逻辑。旧 persistence 路径扫描、相对导入检查和 diff 检查通过。devserver SSH 握手超时，尚未执行本批构建及定向回归。

Agent 聊天与交互响应路由、运行事件投影、当前消息附件的 PostgreSQL/本地文件读取已归入 `modules/agent-sessions/`。生产、测试及路由测试元数据已切换，保留现有 SSE 投影、授权调用及附件格式适配。旧路径扫描、相对导入和 diff 检查通过。devserver 可执行摘要命令，四个新路径均尚未同步，本批未启动构建或行为回归。

Agent 记忆范围、搜索和知识写入的三个 Host 适配已归入 `modules/agent-sessions/tools/`，组合根及测试改用新路径。旧路径、相对导入和 diff 检查通过。devserver 上本批适配、组合根与选定测试文件摘要一致，已启动串行定向回归。

2026-11-19 `rename_folder` 持久调用闭环补齐：Host 端口在复用文件夹 owner 读取、expected_version CAS、同名冲突检查及 FolderWriteOperations.rename/Undo/PathMirror 前，先绑定当前 dispatch lease 并持久预留；完整成功/业务拒绝结果均可读取恢复，未知结果不重放改名。Core 文件组 **77/77**、Host 文件工具 Registry→adapter→临时 SQLite receipts/临时文件域行为 **1/1**、Web Host production typecheck 通过。Host Pool/lease/领域服务使用合成依赖；按名称定位和真实 PostgreSQL/HTTP-SSE Run 尚未验收，仍列部分实现。Node-only，不使用 Python 运行桥接。

上述记忆、搜索和知识写入回归在 devserver 完成，10 通过、0 失败、2 跳过。通过项覆盖 owner 记忆隔离、安全出站及 SQLite 文件写入后由持久 Worker 重建知识索引。缺少隔离 PostgreSQL 测试连接，付费搜索额度持久认领与知识删除事务失败恢复未运行。

回收站写入与清除的 PostgreSQL 适配已迁入 `modules/files/persistence/`，保留并行工作加入的清除任务状态及文件恢复逻辑。组合根、注册重置、项目过期清理、测试与测试元数据均已切换。旧文件域目录已移除，旧路径扫描、相对导入及 diff 检查通过。devserver 尚缺两个迁移文件，回收站定向回归未启动。

Agent 运行时的 Web 持久化装配、运行生命周期和 Web 重建器已归入 `modules/agent-sessions/`。继续调用 Core runtime，保留 PG/Redis、工具注入及观测端口，并切换组合根、测试与测试元数据。旧路径、相对导入和 diff 检查通过。旧目录剩余 22 个 Agent 工具适配或注册文件。

运行装配批次在 devserver 核对组合根、迁移文件和定向测试后执行，6 通过、1 失败。失败用例预期 dispatch lease 激活前 RAG 授权读取为 0，实测为 4，待定位调用来源及确认迁移前基线。

Agent 目录浏览、文件展示与读取、最近附件和文件内容检索的五个 Host 端口已归入 `modules/agent-sessions/tools/`，继续实现既有 Core 工具契约。生产和测试引用已切换，旧路径、相对导入及 diff 检查通过。devserver 尚缺这五个文件，未启动本批定向回归。

Agent 提问授权、撤销上一操作、Web 下载及工作区目录删除的四个 Host 端口已归入 `modules/agent-sessions/tools/`。保留 Core 工具契约，以及现有确认、回执和文件处理逻辑。生产及测试引用已切换，旧路径扫描、相对导入及 diff 检查通过。旧目录剩余 13 个工具适配与注册文件。

RAG 复测通过绑定阶段零查询断言及独立时区用例，但同一时区查询在注册器用例中的重复执行污染了 embedding owner 调用计数。已移除注册器用例的重复查询和专属夹具，保留独立时区回归和原 owner 断言，修正后的复测待同步。上述四个工具端口的 devserver 摘要核对超时，本批未启动回归。

2026-11-19 `copy_file` 持久调用回执补齐：Core 将 Run 轮次及 ToolCall ID 传至可信 Web Host；文件复制事务复核活动 lease 后，以 owner 范围 advisory lock 去重，并将副本、Undo、文件变更记录和调用收据原子提交。相同调用重放返回原结果且不重复副作用，Run 恢复只读收据；提交结果未知返回 `unknown`。Core `files.test.ts` **77/77**，Host 实际 ToolRegistry/模拟 Pool/lease/复制端口 **1/1**，Core build 与 Web Host production typecheck 通过。没有使用真实 PostgreSQL、磁盘或 HTTP/SSE Run，`copy_file` 仍列部分实现。2.0 只有 Node/TypeScript 路径；Python 仅作为历史行为基准，最终删除 Python 后端，不引入桥接或 fallback。

2026-11-19 `rename_file` 持久调用回执补齐：Core 在解析逻辑路径前先检查回执，Host 在当前 owner/dispatch lease 授权下把文件路径规划、版本 CAS、Undo、变更记录和调用回执原子提交。重放和 Run 恢复只读收据，源路径改名后仍可恢复原结果，提交未知不重试副作用。Core 文件工具 **77/77**，Host 实际 ToolRegistry/模拟 Pool/lease/更新端口 **1/1**，Core build 与 Web Host production typecheck 通过。未使用真实 PostgreSQL/文件系统或 HTTP/SSE Run，`rename_file` 仍为部分实现。2.0 使用 Node/TypeScript 唯一路径，不保留 Python bridge/fallback，最终删除 Python 后端。

2026-11-19 `rename_file` 完整文件名规则迁移：Core 支持含后缀的 `new_name`、无后缀保留旧扩展名及 `format` 自定义后缀，并按历史规则将 markdown/md、text/txt、yml/yaml 归一；Host 使用既有文件更新事务的类型边界检查，禁止文本/二进制跨类后缀伪转换，保存原始内容；ToolResult 返回旧文件名。Core 文件组 **77/77**、Host 文件工具 registry **1/1**，Core build、Web Host production typecheck 通过。批量改名未迁移，真实 PG/HTTP-SSE 未验收；Node-only，不引入 Python 兼容层。

Agent RAG 生产端口、运行授权和回收站工具 Host 适配已归入 `modules/agent-sessions/tools/`，生产及测试直接引用新位置。旧路径扫描、相对导入及 diff 检查通过。devserver 尚缺三个迁移文件，本批与 RAG 修正未启动回归。余下十个旧文件均为 Agent 工具适配或注册器。

devserver 核对 Web 重建器、RAG 生产端口、运行授权及修正后的测试摘要一致。RAG 资源工厂复测 2 通过、0 失败、0 跳过，覆盖绑定前零授权查询、注册器实际分派、owner 读取与可信时区引用。回收站适配及选定回归文件亦已同步。

归档、文件创建与编辑、文件夹删除、附件保存、批量文件写入装配及工作区创建共七个 Host 端口已归入 `modules/agent-sessions/tools/`。保留正在并行验证的复制、重命名及注册器路径，仅修正重命名新增的 RAG 授权导入。生产及测试相对导入与 diff 检查通过。已启动的回收站回归在加载阶段遇到 Core 构建产物缺失，随后 SSH 超时，未取得行为结果。

文件复制 Host 端口已在并行会话完成回执回归后迁入 `modules/agent-sessions/tools/`，保留其事务授权和结果恢复逻辑。组合根和注册器行为测试直引新位置，旧路径、相对导入及 diff 检查通过。旧目录剩文件重命名和工具注册器。devserver 复查确认 Core 构建输出目录缺失，已启动仓库构建脚本以恢复回归依赖。

最后的文件重命名 Host 端口及工具注册器已迁入 `modules/agent-sessions/tools/`，保留并行完成的重命名事务回执和恢复语义。组合根、模块调用方、测试和测试元数据已切换。旧 `apps/web-host/src/domains/` 已移除，非 Markdown 旧路径扫描、相对导入检查和 diff 检查通过。统一构建和行为回归仍待 devserver 完成。

旧目录清理复核：Git 基线中的 252 个旧路径已从工作区移除。按文件名检查，251 个在 Host 或 Core 仍有对应文件；唯一改名项为旧 Skill 生产端口，组合根现直接装配 Core 的 `createAgentSkillRuntimePorts`。此项用于核对目录去向，运行行为以定向回归为准。现有 devserver 构建尚无结果，独立 SSH 检查在握手阶段超时。

devserver 的正式 Core 构建脚本退出码为 0，缺失的错误契约产物已恢复。回收站源码级回归使用临时模块映射，12 通过、0 失败、2 跳过，覆盖配额校准、异主文件保护、提交失败恢复、清除任务幂等及 owner 状态隔离。两个真实 PostgreSQL 用例未配置隔离连接。Web Host 生产类型检查已在核对组合根、最后迁移文件和编译配置摘要，并确认远端无旧目录后启动。

devserver 上 Web Host 生产 TypeScript 检查（`tsc -p tsconfig.build.json --noEmit`）通过。组合根、最终工具端口及七个定向测试文件摘要一致，已使用正式 Core 构建产物启动 Agent 工具串行回归。devserver 常规路径未发现独立 PostgreSQL 初始化或 Redis 服务二进制，隔离服务验证仍待落实。

Agent 工具串行回归 47 通过、1 失败。失败发生在批量 `rename_file` 请求校验。远端 Core 源码摘要与本地一致，含批量处理；远端构建产物早于源码更新且缺少批量实现。已启动 Core 重建，待用新产物复测。原批量改名行为断言保持原样。

旧目录去向按当前 Git 基线复核：Admin、Agent 会话、认证、文件、Mind、偏好、项目、终端、Undo 和工作区分别归入同名 `modules/`，原 `agent-config` 的 Web 模型配置适配归入 `modules/agent/model-config/`，共享 BYOK 规则位于 Core 的 `agent/config/`。当前生产源码、测试与脚本的旧路径扫描无命中，Node WebUI 技能中的现行入口也已改为新位置。
