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
- 桌面 Host 的可行性验证，包括本地数据库、存储、队列、认证与运行时打包。
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
| Repository | 聚合/实体的持久化契约、用例需要的查询语义 | PostgreSQL/SQLite 实现、事务、迁移、连接池 |
| 任务与事件 | 任务/事件的业务语义、重试后果和幂等要求 | Redis Streams、SQLite 队列、本地通知等具体交付机制 |
| Storage | 文件/对象操作的领域语义 | 本地目录、对象存储、流传输、权限与生命周期 |
| Agent Runtime | 模型调用与工具循环的编排契约 | Provider/模型客户端、执行进程、资源限制及宿主配置 |
| Sandbox | 执行请求、能力要求和结果语义 | Docker/VM/WSL/原生执行、网络隔离、挂载与进程回收 |
| 升级 | Core 与协议的兼容声明 | Host、Schema、数据备份、迁移顺序及失败恢复 |

认证和授权不可混为一层：Host 证明“是谁”，Core/Application 使用不可伪造的身份与租户上下文判断“能否对该资源执行此操作”。所有权和 destructive 操作的确认门继续由现有安全规则约束。

## 5. 必须先冻结的契约

以下内容在扩展迁移前需要形成短 ADR 或在本文件的决策记录中明确；没有结论时，不跨多个领域批量创建抽象。

### 5.1 Repository 与事务

Repository 契约不能只是一组 CRUD 函数。至少明确：

- 一个用例的事务边界及 Unit of Work 所有者；
- 唯一约束、并发写入、锁、排序和分页语义；
- SQLite 与 PostgreSQL 对 JSON、全文搜索、向量查询及隔离级别的差异；
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

### 5.5 桌面运行时

桌面端目标是可独立运行，但 Core 当前属于 Python/Agent 体系，因此需要先完成运行时分发验证：

- 采用随应用打包的 Python/sidecar，还是其他运行形态；
- macOS 与 Windows 的构建、签名、升级、崩溃恢复和诊断方式；
- SQLite 文件锁、备份、迁移和多进程访问约束；
- 本地身份、密钥保存、文件权限及本机沙盒边界。

该验证是架构可行性门槛，不应留到桌面功能完成后才处理。

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

**闸门**：首个切片边界明确，行为测试能在重构前通过；数据和权限不变量有可验证的测试。

### Phase 1：验证桌面承载方式与冻结基础契约

- 完成 Python/Core 运行时在目标桌面平台上的最小启动、通信、日志脱敏、终止和升级 PoC。
- 明确 Repository/Unit of Work、任务队列与事件通知、Principal/tenant、Protocol/Schema 版本契约。
- 形成 Adapter contract test 的运行方式和本地测试 fixture；测试不读取或覆盖用户运行配置。

**闸门**：桌面运行时可以由干净环境重复构建和启动；契约能区分当前 Web 与桌面实现的语义差异。

### Phase 2：首个跨 Host 垂直切片

优先选择低风险、持久化边界清晰的项目元数据用例（列出、创建、改名或归档中的最小集合），覆盖：

```text
Web API ─┐                         ┌─ PostgreSQL Adapter
         ├─ 同一 Application UseCase
Desktop ─┘                         └─ SQLite Adapter
```

- 提取该用例所需的 Domain/Application 类型和 Repository/Unit of Work Port。
- Web 保留既有 API DTO 与 PostgreSQL schema，通过 Web Adapter 调用用例。
- Desktop 通过独立 Host/SQLite Adapter 调用同一用例，不把 SQLAlchemy/Web API 搬进 Core。
- 为两种 Adapter 跑相同的契约测试，并补权限、事务回滚、并发冲突和重启持久化测试。

若产品优先级不支持该切片在桌面端形成真实可用路径，应先重新选择切片；不得为了证明“多端”而造一个无用户价值的桌面壳。

