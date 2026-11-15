# Gugu 2.0 迁移任务清单

> 更新：2026-11-13。本文维护实施顺序、当前状态、验收证据与未完成任务。目标架构和多端职责见[架构说明](Gugu-2.0-架构说明.md)；依赖替换盘点见[Python → Node 依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md)。
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

### N2——Node Web/NAS 后端迁移

引导状态规则与事务仓储已移入 Core，Web Host 已接入 PostgreSQL 仓储；正式 SQLite schema 14 新增状态表及 owner 约束。隔离 SQLite 的引导及旧版升级回归 44 通过，覆盖版本 12/13 升级、冲突回滚和非空约束；另以临时用户态 PostgreSQL 运行 Core 双库合同 5/5、Host 路由与 PG 仓储 3/3、生产 startServer 鉴权与 PG 集成 1/1，Python 基线 3/3。Core 构建及当前树 Host 类型检查通过；先前类型检查曾被 Admin 测试缺失模块阻断。生产组合根测试使用 Fastify 注入，桌面调用方尚未验收。

反馈校验与双库仓储已移入 Core，Web Host 复用同一服务；SQLite schema 15 增加反馈表和 owner 约束。隔离 SQLite/PG 回归、Web 路由及生产 Host 鉴权和 PostgreSQL 组合根验证通过；桌面调用方尚未接入验收。Web Host 提交后读取邮件偏好并异步发送反馈通知；生产 Host→隔离 PG→本地 TLS SMTP 组合测试通过，测试使用 Core 源码映射和合成 schema，邮件模板样式未与 Python 逐项对齐，真实部署未验收。

**当前优先级调整：先完成已有跨端业务的公共化，再继续新增 N2 业务迁移。** 先盘点 Web Host 已实现切片，把桌面也需要的领域规则、完整用例和数据契约收敛到 Core；Web Host 保留 HTTP、认证、部署和注入。以现有 Python pytest 与已实现的 Node 行为为基线，按业务切片保留 PostgreSQL 路径、补齐 SQLite 适配及双库契约回归。PG 专属锁或查询、单端 Admin/认证和平台能力按职责保留专用实现；不机械迁移未实现能力或为了统一重写无关代码。公共化完成后再恢复剩余 N2 功能迁移，避免阻碍桌面复用。

- [ ] 盘点并完成既有跨端项目、联系人、日历、Mind、Local 文件、工作区及相关 Undo 等可共享切片；事务、权限、幂等、失败补偿和提交后事件保持原有契约，SQLite 与 PostgreSQL 均通过相应隔离回归。
- [ ] 盘点并收敛 Agent 会话、Run、队列等已实现跨端规则及持久化端口；HTTP/SSE、Redis 协调及桌面 IPC 分别由 Host 适配，不以测试替身或路由注册代替接入。
- [ ] 对已存在的跨端工具复用 Core 领域用例与平台端口；工具注册、安全边界和 Host 装配职责分开，与其他公共化切片协调接口。

#### 已有业务跨端公共化清单

以下仅统计已有 Web 业务的共享工作，不代表整个 N2 或桌面产品完成度。勾选表示该项范围内的用例、正式双库适配和对应调用方均已接通，并按 Python 行为基线完成适用的回归；原型、单库实现或仅有路由不算完成。按业务切片增量交付，不为凑统一结构增加无必要的抽象。

Admin 专属 API 为服务端能力，当前 Web 使用 PostgreSQL，未来 SaaS 使用自身服务端适配，不要求 SQLite 或桌面 IPC。仅当某条规则或数据能力被普通业务或桌面实际复用时，才按对应跨端契约验证。桌面埋点采集与上传不属于 Admin 查询：其本地离线队列可使用 SQLite，服务端接收和聚合另行实现。

- [ ] 按架构说明将现有共享业务、用例和适用数据实现逐步按领域收敛到 `packages/core/src/` 对应模块；Web Host 的目标 `modules/` 保留 HTTP、平台适配和装配。同步迁移真实调用方、测试与包导出，移除确认无调用方的旧 Node 内部转发层；保留 Python 参考后端及既有对外行为、数据和运行时协议。

