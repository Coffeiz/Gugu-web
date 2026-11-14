# Gugu 2.0 迁移任务清单

> 更新：2026-11-13。本文维护实施顺序、当前状态、验收证据与未完成任务。目标架构和多端职责见[架构说明](Gugu-2.0-架构说明.md)；依赖替换盘点见[Python → Node 依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md)。
>
> **当前路线：先完成 Node Web/NAS 后端迁移，再基于稳定的共享 Core 推进桌面产品化。** Web 使用 Node Host + PostgreSQL；桌面使用 Electron + Node Core + 本地 SQLite。两端共享 Core 契约，但拥有不同 Host 和数据生命周期。迁移期间未具备完整 Node 命令的 Web 写路径继续整体走 Python，不双写。

> **2026-11-13 存储范围决策**：Gugu 2.0 Linux/NAS 自托管版只支持本地文件系统，Node WebUI 不迁移在线 OSS/S3 文件、附件或记忆存储 API（包括 OSS 直传/预签名 URL、对象配额和对象搬移）。既有 Node OSS 实现与历史验收记录仅作迁移过程证据，不构成 2.0 支持承诺；旧 OSS 数据迁移/导出路径仍需实现与验收，用户数据切换到 2.0 前必须完成数据盘点和去向确认。独立备份目标另行设计，SaaS 对象存储不在本决定范围内。

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

**状态：进行中。** Node WebUI Host 和主要用户、项目、文件、日历、工作区、偏好、通知及部分 Admin/Agent 路由已接入。逐路由覆盖见[Node WebUI API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md)；历史测试与切片细节见[devlog 索引](../devlog/README.md)。旧版全量数量快照已过期，不作为当前完成率。

**主要缺口**：Agent 聊天生成与 SSE/取消、Mind 画布、Worker/调度调用方、剩余 Admin/集成 API、真实服务集成和全量调用方切换。Node 已写入队列的 RAG job 仍由 Python Worker 消费。Linux/NAS 2.0 只支持 Local 文件存储；旧 OSS 数据迁移需在切换前另行验收。

**退出条件**：Web 必需 HTTP/SSE 与后台调用方在 Node 上行为等价；关键 PostgreSQL、Redis、文件系统路径完成隔离验收；默认 Web 流量切至 Node 后，再清理 Python Web 后端。Python API 不作为隐式回退。

- [ ] 盘点并迁移 Web 必需 API、Agent 工具、Worker/调度、撤销及其他写入口。
- [ ] 保持 HTTP/SSE、认证身份、错误/字段映射、事务和提交后副作用兼容。
- [ ] 完成真实 PG/Redis/文件系统的隔离、并发和故障路径验收。
- [ ] 所有调用方切换并验收后，移除对应 Python Web 写实现。

### N3——扩展数据域与 Agent 迁移

**RAG 目标**：复用 Gugu 1.7.8 TypeScript RAG 作为 Node/Core 唯一生产检索路径，不迁移 Cython 算法到 TS，也不保留双引擎线上选择。迁移时以当前 Python/Cython 行为回归和固定质量语料为基准，接入 Node/Core 授权来源读取、派生索引存储/重建及 ACL 过滤；具体验收见依赖迁移矩阵。RAG 来源文件正文按架构说明从授权 FS 直读，DB 不保存文件正文副本。

- [ ] 会话/消息/附件引用、Canonical 历史与顺序规则。
- [ ] Run/Job、确认授权、租约、持久调度、outbox 和重启恢复。
- [ ] 按 `agent/harness/`、`providers/`、`tools/` 拆分 Agent 实现，调用共用 Executor；保证测试和可移植入口不隐式装载平台后端。
- [ ] Linux/NAS MXC 执行后端通过多用户隔离验收后，将 Admin Shell 页面收敛为执行环境状态与安全策略管理；移除 Docker/Rootless/镜像和容器生命周期操作，保留全局启停、用户/Agent 授权、危险操作策略、资源配额、网络策略及执行审计。SaaS 不开放该管理入口。
- [ ] Provider/流式事件、工具、取消与背压；代码权限、confirm、URL 安全和脱敏边界。
- [ ] 原生 wire/thinking/signature、上下文压缩、反思及缓存/用量契约。
- [ ] 便签/画布/日历、长期记忆/RAG、媒体/Office 按依赖矩阵逐域迁移和验收。
- [ ] SaaS 数据同步、设备绑定/路由及受限任务转交。
- [ ] SaaS 旧 FS 的内容迁移、完整性与恢复验收，通过后退出兼容 FS。
- [ ] 旧 FS 兼容迁移验收后，退役以 DB `File` 行和物理对象清单互相比对为前提的 Admin 对账能力：幽灵/孤儿对象修复、对象导入及路径镜像迁移。改由存储健康、派生索引重建状态和必要的配额账本核对承担运维诊断；配额核对与文件对象对账分别设计。
- [ ] 移除“用户目录缺失即列入账号删除修复”的存储对账路径；账号生命周期必须由独立、明确的账号管理规则决定，不能由 FS 扫描结果推断。
- [ ] Mobile 可移植 Core 与独立 Host 的平台可行性验证。

#### N3 Agent Harness 专项（2026-11-13，Core 切片已实现并完成本轮回归）

本切片仅负责可移植 Harness，实现在 `packages/core/src/agent/harness/`；不迁移具体 Provider 协议、工具业务、Web API 或桌面 Host。行为与逐项缺口见 [Harness 回归映射](../testing/node-agent-harness-parity.md) 和 [逐 Python 定义清单](../testing/node-agent-harness-parity.json)。

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
