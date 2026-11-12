# 重构文档索引

## Gugu 2.0：多端与 Node 迁移

只从以下入口读取当前路线，避免把历史方案当成正在实施的版本。

| 文档 | 职责 |
| --- | --- |
| [架构说明](Gugu-2.0-架构说明.md) | 多端与 Electron 目标架构、目录职责、依赖边界和数据约束 |
| [迁移任务清单](Gugu-2.0-迁移任务清单.md) | 当前完成状态、先迁 Web Node 后端再产品化桌面的执行顺序、验收证据与待办 |
| [Python → Node 依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md) | 依赖盘点、候选库和逐项验收门槛；不单独维护整体完成状态 |
| [历史方案与验证记录](_archive/gugu-2.0/README.md) | 原多端/职责方案、Python 切片、Node 方案与桌面/MXC 实验，供追溯使用 |

本轮已落地项目/联系人 Core 同逻辑回归和 pytest 语义分层、Electron 验证 Host 与共用 Executor 边界。具体行为及差异见 [测试对照清单](../testing/node-core-parity.md)；实现、CI 通过、合并与正式发行分别记录。

桌面目标已改为 **Electron + TypeScript Main/Preload + 独立 Node Core**，使用 `electron-builder.yml` 与 package/smoke 脚本打包验证。目录统一见[架构说明](Gugu-2.0-架构说明.md)：Core 的 `runtime/transport/` 分离传输，`agent/executor/` 复用执行契约/策略/平台适配；Desktop 的 `sandbox/` 仅诊断，Host 注入端侧授权与原生能力。当前活动实现为 Electron。平台和发行门槛见[迁移任务清单 N4](Gugu-2.0-迁移任务清单.md#n4桌面产品化与发行准备)，旧 Rust Host 的 CI/制品结果不视为 Electron 验收。

## 其他重构文档

目录中的 `【已完成】*.md` 保留为已交付专题记录；其他独立专题仍按各自文档维护。本次整合只处理 Gugu 2.0 多端/Core/Node 迁移文档，不改写其他重构项目的状态。
