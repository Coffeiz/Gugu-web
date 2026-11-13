# PRD-RAG-11：RAG 全量迁移到 Python/Cython（历史方案，已被替代）

> 状态：历史方案，已被 2026-11-13 的 2.0 架构决策替代。2.0 改为复用 Gugu 1.7.8 TypeScript RAG 作为 Node/Core 唯一生产检索路径；本 PRD 仅保留当时 Python/Cython 收敛方案的记录，不再作为 2.0 实施目标。新目标见 [架构说明](../refactor/Gugu-2.0-架构说明.md)、[迁移任务清单](../refactor/Gugu-2.0-迁移任务清单.md) 和 [Python → Node 依赖迁移矩阵](../refactor/Gugu-2.0-Python-to-Node-Dependency-Migration.md)。
> 创建：2026-10-29　|　更新：2026-11-04

## 目标

只保留一套 RAG 实现，结束 Python/Cython 与 TypeScript RAG 双轨维护。用户可见的召回来源、owner/scope 安全边界、会话水位、引用结构和索引可重建能力保持不变。

## 当前职责

| 部分 | 职责 |
| --- | --- |
| Python | 身份与权限校验、数据库/存储读取、来源适配、索引持久化编排、embedding HTTP 请求、最终 owner/scope 复核、引用和上下文组装 |
| Cython | 词法索引计算、BM25、混合检索与候选排序中的 CPU 密集操作 |
| Python sidecar host | 可选常驻进程；通过本机 Unix socket 管理多个服务进程共享的 Cython 索引 |
| 事实数据 | PostgreSQL 与用户存储；RAG 索引为可重建派生数据 |

TypeScript 后端中与 RAG 无关的文件同步 watcher、画布渲染等 worker 保持独立，不属于本次清理范围。

## 保持的契约

- 来源：Memory、Knowledge、项目、便签、画布、日历、定时任务和会话消息；文件库继续使用独立文件工具。
- 安全：owner/scope 授权、租户隔离、session/message 水位和引用回填不得退化；索引分数不是授权依据。
- 更新：业务事务提交后再更新派生索引；事件失败重试不能回滚业务写入。
- 恢复：revision 不匹配或快照不可用时从 canonical 业务数据重建，不自动 fallback 到其他引擎。
- 配置：统一使用 `rag_sidecar_socket`、`rag_index_ttl_seconds` 和 `rag_query_mode`；不保留 TS RAG 选择器或命令配置。

## 本次迁移范围

- 生产查询和候选排序统一使用 Cython 路径。
- 来源投影与索引缓存/快照采用唯一实现。
- 常驻 sidecar 仅保留 Cython 生命周期与 IPC。
- 清除 TS RAG worker、RAG-only contract、Data Runtime、构建脚本、启动配置和差分/worker 专属测试。
- 诊断脚本、部署文件、测试元数据和当前架构文档更新为唯一 Cython 路径。
- 保留独立文件同步 sidecar 与 TypeScript workspace 中仍被使用的通用基础设施。

## 验收清单

- [x] 从 `main` 创建独立迁移分支。
- [x] 生产查询、索引生命周期和 sidecar 不再按配置选择 TS RAG。
- [x] 清除 RAG 专属 TypeScript worker、Data Runtime、contract、构建与部署入口。
- [x] 移除依赖已删除 RAG worker 的差分测试，并保留 Cython 自身行为/安全边界测试。
- [x] 更新当前 RAG 架构文档和 TypeScript workspace 说明。
- [x] 重新生成 workspace lockfile 并核对所有残余引用。
- [x] 静态差异检查通过。
- [ ] 用户明确要求测试后，执行后端 RAG 与相关部署检查。

## 历史验证说明

2026-10 月的 Cython/TS 对照、真实性能测量和迁移阶段测试报告是当时的历史记录，不代表当前实现仍含有 TS RAG。历史报告中的文件路径、测试数量和性能结论不作为本分支的测试结果。本分支的测试尚未执行，必须在提交或合并前按用户指令另行验证。
