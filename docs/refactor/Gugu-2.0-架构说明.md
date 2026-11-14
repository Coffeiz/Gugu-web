# Gugu 2.0 架构说明

> 更新：2026-11-13。本文只维护目标架构、多端职责和跨端约束；实施顺序、当前完成状态与待办见[迁移任务清单](Gugu-2.0-迁移任务清单.md)。
> 当前桌面路线为 Electron + TypeScript Host + 随包 Node 26。完整 Agent、其他业务域、同步与正式发行仍需按迁移任务清单验收。

## 1. 目标架构与产品边界

### 1.1 已确定的方向

- 2.0 目标使用 `apps/` 放可运行应用，`packages/` 放可复用库：Vue 前端、Linux/NAS Node Host、Electron Host 分别归入 `apps/web/`、`apps/web-host/`、`apps/desktop/`；共享业务 Core 归入 `packages/core/`。四个包已迁入目标路径，构建与部署验收正在进行。
- `packages/core/` 承载可复用的领域规则、应用用例、统一数据运行时和 Agent 编排，目标语言为 TypeScript，完整桌面/服务端 Runtime 由 Node 承载。Core 不反向依赖 Web Host、SaaS 或 Electron 源码。
- `apps/desktop/` 使用 Electron + TypeScript 装配桌面 Host，负责窗口、生命周期和受限 IPC。可复用的执行契约、策略与平台适配目标收敛到 `packages/sandbox/`；端侧 Host 注入授权与原生后端，必要时使用独立原生 helper。`apps/web-host/` 是 Linux/NAS 自托管版的 Node HTTP Host，负责 Web API/SSE、可信身份上下文、服务生命周期和 Core 装配，并提供 `apps/web/` 构建的静态资源。SaaS 保留独立的 Gateway、身份、同步和部署装配边界；具备独立构建边界后可迁入私有仓库，不为尚未实现的 SaaS Host 创建空包。
- `apps/web/` 暂时承载 Vue 功能 UI；Web 与桌面共享看板、日历、笔记、画布等领域功能，分别装配应用壳、顶栏和主导航。不要求桌面沿用 Web Host 布局。
- macOS、Windows 桌面采用本地优先、应用内单用户；Linux/NAS 与 SaaS 保留多用户。桌面是默认家节点，SaaS 不是必经中转。
- SaaS 长期以多用户 DB、云同步及相应消息/任务路由为职责，不持有用户 FS，也不装配本机用户目录、watcher 或通用 Shell。首版可保留旧 FS 兼容链路，须完成数据去向和恢复验收后再退出。
- 文件正文以授权范围内的本地 FS 为唯一真源，业务读写直接通过 FS Adapter 完成；不再采用“本地文件与 DB 正文副本靠 watcher 同步”的方案。DB 不为本地文件单独生成持久对象 ID；需要索引、搜索或预览时，可保存可丢弃、可从文件重建的派生数据。文件以授权根目录下的相对路径定位，改名或移动后旧路径引用允许失效；watcher 仅可作为派生数据刷新的优化，不得作为一致性或数据恢复的前提。
- 可复用的 FS 能力收敛于 `packages/fs/`，Node 实现通过独立入口按需导入；Host 负责建立可信身份和授权根。当前仅安全只读打开已接入 Web 文件读取，写入、目录操作和其他端的接入仍待迁移。
- Linux/NAS 自托管版 2.0 只支持本地文件系统存储，取消应用在线文件/附件/记忆存储的 OSS/S3 后端及其直传、预签名 URL、对象配额和对象搬移 API。升级路径必须包含旧版 OSS 数据的盘点与迁移/导出验收；不能在数据去向未确认时直接禁用旧对象读取。独立备份目标可另行设计，SaaS 云端对象存储由 SaaS 架构单独决定，不受此项取消决定约束。
- 2.0 不把旧版“DB File 记录 ↔ 物理文件对象”双向对账和互相修复作为常规 Admin 能力；幽灵记录、孤儿文件导入/删除、路径镜像迁移仅可作为旧 FS 兼容数据迁移期的一次性诊断/修复工具。完成旧数据去向、完整性及恢复验收后，退役对应 Admin 页面、API 和维护任务。后续 Admin 存储页定位为存储健康与迁移/派生索引状态；若仍维护持久配额账本，可独立保留账本与 FS 实际占用核对，不与文件对象身份对账混为一体。缺失 FS 目录不得作为删除用户账号的依据。
- RAG 目标复用 Gugu 1.7.8 的 TypeScript RAG 实现，作为 Node/Core 的唯一生产检索路径；不再把 Cython RAG 算法移植到 Node，也不长期维护 TS 与 Cython 两套生产引擎。Python/Cython 仅可在迁移期作为当前行为的参考基准，退出前以回归与质量集确认 TS 行为。
- Linux/NAS 自部署保留多用户，执行后端目标改为 MXC 调用受授权的系统环境；2.0 不再维护 Linux Docker 执行沙箱。SaaS 不使用该 Linux 自部署执行方案，也不提供因此隐含的宿主机命令能力。MXC 必须在 Linux 上落实账号间的工作区、进程、资源和网络边界后，才可作为多用户通用执行后端启用；系统环境调用不等于无边界的宿主机 Shell。
- Admin 的 Shell 管理随执行后端去 Docker 化：退役 Docker/Rootless/镜像状态、容器重建/重启和 Docker 网络诊断等实现专属控制；Linux/NAS 自托管保留通用执行环境健康/能力状态、全局启停、用户与 Agent 授权、危险操作策略、资源配额、网络策略和执行审计。网络及资源限制由 MXC/Host 的受控执行边界落实。SaaS 不展示或开放 Linux 自部署 Shell 管理；桌面端使用本地 Host 的权限和状态界面。
- 各 Host 使用同一套 Core 定义，但分别拥有数据实例和运行生命周期。代码共享、数据同步、远程任务转交是三件事，分别验收。

