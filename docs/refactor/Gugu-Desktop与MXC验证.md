# 桌面壳与 MXC 验证记录

> 本轮同时交付桌面壳和 MXC 验证；目标平台仍是 Windows/macOS。Linux 图形环境用于验证真实窗口与 IPC，不改变 Linux/NAS 保留多用户的产品决定。

## 1. 已实现链路

```text
frontend/desktop.html + Vue 工作台
    → Tauri Rust Host：白名单业务 IPC、进程生命周期
    → 私有 stdin/stdout NDJSON v1
    → gugu_desktop_host：固定本地身份、Core 装配
    → gugu-core：项目/联系人用例、数据事务
    → SQLite

Tauri Rust Host → MXC 1.0.1 → 固定合成文件任务
```

`gugu-desktop/` 是独立宿主目录，前端仍留在 `frontend/`，没有提前拆成新前端工程。Core 不导入桌面包。Python Host 是单独 wheel，只依赖 Core；实际在不含 Web/FastAPI/Redis 的新环境中安装并验证了 IPC 写入。

窗口不接收 SQL、数据库路径、所有者 UUID 或任意执行命令。Host 选择应用数据目录，Python 保存唯一的本地身份。进程协议校验版本、能力、请求标识和帧长度；Rust 串行访问一个子进程，15 秒通信超时后终止，不自动重试写操作。应用没有注册通用 Shell/FS 插件、远端页面或数据 HTTP 服务。

沙箱检查与数据查询分开：数据库由 Core 直接通过驱动访问；执行隔离只负责受限子进程。沙箱固定任务不会获得数据库或用户文件目录。

## 2. MXC 选择与实际证据

