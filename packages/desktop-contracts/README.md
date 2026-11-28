# @gugu/desktop-contracts

定义 Electron 主进程、preload、renderer 和桌面开发预览之间的契约。该包把 Core 的业务桥接类型和桌面宿主能力组合起来。

| 公开入口 | API 与职责 |
| --- | --- |
| `@gugu/desktop-contracts` | `DesktopBridge` 是 renderer 使用的完整桥接类型，`DesktopAccountBridge` 定义 `remoteAccount`、`remoteLogin`、`remoteLogout` |
| `@gugu/desktop-contracts` | 文件预览、项目窗口、应用菜单的消息与方法，以及开发预览的路由映射 |
| `@gugu/desktop-contracts/file-preview` | 文件预览类型和支持范围判定 |

远程账号的登录输入与状态 DTO 由 [Auth](../auth/README.md) 定义。Desktop 主进程负责凭据存储和 IPC 实现。Core 提供桌面业务契约，其源码和依赖清单无需引用 Auth。