### 1.2 各端职责

| 产品/入口 | 数据与运行职责 | FS / 执行职责 | 当前状态 |
| --- | --- | --- | --- |
| macOS / Windows Desktop | Electron Host 装配本地 Node Core、SQLite、稳定本地所有者；默认家节点 | 授权目录内直接读写文件；系统凭据和原生执行 Broker | Electron + Node 数据验证壳已实现；完整 Agent、FS 产品接入和正式发行未完成 |
| Linux / NAS 自托管 | 目标为 `apps/web-host` Node HTTP Host、多用户 Core Runtime、PostgreSQL；按部署需要使用 Redis（当前包目录为 `apps/web-host/`） | MXC 调用受授权的系统环境；保留多用户执行隔离，Linux Docker 执行沙箱不再作为 2.0 维护目标 | Node Host 的 Linux 部署切片已在 devserver 和 Node 26 容器验证；主站/Admin Vue 静态产物由镜像构建并由 Node Host 提供，另有健康检查、公开站点配置、密码登录与认证用户读取、项目活动/回收站列表、详情/文件计数读取、工作区列表/声明与绑定、日历读写、客户读写、通知和埋点路由；登录限流可选用共享 Redis。工作区列表暂时将 sandbox readiness 设为不可用；注册仍返回显式 503。多数业务 API、SSE 和 Worker 仍运行在 Python |
| SaaS | 多用户 PostgreSQL、云同步、连接路由；按启用能力装配常驻 Core Runtime 副本 | 不装配 Linux 自部署的 MXC 执行后端；长期无用户 FS，需要端侧资源时走显式授权的任务转交 | 新 Node SaaS Host 与云同步尚未实现；旧 FS 仅为过渡兼容 |
| Mobile | 可作为远端入口，后续也可承载独立本地数据/Runtime | 仅实现移动平台允许的文件和系统能力 | 目标方案；只承诺共享可移植 TS 边界，不假定能运行完整 Node、桌面原生模块或任意 Shell |
| Web 控制台、IM 等入口 | 请求转换、连接、展示；业务事实由选定 Runtime 持久化 | 不因能够连接 Runtime 而获得端侧权限 | 现有入口保留；跨设备绑定/路由待实现 |

入口可保存展示缓存、连接配置和临时输入，但不成为 Canonical 历史或业务数据的独立真源。SaaS 常驻副本实际启用的 Agent/云端计算能力须在后续能力表中明确，不能从“有 Runtime 副本”推导出已有完整云端 Agent 或端侧执行授权。

### 1.3 依赖方向

```mermaid
flowchart TB
    Entry["Vue / Web / IM / Mobile 入口"] --> Host["Host：认证、路由、进程与能力装配"]
    Host --> App["Core Application / Agent：用例与编排"]
    App --> Domain["Core Domain / Contracts：规则、模型与协议"]
    App --> Ports["Repository / 平台能力契约"]
    Host --> Data["Core Data Runtime：共用数据实现"]
    Data -. 实现 .-> Ports
    Data --> SQL["SQLite / PostgreSQL；后续持久任务与协调后端"]
    Host --> Platform["端侧 Adapter / Broker：FS、凭据、原生执行"]
    Platform -. 实现 .-> Ports
```

Domain/Contracts 不导入 Node、SQL 或具体 Host；Application/Agent 面向明确的数据及平台契约。Core 外层的 Data Runtime 可以使用 Kysely、SQLite、PostgreSQL 等库，共用 schema、编码和事务实现。Host 提供配置、私有数据位置及生命周期，不复制领域规则，不把全局运行配置注入内层模块。

### 1.4 Electron 桌面进程与通信方案

```mermaid
flowchart LR
    UI["Renderer：现有 Vue 桌面入口"] --> Preload["Preload：按能力暴露的类型化 API"]
    Preload -->|Electron IPC| Main["Main：窗口、身份、授权与生命周期"]
    Main -->|私有 NDJSON v2| Core["随包 Node 26：独立 Core 进程"]
    Core --> Worker["SQLite Worker：完整业务事务"]
    Worker --> DB[("本地 SQLite")]
    Core --> Executor["Core Executor：契约、策略与可选平台适配"]
    Executor -->|Host 注入的原生后端与授权| Broker["端侧 Broker：Windows MXC / macOS Adapter"]
    Main -. 注入能力 .-> Core
    Broker --> Task["授权范围内的不可信工具进程"]
```