- [x] 建立共享 Core、SQLite/PG 适配、事务和首批项目/联系人双库契约。
- [ ] **项目与联系人**：补齐项目更新的正式 SQLite 验收，以及文件计数、文件引用、恢复和 Undo 等跨域路径；核对联系人剩余调用方和双库行为。
- [ ] **日历**：已有列表、读取和增删改进入 Core；完成 Agent 范围查询、撤销执行器和相关消费链路验收。
- [ ] **Mind 与 Undo**：已有便签增删改及画布创建、更新、删除接入 Core；完成其余画布操作、通用撤销执行器、跨域事务及调用方接线。未集成原型不计为完成。
- [ ] **工作区**：已有声明管理及部分会话绑定用例进入 Core；补齐正式 SQLite 适配、Agent 工作区绑定、Local 权限和物理目录清理。
- [ ] **Local 文件**：明确授权根与相对路径身份，完成旧 ID 引用迁移、正式 SQLite 数据模型、文件授权、恢复和安全删除；回收站消费者须待删除安全边界与生命周期验收后接入。
- [ ] **Agent 会话与运行**：在已有列表、改名、消息定位、上下文刷新及待发送队列的基础上，完成消息历史、RunStore、运行身份与租约、孤儿恢复、队列事务和桌面 IPC 接线。
- [ ] **搜索**：在已有 Web PG 搜索和 SQLite 项目、联系人、活动来源基础上，补齐其他 SQLite 来源、兼容搜索语义及 Agent 工具调用。
- [ ] **定时任务与后台消费者**：在已有双库仓储和删除用例基础上，接通 runner、poller、执行和投递，完成租约、持久 fencing、重启恢复及关闭排空；RAG 等消费者分别验收。
- [ ] **工具与调用方**：让已有跨端工具复用 Core 用例及平台端口，接通实际注册和装配，并核对授权、确认、错误与提交后副作用。
- [ ] **公共化收尾**：逐项核对 PostgreSQL / 正式 SQLite、Web Host 及适用的桌面调用方，保留 Python 对照和必要回归；记录仍属于单端的能力及未覆盖边界，再继续新增 N2 功能迁移。

**状态：进行中。** Node WebUI Host 和主要用户、项目、文件、日历、工作区、偏好、通知及部分 Admin/Agent 路由已接入。逐路由覆盖见[Node WebUI API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md)；历史测试与切片细节见[devlog 索引](../devlog/README.md)。旧版全量数量快照已过期，不作为当前完成率。

**Agent 本轮边界**：Agent 和 Mind 的 PostgreSQL 借用事务入口已共用连接互斥与事务控制检查，隔离 PG 合同 1/1、Agent Host 桥 2/2；调度监督器首次订阅失败时继续扫描并重试，定向回归 1/1。模型绑定在异步选择前固定运行身份并幂等释放，BYOK 定向 Node 5/5、Python 5/5。上述是组件回归；生产 Host 尚未装配聊天、可信模型配置及访问版本，附件媒体与孤儿恢复竞态仍未解决，不代表 Agent 执行链已接通。

管理员 Agent 用量查询已接入生产 Host 的 Admin 鉴权和 PostgreSQL；隔离 PG/Host 测试 5/5、Python 用量对照 5/5、Host 类型检查通过，真实部署尚未验收。

Agent 历史图片的 owner/session 限定两阶段读取已由 Core PostgreSQL 端口提供，并接入 Web 历史读取器；第二次读取在数据库内复核 8 MiB 总预算，旧数据中非对象项按 Python 行为保留。隔离 PG Core 合同与 Host 读取器→Harness 回放各 1/1、Harness 历史回归 58/58、Python 历史对照 12/12。实际聊天重建器尚未由生产入口装配，其他数据库方言和真实部署未验收。