**闸门**：相同业务输入产生一致领域结果；Web 行为和数据不回归；SQLite 的事务/并发局限得到明示，未被假装等同 PostgreSQL。

### Phase 3：Core 包与渐进依赖治理

- 按稳定职责建立 Domain、Application、Runtime、Ports 的包边界，Core 由 Host Composition Root 显式装配。
- 对新边界启用静态依赖检查：禁止 Core 导入 Web 框架、SQLAlchemy、Redis client、Host 配置/路径和具体 Adapter。
- 按已有领域和真实调用者分批迁移，不一次性将 `backend/agent` 全目录重命名为 Core。
- 删除旧实现前先证明所有入口已切换，并以测试确认没有 API、Worker、IM 或定时任务遗漏。

**闸门**：每次迁移都有明确调用入口、旧/新路径对照、回归测试和可回滚部署方式；Core 新增依赖违规为零。

### Phase 4：扩展 Host Adapter 与任务生命周期

- 逐领域迁移现有 Web 查询和写入，不把 PostgreSQL 专有能力隐藏在虚假的通用 Repository 中。
- 单独处理 DurableJobQueue、事件通知、锁/租约；验证 ack、重投、消费者崩溃、幂等与长任务行为。
- 逐项迁移本地文件、对象存储和沙盒请求；执行实现留在 Host，Core 持有请求/策略契约。
- 保持 Worker、IM、Scheduler 的生命周期由 Host/部署管理，Core 不直接启动宿主守护进程。

**闸门**：旧 Web 任务与 Adapter 变更后的任务在故障注入测试中保持既定交付语义；所有安全敏感能力明确失败关闭。

### Phase 5：Desktop Host MVP 与发布验证

- 在已选产品场景内完成桌面 Host 的 Composition Root、身份/密钥管理、本地迁移、备份/恢复和 Core 通信。
- 验证干净安装、升级、迁移中断恢复、备份恢复、多用户/本地数据隔离及日志脱敏。
- 明确 Core、Host、Protocol、Schema 的独立版本号与兼容矩阵；升级前检查兼容并备份必要数据。

**闸门**：目标操作系统的可分发构建通过端到端测试；升级失败可恢复，数据 schema 不由 Core 自行迁移。

### Phase 6：评估拆仓

只有满足以下条件后才进入拆仓设计：

- Core 可独立构建、测试、生成版本和发布，不依赖 Web 仓库私有路径；
- 至少两个 Host 使用稳定且有契约测试的 Core/Protocol；
- Adapter、Schema 与 Core 的兼容矩阵可自动验证；
- 依赖规则和安全检查在 CI 中稳定运行。

未满足时继续 monorepo，使用包边界和 CI 依赖规则维持模块化。

## 8. 首批范围与建议拆分

首批只覆盖 Phase 0–2：依赖/行为基线、桌面运行时 PoC、基础契约决策和一个项目元数据垂直切片。以下模块明确不进入首批：

- Agent 全量工具系统、模型 Provider 全量抽象；
- RAG/向量/全文搜索与 TypeScript sidecar；
- IM 平台、Webhook 与会话路由；
- 定时任务、反思/记忆后台任务的完整迁移；
- 文件存储全量迁移、OSS 切换、跨端同步；
- 沙盒执行器、Updater 和仓库拆分。

每个后续切片须列明实际入口和调用方（Web API、Worker、IM、Scheduler 等）、持久化副作用、权限不变量、对应 Adapter、契约测试与失败回滚方法。禁止只迁 API 主路径而遗漏后台/IM 入口。

## 9. 验收标准

### 架构

- Core 的依赖方向由静态规则持续验证；新增 Core 代码不直接访问 DB Session、ORM、Redis、文件根目录或 Web 框架。
- Port 反映真实语义，不用 `EventBus`、通用 CRUD 或 `bytes` 等过度简化接口掩盖实现差异。
- Host Composition Root 是 Adapter 和运行配置的装配边界；API DTO、数据库模型与领域模型可独立演进。

