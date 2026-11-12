# Core 与桌面 Node 首批迁移实现

> **历史归档（2026-11-12）**：当前架构、完成状态和任务统一见 [架构与迁移任务清单](../../Gugu-2.0-架构与迁移任务清单.md)。
> 本文保留原时点的设计/实现/验证，不维护实时状态；正文中的旧技术路线和待办不能作为当前实施依据。

> 日期：2026-11-11。范围按用户确认的 N0–N2 首批切片执行：已有 Core 数据能力与桌面 Host。Web、Agent、RAG 等按后续阶段迁移。
> 方案：[Node/TS 迁移方案](Gugu-Core迁移Node与TypeScript方案.md)。输入清单：[全量依赖迁移矩阵](../../Gugu-2.0-Python-to-Node-Dependency-Migration.md)。

## 本轮落地

- 顶层 `gugu-core/` 现为 `@gugu/core` TypeScript 包，严格类型、编译后 ESM 与声明；领域/契约禁止 Node/SQL/Host 依赖。当前实现项目、联系人、跨域事务及两库适配。
- 选定 Kysely 0.29.8，SQLite 使用 better-sqlite3 13.0.3，PostgreSQL 使用 pg 8.23.1，边界校验使用 Zod 4.6.7。只引入本切片实际使用的依赖；原依赖矩阵中的 Fastify、Redis/调度、Provider/MCP、媒体和 Office 等继续标为后续候选。
- SQLite 用专属 Worker、有界队列、独占事务和跨线程取消标志；不把每条 SQL 当 RPC。保留用户隔离、版本 CAS、归档/墓碑过滤、UTC 微秒、旧列名与阶段/待办身份。
- 桌面 Rust Host 启动随包 Node，协议、制品平台/架构、版本和摘要不匹配时拒绝；不依赖 Python 或系统 PATH，不把执行能力开放给 Vue。单实例保护本地数据 Host。
- 制品含实际生产依赖、Node/包许可证及依赖/摘要清单；装配与独立冒烟脚本均只使用生成目录和合成测试库。
- 原 Python Core 与 Desktop Host 完整保留在 `compat/core-python/`、`compat/desktop-python/`；Web/NAS、原有测试、Docker、Compose 和手动安装路径同步指向兼容包。
- 源码开发/CI 和 Node 构建层统一到 Node 26 LTS，固定 pnpm 10.15.0；Node 26 不自带 Corepack，调用链显式安装并使用 pnpm。Web 生产路径仍是兼容实现，不声称整站已改为 Node。

## 根据依赖矩阵增加的持久写入收据

原桌面 v1 只能在超时后重读数据。为处理“已提交但回包丢失”，正式 Node 桌面改用 **NDJSON v2 + SQLite schema v3**，这是新增持久能力带来的显式版本变化：

1. Rust 为写操作生成稳定 UUID `operation_id`，Node 要求修改命令带有效标识。
2. 业务写入与 `core_operation_receipts` 在同一个数据库事务内提交；收据按 owner 和操作 ID 隔离。
3. 同标识、同方法/参数返回已提交结果；同标识不同内容冲突，不再次写入。
4. `operations.get` 支持重启后查询；通信失效不自动重放修改。提交状态未知时显示操作标识，要求重启后查询/重读。
5. v1 仅保留为明确的参考协议；旧 v2 数据文件仅在显式 legacy 数据模式中用于互读验证，不能冒充有收据能力。

本地新库先在同目录构建完整文件，再用不覆盖目标的方式发布，避免半初始化库被当作完成。已有 v1/v2 库必须停应用后显式 migrate：持有写锁、独立一致性备份、验证完整性、事务性建表/推进版本；失败保留原库和备份。备份转换为独立 DELETE-journal 文件，不依赖 WAL/SHM 副文件。

旧 Python 不能直接打开 v3，回滚应停止新版、恢复升级前备份并使用匹配代码。不会创建、重写或覆盖用户 Web 运行配置。

## 行为与兼容处理

正常行为由同一份合成语料同时驱动 Python 与 TS。已验证 Python v2 → Node 更新 → Python 重读，保留 owner、数据和版本；显式升级生成的 v2 备份也可由旧包完整重读。

原实现的意外宽松行为没有作为新接口保证：TS 不接受布尔值作进度，不接受非布尔归档值，并在写入前检查名称/联系人/当前阶段的列长度边界。长度按 Unicode 码点；不对联系人名称额外 trim。读取非法数据类型/日期明确失败，不通过自动转换掩盖损坏。

Web 继续借用原 Python Session，保留同事务撤销、幂等、文件联动与提交后事件。没有把项目 Node commit 和 Python undo commit 拆成两个事务，也不对同一部署写域双写。真实 Web 写路径切换仍是 N3。

## 验证与验收范围

本地已运行的验证包括：Node 严格编译与领域/真实 SQLite/Worker/进程测试；真实隔离 PostgreSQL 契约；Python/TS 同语料差分与文件库互读；原 Python Core 回归；Windows 与 Linux 自包含资源冒烟；Rust 与随包 Node 真实管道的创建及重启读回。具体最终数量与精确提交的 CI 结果以本 PR 正文为准，不把中间提交的绿灯当作最终结论。

Runtime integration 增加专用 Core/Golden/PG job，以及 Windows x64、macOS arm64/x64 桌面矩阵，检查原生 Rust IPC、制品独立运行和 Tauri 构建；macOS 额外检查 app 内的 Node 资源。保留既有前后端/Runtime/LoopScope/E2E 和 Docker release 的构建与安全扫描。

首轮 CI 发现 Node 26 的全局 Web Storage 遮蔽了 Vitest 4 的 jsdom 存储。前端测试进程显式关闭 Node 的实验性 Web Storage，让 jsdom 提供按页面隔离的真实实现；保留主题、缩放、会话等原有持久化和不可用路径断言。问题机制见 [Vitest 上游记录](https://github.com/vitest-dev/vitest/issues/10867)，没有为恢复绿色删除或放宽测试。

平台制品为验证用途。正式 Apple Developer ID/公证、Windows Authenticode、Windows ARM64、最低 OS 实机、完整 Agent 工具链尚须发行验收。当前 macOS 使用 ad-hoc 签名；不把它描述为正式签名发行版。

Windows MXC 仍沿用原生 Rust Adapter。可信 Node Core 在执行沙箱外访问自己的数据库；不可信 Node/MCP/PTY 仍需单独验证。此前严格 UI 策略下 Node 负载初始化失败的缺口没有因 Core 迁移而消失，也没有自动放宽隔离。

## 后续项

Web 完整事务及 Alembic 历史交接、会话/Job/调度、Agent/Provider/IM、RAG/记忆、媒体/Office 与同步仍按全量依赖矩阵推进。当前生产 Python 依赖保留有真实调用方，不能删除依赖表中尚未迁移的包来制造“已无 Python”的表象。

后续将持久调度、确认授权和其他业务域接入同一数据底座，再清空兼容包调用方。SaaS 保留多用户并长期只负责数据与同步，FS/执行继续由各 Host 的授权端口提供。
