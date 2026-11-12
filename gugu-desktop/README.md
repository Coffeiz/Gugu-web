# gugu-desktop：Electron / Node 验证版

Electron 45.3.1 的 TS Main/Preload 复用 `frontend/src/desktop/`，经私有 NDJSON v2 调用随包 Node 26 Core；SQLite 用例在独立 Worker 执行。桌面单用户，支持项目/联系人创建和重读，不依赖 Web 登录、系统 Node 或 Python。职责与阶段状态见 [统一任务清单](../docs/refactor/Gugu-2.0-架构与迁移任务清单.md)。

当前桌面 Host、依赖、打包与 CI 均以 Electron 实现。

## 开发与构建

使用 Node 26.13+ 的 26 LTS 和 pnpm 10.15.0，从仓库根执行：

```bash
pnpm --filter gugu-desktop... --filter gugu-web install --frozen-lockfile
node gugu-desktop/node_modules/electron/install.js
pnpm --dir gugu-desktop dev
pnpm --filter gugu-desktop typecheck
pnpm --filter gugu-desktop test
pnpm --dir gugu-desktop build
# 只生成目录包
pnpm --dir gugu-desktop build -- --dir
# 源码运行的真实界面/重启回归
pnpm --dir gugu-desktop smoke
# 从仓库根验证 Windows 目录包
node gugu-desktop/scripts/smoke.ts --app gugu-desktop/release/win-unpacked/咕咕桌面验证.exe
```

`dev` 构建 Main/Preload、Vue 与 Core 后打开应用。`scripts/package.ts` 调用 electron-builder 26.18.0，先装配并冒烟 Core，再装配应用；构建始终 `--publish never`。生成资源在 `resources/core-sidecar/`，平台制品在 `release/`，均不入 Git。

Core 制品包含固定 Node、编译后的 Core/Worker、生产依赖、许可证、版本/ABI 与逐文件摘要。Main/Preload 不加载 SQLite/MXC 原生模块，它们只在独立 Node 使用相应 ABI。运行不下载解释器或从系统 PATH 查找 Node。

`scripts/smoke.ts` 将目录包复制到仓库外的新建临时目录，隐藏窗口完成创建、重启、收据查询、导航拒绝和 Renderer 无 Node 验证；子进程 PATH 不含开发 Node/Python。显式测试目录必须有冒烟标记，不可指向用户数据。`smoke:sidecar` 也在临时副本中运行。

## 进程、数据与恢复

Main 的入口、窗口、Core 通信、生命周期与更新分别位于 `index.ts`、`windows.ts`、`core-host.ts`、`lifecycle.ts`、`updater.ts`。Preload 只暴露六个业务函数，不透传通用 IPC、Shell、SQL 或 FS。每次调用校验窗口、主 frame 和随包 UI 来源；自定义 UI 协议只读取 UI 根目录，拒绝路径穿越及外部导航。

数据继续使用原 `com.gugu.desktop.preview` 位置及 `core.db` 中的稳定 owner。Electron 单实例和 Core SQLite 独占连接共同保护本地数据；退出/暂停先拒绝新增调用，再关闭数据进程。平台、协议/schema、版本/ABI 或摘要失配时拒绝启动。

schema 仍为 3。修改生成稳定操作 UUID；未知结果保留标识，不自动重放。重启后读取权威数据，或通过固定收据 API / Core CLI 查询。v1/v2 库仍须停应用后显式备份升级；旧 Python 不写 v3，回滚恢复升级前备份，见 [Core README](../gugu-core/README.md)。

## 原生执行与发行边界

执行契约、策略与 MXC/平台适配归 Core `agent/executor/`；Host 注入可信授权及后端。桌面 `sandbox/diagnostics.ts` 仅探测并显示脱敏结果，不执行任意命令或修改 ACL。可信 Core 的数据库和密钥不属于工具工作区授权。

```bash
pnpm --dir gugu-desktop probe:mxc
pnpm --dir gugu-desktop smoke:mxc
```

原生主动验证只操作新建合成资料，覆盖授权写入、只读/越界/网络拒绝、超时和进程终止。严格禁 UI 时 Node 初始化缺口仍存在，未放宽策略；macOS 执行 Adapter、MCP/PTY 和完整 Agent 工具链仍待后续验收。

更新状态机支持检查、下载校验、取消安装及确认后的停写退出；验证制品未配置生产更新通道。Windows 未配置正式签名，macOS 为 ad-hoc 验证签名。macOS 预览构建保留 Core 资源字节以维护摘要；正式签名/公证需统一嵌套代码签名与清单生成顺序。最低 OS 实机、Windows ARM64、干净安装/升级回滚与商业发行另行验收。最终 CI 与合并状态以 [PR #118](https://github.com/Coffeiz/Gugu-web/pull/118) 的精确提交记录为准。
