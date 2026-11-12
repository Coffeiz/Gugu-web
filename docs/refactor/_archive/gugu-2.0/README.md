# Gugu 2.0 历史方案与验证记录

这些文档已于 2026-11-12 归档。当前架构与多端职责见[架构说明](../../Gugu-2.0-架构说明.md)，实施状态与待办见[迁移任务清单](../../Gugu-2.0-迁移任务清单.md)；[依赖矩阵](../../Gugu-2.0-Python-to-Node-Dependency-Migration.md) 保留为专题参考。

桌面当前目标已切换 Electron；归档正文中的 旧桌面壳/Rust 壳方案与 CI/实测结论保留原时点含义，不代表新壳已实现或通过验收。

| 历史文档 | 保留用途 | 阅读限制 |
| --- | --- | --- |
| [多端统一架构重构方案](Gugu-Core多端统一架构重构方案.md) | 早期依赖边界、垂直切片与运行归属推理 | 路线未定、PGlite/Python 候选和未实施状态属于旧快照 |
| [Core 与桌面端职责划分](Gugu-Core与桌面端职责划分方案.md) | 产品拓扑、平台 Port、FS/授权、同步与任务转交的详细推理 | Python 技术路线及部分推断已由主清单收敛，不单独作为当前决策 |
| [Node/TypeScript 迁移方案](Gugu-Core迁移Node与TypeScript方案.md) | 迁移接缝、事务、安全和兼容验收依据 | “Node 尚未实施”、IPC v1 和原阶段完成状态已过期 |
| [项目数据切片实现说明](Gugu-Core项目数据切片实现说明.md) | 第一批 Python 项目切片与行为基线 | 不是当前 Node 目录与运行入口 |
| [顶层包与数据统一层](Gugu-Core顶层包与数据统一层.md) | Python 项目/联系人 UoW、Web Session 接缝与对照来源 | Python 包现位于 `compat/`；不能解读为全量 DB 已统一 |
| [Core 与桌面 Node 实现记录](Gugu-Core与桌面Node迁移实现记录.md) | 首批 Node、schema v3、收据及制品验证的交付证据 | 后续质量修复和实时 checklist 见主清单及 `docs/devlog/` |
| [桌面与 MXC 验证](Gugu-Desktop与MXC验证.md) | 原生执行实测、严格 UI/Node 兼容缺口及历史桌面实验 | Python/IPC/窗口结论保留当时范围，不能替代当前 Node 制品或完整沙箱验收 |

归档保留正文及历史证据，只修正搬迁后的链接与明显已搬移的 Python 包链接。历史测试数量、未完成项及设计候选不再随当前代码更新。阅读当前方案无需依次读完这些旧稿。