Knowledge overview 已有要求迁移标记存在的 Core 只读子集，合成存储回归 2/2；真实存储、Host 和旧文档自动迁移尚未接入。Python 知识对照全量为 43 通过、1 失败：失败项需要本环境尚未构建的 Cython RAG 内核；排除该项后 43 通过、1 未选，不表示 RAG 已迁移。

个人记忆已有明确限定为规范小规模数据的 Core 读取规则，合成存储 Node 4/4、Python 记忆存储对照 19/19；真实存储和 Host 未接入，legacy 写回、超预算 embedding 与 Python 容错尚未实现，不能作为完整记忆服务。

Web 聊天准备现将可信来源写入加密调度载荷，worker 与重建器检查来源；旧载荷在确认无活跃 Harness 租约后进入现有版本冲突状态并保留数据，不根据会话历史来源推断。隔离 PG/Redis 调度及重建回归 5/5、Python 取消对照 11/11；这些测试仍使用合成 Provider/部分上下文，生产聊天入口尚未装配。账号状态仍按 Python 的请求认证语义处理，未新增运行中按版本中断。

Web 重建器在可信 Web 来源下按 Python 规则不加载 IM 记忆，即使会话原本来自 IM；相关隔离 PG/Redis 重建与绑定回归 2/2。用户记忆和知识存储仍需真实服务，不能把该 Web 分支当作完整上下文接入。

Harness 已支持可信工具适配器分别提供模型结果和原始展示结果，并在检查点中验证和恢复，旧检查点继续可读；定向回归 113/113。项目字段错误和实际幂等冲突的模型投影已通过合成 Provider 的 Host Runtime→隔离 PG 续轮 1/1；通用检查点恢复有独立回归，项目冲突专用重启验收以及生产工具注册与 Run 仍未接通。

本轮冻结源码的 Harness 与全部 Core Provider 定向回归共 10 文件、572/572 通过、无跳过；这是源码级回归，不代表生产 Host 或真实 Provider 已验收。

**跨端公共化进度**：日历创建、更新、删除用例已迁入 Core，Web Host 保留 PostgreSQL 适配；隔离 PG/生产 Host 回归 50/50、Python 对照 6/6，日历管理 list/get 也已委托 Core，正式临时 SQLite 8/8、隔离 PG/Host 3/3、Python 读取对照 5/5，Agent 范围查询仍待迁移。日历创建、更新和删除双库事务已接入 Core 和生产 Host；隔离 SQLite/PG 合同通过，生产 Host/Vite 验证幂等、提醒重排、越权、冲突、Undo/redo 和与现有 Host RAG 生产者混合并发；撤销执行器和 RAG 消费仍需独立验收。便签创建、更新、删除用例及 Undo 写入事务已接入 Core；各自 SQLite/PG 合同通过，生产 Host/Vite 在合成隔离 PG schema 验证创建、更新、删除、读取、越权、冲突及 Undo/redo，Python Mind 对照 39/39；画布创建、更新和删除已接入 Core 双库事务及生产 Host；隔离 PG 验证项目归属、跨 owner 拒绝、关联项和关系的 Undo/redo 与便签正文保留；画布其他操作和撤销执行器尚未完整公共化。Core SQLite schema 13 增加 SMTP 设置表并保留此前交互动作、通知和业务数据；工作区和文件授权字段尚受限，后台消费者及凭据交互尚未由建表接通；版本升级回归 40/40、桌面 Host 回归 15/15、Python 互读 2/2。SMTP 设置读写已接通 Core 双库和生产 Host，正式 SQLite/隔离 PG 合同 2/2、Host/Vite/隔离 PG 1/1、Python 对照 3/3；真实邮件与部署未验收。项目创建用例和事务适配器已接入 Core，SQLite/PG 合同回归 2/2，生产 Host/Vite 在合成隔离 PG schema 验证创建和幂等重放 1/1；项目更新用例也已迁入 Core，Host 的隔离 PG、临时 FS 和生产组合根回归 21/21；工作区声明创建/更新及列表已委托 Core，Host 隔离 PG 与相关 Python pytest 各 5/5；列表另有隔离 SQLite 原型 12/12、PG 1/1、Host 4/4、Python 19/19，详见 `docs/testing/node-agent-workspace-port.md`。工作区会话绑定、解绑和当前查询也已委托 Core，临时 SQLite 12/12、隔离 PG/Host 3/3、Python 19/19；声明删除已委托 Core，临时 SQLite 14/14、隔离 PG 4/4、Python 2/2，正式 SQLite 和物理目录清理未接通；通知中心已接入 Core 双库及生产 Host，隔离合同 2/2、Host/Vite/PG 1/1、Python 4/4。项目更新与工作区的正式 SQLite 适配、Local ACL、完整生产 schema 和真实部署尚未验收。

