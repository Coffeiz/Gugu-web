# gugu-desktop Node 验证版

Tauri 2 / Rust Host 复用 `frontend/` 的桌面入口，通过私有 NDJSON v2 调用随包 Node Core，SQLite Worker 执行业务事务。桌面单用户，可创建和查看项目、联系人；没有登录或账户切换。

## 开发与构建

需要 Node 26.13+ 的 26 LTS、pnpm 10.15.0、Rust stable 和 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。Windows 需要 MSVC/WebView2，macOS 最低目标为 13.5。源码构建从仓库根执行：

```bash
pnpm --filter gugu-desktop... --filter gugu-web install --frozen-lockfile
pnpm --dir gugu-desktop run dev
```

Tauri 钩子先装配独立 Node 制品，再启动/构建现有 Vue 桌面入口。发布程序使用应用资源中的 Node，不依赖系统 PATH，不下载解释器，不读取 `GUGU_DESKTOP_PYTHON`。Rust 校验平台/架构、协议/schema 及逐文件摘要，失配时拒绝启动。

```bash
pnpm --dir gugu-desktop run prepare:sidecar
pnpm --dir gugu-desktop run smoke:sidecar
# Windows 安装制品
pnpm --dir gugu-desktop exec tauri build --bundles nsis
# macOS app（当前为 ad-hoc 验证签名）
pnpm --dir gugu-desktop exec tauri build --bundles app
```

生成资源位于 `src-tauri/resources/core-sidecar/`，包含固定 Node、编译后的 Core/Worker、生产依赖、Node/包许可证和完整性/依赖清单；不提交 Git。制品冒烟在新建临时目录中运行，不依赖开发 node_modules 或 Python，并验证创建、重启与收据查询。Rust IPC 回归要求显式设置 `GUGU_DESKTOP_TEST_SIDECAR` 为本轮生成资源目录，再运行 `cargo test --no-default-features`。

## 数据与升级

Rust 选择应用数据目录中的 `core.db`，不从渲染进程接收路径、身份或任意命令。单实例插件避免多个桌面进程抢占同一个数据 Host。

新库为 schema 3，业务写入带稳定操作 ID；结果丢失后可调用 `operations.get` 或 Core CLI 的 `receipt` 查询，不重新创建。Rust 通信中断后显示操作标识并停止写入，重启后读取数据库。数据进程和管道有长度、队列和超时上限。

原 Python 验证版的 v1/v2 库需要停应用后，用 Core CLI 显式 `migrate`：先校验备份、再升级。旧版本不能直接写 v3；回滚恢复升级前备份。不会自动升级或覆盖用户库，见 [Core README](../gugu-core/README.md)。

## 原生执行与平台验证

原生沙箱仍由 Rust Broker 提供。Windows 固定任务复用 MXC 1.0.1，只操作应用缓存中的合成文件；不接受 UI 任意 Shell/FS 请求，不自动调整 ACL，不回退宿主执行。

```bash
pnpm --dir gugu-desktop run probe:mxc
pnpm --dir gugu-desktop run smoke:mxc -- --compare-ui
```

可信 Node Core 在沙箱外访问自己的数据库；不可信脚本、MCP、PTY 必须走执行端口。此前严格禁用 UI 时的 MXC Node 初始化兼容问题仍未解除，默认策略未放宽。

本轮验证范围见 [实现记录](../docs/refactor/Gugu-Core与桌面Node迁移实现记录.md)。CI 覆盖 Windows x64、macOS arm64/x64 的 Node/原生 Host 与平台构建；正式 Developer ID/Authenticode、Apple 公证、Windows ARM64、目标最低 OS 实机及完整 Agent 工具链另行验收。当前 ad-hoc/未签名验收制品不等于商业发行版。
