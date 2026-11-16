---
name: node-webui
description: gugu-webui Node.js/Fastify 后端开发、Python API 迁移与实现收敛。修改 Node WebUI 服务端代码前必须阅读。
---

# Node WebUI 开发与迁移约定

适用范围：`apps/web-host/src/` 中的 Fastify Host、领域路由、应用服务、持久化和适配器。前端改动阅读 `frontend` skill，测试设计阅读 `testing` skill；本文件不重复通用安全、Git、环境配置和测试规则。

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
| PostgreSQL 事务、唯一键错误 | `apps/web-host/src/adapters/postgres-transaction.ts`：`withPostgresTransaction`；`apps/web-host/src/adapters/postgres-errors.ts`：`isPostgresUniqueViolation` |
| 路径包含判断、owner ID 规范化、提交后 best-effort | `apps/web-host/src/adapters/path-safety.ts`：`isPathWithin`；`apps/web-host/src/adapters/owner-context.ts`：`normalizeOwnerId`；`apps/web-host/src/adapters/best-effort.ts`：`runBestEffort` |
| Cookie 解析、请求元数据 | `apps/web-host/src/http/cookies.ts`：`parseCookieHeader`；`apps/web-host/src/http/request.ts`：`writeRequestMetadata`（`limitHeaders` 用于 trim 并限制文件写入头长） |
| 日期键与 UTC 时间格式化 | `apps/web-host/src/shared/date-time.ts`：`dateKeyInTimeZone`、`addUtcDaysToDateKey`、`startOfDateKeyInTimeZone`、`toUtcIsoWithOffset` |
| Admin HTTP 错误、通用密钥遮蔽 | `apps/web-host/src/domains/admin/errors.ts`；`@gugu/core/shared/secret-mask`：`maskSecret` |
| Agent 媒体载荷清理 | `packages/core/src/agent/context/messages/`：`sanitizeMediaPayload` |
| 文件 owner 校验、正向 Undo 写入、项目查询与时间戳格式化 | `apps/web-host/src/domains/files/file-owner.ts`；`apps/web-host/src/domains/undo/persistence/forward-operation.ts`；`apps/web-host/src/domains/projects/persistence/projects.ts`：`readProjectFileCount`、`projectExistsForOwner`、`projectTimestamp` |
| 日历事件投影与持有查询 | `packages/core/src/calendar/event-projection.ts`：数据库行、DTO 与 Undo 快照投影；Core 日历读写端口执行 owner 限定查询 |
| 项目公开 DTO 与时间投影 | `packages/core/src/projects/project-projection.ts`：`projectResponse`，读写与恢复事件共同复用；`packages/core/src/shared/timestamps.ts`：严格 UTC 微秒解析，`data/codec.ts`保留兼容出口，公开 ISO 与数据库/Undo 编码分开 |
| 项目文件计数、恢复和 Undo | `packages/core/src/projects/read-store.ts`：借用 Host 池读取投影；`project-trash.ts`：同批恢复、保留期与事务补偿；`file-paths.ts`：逻辑路径和关系元数据规则；`undo.ts`：owner/版本预检、资源顺序及快照。Host 保留物理访问和 PG/旧记录兼容适配，不新增文件对象身份 |
| 文件相对引用 | `packages/core/src/files/relative-references.ts`：路径编码、逐段目录解析、scope 根和文件优先规则；Host 绑定可信 owner/scope 查询及公开 DTO，Core 不接收数据库文件 ID 作为定位依据 |
| 日历管理列表与详情 | `packages/core/src/calendar/application/event-read.ts`：`createCalendarEventReader`；`packages/core/src/calendar/read-store.ts`：实际 PG/SQLite 读取，不以管理查询代替 Agent 提醒聚合 |
| 站内全局搜索 | `packages/core/src/search/`：查询解析、来源能力、分组及实际 PG/SQLite 读端口；Host 仅注入后端，未接来源明确不可用，不能把 Web 查询公共化算作 Agent 工具或 RAG 完成 |
| 实时消息 envelope 与安全字段裁剪 | `@gugu/core/live-message`：共享业务消息校验及敏感字段裁剪；Web Host 保留认证、Redis 订阅、SSE 与账户状态复核 |
| 普通笔记生命周期 | `packages/core/src/mind/note-lifecycle.ts`：精确软删/恢复与最近gugu目标解析；`note-mutations-sql.ts`：共享CAS/Undo和借用事务，快照保留非零微秒；回执复用note-read的detail投影 |
| 画布放置与几何 | `packages/core/src/mind/canvas-layout.ts`：Python世界坐标/端点纯规则；`canvas-placement.ts`：借用事务创建canvas_note、引用和视图，复用原SQL服务，不在工具里复制数据库业务 |
| Agent画布批量编辑 | `packages/core/src/mind/canvas-edits.ts`：布局、视图移除、画布便签字段更新复用原SQL服务和外层事务；工具组持久收据与Undo共同提交，事件在提交后发布 |
| Agent画布候选和技能元数据目录 | `packages/core/src/mind/canvas-read.ts`：owner限定候选检索及旧分页探测；`packages/core/src/agent/skills/user-read.ts`：Markdown head定义和含停用项的用户Skill元数据，不使用可加载catalog替代管理目录 |
| Python 数字分类与转换 | `packages/core/src/shared/unicode-decimal.ts`：固定生产 Python 的 Unicode 16，区分 Nd 十进制和 isdigit；工具整数/日期/行号与项目编号共用，不使用 Node 较新 Unicode 属性扩大可接受输入；维护生成器为 `packages/core/scripts/generate-tool-unicode.py` |

新增稳定复用入口时，在本节补充契约与路径；删除或迁移入口时同步更新，避免清单过期。

## Python API 迁移

- Python 当前行为是兼容基线。保持认证与 owner 隔离、请求/响应 DTO、HTTP 状态及错误语义、事务顺序和提交后副作用。
- TDD 不作硬性要求；按切片验证对应 Python pytest 回归与 Node 行为/集成路径，并把结果记录到 Node API 迁移清单。只注册路由或验证未认证请求返回 401，不能单独作为业务迁移完成证据。
- 修改共享模块前检查工作区和并行会话的编辑范围；发生职责重叠时先协调并保留其他会话的未提交改动。完成通用收敛后通知相关会话复用入口和边界规则。