- **Renderer / Preload**：复用目标目录 `apps/web/`中的领域功能 UI；桌面入口装配桌面专属 Shell，并通过逐项声明的 `contextBridge` API 暴露受限业务调用。显式设置 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`；不暴露原始 `ipcRenderer`、任意 channel、Shell、SQL 或通用文件路径接口。主进程校验调用窗口、frame/来源、命令和 DTO；身份、数据库路径及执行授权由 Host 建立。使用受限自定义协议加载随包 UI，验证资源根目录，限制导航/新窗口并设置 CSP。依据 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security) 与 [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)。
- **Main**：管理窗口、单实例、菜单、系统对话框、私有数据位置、授权、子进程及退出回收；将现有 Rust Host 的白名单、完整性校验、有界通信、未知结果恢复等契约迁入 TS。业务事务仍由 Core 执行。主进程与渲染进程职责依据 [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)。
- **Windows / macOS 适配**：保持同一 Desktop Shell、领域页面、业务状态和 Preload/Core 契约；按平台适配窗口标题栏/控制区、菜单栏、快捷键修饰符、文件对话框和窗口关闭/退出行为。平台差异由 Electron Main 的平台模块和 Renderer 的小型 chrome/style 适配承载，不在业务页面散布 OS 判断。Renderer 只接收有限、只读的平台显示信息；不自绘或仿造系统安全边界。
- **桌面构建与发布**：一次版本发布使用同一源码提交和版本号，Windows/macOS 在同一发布流水线中作为独立平台任务构建，完成后汇总为同一版本的 artifacts。macOS 签名/公证在 macOS runner 完成；Windows 产物在 Windows runner 构建并按发布配置签名。开发期可产出未签名验证包；正式分发需显式要求签名，缺失凭据时不得静默发布未签名包。CPU 架构与 macOS 是否提供 Universal 包按发行支持矩阵确定；每个平台产物分别做安装/启动 smoke。electron-builder 支持多目标配置，但原生依赖与 macOS 签名存在目标平台约束，不能将“单次流水线”理解成必须由单台机器打包全部平台；参考 [electron-builder 多平台构建](https://www.electron.build/v26/docs/features/multi-platform-build/)、[代码签名](https://www.electron.build/v26/docs/features/code-signing/) 与 [Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)。
- **Core 进程**：首个 Electron 版本继续随包独立 Node 26，通过固定可执行路径、固定参数和 `shell: false` 启动，清理环境注入；复用现有 NDJSON v2、Worker、schema 3 和操作收据。Core 不导入 Electron，不在 UI/Main 执行同步数据库工作，不启动 localhost HTTP 服务或依赖系统 PATH。
- **运行时版本与 ABI**：Electron 自带 Node 的版本不等于 Core 声明的 Node 26。本阶段保留独立 Node，接受新增包体成本并纳入 N0 预算；`better-sqlite3` 仅在独立 Node 的 Worker 加载，按该 Node ABI 和目标架构装配。未来若改为 Electron `utilityProcess`，须先验证内嵌 Node、Core engines 和原生模块 ABI，再单独决策；启动失败不能自动切换运行时。Electron 原生模块的 ABI 差异见 [官方说明](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)。
- **Executor / 原生 Broker**：`packages/sandbox/` 定义执行请求、确认/取消、策略与能力协商，并提供可选的 MXC/平台适配；授权材料、真实目录和可用原生后端由 Host 注入。`mxc.ts` 封装 SDK 或版本化 native bridge 调用，不依赖 Electron；`platform.ts` 仅选择已授权且能落实策略的 Adapter。必要的原生 helper 保持有界协议和能力校验。桌面 `sandbox/diagnostics.ts` 只负责探测与脱敏诊断，不再复制执行策略或另建业务执行器。Electron 渲染沙箱不能据此替代 OS 隔离或放宽 MXC 策略。
- **装配与发行**：按 `electron-builder.yml` 使用 **electron-builder**，由 `scripts/package.ts` 装配 Core 制品、目标架构依赖与许可证，并生成安装包；`scripts/smoke.ts` 运行独立制品冒烟。固定 Electron、electron-builder 及后续更新依赖的稳定版本后再改锁文件。UI/Main/Preload 可放 ASAR；独立 Node、Core/Worker、生产依赖及原生 helper 通过真实资源目录分发，独立 Node 不依赖 Electron 的 ASAR 虚拟文件系统。pnpm workspace 依赖收集、资源摘要和安装后路径必须实测。参见 [electron-builder 稳定版配置](https://www.electron.build/v26/docs/configuration/) 与 [ASAR 限制](https://www.electronjs.org/docs/latest/tutorial/asar-archives)。
- **更新**：`main/updater.ts` 管理版本检查、下载/校验及用户确认安装；调用 `lifecycle.ts` 停止接收写入、收敛未完成操作并退出 Core 后再安装。发行签名、更新来源校验、失败后的可启动版本及数据 schema 回滚分别验收；验证版不默认开启生产更新通道。后续可接入 `electron-updater`，具体格式及平台要求按 [官方更新文档](https://www.electron.build/v26/docs/features/auto-update/) 冻结。

当前替换窗口壳未升级数据 schema。Electron 必须复用既有稳定 owner 和数据位置；数据目录规则变化时须显式停写、备份并验证搬迁，不能启动成空库。不得让多个 Host 同时写同一库；CI、正式签名和产品发行分别验收。

<a id="directory-plan"></a>

## 2. 目标目录与职责

2.0 仓库目标根目录如下；迁移期间允许旧目录暂留，路径迁移与业务实现分阶段完成。辅助构建脚本和图标不逐项展开。`〔规划〕` 表示目录/文件尚不存在或尚未迁入对应能力；不因目录已规划就勾选实现完成。

```text
apps/
  web/                            # Vue Web/桌面 Renderer；由两个 Host 分别装配 Shell 与平台服务
  web-host/                       # Linux/NAS 自托管 Node + Fastify Host
  desktop/                        # Electron Host；不承载共享领域规则或数据库实现