固定 SDK 为 [Microsoft MXC 1.0.1](https://github.com/microsoft/mxc/releases/tag/v1.0.1)，分别使用 Rust v1 API 和 Node v1 API。Windows 探测得到 `processcontainer` 可用、tier 为 `base-container`、不需要 DACL augmentation，未自动执行主机权限准备。只验收 process 路线，没有启用 Hyperlight 或 IsolationSession。

Node SDK 要求受支持的 Node 版本，测试使用满足要求且通过官方校验和核验的独立运行时；没有更改系统 Node。脚本只输出受控结果和能力字段，不输出本机路径或原始异常。

| 验证 | 实际结果 | 防止误判的控制 |
| --- | --- | --- |
| 授权目录读写 | 通过，输出内容一致 | 先验证受限进程可正常运行 |
| 只读目录写入 | 拒绝，没有创建文件 | 使用新建合成文件目录 |
| 范围外读取 | 拒绝，没有泄漏合成标记 | 范围外也是本次新建的测试资料 |
| 环回网络 | 拒绝，监听端收到 0 次连接 | 同一策略下先验证 curl 可启动；请求未超时 |
| 超时回收 | 通过，启动后命中超时 | 校验子进程已输出启动标记 |
| 显式终止 | 通过，等待结束后进程不存在 | 固定忙循环，主动 kill 后检查进程 |

严格禁用 UI 时，Node 在输出启动标记前退出，状态为 `0xC0000142`（`STATUS_DLL_INIT_FAILED`）。这属于负载启动兼容性问题，不能作为网络隔离成功的证据。因此网络验证使用有正向启动控制的系统 curl，结果为退出码 7、无超时、主机连接计数 0。

增加显式 `--compare-ui` 对照后，仅把 UI 子系统改为允许，剪贴板和注入仍禁止、文件和网络范围保持不变；Node 输出标记并以 0 退出。可据此判断严格 UI 限制与该负载的启动兼容性相关，尚不足以证明所有 Node/MCP stdio 负载都可安全运行。产品默认策略没有放宽，没有自动重试为允许 UI 的配置。

结论：MXC 可继续作为 Windows 原生执行 Adapter 候选；本轮已验证文件范围、网络拒绝和进程回收。Node/MCP、PTY、Python/Cython 工具负载、公共资源可读面以及不同 Windows 版本仍须逐项验收，不能宣布它已替代所有执行后端。macOS Adapter 仍待真实平台验证。

## 3. 桌面与数据回归

| 检查 | 实际结果 |
| --- | --- |
| 后端全量 pytest | 5529 通过、6 跳过；在隔离 Linux 测试环境运行，包含真实 PostgreSQL 数据契约 |
| 独立 Core/IPC（Windows） | 23 通过、2 个 PostgreSQL 测试跳过；PostgreSQL 在上述 Linux 环境验证 |
| 桌面 Vue 组件 | 2 通过：创建后刷新、无原生桥时释放忙状态；校验不调用 fetch |
| 前端类型与桌面构建 | `pnpm typecheck`、`pnpm build:desktop` 通过 |
| Rust | `cargo test --no-default-features` 通过；完整 Tauri `cargo check`、嵌入前端的 `cargo build --features custom-protocol` 通过 |
| 真实窗口 | 隔离 Linux 图形会话中，输入中文项目名并提交，经过 Vue → Rust → Python → SQLite，数据库存在相同名称和初始版本 |
| 包制品 | Core、Desktop Host wheel 构建通过，在独立环境安装后经 IPC 创建项目 |
| 安全与语法 | 所有者过滤、confirm 门、测试元数据、依赖边界、compileall、Shell 语法和 diff 空白检查通过 |
| 开发 Compose | 使用独立空环境文件并禁用 service env 解析，`config --quiet` 通过 |

图形验证使用真实 Tauri/WebKit 窗口和软件渲染，没有禁用 WebKit 沙箱。窗口标题的测试定位曾受临时会话编码影响，改用窗口类名定位后完成验证；未修改应用逻辑规避错误。构建和测试仅使用隔离配置，不读取或覆盖用户运行配置。

本轮没有 Windows Rust/MSVC 构建环境或 macOS 原生环境，因此没有执行 Windows/macOS Tauri 二进制、安装、签名和原生发布验证，devserver 也未验收。用户后续已授权运行 `Runtime integration` 和 `Docker release`；CI 结论以 [PR #116](https://github.com/Coffeiz/Gugu-web/pull/116) 正文所列同一最新提交的运行结果为准。

首次 CI 的全站表单规范检查发现桌面输入标题使用了 `label for`，已改为非交互标题加 `aria-labelledby`，并复用公共 `.form-input` 样式。原有规范测试未改断言；桌面组件与全站标题规范定向回归合计 3 项通过。详见 [CI 修复记录](../devlog/2026-11-11-桌面表单CI规范修复.md)。

## 4. 后续验收门槛

- 两平台自包含 Python/Cython 制品、签名/公证、安装升级与故障恢复；无需用户手动安装解释器。
- MXC 负载矩阵及 macOS 原生 Adapter；PTY、取消、输出背压、进程树回收和权限边界。
- 平台 watcher 与目录授权；不因数据层完成而授予通用 FS。
- 单实例、退出与重启、多窗口、休眠及版本兼容；当前只验证单窗口单 Host 链路。
- Agent、会话/消息和其他领域逐域接入统一数据底座；任务转交和同步另行验收。

## 5. 参考资料

- [MXC Node SDK](https://github.com/microsoft/mxc/blob/v1.0.1/sdk/node/README.md)
- [MXC Rust v1 API](https://github.com/microsoft/mxc/blob/v1.0.1/docs/api-reference/rust/v1/api.md)、[类型与策略](https://github.com/microsoft/mxc/blob/v1.0.1/docs/api-reference/rust/v1/types.md)
- [Windows MXC 快速开始](https://learn.microsoft.com/en-us/windows/apps/develop/mxc/quickstart)
- [Windows NTSTATUS 定义](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)
- [Tauri 平台构建依赖](https://v2.tauri.app/start/prerequisites/)
