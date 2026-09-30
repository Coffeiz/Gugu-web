# Gugu Core 多端统一架构重构方案

> **文档类型**：架构重构方案（不是 PRD）
> **状态**：方案草案，尚未批准实施、尚未实施
> **整理依据**：`Gugu-Core-多端统一架构与执行方案-v2.md` 及当前 Gugu-web 代码结构核查
> **核查基线**：2026-09-26；本文件中的代码规模数据是当时快照，不作为后续版本的实时指标。

## 1. 重构目标

逐步把 Gugu 的领域语义、应用用例和 Agent 执行编排收敛到可复用的 Core；Web、桌面端及后台 Worker 通过各自 Host 装配 Core，并提供数据库、队列、文件存储、认证、沙盒和进程生命周期等运行能力。

目标不是先搬目录、抽象所有基础设施或立即拆仓，而是通过可回归的垂直切片逐步建立边界：同一业务用例能在不同 Host 中复用，Host 的基础设施选择不反向渗入 Core，既有 Web 行为和数据在迁移中保持不变。

## 2. 现状与范围判断

当前 Gugu-web 已有 Agent、API、Worker、IM、存储和沙盒等模块，但 Agent 业务执行与 Web 基础设施仍有较多直接耦合。2026-09-26 的代码搜索显示，`backend/agent` 下约 71 个 Python 文件直接导入数据库、ORM、Redis 或存储实现相关模块。这意味着重构范围是跨模块的依赖收敛，不是新建 `core/` 目录即可完成。

同日依赖图快照整体呈横向结构（`nccd=0.15`），但存在两个依赖环。该结果支持渐进迁移，不支持一次性全量搬迁。首批工作应先做边界基线和单个垂直切片，避免把现有 Agent、RAG、IM、定时任务及存储同时纳入改造。

### 本次重构范围

- Domain 与 Application 用例的边界及依赖方向。
- Agent Runtime 与业务用例、Provider、工具、交互协议之间的协作边界。
- Repository / Unit of Work、任务队列、事件通知、对象存储和沙盒等 Port 与 Host Adapter。
- Web Host 对现有 PostgreSQL、Redis、API、存储及进程的装配。
- 桌面 Host 的可行性验证，包括本地数据库候选方案（PGlite、SQLite）、存储、队列、认证与运行时打包。
- 协议契约、能力协商、Core/Host/Schema 兼容与测试策略。

### 本次不做

- 不先拆成多个 Git 仓库；在 monorepo 中先稳定依赖规则和独立构建边界。
- 不为抽象而重写全部 Agent、RAG、IM、MCP、定时任务、文件或沙盒实现。
- 不要求 Web 与桌面使用相同数据库、队列、存储或发布节奏。
- 不把 Host 能力声明当成授权；不得因此绕过用户、租户、所有权或确认门检查。
- 不在第一阶段实现通用同步引擎、离线冲突合并或跨端文件同步。

## 3. 目标依赖结构

```text
Web Client ── Web API / Protocol ──┐
                                    │
Desktop UI ─ Local API / Protocol ─┼── Host Composition Root
                                    │       ├─ Authentication / Principal
Worker / Scheduler ─ Job Adapter ──┘       ├─ Database + migrations
                                            ├─ Durable queue / event transport
                                            ├─ Storage / sandbox / process lifecycle
                                            └─ Core Ports 的具体 Adapter
                                                    │
                                                    ▼
                                      Gugu Core
                                      ├─ Domain：规则与领域状态
                                      ├─ Application：用例与授权策略调用
                                      ├─ Runtime：Agent/任务执行编排
                                      └─ Ports：Core 所需的外部能力契约
```

依赖方向为 `Host Adapter → Core Port`，Core 不导入具体 Host 实现。Protocol 位于客户端与 Host 的传输边界，不等同于 Core 内部 Port：Core Port 面向进程内用例依赖；Protocol 面向进程间请求、事件和兼容性。

API 端点、Web SSE/IM 消息格式、数据库迁移和 Worker 启停属于 Host 生命周期。Core 可定义业务请求、领域事件和应用结果，但不得依赖 FastAPI、SQLAlchemy Session、Redis 客户端或某个宿主文件路径。