### 行为与数据

- 重构前后的 Web 权限、所有权、确认门、事务、响应、任务投递与错误语义有回归覆盖。
- PostgreSQL/SQLite Adapter 契约测试覆盖创建/查询/更新、事务回滚、并发约束、重启持久化和越权隔离。
- Schema 迁移只由相应 Host 执行；升级、备份和恢复有故障路径测试。

### 任务、存储与沙盒

- DurableJobQueue 测试覆盖至少一次投递、ack、重投、重复消息和消费者崩溃；不同 Adapter 的语义差异公开。
- Storage 测试覆盖流式大对象和路径/对象键安全。
- Sandbox Adapter 不可用或能力不足时明确拒绝执行，不回退到宿主机。

### 发布

- Core、Protocol、Host、Schema 的版本责任、兼容范围和升级先后顺序有可执行检查。
- 桌面构建、升级中断恢复、备份恢复以及用户数据权限通过目标平台 E2E。
- 拆仓不是验收条件；是否拆仓在 Phase 6 单独评估。

## 10. 风险与回滚

| 风险 | 控制措施 |
| --- | --- |
| 迁移遗漏 IM、Worker 或 Scheduler 调用方 | 每个切片先做调用入口清单，合并前搜索旧实现引用并跑对应入口回归 |
| SQLite/PostgreSQL 语义不等价 | 收紧契约、显式声明能力差异，不为“通用”而降低 Web 一致性 |
| 授权上下文丢失或伪造 | Host 建立可信 Principal；Core 用显式 tenant/ownership context；契约测试越权拒绝 |
| 任务队列可靠性下降 | 保留现有投递行为基线，故障注入验证 ack/retry/idempotency 后再切流 |
| Core 与 Schema 升级错序 | Host 负责迁移和备份，兼容检查失败时拒绝启动或更新 |
| 切片回归或上线故障 | 单领域逐步切换、保留 Host Adapter 回退开关；不得删除旧实现直到新路径稳定 |
| 桌面运行时分发成本超预期 | Phase 1 先做可构建 PoC；若不可行，重评产品承载方式，不把风险拖到末期 |

回滚以恢复旧 Host Adapter/用例路径为主，不回滚或覆盖用户数据库。任何数据迁移必须先备份并校验；本方案不授权删除旧数据或重建用户配置。

## 11. 决策记录

| 决策 | 当前结论 | 后续条件 |
| --- | --- | --- |
| 先 monorepo 还是立即拆仓 | 先 monorepo，按包边界和 CI 规则治理 | Phase 6 满足独立构建/发布条件后评估 |
| Core 是否直接管数据库和迁移 | 不管；Host Adapter/Host 负责具体实现和迁移 | Core 仅定义用例需要的 Port 与领域语义 |
| 是否统一 Web/桌面队列实现 | 不要求统一实现，要求明确且可测的交付契约 | 队列 Port 细节由 ADR 冻结 |
| Web/桌面是否同步升级 | 不要求同时发布；要求兼容矩阵和失败关闭 | Protocol/Core/Schema 版本策略由 ADR 冻结 |
| 首个跨 Host 切片 | 建议项目元数据最小用例 | 开始实施前确认产品价值及目标桌面场景 |
| Core 运行时 | 尚未定；先做 Python 运行时打包 PoC | PoC 通过后选择发布形态 |

## 12. 当前实施状态

- [x] 整理 v2 方案并核对当前仓库依赖形态。
- [ ] 确认首个桌面产品场景和切片价值。
- [ ] 完成 Core 运行时分发 PoC。
- [ ] 冻结 Repository/Unit of Work、队列、身份授权及 Protocol ADR。
- [ ] 建立首个切片的行为基线与 Adapter contract tests。
- [ ] 实施 Phase 0–2。

本文件是重构方案，不等于实施授权或实施完成记录。阶段状态只有在实际改动、测试和运行验证完成后才更新。
