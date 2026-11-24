# gugu-desktop：Electron / Node 验证版

Electron 45.3.1 的 TS Main/Preload 复用 `apps/ui/src/desktop/bridge/`，经私有 NDJSON v2 调用随包 Node 26 Core；SQLite 用例在独立 Worker 执行。桌面单用户，支持项目/联系人创建和重读，不依赖 Web 登录、系统 Node 或 Python。职责与阶段状态见 [统一任务清单](../../docs/refactor/Gugu-2.0-迁移任务清单.md)。

当前桌面 Host、依赖、打包与 CI 均以 Electron 实现。

## 开发与构建

使用 Node 26.13+ 的 26 LTS 和 pnpm 10.15.0，从仓库根执行：

```bash
pnpm --filter gugu-desktop... --filter gugu-web install --frozen-lockfile
node apps/desktop/node_modules/electron/install.js
pnpm --dir apps/desktop dev
pnpm --filter gugu-desktop typecheck
pnpm --filter gugu-desktop test
pnpm --dir apps/desktop build
# 只生成目录包
pnpm --dir apps/desktop build -- --dir
# 源码运行的真实界面/重启回归
pnpm --dir apps/desktop smoke
# 从仓库根验证 Windows 目录包
node apps/desktop/scripts/smoke.ts --app apps/desktop/release/win-unpacked/咕咕桌面验证.exe
```

`dev` 使用工作区的增量构建产物启动 Core，界面由 Vite 热更新。仅 Core 子进程使用的代码改动时，桌面窗口保持打开；Main、Preload 或它们实际打包的共享代码改动时，Electron 自动重启。Core 重载期间，正在执行的本地请求可能中断。`scripts/package.ts` 调用 electron-builder 26.18.0，先装配并冒烟 Core，再装配应用；构建始终 `--publish never`。生成资源在 `resources/core-sidecar/`，平台制品在 `release/`，均不入 Git。

Core 制品包含固定 Node、编译后的 Core/Worker、生产依赖、许可证、版本/ABI 与逐文件摘要。Main/Preload 不加载 SQLite/MXC 原生模块，它们只在独立 Node 使用相应 ABI。运行不下载解释器或从系统 PATH 查找 Node。

`scripts/smoke.ts` 将目录包复制到仓库外的新建临时目录，隐藏窗口完成创建、重启、收据查询、导航拒绝和 Renderer 无 Node 验证；子进程 PATH 不含开发 Node/Python。显式测试目录必须有冒烟标记，不可指向用户数据。`smoke:sidecar` 也在临时副本中运行。

## 进程、数据与恢复

桌面端网络、数据和窗口设计见[桌面端架构](../../docs/architecture/desktop/README.md)。

Main 的入口、窗口、Core 通信、生命周期与更新分别位于 `index.ts`、`windows.ts`、`core-host.ts`、`lifecycle.ts`、`updater.ts`。Preload 只暴露六个业务函数，不透传通用 IPC、Shell、SQL 或 FS。每次调用校验窗口、主 frame 和随包 UI 来源；自定义 UI 协议只读取 UI 根目录，拒绝路径穿越及外部导航。

数据继续使用原 `com.gugu.desktop.preview` 位置及 `core.db` 中的稳定 owner。

桌面 Agent 的记忆正文位于文件库根目录 `Gugu-data/.agent/memories/`。长期记忆和每日记录使用 `memory.md`、`daily.md`，画像、行为模式和摘要使用对应的 JSON 文件。SQLite 继续保存聊天记录、工具回执和检索索引。浏览器开发预览在自己的数据目录下使用独立的 `Gugu-data/.agent/memories/`。

桌面 Agent 的当前时间、日期上下文和 `get_current_time` 使用运行机器的系统时区；桌面端保存的用户时区偏好及旧会话快照不覆盖机器时区。Web Host 按用户设置的时区运行，两端的时区来源有意不同。

桌面 Agent 的会话、持久 Run、恢复、记忆、联网搜索和工具注册由共享 Core 规则及 Desktop SQLite/Main 适配组成；聊天事件经具名 IPC 投影给共享 UI。普通 `ask_user` 澄清及回答恢复复用共享 UI 和 Desktop IPC。桌面不注册回收站或独立清理工具：拖入的本机文件以引用方式交给 Agent，需要清理时使用桌面 Shell，并遵循桌面独立权限策略。`user_sandbox` 授权请求不通过普通澄清工具开放，继续由 Desktop 权限策略负责。共享 `save_attachment` 支持个人、项目和当前会话绑定的本机工作区，可使用相对 `folder_path`，保留同名文件并写入本机持久回执。工作区可通过聊天命令 `/workspace list`、`/workspace <工作区ID>`、`/workspace show` 和 `/workspace unlink` 管理；绑定保存在会话上下文，不授予 Shell 权限。Web 与桌面文件操作均以用户授权的目录和相对路径为准，不依赖数据库文件夹 ID。该能力不改变本机拖入文件保持引用的语义。完整能力与回归缺口见[迁移任务清单](../../docs/refactor/Gugu-2.0-迁移任务清单.md)。