## 4. 职责边界

| 能力 | Core 负责 | Host / Adapter 负责 |
| --- | --- | --- |
| 领域与用例 | 领域规则、用例编排、输入/结果语义 | HTTP/IM/UI 请求转换与响应传输 |
| 身份与授权 | 领域授权规则、资源所有权校验所需的明确上下文 | 登录、凭据验证、Principal 建立及认证会话生命周期 |
| Repository | 聚合/实体的持久化契约、用例需要的查询语义 | 数据库运行时、事务、迁移、连接与连接池；桌面数据库选型须先经过复杂度验证 |
| 任务与事件 | 任务/事件的业务语义、重试后果和幂等要求 | Redis Streams、SQLite 队列、本地通知等具体交付机制 |
| Storage | 文件/对象操作的领域语义 | 本地目录、对象存储、流传输、权限与生命周期 |
| Agent Runtime | 模型调用与工具循环的编排契约 | Provider/模型客户端、执行进程、资源限制及宿主配置 |
| Sandbox | 执行请求、选定工作区范围、读/写策略、授权上下文和结果语义 | Docker/VM/WSL/原生执行、工作区外访问拒绝、运行时只读路径、网络隔离、资源限制与进程回收 |
| 升级 | Core 与协议的兼容声明 | Host、Schema、数据备份、迁移顺序及失败恢复 |

认证和授权不可混为一层：Host 证明“是谁”，Core/Application 使用不可伪造的身份与租户上下文判断“能否对该资源执行此操作”。所有权和 destructive 操作的确认门继续由现有安全规则约束。

## 5. 必须先冻结的契约

以下内容在扩展迁移前需要形成短 ADR 或在本文件的决策记录中明确；没有结论时，不跨多个领域批量创建抽象。

### 5.1 Repository 与事务

Repository 契约不能只是一组 CRUD 函数。至少明确：

- 一个用例的事务边界及 Unit of Work 所有者；
- 唯一约束、并发写入、锁、排序和分页语义；
- SQLite 与 PostgreSQL 的 JSON、全文搜索、向量查询、迁移和并发语义差异；
- PGlite 对当前 PostgreSQL schema、SQLAlchemy/asyncpg、Alembic 与真实并发工作负载的兼容边界；
- 同一组代表性用例在 PGlite 与 SQLite 路径上的实现、测试、打包和维护复杂度；
- 失败/回滚、幂等和数据所有权过滤的统一要求。

领域逻辑不应依赖 ORM 实体；Adapter 将数据库模型转换为 Core 的领域/应用模型。若某查询依赖 PostgreSQL 专有能力，应由明确的查询 Port 表达，不伪装成所有 Adapter 都具备的通用 CRUD。

### 5.2 任务队列与事件通知

不得用一个含糊的 `EventBus` 同时承载不同交付语义。至少区分：

- **DurableJobQueue**：持久化、确认、重投、消费组、延迟重试、幂等和并发控制；
- **EventPublisher / Subscription**：进程内或跨进程通知，可允许不同可靠性等级；
- **Lock / Lease**：所有权、续租、过期和 fencing 语义，如用例确实需要。

Redis Streams 和桌面本地队列只能在满足相同的交付契约时实现同一 Port。不能因接口名称相同，就假设两者在崩溃恢复和并发上等价。

### 5.3 Storage

Storage Port 应覆盖流式上传/下载、元数据、范围读取（若调用场景需要）、删除/复制/移动和失败语义；大对象不得被强制读入内存为单个 `bytes`。Host Adapter 管理根目录、对象键、凭据、路径安全和物理清理；Core 只表达资源及业务操作。

### 5.4 Protocol 与版本

Protocol 是 Host 对外的传输契约。需指定 Schema 的唯一事实来源、生成/校验方式、向后兼容规则及版本协商失败行为。Core 内部 Port 不应直接复用 HTTP DTO。

“相同 Core 源码”不代表每个 Host 必须同一时刻升级。兼容清单应明确 Core API、Protocol、Host Schema 的版本范围；不兼容时 Host 必须拒绝或降级到明确支持的能力，不能静默跳过安全校验。