packages/
  core/                           # 多端共享的 TypeScript Core
  fs/                             # 〔目标〕授权范围内的本地文件系统能力
  sandbox/                        # 〔目标〕执行契约、策略与平台适配
backend/                           # 迁移期间的 Python API/Worker 基线；按 N2/N3/N5 退出或仅保留未迁移 Worker
compat/                            # 迁移期 Python 兼容与差分回归；按生产调用方退出条件收敛
loopscope/                         # 独立子项目，保留自身 workspace 与构建边界
docs/
agentskills/
scripts/
```

SaaS 尚无当前仓库内的 Node Host；稳定后可维持独立私有仓库，不在本仓库预建空 `apps/saas/`。迁移期间若 Python Worker 仍需独立运行，才迁入 `apps/python-worker/`；Node Worker 只有需要独立部署、扩缩容或生命周期时才增加 `apps/worker/`，否则由相应 Host 装配 Core Job Runtime，不额外拆包。

`packages/fs/` 与 `packages/sandbox/` 是独立共享包目标：FS 负责授权根目录内的直接读写、路径边界与文件操作；Sandbox 负责执行契约、策略和平台适配。Host 建立可信身份与授权，按部署能力注入文件根目录、执行后端及生命周期；共享包不自行授予权限。两个独立包已建立：只读 FS 已接入 Web Host，Sandbox 已承载现有执行器实现，Core 保留兼容导出。完整 FS 产品路径和 Linux MXC 多用户隔离仍待实现和验收。

核心职责树如下；Core 内部目录沿用现有职责划分。Web Host 保留 HTTP/Host Adapter；迁移过程中暂留于 `apps/web-host/src/domains/` 的业务用例、数据访问，按可复用边界逐步归入 Core，不为目录搬迁重写业务逻辑。

```text
packages/core/                     # 公开、可独立构建的 TS Core
  src/
    contracts/                     # DTO、版本、错误类别、数据与平台能力契约
    domain/                        # 项目/联系人等纯规则；逐域扩展
    application/                   # 用例、Repository 契约、跨域协调与授权规则调用
    data/
      schema.ts                    # 共享数据模型与支持的 schema 版本
      codec.ts                     # UUID、UTC 微秒、布尔/整数及行转换
      repositories.ts              # 共用 SQL 仓储；所有查询/修改限定 owner
      runtime.ts                   # UoW、事务、取消、持久操作收据
      sqlite.ts                    # 本地连接、初始化、显式升级及备份
      postgres.ts                  # 连接池、会话配置与 PG Adapter
      migrations/                  # 〔规划〕完整业务迁移历史与升级路径
    runtime/
      local.ts                     # Node Host 的 Worker 客户端与有界请求生命周期
      worker.ts                    # 完整用例排队执行；不按每条 SQL 做 RPC
      commands.ts                  # 命令分派与共用参数边界
      transport/                   # 独立传输适配，不放业务分派
        stdio.ts                   # 迁入现有 NDJSON v2；保留限额和错误契约
        ipc.ts                     # 可注入消息端口的进程 IPC；不导入 Electron
      jobs/                        # 〔规划〕持久 Job、租约、恢复及调度
    agent/                         # Executor 已实现；其他 Agent 能力逐域迁移
      harness/                     # 〔规划〕Run 状态机、Canonical 历史、上下文与流式编排
      providers/                   # 〔规划〕模型协议、事件映射、用量和错误契约
      tools/                       # 〔规划〕工具定义、参数校验、确认与执行协调
      executor/                    # 兼容导出；实现位于 packages/sandbox/
  tests/                           # 独立 Core 的回归；T1 再按类型整理