Agent 会话改名、消息定位、会话列表、上下文刷新和待发送队列的现有 Web 用例已委托 Core；HTTP、认证与 Redis 状态仍由 Host 提供。隔离 PostgreSQL 和 SQLite 契约、相关 Web Host 与 Python 对照已通过。SQLite schema 6 增加会话、消息、批次和队列表，以及显式备份升级和 owner/会话约束；Core 定向回归 31/31、桌面 CoreHost 15/15、Python 互读 2/2。工作区绑定目前只允许为空，文件授权与桌面 Agent IPC 未接入，真实生产打包制品未验收。Core 队列公开读取已移除认领令牌和到期字段；队列与聊天发送尚未共享完整事务，Redis 活跃状态也不是数据库事务事实。消息媒体脱敏、群聊提及规则、群会话最近发言昵称查询及 Run 密文编解码已由 Core 共用；昵称查询正式 SQLite/隔离 PG 各 1/1、Host 11/11、Python 定向 6/6，当前 Bot 默认名及用户 Bot 配置名仍由 Host 补全；交互历史投影和活动令牌轮换已委托 Core 双库事务及 Node Host，隔离 PG/Host 9/9、Python 定向 4/4；实际消费、桌面调用与完整消息历史尚未接通。历史分页、孤儿恢复和完整 RunStore 尚未完成公共化。活动恢复叠加时间窗口可能对无关过期记录产生锁竞争，SQLite 为单写者，PG action 锁等待依赖数据库超时；既有 Python 与 Node 消费者间锁序差异仍需解决。现有孤儿恢复只检查旧 Redis 状态；真实 Node 恢复函数在隔离 PG/Redis 中与合成的新运行启动交错时，已复现清空新运行和删除其状态键。该实验未运行真实 Python 协程或完整 HTTP，也不是生产事故证据；接入 Node 租约前必须协调两端运行身份与回收协议并完成真实两端交错验证。

**共享 Core 冻结快照验证**：最新标准 unit 80 个文件 1491/1491；此前冻结快照的隔离 PostgreSQL 22 个文件 40/40，均无跳过或失败；Python 旧库互读 2/2。后续搜索归一化另经双库对照 3/3、Host 搜索 13/13 和 Python 30/30；上述结果不等于真实部署或所有调用方验收。

**通知与日历读取目录收敛**：通知 HTTP 路由迁至 `modules/notifications`，生产继续使用 Core 双库实现；旧 Host PostgreSQL 适配器及其旧目录已删除，原持久化测试改用 Core 适配器。隔离 SQLite/PG 合同 2/2、生产 Host/Vite/隔离 PG 1/1、Host 路由 4/4、Python 对照 4/4。日历列表与详情由生产 Host 直接装配 Core 读取用例及双库端口，旧 Host 重复查询已删除，写事务仍需的查询辅助保留；正式 SQLite 8/8、隔离 PG/Host 3/3、Python 管理读取 3/3，隔离 PG 综合持久化 1/1。两项均未验收真实部署；Agent 日历提醒聚合仍未接通。

