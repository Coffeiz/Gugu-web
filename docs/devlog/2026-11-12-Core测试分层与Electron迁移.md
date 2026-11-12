# Core 测试分层与 Electron 迁移

## 范围与职责

本轮在 [PR #118](https://github.com/Coffeiz/Gugu-web/pull/118) 继续实现统一迁移清单的 T1 与 N2 验证切片，目标分支为 `v2.0`。Core 继续拥有领域、统一双库数据运行时及执行契约；Electron Host 装配窗口、单实例、数据目录、Node 子进程、权限与更新生命周期。旧 Tauri 源码原样保留在 `compat/desktop-tauri/`，不再参与当前构建。

## 行为与回归

- Core 的显式测试清单区分 layer、依赖 marker 和用途；unit/integration 按 pytest 同款边界划分，process/external_service 自动包含 slow。缺服务、缺 Python 参考、空选择和未登记文件直接失败，完整集合按文件去重。
- 保留首批断言，增加双库共用数据契约、42 组字段语料和 16 步跨语言维护序列。覆盖 owner 隔离、CAS、回滚、微秒/排序、归档/墓碑、联系人部分更新与 null、关闭/取消和操作收据。Python/Node 已有严格度差异分别断言，不改成表面相等。详细映射见 [测试说明](../testing/node-core-parity.md)。
- SQLite 桌面运行时独占打开；stdio 与消息端口复用协议规则。Electron Main 只接受可信主窗口和固定能力，Preload 只公开六项类型化方法；Renderer 无 Node、SQL、原生 SDK 或通用 Shell 权限。资源经固定 scheme 和路径校验加载。
- Core 单独随包 Node 26 与原生依赖，启动前验证版本、ABI、协议、schema、完整资源集合与摘要。Electron 内嵌 Node 不加载 SQLite/MXC，避免跨 ABI 使用。未知写入结果保留操作 UUID，不自动重放。
- 生命周期覆盖启动、挂起/恢复、并发关闭、失败与退出。更新默认关闭，只有配置发行通道的制品才可检查/下载，确认安装前先关闭 Core；正式签名、公证及更新发行尚待独立验收。
- 原生执行契约、授权快照和策略位于 `gugu-core/src/agent/executor/`。Host 显式注入后端与资源；缺少隔离能力时拒绝执行，破坏性操作要求确认，执行限制输出/时长并支持取消。桌面只提供诊断入口。

## 本地验证

- Core 默认回归 67 条通过，其中快速层 59 条、IPC 8 条；Python 对照 3 条通过。Core 与测试代码类型检查通过。
- Electron Host 17 条通过，类型检查通过；完整前端 983 条通过，两种类型检查与生产构建通过。
- Windows NSIS 安装制品构建通过；源码与目录制品均实际启动。目录制品整体复制到工作区外的临时目录后，移除开发 Node/Python PATH，验证创建项目/联系人、退出重启、持久化与收据、Renderer 边界和外部窗口拦截。未在真实用户目录执行安装。
- Windows 新 Core Executor 的六项原生验证通过：授权写入、只读拒写、目录外拒读、网络拒绝、超时回收和显式取消回收。
- Node 工作负载在严格 UI 隔离下仍以 `0xc0000142` 失败，未放宽 UI/网络/系统 ACL，未增加宿主回退。六项通过不能推导完整 Node/MCP/PTY 或 Agent 已可用。macOS 原生执行后端尚待实现。

## CI 与后续

Runtime integration 接入 Linux 真实 PostgreSQL/完整 Core 测试，以及 Windows、macOS arm64/x64 的 Electron 安装制品与真实应用冒烟。Docker release 保留既有完整兼容验证。最终精确提交的运行链接与结论以 PR 为准，接入流水线不等于已经通过。

当前只完成项目/联系人数据切片和桌面验证 Host。Web Session/撤销/文件联动、其他数据域、完整 Agent、同步、移动端及正式发行继续按照 [迁移清单](../refactor/Gugu-2.0-架构与迁移任务清单.md) 的后续阶段推进；没有改写用户运行配置或迁移真实数据。

## 对照文档补测

继续核查后，补充收据字段顺序/内容冲突、同 UUID 跨用户隔离、CAS 失败后同 UUID 重试三类双库契约；桌面补充真实第二 Host 拒绝/释放接管，以及真实提交后丢失回包、重启只查收据的恢复路径。具体来源、断言和层级见 [补测映射](../testing/node-core-parity.md#文档约束的补充行为回归)。原测试未删除或放宽。

本地快速层增至 62 条、桌面 Host 增至 19 条并通过类型检查；共享数据契约由 PG job 执行同样的新增行为。内容规范化规则抽样移除排序后，新回归如期失败，随后生产文件按原字节恢复。本次只补测试与映射文档，精确提交的最终双 workflow 结论仍以 PR #118 为准。