apps/desktop/
  src/                             # Electron Host，不放领域/数据库实现
    main/
      index.ts                     # 组合各模块、注册应用入口与桥接
      windows.ts                   # 窗口、安全配置、导航与窗口来源管理
      platform/                    # 〔规划〕桌面 OS 差异集中在 Host 层
        windows.ts                 # Windows 标题栏、菜单、快捷键和退出行为
        macos.ts                   # macOS 交通灯、菜单栏、快捷键和窗口关闭行为
        shared.ts                  # 两端共享的安全窗口设置和生命周期逻辑
      core-host.ts                 # 可信 IPC 边界、随包 Core 通信与完整性/恢复
      lifecycle.ts                 # 单实例、Core 启停、休眠/退出和资源回收
      updater.ts                   # 更新检查、制品校验、确认安装与恢复
    preload/
      index.ts                     # 最小 contextBridge API；无通用 IPC 透传
    sandbox/
      diagnostics.ts               # 平台能力/版本探测与脱敏诊断，无执行策略副本
  scripts/
    package.ts                     # 装配 Core/原生资源、依赖与许可证，调用打包
    smoke.ts                       # 干净临时环境中的安装资源与重启/故障冒烟
  electron-builder.yml             # 资源布局、平台安装包、签名与更新配置
apps/web-host/                     # Linux/NAS 自托管版 Node HTTP Host 与部署装配
  package.json                     # workspace 包；依赖 @gugu/core，不复制 Core 源码
  src/
    app.ts                         # Fastify Host 组合根；安装共享 HTTP 边界并注册域插件，不承载域业务实现
    main.ts                        # PostgreSQL/Core/Redis 等 Adapter 装配、启动、信号处理与优雅关闭
    config.ts                      # 环境变量解析与启动前校验
    config/
      capabilities.ts              # 本部署显式启用的能力
    http/
      errors.ts                    # 统一映射 Core/HTTP 错误，保持 FastAPI {detail} 响应契约
      authenticated-domain.ts      # 认证一次并向域插件提供可信 RequestContext
      dto/                         # 〔规划〕共享请求/响应 DTO 与校验器
      server.ts                    # HTTP 服务生命周期
      sse/                         # 流式事件与连接生命周期
    domains/                       # HTTP 插件按业务域组织；只做协议映射与 Host 接线
      auth/routes/                 # 认证 HTTP 入口
      projects/routes/             # 项目 HTTP 入口
      workspaces/routes/           # 工作区 HTTP 入口
      calendar/routes/             # 日历 HTTP 入口
      clients/routes/              # 联系人 HTTP 入口
      notifications/routes/        # 通知 HTTP 入口
      site/routes/                 # 公开站点配置与埋点入口
      admin/routes/                # Admin HTTP 入口
      agent-sessions/routes/       # Agent 会话 HTTP 入口
    adapters/
      postgres/                    # 连接池与 Core PostgreSQL Adapter 装配
      redis-events.ts              # 跨域 Redis 通知与 revision Adapter
      executor/                    # 〔规划〕Linux MXC；隔离验收后才允许装配
    workers/                       # 队列/租约/消费生命周期；由 Host 注入运行时 Adapter
    migrations/                    # WebUI 部署所需的显式数据库迁移
  web-dist/                        # frontend 构建生成的静态产物，不提交源码副本
  deploy/
    Dockerfile                     # Linux Web Host 镜像
    compose.yaml                   # Web Host；PostgreSQL 可外接或按部署组合
    nginx/                         # 该部署版的反向代理配置
  scripts/
    build-web.mjs                  # 构建 frontend 并装配静态资源
    smoke.mjs                      # 临时环境中的部署启动冒烟
  tests/
    app.test.ts                    # 当前保护 /health 契约及 readiness 响应
    config.test.ts                 # 当前保护启动配置校验与连接串处理
    auth.test.ts                   # 当前保护令牌、Bearer/Cookie、CSRF 与撤销行为
    auth-route.test.ts             # 当前保护 GET /api/v1/auth/me 用户响应契约
    auth-login.test.ts              # 当前保护 bcrypt 登录、JWT/Cookie、活跃记录与单进程限流契约
    database.test.ts               # 当前保护 readiness 对必需 PostgreSQL schema 的核对
    projects-route.test.ts         # 当前保护项目列表/详情/文件计数认证、参数和 owner 绑定
    events-route.test.ts           # 当前保护日历列表筛选、详情参数和 owner 绑定
    clients-route.test.ts          # 当前保护客户列表、创建、删除与 HTTP 错误映射
    postgres.integration.test.ts   # 显式测试 URL 下以随机隔离 schema 验证真实 PG 用户、项目/日历查询和文件计数
  .env.example                     # 配置项示例，不包含真实凭据
  README.md                        # Linux/NAS 安装、升级、备份与恢复
