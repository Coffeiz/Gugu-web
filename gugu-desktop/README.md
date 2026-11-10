# gugu-desktop 验证版

Tauri 2 原生宿主复用 `frontend/` 中的独立桌面入口，通过私有 stdin/stdout 管道调用 Python Host，再使用顶层 `gugu-core` 操作本地 SQLite。当前可创建和查看项目、联系人，没有桌面登录或用户切换。

## 本地开发

需要 Python 3.12+、Rust stable、满足 `package.json` 的 Node，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。Windows 还需要 MSVC 构建工具和 WebView2；macOS 需要 Xcode 命令行工具。本轮没有生成安装包或打包 Python/Cython。

从仓库根安装 Python 包与现有前端依赖：

```bash
python -m pip install -e ./gugu-core -e ./gugu-desktop
pnpm --dir frontend install --frozen-lockfile
cd gugu-desktop
npm ci
npm run dev
```

应在安装上述 Python 包的虚拟环境中启动。也可由启动环境把 `GUGU_DESKTOP_PYTHON` 指向该环境解释器；应用不自动安装或下载 Python。Tauri 负责启动前端开发服务，前端源码仍在原目录。`npm run build` 构建嵌入前端的应用程序，`bundle.active=false`，不承诺可分发安装包。

数据库由原生 Host 选择应用数据目录中的 `core.db`，不从渲染进程接收路径或所有者身份。版本 1 数据库必须先停止应用，再用 Core 的显式迁移命令升级。不要用覆盖数据库的方式升级。

## 原生隔离验证

Windows 固定任务接入 MXC 1.0.1 的 process containment。界面按钮只验证应用缓存目录内的合成文件读写，不接受任意命令或路径。网络、UI 默认限制保留；主机条件不满足时明确失败，不自动调整系统 ACL 或回退为宿主执行。

独立脚本在 `gugu-desktop/` 下运行：

```bash
npm run probe:mxc
npm run smoke:mxc
# 额外对照 Node 在允许 UI 子系统、仍禁止剪贴板/注入时的兼容性
npm run smoke:mxc -- --compare-ui
```

探测不修改主机权限；隔离测试显式启动受限进程，只使用新建的 `.tools/` 临时目录和合成资料。不要以管理员权限自动准备系统权限。测试会校验允许写入、只读写入拒绝、范围外读取拒绝、环回网络阻断、超时回收和显式终止。

本轮 Windows 六项隔离测试通过。严格禁用 UI 时，Node 进程初始化失败；放开 UI 子系统的独立对照可启动。默认策略没有因此放宽，暂不把 Node/MCP stdio 或交互终端列为支持能力。

## 已验证范围

| 环境 | 已执行 | 尚未执行 |
| --- | --- | --- |
| Windows | 独立 wheel 安装、真实 Python IPC、MXC 探测与六项隔离验证 | Windows Tauri 编译/安装包、签名、完整 Agent 工具链 |
| 隔离 Linux 图形环境 | Rust 编译与能力单测；真实 Tauri 窗口创建项目，经 IPC 写入 SQLite | Linux 桌面作为发行产品；不改变 NAS/Linux 多用户宿主 |
| macOS | 尚无原生环境验证 | 编译、打包、签名、原生沙箱及 watcher |

前端组件测试、桌面入口构建与全量类型检查已通过；后端全量回归为 5529 项通过、6 项跳过。详细证据、限制和后续门槛见 [桌面与 MXC 验证记录](../docs/refactor/Gugu-Desktop与MXC验证.md)。

## 交付边界

当前是可运行的技术验证壳。只开放项目/联系人业务 IPC 和固定沙箱检查，没有通用 Shell/FS 插件，也没有 HTTP 数据服务。进程通信有版本、请求标识、长度和超时限制；通信失效后终止 Host，写入不自动重试。

尚需完成两平台自包含 Python/Cython 分发、原生沙箱适配、watcher、Agent/会话等领域接入、外部目录授权、单实例生命周期、退出恢复和升级回滚。不能据此把总方案 P1 的两平台安装包验收标为完成。