### 5.5 桌面产品路线与运行时

“桌面端”在本方案中必须先区分两种产品形态，二者不是同一条 Host 迁移路径：

- **云客户端壳**：Electron/WebView 展示云端 Web Host，通过既有 Web API 访问数据和 Agent；不在本机运行 Core，不提供本地数据库或本地 Shell 能力。它是客户端交付形态，不计作第二个 Core Host。
- **本地优先 Agent**：桌面 Host 在本机装配 Core，使用本地数据，并可按授权提供本机文件或受限命令能力；需要验证 Python/Agent sidecar、本地数据库、密钥管理和操作系统沙箱。

两种路线的数据库、运行时、安全 PoC 和 Phase 2 切片均不同。应在 Phase 1 技术选型前由产品决策确认首发路线和目标操作系统。未确认前，只进行不依赖路线的现状盘点与行为基线，不启动可能被路线选择作废的桌面 PoC。云客户端壳可作为独立产品工作推进；它不阻塞本方案的 Web Host 内部边界治理，但不进入本方案的 Desktop Local Host Phase 2。

若选择本地优先 Agent，需在目标平台验证：

- Python/Core sidecar 的打包、签名、启动、IPC、日志脱敏、终止、升级和异常退出恢复；
- SQLite（Python/SQLAlchemy 本地文件）与 PGlite（Electron/Node 内嵌运行，由 Python sidecar 经受限 socket 访问）的端到端复杂度；
- 本地数据库的迁移、并发访问、备份/恢复及断连恢复；
- 本地身份、密钥保存、文件权限和沙箱执行边界。

PGlite 与 SQLite 使用同一组业务切片和能力清单比较，不预设选型。代码行数或单项测试通过比例不能单独作为依据；至少记录 PostgreSQL 语义缺口、需维护的专用代码、运行进程数量、并发/崩溃恢复行为、打包与升级负担。云客户端路线不做本地数据库选型，也不因该选型延期而阻塞。

### 5.6 任务归属与跨端可见性

Core 是被 Host 装配的库，不是共享守护进程。每次运行必须有明确的执行所有者；不能从“多个 Host 使用同一 Core”推导出运行状态自动共享。

- **交互运行**：接收请求并取得运行所有权的 Execution Host 负责该次运行的状态、事件、追问/续接和取消。首版不做跨 Host 接管、查看或控制；未接入所有者的 Host 不得展示本地猜测的运行状态，也不得声称已取消。
- **持久化后台 Job**：DurableJobQueue 保存待执行作业；Worker 通过租约取得执行权。作业状态、重试和恢复语义由队列及任务状态存储承载，不能只存在 Worker 的进程内存中。
- **跨 Host 控制**：若后续要让 Desktop 查看/追问由 IM 启动的运行，或让 IM 取消 Desktop 启动的运行，必须先增加共享 Run Store、事件订阅、所有权/租约和控制协议，并定义所有者失联后的接管规则。该能力不属于首版。

Protocol 至少携带稳定的 `run_id`、发起方、当前执行所有者和可用控制操作；Host 必须校验控制请求是否到达当前所有者。身份认证仍不等于对运行或会话的授权。

### 5.7 Sandbox 契约

桌面首发按单个操作系统登录用户使用，不实现桌面应用内的多用户/租户隔离；这减少的是产品身份与租户模型，不会取消操作系统对进程和文件的访问控制。Sandbox Port 描述 Core 请求的隔离语义，Host Adapter 负责在目标平台实际执行和强制边界。Host 声明支持某项能力不构成用户授权；每次执行仍须携带可信 Principal、资源归属和 destructive 确认结果。

契约至少包含：