apps/web/                          # Vue Web/桌面 Renderer；桌面 bridge 由 apps/desktop 的 Preload 提供
  src/entrypoints/                 # 〔规划〕端侧启动入口；共享功能，不共享根 Shell
    web.ts                         # Web 路由、服务和 Web Shell 装配
    desktop.ts                     # 桌面路由、桌面服务和 Desktop Shell 装配
  src/shells/                      # 〔规划〕应用级布局，各端分别持有
    web/                           # Web 顶栏、侧栏、主导航与页面框架
    desktop/                       # 桌面工具栏、窗口导航、可隐藏侧栏与页面框架
  src/features/                    # 〔规划〕跨端复用的产品功能，按领域组织
    board/                         # 看板页面、组件、composable 和领域状态
    calendar/                      # 日历功能
    notes/                          # 笔记功能
    canvas/                         # 画布功能
  src/shared/                      # 〔规划〕不依赖具体 Shell/平台的 UI 与业务状态
    components/                    # 两端共享的基础控件
    composables/                   # 两端共享交互逻辑
    stores/                        # 跨端一致的业务状态
  src/platform/                    # 〔规划〕端特有能力适配，不让功能组件直接依赖平台 API
    web/                           # HTTP、浏览器存储等 Web Adapter
    desktop/                       # Preload IPC、Core 命令和桌面存储 Adapter
  src/api/
    client.ts                      # 从 services/api.ts 收口通用请求、CSRF、错误处理和请求去重
    auth.ts                        # 认证/账户 API
    files.ts                       # files、folders、trash、workspace directories API
    projects.ts                    # 项目 API
    mind.ts                        # 思维 API
    calendar.ts                    # events API
    schedules.ts                   # 定时任务 API
    agent.ts                       # Agent/会话 API
    integrations.ts                # BYOK、MCP、IM 连接 API
    preferences.ts                 # 用户偏好 API
    admin/                          # Admin API，按业务域继续拆分
      filesync.ts                  # 文件同步管理 API
    types/                          # 仅跨领域共享类型；领域类型留在对应 API 模块
    index.ts                       # 可选兼容导出
