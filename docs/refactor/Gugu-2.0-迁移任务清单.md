# Gugu 2.0 迁移任务清单

更新于 2026-11-21。以下现状以当前源码和仓库验收记录为准。发布状态以实际制品和部署记录为准。

## 当前状态

| 阶段 | 已接入的入口 | 剩余重点 |
| --- | --- | --- |
| N0–N1 共享底座 | 阶段职责已拆分。Web Host、Electron Desktop 和共享 Core 分别位于 `apps/web-host/`、`apps/desktop/` 和 `packages/core/`。PostgreSQL 和 SQLite 由 `packages/database/` 的编号迁移管理。 | 旧库升级、回滚、数据完整性和性能预算。 |
| N2 Node Web/NAS | Fastify Host 已接入 PostgreSQL、认证、主要业务 API、聊天 SSE 和后台消费者。业务域位于 `modules/`，启动装配位于 `startup/`。Admin 入口保留在 `apps/web/`。 | 核对必需路由和部署调用方，完成仅 Node 部署验收。 |
| N3 Agent 与 IM | Web 和桌面共用 Core 的 Run、工具、交互和上下文规则。Web 通过 PostgreSQL、Redis 和 SSE 协调，桌面通过 SQLite 和具名 IPC 接入。Node IM Gateway 已有四平台生产装配入口，Web Host 代码中的消费者归属默认仍为 Python。 | 真实平台交接、跨进程恢复、租约和投递验收。 |
| N4 桌面 | Electron Main/Preload 经受限 IPC 调用独立 Node Core。项目、联系人、日历、笔记、画布、文件库、偏好和 Agent 已有应用入口。桌面 Agent 已接入 SQLite 持久会话/Run、事件投影、记忆、搜索及共享工具注册；会话工作区绑定和 `save_attachment` 的个人/项目/工作区目标已有 Desktop 适配及自动化覆盖。 | Agent 行为与旧 Python 基准的重点回归；`ask_user` 和工作区附件目标真实桌面端到端验收；实机安装、签名更新、平台隔离及恢复验收。 |
| N5 收敛与发行 | 运行入口已分拆，仓库仍包含旧 Python 后端、兼容包和 Python 部署入口。 | 完成数据交接和 Node 独立部署，再清理旧运行依赖。 |

- **文件**。Linux/NAS 版使用本地文件系统。聊天、笔记和画布引用使用路径和文件身份，历史数字文件引用失效时明确提示。桌面沙箱外的绝对路径走宿主机授权，工具回执保留真实路径。旧文件数据、附件和其他仍使用文件记录的调用方按[文件迁移](Gugu-2.0-文件迁移.md)逐项处理。SaaS 对象存储单独规划。
- **Agent**。Web 普通聊天和 IM 使用用户设置时区，桌面时间与日期上下文使用运行机器时区。两端各自注入 Shell 策略和权限；桌面文件清理只通过桌面 Shell，不注册回收站/清理工具。桌面不注册独立 `read_file`，但共享 Core 仍保留该工具实现，不能据此称 Node 全局已退役。桌面通过 `/workspace` 命令在本机文件目录间绑定会话；绑定只提供会话工作区上下文，不改变桌面 Shell 权限。共享 `save_attachment` 支持当前 Run 授权附件保存到个人/项目/绑定工作区、相对 `folder_path`、同名保留和本机调用回执。Web 的数字 `folder_id` 在 Desktop 用相对路径表达。本机拖入文件仍作为引用，不改成上传。

## 待办与验收

### 数据升级与旧存储

- [ ] 用隔离的旧版 PostgreSQL、SQLite 数据演练备份、编号迁移、完整性校验、失败恢复和回滚。覆盖 owner、会话、凭据、附件、文件引用及 Undo/Redo。
- [ ] 清点历史本地文件和 OSS/S3 数据，明确导出、导入、缺失对象和无法验证身份的引用如何处理。验收文件内容、关联及恢复。
- [ ] 数据切换完成后，核对并清理旧 DB↔FS 对账、幽灵/孤儿修复和路径镜像入口。独立保留存储健康、索引重建及配额账本核对。账号删除走独立账号管理规则。

### Web Host 与 Agent