- 执行目标、参数、工作目录和受控环境变量；文件访问按读/写分别声明，默认只允许用户明确选择的工作区及执行所需的显式只读运行时路径，其他路径拒绝访问；网络策略与文件授权分别表达；
- Core 将用户选定的工作区引用绑定到单次运行上下文，Agent/工具不能自行替换该引用。这个绑定用于表达授权意图，不构成安全边界；Host Adapter 将其解析成平台可强制执行的目录/句柄授权，并在子进程启动前施加限制；
- 若产品要求工作区内的密钥或敏感子目录默认不可读，可增加明确的排除策略；不得把路径名/通配符 deny list 当成工作区隔离的替代品。允许读取的文件仍可能通过网络外传，网络访问须由独立策略控制；
- 超时、CPU/内存/输出限制、取消语义，以及超时或取消后对子进程树的终止和回收；
- 结构化结果（退出码、受限输出、超时/取消状态）及可诊断拒绝原因；不得将密钥、提示词或未经脱敏的异常写入可见日志；
- Adapter 不可用、策略无法执行或目标能力不支持时明确拒绝，禁止回退到宿主机执行。

单用户产品不等于可跳过 OS 权限授权。若 Adapter 采用独立 UID、AppContainer SID 或类似受限身份，仍须验证如何只向选定工作区授予所需访问权及其打包/安装成本；不得假设换身份后工作区天然可写，也不把 ACL/chmod 复杂度视为已消失。独立身份只是候选实现，不是 Core 契约。

Core 可以做路径规范化和请求校验，但不得宣称一次性实现跨平台“无逃逸”。符号链接、硬链接、`..` 路径穿越、Linux bind mount、Windows reparse point、路径检查与打开之间的竞态、继承的文件句柄以及子进程继承都须由各平台 Adapter 的执行机制覆盖并实测。桌面 renderer 的进程沙箱不能替代 Python sidecar 的操作系统级隔离；侧车如何获得最小权限、如何与 Electron 主进程通信、签名/打包后的构建是否仍受限，也属于目标平台 PoC 的验收内容。

## 6. 迁移原则

1. **按垂直切片迁移。** 一个切片包括调用入口、用例、Port、至少一个现有 Adapter、行为测试和文档，不以搬文件数量验收。
2. **现有 Web 是行为基线。** 先锁定输入/输出、权限、事务、副作用和错误语义，再替换实现；不得借抽象改产品行为。
3. **新边界先于大迁移。** 新 Core 包先设依赖规则，旧模块按域迁入；历史调用方暂时保留明确的适配接缝，不新增平行真源。
4. **失败显式化。** 缺少 Host 能力、Adapter 不支持查询或版本不兼容时返回可诊断错误；禁止静默退回宿主机、空数据或弱权限实现。
5. **权限与数据隔离先行。** 每个 Adapter 契约测试都验证用户/租户过滤、越权拒绝与 destructive 确认，不只测成功路径。
6. **拆仓是结果，不是起点。** 只有 Core 可独立构建、测试、版本化，且 Host 兼容边界稳定后，才评估仓库拆分。

## 7. 实施阶段与闸门

### Phase 0：冻结现状与行为基线

- 盘点 Core 候选调用链及对 ORM、DB、Redis、存储、API、进程全局状态的直接依赖。
- 为首个切片记录现有 API、权限、事务、副作用、错误和持久化行为。
- 将现有依赖环和架构检查结果登记为基线；不以一次性清理所有环作为启动条件。
- 找出跨用户查询、任务重试、数据迁移等安全与恢复守卫。
- 在启动桌面 PoC 前确认首发属于“云客户端壳”还是“本地优先 Agent”，并列出首发目标操作系统及是否包含本地文件/命令执行。

**闸门**：首个切片边界明确，行为测试能在重构前通过；数据和权限不变量有可验证的测试；桌面首发路线和目标平台已确认。未确认路线时只继续与桌面无关的基线工作，不进入桌面相关 Phase 1 PoC。

### Phase 1：按桌面路线验证承载方式并冻结基础契约