**联系人 Host 目录收敛**：Web 联系人路由和身份/事务桥已迁至 `modules/clients`，真实读写仍复用既有 Core 服务及双库仓储；Agent 工具、Host 装配和测试导入已更新，旧目录无引用。正式 SQLite 40/40、隔离 PG 1/1、Host/隔离 PG 与生产 Vite 6/6、Python 对照 3/3，Host 类型检查通过；目录移动本身不代表新增业务能力，真实部署未验收。

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

**主要缺口**：Agent 聊天生成与 SSE/取消、Mind 画布剩余跨端引用及撤销执行器、Worker/调度调用方、剩余 Admin/集成 API、真实服务集成和全量调用方切换。Node 已写入队列的 RAG job 仍由 Python Worker 消费。Linux/NAS 2.0 只支持 Local 文件存储；旧 OSS 数据迁移需在切换前另行验收。

**退出条件**：Web 必需 HTTP/SSE 与后台调用方在 Node 上行为等价；关键 PostgreSQL、Redis、文件系统路径完成隔离验收；默认 Web 流量切至 Node 后，再清理 Python Web 后端。Python API 不作为隐式回退。

- [ ] 盘点并迁移 Web 必需 API、Agent 工具、Worker/调度、撤销及其他写入口。
- [ ] 保持 HTTP/SSE、认证身份、错误/字段映射、事务和提交后副作用兼容。
- [ ] 完成真实 PG/Redis/文件系统的隔离、并发和故障路径验收。
- [ ] 所有调用方切换并验收后，移除对应 Python Web 写实现。

### N3——扩展数据域与 Agent 迁移

**RAG 目标**：复用 Gugu 1.7.7 TypeScript RAG 作为 Node/Core 唯一生产检索路径，不迁移 Cython 算法到 TS，也不保留双引擎线上选择。迁移时以当前 Python/Cython 行为回归和固定质量语料为基准，接入 Node/Core 授权来源读取、派生索引存储/重建及 ACL 过滤；具体验收见依赖迁移矩阵。RAG 来源文件正文按架构说明从授权 FS 直读，DB 不保存文件正文副本。

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

**桌面首批实际入口（2026-11-15）**：当前桌面验证工作台已调用项目和联系人列表、创建；项目重命名现经具名 Preload/IPC、Core 命令及正式 SQLite 接通，携带版本并使用操作收据。devserver 的 Preload 定向 1/1、真实 CoreHost/SQLite 重命名及重启恢复 1/1、桌面工作台组件 5/5、桌面类型检查通过；未验收真实 Electron 窗口、跨平台制品与最终交互布局。联系人编辑/删除、日历、笔记、画布、偏好和引导尚未由该界面接通；Mind Undo IPC 已有独立接线，但不代表桌面正向编辑可用。文件授权根、相对路径身份和恢复仍待落实，不能用 Web 文件 ID 替代。

联系人名称编辑现由工作台经具名 Preload/IPC 调用 Core `clients.update`，使用正式 SQLite 和操作收据；devserver Preload 1/1、真实 CoreHost/SQLite 重命名及重启恢复 1/1、工作台组件 6/6、桌面类型检查通过。上段的联系人编辑缺口现限于名称以外的字段；删除尚未接通。未验收真实 Electron 窗口及跨平台制品。

桌面日历创建的事务基础已增加 Core 显式借用事务入口，外层负责提交后通知；正式 SQLite 定向验证活动、索引、Undo 与操作收据同事务回滚及幂等重放 2 项通过，隔离 PostgreSQL 1 项跳过。日历命令、受限 IPC 和桌面界面尚未接通；本轮 Core 构建被并行 BYOK 凭据更新的类型错误阻断，不能算构建通过。

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
- [ ] 建立独立 `packages/fs/` 和 `packages/sandbox/`，迁移现有 Web Host 文件能力及 Core Executor 的可复用部分；Host 负责可信身份、授权根目录、执行后端与能力注入。现有部分实现不等于两包完成。
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


链接按钮新增安全校验及可信投递端口原型；实际平台投递、持久恢复及Host装配未完成，仍记依赖阻塞。Node专项1项、Python基准49项通过，详见工具行为清单。