backend/                           # 迁移期 Python Web/Agent/Worker 与行为基线；按退出条件清理
compat/                            # 仍在使用的 Python 兼容包，不复制新能力
loopscope/                         # 独立子项目及 workspace，不为统一目录而强行拆并
docs/                              # refactor 主清单/矩阵/归档，testing 分层规范与映射
```

WebUI 目录参照 Python `backend/app/api/v1/`、`backend/app/services/`、`backend/app/db/` 与 `backend/app/core/` 的职责边界：业务域作为路由/服务模块组织边界，域内按 `routes/`、`application/`、`persistence/` 拆分；共享认证身份、DTO 校验、HTTP 错误和日志归 `http/` 公共边界，跨域运行时 Adapter 放在 `adapters/`。域插件只能从 Host 收到显式依赖，不能自行读取请求头推断 owner、创建全局连接或绕过 Core 契约。`app.ts` 只负责安装共享 HTTP 能力并注册域插件，`main.ts` 负责构造并注入 PG/Redis/Core 等 Adapter。

2026-11-13 已将现有认证、Admin、Agent 会话、项目、工作区、日历、联系人、通知和站点 API 模块从 `src/` 根目录移入 `src/domains/<domain>/`，并将共享 Redis 事件 Adapter 移入 `src/adapters/`；`app.ts`、`main.ts`、启动配置、数据库 readiness、静态资源、HTTP 边界、Worker 与 migrations 保持 Host/基础设施职责。当前部分 Admin 与 Agent 原型仍在单个模块中混合 route/service/persistence，后续在行为切片稳定和 Host 接线时按上述分层继续拆分，不做一次性全树重写。`src/http/` 是共享边界，不能把业务 SQL/服务塞入该目录。

Vue 前端 API 客户端目标位于 `apps/web/src/api/`，并按业务域组织：通用传输、CSRF、错误与请求去重由 `client.ts` 承担；`auth.ts`、`files.ts`、`projects.ts`、`mind.ts`、`calendar.ts`、`schedules.ts`、`agent.ts`、`integrations.ts`、`preferences.ts` 和 `admin/` 各自负责对应领域。领域类型放在所属 API 模块，`types/` 只收真正跨域共享类型。现有 `apps/web/src/services/api.ts` 在迁移期作为兼容入口逐步收口到新模块，调用方分批迁移；`index.ts` 可提供短期兼容导出，不能重新成为所有业务 API 的集中实现。

### 多端前端：共享功能，分端 Shell

Web 与桌面共享产品领域功能，不共享整站布局。看板、日历、笔记、画布等页面及其组件、composable、业务状态和交互规则应保持同一实现；Web 的 Topbar、Sidebar、Nav 与桌面窗口工具栏、主导航、侧栏布局分别由 `shells/web/`、`shells/desktop/` 持有。两端可共享设计 token、基础控件与领域组件，但桌面端可采用适合窗口空间、菜单栏、快捷键和侧栏显隐的布局，不以复刻 Web 页面为目标。

领域功能通过稳定的应用服务接口访问数据与平台能力；Web Adapter 走 HTTP，桌面 Adapter 通过受限 Preload/IPC 调用 Core。功能组件不得直接导入 Electron、`window.guguDesktop` 或 Web 专属路由/请求单例。端侧启动入口负责选择 Router、Shell、存储与服务 Adapter；桌面 UI 状态（窗口、导航展开、工具栏）与 Web UI 状态分别持有，业务状态只有语义一致时才共享。

以上目录是渐进式目标而非当前已完成结构。迁移时先提取 Shell 边界和服务端口，再按领域迁移可复用页面；不为目录对称而整体搬动 `views/`，也不通过条件分支把两端布局塞进单一大 Shell。验收需分别检查 Web 与桌面入口，并确认功能组件不依赖平台实现。

正式 stdio 已移入 `runtime/transport/stdio.ts`；原 `.mjs` 制品/主动验证脚本作为 package/smoke 的共用辅助保留。生成的 Node/Core/原生资源放打包暂存及应用资源目录，不作为新的源代码职责层，也不提交 Git。

### 2.1 关键职责不能混淆

| 模块 | 负责 | 由其他模块负责 |
| --- | --- | --- |
| Core Domain / Application | 领域不变量、业务用例、所有权规则、确认与副作用语义 | Host 建立可信身份、展示确认并验证调用来源 |
| Core Data Runtime | 仓储、schema、事务、精度、CAS、操作收据及迁移实现 | Host 停写、备份编排、独占升级、启动和运维配置 |
| Core Agent | Canonical 历史、Provider 适配、上下文、工具及 Run 编排 | Host 注入凭据、网络/进程能力与入口交付 |
| Core RAG | 复用 1.7.8 TypeScript 检索与排序规则；索引为派生数据，可从授权 FS/Canonical 数据重建 | Host/Core Data Adapter 负责授权来源读取和索引持久化；Python/Cython 不作为 Node 生产执行路径 |
| Core Runtime / Transport | `commands.ts` 统一命令边界；stdio/进程 IPC 只处理编码、消息、背压、超时与错误终态 | Electron IPC 的窗口/frame 来源校验和 Preload 暴露由 Desktop 负责 |
| Sandbox 包（目标；当前部分实现位于 Core Executor） | 共用执行契约、策略计算、能力协商、MXC/平台适配及执行终态 | Host 注入真实授权、原生后端、私有资源与生命周期；OS 后端强制隔离 |
| Host Broker | 数据及平台 Adapter 装配、能力协商、进程和资源生命周期 | 业务数据规则继续由 Core 统一维护 |
| Web Host (`apps/web-host`，当前为 `apps/web-host/`) | HTTP/SSE、认证身份到 DataContext 的可信映射、Core/PG 装配、前端静态资源服务和服务生命周期 | 不复制 Core 领域/仓储实现；不自行持有第二份业务 schema 或绕过命令边界；Linux 执行能力须待隔离验收后显式装配 |
| FS Adapter | 真实目录、句柄/bookmark、直接读写与路径强制边界 | 文件正文由 FS 持有；以授权根目录和相对路径定位，不另建本地文件对象 ID；机器授权材料不跨设备复制 |
| Execution Adapter | Shell/PTY/MCP stdio 隔离、网络/资源限制、取消与进程树回收 | Core 决定调用意图和授权要求；模型字段不能成为权限凭据 |

SQLite 内部数据文件、初始化与备份属于 Data Adapter，不等于提供用户工作目录 FS。数据库查询不经过命令执行沙箱；可信 Core 的数据库和密钥也不能随工作区授权暴露给待执行进程。

本地文件正文不进入 DB 作为同步副本。派生索引或缓存必须能丢弃并从源文件重建，不能在 DB 与文件不一致时回写旧内容覆盖源文件。需要持久化的文件引用使用授权根目录及相对路径；路径改变后引用可以失效，由用户重新定位，不通过 watcher 推断或重建文件身份。

RAG 复用既有 TypeScript 算法实现，不从 Cython 重写算法。迁移重点是接入 Node/Core 的授权数据读取、来源适配、派生索引生命周期和重建流程，并以当前 Python/Cython 回归及固定质量语料验证召回来源、Token、候选、排序、confidence 与 ACL 过滤；索引格式或 tokenizer 版本变化时须明确重建策略。迁移期间 Python/Cython 仅用于差分参考，不与 TS 同时成为线上权威结果。

### 2.2 Transport、Executor 与桌面装配边界

`runtime/transport/ipc.ts` 是 Core 进程消息传输适配，与 Renderer → Preload → Main 的 Electron IPC 属于两个边界。它通过注入端口连接，不 import Electron，不把原始 IPC 对象交给工具/界面。stdio 与 IPC 复用同一命令、收据、限额和错误契约；每个 Host 在装配时显式选择一种传输，不在异常时自动切换或重放修改。Electron 继续使用 NDJSON v2；通用 IPC 适配已独立回归，其他 Host 接入时仍须显式选择。

执行实现位于 `packages/sandbox/`，Core 的 `agent/executor/` 保留兼容导出：`contracts.ts` / `policy.ts` 不依赖 Electron 或平台 SDK；`mxc.ts` 及平台后端仅由获准的 Node Host 显式装配。可移植 Core 入口不主动导入 MXC、Node 进程或原生模块；Linux/NAS 自部署目标使用 MXC 调用经授权的系统环境，不再维护 Linux Docker 执行沙箱；SaaS 不装配这条 Linux 执行路径，Mobile 按自身能力集选择实现。共享包中存在 `mxc.ts` 不代表 Host 自动获得执行权限。`policy.ts` 只能收紧可信 Host 授权并检查可落实能力，最终文件/网络/进程限制仍须由 OS 后端强制执行。MXC 的 Linux 多用户隔离尚属验收要求，未验证前不得宣称满足多用户通用执行的安全边界，也不得回退到无隔离的宿主机执行。

`agent/harness/` 管理 Agent Run 与事件顺序，`providers/` 适配模型协议，`tools/` 描述工具意图并通过确认门调用 Executor；三者不自行绕过执行边界。桌面 `diagnostics.ts` 只显示脱敏后的能力/版本与拒绝原因，不运行任意命令、不改 ACL，也不通过诊断结果自动放宽策略。真实目录授权与系统凭据是端侧能力，由 Host 注入；watcher 若接入，只用于刷新派生索引，不参与正文同步或正确性保证。具体平台文件待功能切片时补充，不在主进程入口堆叠实现。

`main/index.ts` 只组合模块；窗口创建与来源管理归 `windows.ts`，Core 通信与可信请求边界归 `core-host.ts`，单实例/启停/退出回收归 `lifecycle.ts`，更新流程归 `updater.ts`。这些模块共享同一个 Core 生命周期，更新器不另起数据写入进程。`electron-builder.yml` 只声明打包/签名/更新规则，证书和密钥从安全存储或临时环境变量注入，不写入配置或生成资源。

## 3. 数据统一与 Node 迁移规则

1. 一个完整业务命令由同一个 UoW/连接拥有事务。仓储不自行 commit；项目、撤销记录、关联元数据、需要可靠投递的 outbox 必须一起设计。
2. 同一部署的同一写域只有一个权威写入口。未具备完整 Node 命令时，整条 Web 命令继续走原 Python 路径，不拆成 Python/Node 两次提交，也不双写。
3. SQLite 与 PG 通过同一业务契约验收，差异集中在 Adapter：用户隔离、UUID、UTC 微秒、缺字段/null、布尔/整数、JSON、排序、CAS、回滚与持久化均需验证。
4. 当前本地 schema 为 **3**、正式桌面 NDJSON 为 **v2**。业务写入与操作收据同事务提交；相同操作 ID/内容重读原结果，内容不一致冲突。未知提交状态不自动重放修改。
5. 旧本地 v1/v2 库须停应用后显式备份升级；不自动覆盖或修复用户库。旧 Python 不直接写 v3，回滚需恢复升级前备份并配套旧代码。
6. SQLite 由专属 Worker 调度完整用例，Host 单实例；队列、帧、超时和取消有明确边界。线程异步不等于数据库可随意并发写入。
7. 文件字节与 SQL 不能天然共享事务。先确定暂存、引用提交、幂等任务、补偿/对账和用户可见终态，再迁移文件联动命令。
8. 凭据只由 Host 安全配置/系统凭据来源注入；测试不读取或覆盖用户 `.env`、`config.override.json`、真实数据目录或部署数据库。

**当前结论：项目/联系人这一批 DB 底座已经实现，不代表全部业务数据、Web 写路径或云同步已统一。**

## 4. 多端 FS、沙箱、同步与任务转交

桌面优先原生执行。Windows 的 MXC 1.0.1 是已做有限验证的 Adapter 候选；macOS 原生 Adapter 尚待验证与选择。Electron Renderer 沙箱和 Node Worker 都不能替代不可信执行的 OS 隔离。请求的文件/网络/进程约束无法落实时必须拒绝，不自动回退宿主执行或放宽策略。

| 平台能力 | 已有事实 | 仍需完成 |
| --- | --- | --- |
| Windows MXC | 已验证授权目录、只读/越界拒绝、受控网络拒绝、超时和终止；实验 Host 有固定验证入口 | 严格 UI 策略下 Node 初始化仍有兼容缺口；Node/MCP/PTY、链接/重解析点、继承句柄、完整进程树和真实发行环境验收 |
| macOS 执行 | Electron 数据制品与实际应用验证已接入三平台矩阵 | 可发布的原生隔离 Adapter、目录授权、网络、进程回收、签名后边界；不能将数据制品通过算作沙箱通过 |
| Linux / NAS MXC | 作为自部署多用户的目标执行后端；Linux Docker 执行沙箱不再作为 2.0 维护目标 | Linux 上的用户隔离、授权目录、进程树、资源/网络限制、超时终止与拒绝策略均须实测；完成前不启用多用户通用执行 |
| 本地 FS | 文件正文由授权范围内的本地文件系统持有，按根目录和相对路径直接读写；不以 DB 副本作为正文真源 | 各平台授权目录及路径边界；原子写入、覆盖恢复、删除恢复；派生数据失效后可重建 |
| 派生索引 / watcher / Secrets | DB 可保存可重建的索引、搜索或预览数据；watcher 不承担文件正文同步 | 索引重建与失效策略；watcher 如启用只能触发刷新；桌面系统凭据接入 |
| 云同步 | 方向和本地稳定身份/版本底座已有定义 | 实体全局 ID、同步游标、墓碑、冲突/重放/离线恢复、设备绑定与隔离协议 |
| 任务转交 | 与数据同步分开设计 | 任务/父 Run ID、目标、授权引用、幂等/租约、接受/结果/取消回执及离线状态 |

同步不复制本机绝对路径、bookmark、OS 授权、凭据或活跃进程。本地路径引用不代表文件已同步到其他设备；附件/记忆的逻辑记录及其正文是否进入云端属于独立产品能力，SaaS 云端对象存储方案仍需单独冻结，不能把“记录已同步”显示成“文件已备份”。SaaS 退出旧 FS 前，须明确附件和长期记忆正文的去向及恢复路径。