- [ ] 以 [Node WebUI API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md) 核对活动调用方。通过真实 PostgreSQL、Redis 和文件系统验收认证、HTTP/SSE、文件事务、Undo、重启和优雅停机。
- [ ] 在 Web 和桌面分别验证聊天队列顺序、重复领取、取消、交互断线重连、凭据提交、结果未知与进程重启。跨进程恢复复验 owner、Run、凭据版本及租约。
- [ ] 验收 Provider 流式协议、附件与媒体、摘要、RAG、记忆及定时任务。优先覆盖仍影响发布的协议差异、故障恢复和持久副作用。
- [ ] 替换或删除旧独立文件工具前，核对调用者并验证替代路径。分别确认文件引用、配额、Undo、事件刷新和 Office/PDF 提取。无 Shell 的入口单独核对可用能力。
- [ ] 验收 Linux/NAS 的授权根、跨用户和进程隔离、进程回收、资源限制及默认禁网。验证 DNS、重定向、内网和 loopback 边界。旧 Docker 专属管理字段、容器生命周期和 egress 依赖待替代能力验收后清理。

### IM Gateway

- [ ] 按 [IM Gateway 迁移清单](Gugu-2.0-IM-Gateway迁移清单.md) 完成飞书、QQ、微信、Telegram 的真实账号验证。覆盖入站、控制交互、出站、媒体、失败重投及恢复。
- [ ] 演练消费者单一归属交接、在途任务排空、重复投递保护和回退，核对部署后实际归属。

### N4——桌面产品化与发行准备

- [ ] 完成桌面 Agent 关键行为回归：会话/Run、SSE 事件投影、取消与续接、工具交互、Provider 流式、搜索、附件与媒体、记忆和重启恢复。优先验证共享 Core 契约与 Desktop Node 集成，不要求对旧 Python 做全量逐项对照；区分自动化覆盖与真实桌面端到端验收。
- [ ] 端到端验收桌面普通 `ask_user` 提问、选择/文本回答、过期及重启续接；在真实 Desktop Run 中验证个人/项目/绑定工作区保存、持久回执、重启恢复和冲突行为。本机拖入文件保持引用语义。`user_sandbox` 授权及危险操作继续遵循 Desktop 独立权限设计；桌面不注册独立 `read_file` 或回收站工具。
- [ ] 验收 macOS 原生执行适配器和 Windows 不可信负载矩阵。覆盖系统代理、工作区授权、沙箱外文件、Secrets、PTY、文件监听、退出及休眠恢复。
- [ ] 完成 macOS arm64/x64、Windows x64 的正式制品验收。检查签名/公证、最低支持 OS、干净离线安装、更新回滚及多窗口行为。
- [ ] 确定冷启动、内存、包体、IPC 延迟、读写 P50/P95、取消和恢复预算，按同一条件记录平台基线。
- [ ] 桌面遥测单独验收用户授权、关闭后停止上传、离线队列限制和自部署目标。SaaS 接收及聚合另行规划。

### N5——收敛与发行

- [ ] 在仅 Node 的独立部署中验证启动、运行、恢复和升级，确认 Web、Worker、IM、终端和管理入口均已切换。
- [ ] 按实际调用清理 `backend/`、`compat/` 及旧 Compose、构建和验收依赖。保留独立 Node 回归和数据迁移资料。
- [ ] 在目标发行提交上核对平台安全、升级恢复、构建产物与整体产品验收，按[发版流程](../ops/release.md)完成发行。
- [ ] SaaS 数据同步、设备绑定与任务转交、独立控制台，以及 Mobile 的 Core 可移植性分别验证。共享 Core 构建保持独立。

<a id="core-test-parity"></a>

## T1 实现与验收证据

| 问题 | 查阅位置 |
| --- | --- |
| 模块边界和数据生命周期 | [架构说明](Gugu-2.0-架构说明.md)、[数据库迁移](../../packages/database/README.md) |
| API、工具、Provider 与历史行为差异 | [API 迁移清单](Gugu-2.0-Node-WebUI-API迁移清单.md)、[工具注册](Gugu-2.0-Agent工具与技能注册机制.md)、[依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md) |
| 分层测试与覆盖证据 | [测试入口](../testing/README.md)、[Core 双库](../testing/node-core-parity.md)、[Agent 工具](../testing/node-agent-tools-parity.md)、[Provider](../testing/node-agent-provider-parity.md)、[LoopScope](../testing/node-loopscope-trace.md) |
| 旧决策与阶段记录 | [开发日志](../devlog/README.md)、[历史归档](_archive/gugu-2.0/README.md)、本文 Git 历史 |

日常回归用 `corepack pnpm test:fast`，按改动范围补 `test:integration` 或 `test:e2e`。真实 PostgreSQL、Redis、平台账号或实机制品不可用时，记录对应验收缺口。每项验收只保留最新证据入口。