桌面 Agent 可使用共享 Core 的 `send_email` 工具。使用前需在桌面邮件页连接发件邮箱；私聊 Agent 可发送纯文本、咕咕模板或经净化的 HTML 邮件，并可附加当前消息中已授权的本机文件引用（最多 5 个，每个不超过 10 MiB、合计不超过 25 MiB）。确认绑定发件账户版本、收件人、邮件内容及附件摘要；发送尝试及结果写入持久回执，结果未知时不会自动重复投递。群聊不注册该工具。邮箱凭据留在 Electron 主进程的系统安全存储中。

`pnpm run dev` 启动 Electron 和配套 Vite，`pnpm run dev:web` 还会自动在浏览器打开共享预览。使用终端打印的共享预览地址，浏览器和 Electron 的模型、IM 绑定、聊天会话和聊天流都由同一桌面进程提供。桌面进程负责 SQLite 和系统安全存储。独立启动 Vite 时，预览使用按检出目录和端口区分的独立 SQLite 与加密凭据。

开发模式下，Vite 热更新桌面界面。桌面主进程、preload 或共享源码变更时，开发脚本重建所需制品，构建通过后关闭旧 Electron 和 Core，再在原 Vite 地址重启。重载会中断正在执行的本地任务和聊天流。构建失败时保留当前运行实例，保存修复后重新构建。

Electron 单实例和 Core SQLite 独占连接共同保护本地数据；退出/暂停先拒绝新增调用，再关闭数据进程。平台、协议/schema、版本/ABI 或摘要失配时拒绝启动。

schema 为 16。修改生成稳定操作 UUID；未知结果保留标识，不自动重放。重启后读取权威数据，或通过固定收据 API / Core CLI 查询。v1 至 v15 库须停应用后显式备份升级；旧 Python 不写 v16，回滚恢复升级前备份，见 [Core README](../../packages/core/README.md)。

v2 侧车声明 `undo_mind_v1` 时，受信桌面桥提供 Mind 撤销预览、撤销和重做；写入由调用方提供稳定操作 UUID。未声明该能力的旧侧车仍可启动，但不开放撤销。结果未知时凭 UUID 查询收据并重新读取数据；v1 不开放这些方法。桌面 Mind 正向编辑界面和其他资源的本地撤销尚未接通。

## 原生执行与发行边界

执行契约、策略与 MXC/平台适配归 `packages/sandbox/`，Core `agent/executor/` 保留兼容导出；Host 注入可信授权及后端。桌面 `sandbox/diagnostics.ts` 仅探测并显示脱敏结果，不执行任意命令或修改 ACL。可信 Core 的数据库和密钥不属于工具工作区授权。

```bash
pnpm --dir apps/desktop probe:mxc
pnpm --dir apps/desktop smoke:mxc
```

原生主动验证只操作新建合成资料，覆盖授权写入、只读/越界/网络拒绝、超时和进程终止。严格禁 UI 时 Node 初始化缺口仍存在，未放宽策略；macOS 执行 Adapter、MCP/PTY 和完整 Agent 工具链仍待后续验收。

更新状态机支持检查、下载校验、取消安装及确认后的停写退出；验证制品未配置生产更新通道。Windows 未配置正式签名，macOS 为 ad-hoc 验证签名。macOS 预览构建保留 Core 资源字节以维护摘要；正式签名/公证需统一嵌套代码签名与清单生成顺序。最低 OS 实机、Windows ARM64、干净安装/升级回滚与商业发行另行验收。最终 CI 与合并状态以 [PR #118](https://github.com/Coffeiz/Gugu-web/pull/118) 的精确提交记录为准。


## 远程账号

在桌面侧栏打开「远程账号」，填入自部署 Web Host 的根地址和账号密码。服务器需提供 HTTPS，本机回环地址可使用 HTTP。

应用保留一个当前远程会话。Electron 主进程通过系统安全存储加密令牌，重新打开远程账号页时通过服务器验证会话。选择「退出此设备」会删除桌面保存的会话。远程身份与本地工作台 SQLite 的身份分别管理。官方 SaaS 已预留登录方式，当前启用自部署登录。

### 桌面运行日志

Desktop 的本地 Agent 日志适配器和 Web Host 共用 `@gugu/log`。运行时传入适配器的 `log` 和 `diagnose` 端口后，日志写入 `userData/logs/`，常规日志按 5 MiB 轮转并保留 5 份，诊断日志按 2 MiB 轮转并保留 3 份。Electron 生命周期和 Sandbox 探测失败也使用这两个本地文件。远程 Run 的日志由执行它的 Web Host 保存。

### 本机 Telegram

在「个人设置 → 接入咕咕」填写 Bot Token 和允许的 Telegram 私聊用户 ID，保存后即可连接。桌面复用共享 IM Gateway，启用的连接随应用启动恢复，关闭应用时停止。启用前请先停止同一 Bot 在其他宿主上的连接。

凭据和收件箱通过系统凭据存储加密后保存在当前设备。收件箱按 Bot 和授权用户隔离，保留最近 100 条私聊文本，并从本机保存的游标继续拉取。点击「刷新」查看收件箱和连接状态。
