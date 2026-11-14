---
name: node-webui
description: gugu-webui Node.js/Fastify 后端开发、Python API 迁移与实现收敛。修改 Node WebUI 服务端代码前必须阅读。
---

# Node WebUI 开发与迁移约定

适用范围：`gugu-webui/src/` 中的 Fastify Host、领域路由、应用服务、持久化和适配器。前端改动阅读 `frontend` skill，测试设计阅读 `testing` skill；本文件不重复通用安全、Git、环境配置和测试规则。

## 路由与业务边界

- 按业务域组织 Fastify 路由插件；认证由共用 Hook 建立已验证身份上下文，参数与 DTO 使用项目现有 Schema/Zod 契约，Core 错误通过统一 HTTP 映射返回。
- Fastify 负责 HTTP 接线、认证接入和协议映射；业务授权、ownership、事务边界和领域错误由应用/领域层决定。
- Store/Repository 按业务域组织。简单 CRUD 与同一事务内的读写放在同一领域持久化模块，不按每条 API 新建 `postgres.ts`。文件系统与数据库协调、Undo/CAS、租约/并发、提交后事件等具有独立生命周期的流程可以单独拆分。

## 重复逻辑收敛

- 先阅读重复实现、调用方、错误语义、事务顺序和数据隔离，再决定是否共用。静态克隆扫描用于发现候选；相似名字或相似 SQL 不足以证明领域语义相同。
- 只抽取至少两个调用方确实共享的稳定契约。保留各领域的权限、key 校验、业务错误映射、符号链接策略和不同的失败语义；避免单调用包装、动态拼 SQL 的通用层及为了减少行数而合并生命周期不同的操作。
- 优先复用以下现有模块，不重复实现同一契约：

| 契约 | 复用入口 |
|---|---|
| PostgreSQL 事务、唯一键错误 | `gugu-webui/src/adapters/postgres-transaction.ts`：`withPostgresTransaction`；`gugu-webui/src/adapters/postgres-errors.ts`：`isPostgresUniqueViolation` |
| 路径包含判断、owner ID 规范化、提交后 best-effort | `gugu-webui/src/adapters/path-safety.ts`：`isPathWithin`；`gugu-webui/src/adapters/owner-context.ts`：`normalizeOwnerId`；`gugu-webui/src/adapters/best-effort.ts`：`runBestEffort` |
| Cookie 解析、请求元数据 | `gugu-webui/src/http/cookies.ts`：`parseCookieHeader`；`gugu-webui/src/http/request.ts`：`writeRequestMetadata`（`limitHeaders` 用于 trim 并限制文件写入头长） |
| 日期键与 UTC 时间格式化 | `gugu-webui/src/shared/date-time.ts`：`dateKeyInTimeZone`、`addUtcDaysToDateKey`、`startOfDateKeyInTimeZone`、`toUtcIsoWithOffset` |
| Admin HTTP 错误、通用密钥遮蔽 | `gugu-webui/src/domains/admin/errors.ts`；`gugu-webui/src/shared/secret-mask.ts`：`maskSecret` |
| Agent 媒体载荷清理 | `gugu-webui/src/domains/agent-sessions/media-payload.ts`：`sanitizeMediaPayload` |
| 文件 owner 校验、正向 Undo 写入、项目查询与时间戳格式化 | `gugu-webui/src/domains/files/file-owner.ts`；`gugu-webui/src/domains/undo/persistence/forward-operation.ts`；`gugu-webui/src/domains/projects/persistence/projects.ts`：`readProjectFileCount`、`projectExistsForOwner`、`projectTimestamp` |
| 日历事件投影与持有查询 | `gugu-webui/src/domains/calendar/event-projection.ts`：数据库行、DTO 与 Undo 快照投影；`gugu-webui/src/domains/calendar/persistence/events.ts`：`findOwnedActiveEvent` |

新增稳定复用入口时，在本节补充契约与路径；删除或迁移入口时同步更新，避免清单过期。

## Python API 迁移

- Python 当前行为是兼容基线。保持认证与 owner 隔离、请求/响应 DTO、HTTP 状态及错误语义、事务顺序和提交后副作用。
- TDD 不作硬性要求；按切片验证对应 Python pytest 回归与 Node 行为/集成路径，并把结果记录到 Node API 迁移清单。只注册路由或验证未认证请求返回 401，不能单独作为业务迁移完成证据。
- 修改共享模块前检查工作区和并行会话的编辑范围；发生职责重叠时先协调并保留其他会话的未提交改动。完成通用收敛后通知相关会话复用入口和边界规则。