- 所有路线都明确 Repository/Unit of Work、任务队列与事件通知、Principal/tenant、Protocol/Schema 版本、交互运行归属及 Sandbox Port 契约；形成 Adapter contract test 的运行方式和本地 fixture。测试不读取或覆盖用户运行配置。
- **云客户端壳路线**：不做本地数据库、Python Core sidecar 或本地 Sandbox PoC；客户端只通过 Web API 访问云端 Web Host，不作为 Phase 2 的 Desktop Local Host。其 Electron/WebView 打包和云端认证属于独立客户端工作，不作为本方案 Core 多 Host 切片的完成条件。
- **本地优先 Agent 路线**：在首发目标操作系统上完成 Python/Core sidecar 的最小启动、IPC、日志脱敏、终止、升级和崩溃恢复 PoC；另完成 §5.7 规定的工作区边界沙箱 PoC，验证工作区外读/写拒绝、`..`、符号链接、硬链接、平台对应的挂载/重解析点、继承句柄及子进程树行为。
- 本地优先路线下，对 PGlite 与 SQLite 使用同一组代表性业务切片和数据库能力做复杂度验证，不预设选型：
  - PGlite：验证 Electron/Node 内嵌实例、本地持久化、Python sidecar 到 PGlite Socket Server 的连接、现有驱动与 Alembic 迁移、连接复用和并发事务、扩展、异常退出恢复及跨平台打包。
  - SQLite：验证 SQLAlchemy/aiosqlite、现有迁移的方言改造、PostgreSQL 专有查询/类型/索引的替代方案、事务与并发限制、备份恢复及跨平台打包。
  - 两条路径使用同一份能力清单和验收用例；记录改动范围、需维护的专用代码、测试负担、未通过项和实测运行成本。代码行数或“通过测试比例”不能单独作为选型依据。
- **本地优先 Agent 路线**以原生 PostgreSQL 作为行为兼容基线；若 PGlite 与 SQLite 均不满足关键语义，再单独评估桌面随包 PostgreSQL 的分发成本。云客户端壳不做本地数据库兼容性对照。

**闸门**：云客户端壳路线记录本地数据库、Core sidecar 和本地 Sandbox 延期，并退出本方案的 Desktop Local Host Phase 2；如继续 Core 工作，只能按 Web Host 内部垂直切片验收，不能标记为跨 Host。选择本地优先路线时，sidecar 与 Sandbox PoC 在目标平台通过，且数据库同口径验证、关键语义、兼容缺口、维护成本和打包/运行指标均有可复现记录；明确选定数据库后才进入 Phase 2。

### Phase 2：首个跨 Host 垂直切片（仅本地优先路线）

优先选择低风险、持久化边界清晰的项目元数据用例（列出、创建、改名或归档中的最小集合），覆盖：

```text
Web API ─┐                         ┌─ PostgreSQL（现有 Web 存储）
         ├─ 同一 Application UseCase
Desktop ─┘                         └─ 已通过 Phase 1 选型闸门的本地持久化路径
```

- 提取该用例所需的 Domain/Application 类型和 Repository/Unit of Work Port；Port 仅表达该用例需要的持久化语义，不为候选数据库预先设计通用 CRUD。
- Web 保留既有 API DTO 与 PostgreSQL schema，通过 Web Adapter 调用用例。
- Desktop 通过所选本地数据库路径调用同一用例，不把 Web API 搬进 Core；是否复用 SQLAlchemy 由 Phase 1 验证结果决定。
- 为 Web 和所选桌面实现跑相同的业务契约测试，并补权限、事务回滚、并发冲突和重启持久化测试；候选方案未选定前不维护两套生产 Adapter。

本阶段只在本地优先路线实施。云客户端壳路线不实现本地 Repository Adapter，也不把 Web API 调用伪装成 Core Port；若产品后来需要本地优先能力，应在重新确认路线后补做 Phase 1 PoC，再启动本阶段。若项目元数据切片不能形成真实可用的本地路径，应先重新选择切片。

**闸门**：相同业务输入产生一致领域结果；Web 行为和数据不回归；所选本地存储路径的事务、并发、迁移和恢复保证已明确验证，未被假装等同 PostgreSQL。

### Phase 3：Core 包与渐进依赖治理

- 按稳定职责建立 Domain、Application、Runtime、Ports 的包边界，Core 由 Host Composition Root 显式装配。
- 对新边界启用静态依赖检查：禁止 Core 导入 Web 框架、SQLAlchemy、Redis client、Host 配置/路径和具体 Adapter。
- 按已有领域和真实调用者分批迁移，不一次性将 `backend/agent` 全目录重命名为 Core。
- 删除旧实现前先证明所有入口已切换，并以测试确认没有 API、Worker、IM 或定时任务遗漏。

