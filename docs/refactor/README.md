# 重构文档索引

## Gugu 2.0：多端与 Node 迁移

只从以下入口读取当前路线，避免把历史方案当成正在实施的版本。

| 文档 | 职责 |
| --- | --- |
| [架构与迁移任务清单](Gugu-2.0-架构与迁移任务清单.md) | 唯一主文档：多端与 Electron 目标架构、目录职责、完成状态、迁移顺序及当前 T1 测试任务 |
| [Python → Node 依赖迁移矩阵](Gugu-2.0-Python-to-Node-Dependency-Migration.md) | 依赖盘点、候选库和逐项验收门槛；不单独维护整体完成状态 |
| [历史方案与验证记录](_archive/gugu-2.0/README.md) | 原多端/职责方案、Python 切片、Node 方案与桌面/MXC 实验，供追溯使用 |

当前优先任务是补齐现有 Node Core 与 Python 后端同逻辑的回归，并按 pytest 标记语义分层。任务范围、计划命令与完成条件统一维护在主文档；本次文档整合没有实施该任务或修改测试命令。

桌面目标已改为 **Electron + TypeScript Main/Preload + 独立 Node Core**，使用 `electron-builder.yml` 与 package/smoke 脚本打包验证。目录统一采用主文档 §2：Core 的 `runtime/transport/` 分离传输，`agent/executor/` 复用执行契约/策略/平台适配；Desktop 的 `sandbox/` 仅诊断，Host 注入端侧授权与原生能力。现有代码仍为 Tauri 验证实现；Electron 替换待办统一见 N2，旧 Tauri 的 CI/制品结果不视为 Electron 验收。

## 其他重构文档

目录中的 `【已完成】*.md` 保留为已交付专题记录；其他独立专题仍按各自文档维护。本次整合只处理 Gugu 2.0 多端/Core/Node 迁移文档，不改写其他重构项目的状态。