**闸门**：每次迁移都有明确调用入口、旧/新路径对照、回归测试和可回滚部署方式；Core 新增依赖违规为零。

### Phase 4：扩展 Host Adapter 与任务生命周期

- 逐领域迁移现有 Web 查询和写入，不把 PostgreSQL 专有能力隐藏在虚假的通用 Repository 中。
- 单独处理 DurableJobQueue、事件通知、锁/租约和 Run Store；验证 ack、重投、消费者崩溃、幂等、长任务、运行所有权与失联恢复行为。
- 逐项迁移本地文件、对象存储和沙盒请求；执行实现留在 Host，Core 持有请求/策略契约。Sandbox Adapter 严格按 §5.7 契约实现。
- 保持 Worker、IM、Scheduler 的生命周期由 Host/部署管理，Core 不直接启动宿主守护进程。
- 跨 Host 查看、追问或取消只有在共享事件/控制协议、所有权租约及授权检查完成后才启用；否则继续保持首版不支持的行为。

**闸门**：旧 Web 任务与 Adapter 变更后的任务在故障注入测试中保持既定交付语义；所有安全敏感能力明确失败关闭。

### Phase 5：Desktop Host MVP 与发布验证

- 在已选产品场景内完成桌面 Host 的 Composition Root、身份/密钥管理和 Core 通信；**仅本地优先 Agent 路线**需要实现本地 Schema 迁移、备份/恢复。
- 云客户端壳路线验证登录态、云端 API 兼容、安装/升级和故障恢复；不把云端 Web API 包装成 Core Port，也不要求本地数据库迁移或备份。
- 本地优先 Agent 路线验证本地数据库迁移、备份/恢复和本地数据隔离；对应承诺平台均需覆盖。
- 若首发包含本地文件或命令执行，在每个承诺支持的操作系统上验证打包签名后的 sidecar 沙箱、权限拒绝、网络/挂载策略、超时取消和子进程回收；不得以 Electron renderer 沙箱测试替代。
- 验证干净安装、升级、故障恢复及日志脱敏；本地数据隔离和迁移/备份恢复按所选路线验收。
- 明确 Core、Host、Protocol、Schema 的独立版本号与兼容矩阵；升级前检查兼容并备份必要数据。

**闸门**：目标操作系统的可分发构建通过端到端测试；升级失败可恢复，数据 schema 不由 Core 自行迁移。云客户端壳验证云端兼容与客户端升级；本地优先 Agent 另须验证本地 schema、备份恢复和数据隔离。

### Phase 6：评估拆仓

只有满足以下条件后才进入拆仓设计：

- Core 可独立构建、测试、生成版本和发布，不依赖 Web 仓库私有路径；
- 至少两个 Host 使用稳定且有契约测试的 Core/Protocol；
- Adapter、Schema 与 Core 的兼容矩阵可自动验证；
- 依赖规则和安全检查在 CI 中稳定运行。

未满足时继续 monorepo，使用包边界和 CI 依赖规则维持模块化。

## 8. 首批范围与建议拆分

首批只覆盖 Phase 0–2：依赖/行为基线、桌面路线决策、路线适用的 PoC、基础契约决策和一个项目元数据垂直切片。若选择云客户端壳，Phase 2 本地跨 Host 切片延期，云端壳验证单独管理；若选择本地优先 Agent，首批包含目标平台 sidecar/Sandbox 最小 PoC，但不包含完整沙盒执行器迁移。以下模块明确不进入首批：

- Agent 全量工具系统、模型 Provider 全量抽象；
- RAG/向量/全文搜索与 TypeScript sidecar；
- IM 平台、Webhook 与会话路由；
- 定时任务、反思/记忆后台任务的完整迁移；
- 文件存储全量迁移、OSS 切换、跨端同步；
- 完整沙盒执行器迁移、Updater 和仓库拆分。

每个后续切片须列明实际入口和调用方（Web API、Worker、IM、Scheduler 等）、持久化副作用、权限不变量、对应 Adapter、契约测试与失败回滚方法。禁止只迁 API 主路径而遗漏后台/IM 入口。

## 9. 验收标准

### 架构

- Core 的依赖方向由静态规则持续验证；新增 Core 代码不直接访问 DB Session、ORM、Redis、文件根目录或 Web 框架。
- Port 反映真实语义，不用 `EventBus`、通用 CRUD 或 `bytes` 等过度简化接口掩盖实现差异。
- Host Composition Root 是 Adapter 和运行配置的装配边界；API DTO、数据库模型与领域模型可独立演进。

### 行为与数据

- 重构前后的 Web 权限、所有权、确认门、事务、响应、任务投递与错误语义有回归覆盖。
- 桌面存储选型通过后，针对 Web PostgreSQL 与所选桌面路径运行相同的业务契约测试，覆盖创建/查询/更新、事务回滚、并发约束、重启持久化和越权隔离；未选中的候选方案不作为长期兼容承诺。
- Schema 迁移只由相应 Host 执行；升级、备份和恢复有故障路径测试。

### 任务、存储与沙盒

- DurableJobQueue 测试覆盖至少一次投递、ack、重投、重复消息和消费者崩溃；不同 Adapter 的语义差异公开。
- 交互运行有唯一可验证的执行所有者；运行状态、事件、续接和取消只由所有者处理。首版跨 Host 查看/追问/取消明确拒绝或标记不支持；后台 Job 的租约、重试和恢复由持久化机制验证。
- Storage 测试覆盖流式大对象和路径/对象键安全。
- Sandbox 请求固定本次运行的工作区授权引用，并分开表达读/写、网络和能力约束；工作区外访问默认拒绝。Host Adapter 还须执行资源限制、超时取消和进程回收；不可用或能力不足时明确拒绝执行，不回退到宿主机。
- 本地执行能力只有在每个承诺目标操作系统上通过打包 sidecar 的边界逃逸 PoC 与对应 E2E 后才可宣称支持；Core 路径预检查不能单独作为边界证明。

### 发布

- Core、Protocol、Host、Schema 的版本责任、兼容范围和升级先后顺序有可执行检查。
- 桌面构建、升级中断恢复、备份恢复以及用户数据权限通过目标平台 E2E。
- 拆仓不是验收条件；是否拆仓在 Phase 6 单独评估。

## 10. 风险与回滚

| 风险 | 控制措施 |
| --- | --- |
| 迁移遗漏 IM、Worker 或 Scheduler 调用方 | 每个切片先做调用入口清单，合并前搜索旧实现引用并跑对应入口回归 |
| PGlite socket 并发/协议行为与原生 PostgreSQL 有差异 | Phase 1 使用真实 Python 驱动和 Agent 并发负载验证连接复用、事务、断连与恢复；不通过时不选 PGlite |
| SQLite/PostgreSQL 语义不等价 | 在同口径 PoC 中登记迁移、查询、类型和事务缺口；只在满足产品语义且维护成本可接受时选择 SQLite |
| 授权上下文丢失或伪造 | Host 建立可信 Principal；Core 用显式 tenant/ownership context；契约测试越权拒绝 |
| 任务队列可靠性下降 | 保留现有投递行为基线，故障注入验证 ack/retry/idempotency 后再切流 |
| Core 与 Schema 升级错序 | Host 负责迁移和备份，兼容检查失败时拒绝启动或更新 |
| 切片回归或上线故障 | 单领域逐步切换、保留 Host Adapter 回退开关；不得删除旧实现直到新路径稳定 |
| 桌面运行时分发成本超预期 | Phase 1 先做可构建 PoC；若不可行，重评产品承载方式，不把风险拖到末期 |
| 交互运行所有者失联或跨端状态不一致 | 首版运行绑定单一 Execution Host；持久化 Job 使用租约与可恢复状态；未完成共享 Run Store/控制协议前不开放跨 Host 操作 |
| 桌面 sidecar 未受操作系统沙箱约束 | 本地优先路线在 Phase 1 按目标平台验证签名构建、受限执行和失败关闭；未通过的平台不宣称支持本地执行 |
| 工作区路径检查被链接、挂载或子进程绕过 | Core 只做意图绑定与输入校验；各平台 Adapter 在 OS 边界执行，并覆盖路径竞态、链接/重解析点、继承句柄和子进程的 PoC/E2E |

回滚以恢复旧 Host Adapter/用例路径为主，不回滚或覆盖用户数据库。任何数据迁移必须先备份并校验；本方案不授权删除旧数据或重建用户配置。

## 11. 决策记录

| 决策 | 当前结论 | 后续条件 |
| --- | --- | --- |
| 先 monorepo 还是立即拆仓 | 先 monorepo，按包边界和 CI 规则治理 | Phase 6 满足独立构建/发布条件后评估 |
| Core 是否直接管数据库和迁移 | 不管；Host Adapter/Host 负责具体实现和迁移 | Core 仅定义用例需要的 Port 与领域语义 |
| 是否统一 Web/桌面队列实现 | 不要求统一实现，要求明确且可测的交付契约 | 队列 Port 细节由 ADR 冻结 |
| Web/桌面是否同步升级 | 不要求同时发布；要求兼容矩阵和失败关闭 | Protocol/Core/Schema 版本策略由 ADR 冻结 |
| 桌面首发路线与目标平台 | 未定；先区分云客户端壳与本地优先 Agent，并确认首发操作系统和本地文件/命令能力 | Phase 0 前确认；未确认时只做路线无关基线，不启动路线相关 PoC |
| 云客户端壳的 Core 范围 | 不作为 Desktop Local Host，不实现本地 Repository Adapter；只通过 Web API 使用云端服务 | Electron/WebView 客户端属于独立产品工作；不阻塞 Web Host 内部 Core 切片 |
| 交互运行归属 | 每次运行归接受请求并实际执行它的 Host；首版不支持跨 Host 查看、追问、续接或取消 | 跨 Host 能力须先有共享 Run Store、事件/控制协议、所有权租约和授权验证 |
| 后台 Job 归属 | 由成功取得持久化租约的 Worker 执行；状态和恢复信息不得只存在进程内存 | Phase 4 验证租约、重试、消费者崩溃与恢复语义 |
| Sandbox 契约 | 桌面按单一 OS 用户设计；Core 固定运行工作区意图和读/写策略，Host Adapter 执行工作区外默认拒绝的 OS 隔离 | 不预选独立 UID/AppContainer 等实现；Phase 1 验证目录授权、路径逃逸和子进程边界；未通过的平台不宣称支持 |
| 桌面本地数据库 | 未定；仅本地优先 Agent 路线需要时，对 PGlite 与 SQLite 做同口径复杂度验证 | Phase 1 完成迁移/查询/并发/恢复/打包验证后再决定；云客户端壳路线延期 |
| Core 运行时 | 未定；本地优先 Agent 路线先做 Python sidecar 打包、IPC、恢复和沙箱 PoC | PoC 通过后选择发布形态；云客户端壳不依赖该运行时 |

## 12. 当前实施状态

- [x] 整理 v2 方案并核对当前仓库依赖形态。
- [ ] Phase 0 前确认首发路线（云客户端壳/本地优先 Agent）、目标操作系统、本地文件/命令能力及首个切片价值。
- [ ] 冻结交互运行归属、后台 Job 租约语义和首版跨 Host 能力边界。
- [ ] 冻结 Sandbox Port/Adapter 契约，明确工作区授权绑定、读/写边界、限制、取消/回收和失败关闭语义。
- [ ] 仅本地优先 Agent 路线：完成目标平台 Python/Core sidecar 与工作区边界 Sandbox PoC，覆盖外部读/写拒绝、路径/链接/挂载逃逸、句柄和子进程继承；需要本地库时再对 PGlite 与 SQLite 做同口径验证并记录选型。
- [ ] 冻结 Repository/Unit of Work、队列、身份授权及 Protocol ADR。
- [ ] 建立首个切片的行为基线与 Adapter contract tests。
- [ ] 按已选路线实施 Phase 0–2；云客户端壳路线不进入本地跨 Host Phase 2。

本文件是重构方案，不等于实施授权或实施完成记录。阶段状态只有在实际改动、测试和运行验证完成后才更新。
