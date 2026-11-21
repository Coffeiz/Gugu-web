---
name: node-webui
description: Node.js/Fastify Web Host 与共享后端开发约定，涵盖 Core、Database、Gateway 和 Desktop/Web Host 适配。修改后端代码前必须阅读。
---

# Node 后端开发约定

适用范围：`apps/web-host/src/` 中的 Fastify Host、领域路由、应用服务、持久化和适配器。前端改动阅读 `frontend` skill，测试设计阅读 `testing` skill；本文件不重复通用安全、Git、环境配置和测试规则。

## 开发监听

日常开发使用 `corepack pnpm --filter @gugu/webui dev`。开发监听首次启动和依赖声明变更时按锁文件安装，按依赖顺序增量编译共享包，随后检查 Web Host 类型及模块导入。检查通过后才正常停止旧 Host 并启动新进程。检查失败时保留已运行的 Host，等待下一次源码变更。不要另启 Node 或 TypeScript 的独立监听绕开上述顺序。


数据库结构变更集中在 `packages/database/`。Web Host 用 `pnpm --filter @gugu/webui migrate check|apply`，Desktop SQLite 用 `pnpm --filter @gugu/core migrate check|apply --database "<数据库文件>"`。编号和数据库要求见该目录 README。

## 路由与业务边界

- `src/main.ts` 接进程生命周期，`src/startup/` 装配运行时与后台任务，`src/app.ts` 装配 Fastify。新增业务路由在所属模块注册，模块内文件优先按职责使用短名。

- 按业务域组织 Fastify 路由插件；认证由共用 Hook 建立已验证身份上下文，参数与 DTO 使用项目现有 Schema/Zod 契约，Core 错误通过统一 HTTP 映射返回。
- Fastify 负责 HTTP 接线、认证接入和协议映射；业务授权、ownership、事务边界和领域错误由应用/领域层决定。
- Store/Repository 按业务域组织。简单 CRUD 与同一事务内的读写放在同一领域持久化模块，不按每条 API 新建 `postgres.ts`。文件系统与数据库协调、Undo/CAS、租约/并发、提交后事件等具有独立生命周期的流程可以单独拆分。

## 重复逻辑收敛

- 先阅读重复实现、调用方、错误语义、事务顺序和数据隔离，再决定是否共用。静态克隆扫描用于发现候选；相似名字或相似 SQL 不足以证明领域语义相同。
- 只抽取至少两个调用方确实共享的稳定契约。保留各领域的权限、key 校验、业务错误映射、符号链接策略和不同的失败语义；避免单调用包装、动态拼 SQL 的通用层及为了减少行数而合并生命周期不同的操作。
- 优先复用以下现有模块，不重复实现同一契约：

| 契约 | 复用入口 |
|---|---|
| PostgreSQL 事务、唯一键错误 | `apps/web-host/src/adapters/database/postgres-transaction.ts`：`withPostgresTransaction`；`apps/web-host/src/adapters/database/postgres-errors.ts`：`isPostgresUniqueViolation` |
| 路径包含判断、owner ID 规范化、提交后 best-effort | `apps/web-host/src/shared/path-safety.ts`：`isPathWithin`；`apps/web-host/src/shared/owner-context.ts`：`normalizeOwnerId`；`apps/web-host/src/shared/best-effort.ts`：`runBestEffort` |
| Cookie 解析、请求元数据 | `apps/web-host/src/http/cookies.ts`：`parseCookieHeader`；`apps/web-host/src/http/request.ts`：`writeRequestMetadata`（`limitHeaders` 用于 trim 并限制文件写入头长） |
| 日期键与 UTC 时间格式化 | `apps/web-host/src/shared/date-time.ts`：`dateKeyInTimeZone`、`addUtcDaysToDateKey`、`startOfDateKeyInTimeZone`、`toUtcIsoWithOffset` |
| Admin HTTP 错误、通用密钥遮蔽 | `apps/web-host/src/modules/admin/errors.ts`；`@gugu/core/shared/secret-mask`：`maskSecret` |
| Agent 媒体载荷清理 | `packages/core/src/agent/context/messages/`：`sanitizeMediaPayload` |
| Agent 持久 Run 与交互 | `@gugu/core/agent` 提供 `createAgentRunReconstructor` 和 `createAgentRunEventStream`，持久动作消费使用 `@gugu/core/agent/interactions/consume-action`。Host 提供可信来源和身份、owner 查询、事务、租约及唤醒端口。 |
| 文件 owner 校验、正向 Undo 写入、项目查询与时间戳格式化 | `apps/web-host/src/modules/files/store.ts`；`apps/web-host/src/modules/undo/record.ts`；`apps/web-host/src/modules/projects/store.ts`：`readProjectFileCount`、`projectExistsForOwner`、`projectTimestamp` |
| 日历事件投影与持有查询 | `packages/core/src/calendar/event-projection.ts`：数据库行、DTO 与 Undo 快照投影；Core 日历读写端口执行 owner 限定查询 |
| 项目公开 DTO 与时间投影 | `packages/core/src/projects/project-projection.ts`：`projectResponse`，读写与恢复事件共同复用；`packages/core/src/shared/timestamps.ts`：严格 UTC 微秒解析，`data/codec.ts`保留兼容出口，公开 ISO 与数据库/Undo 编码分开 |
| 项目文件计数、恢复和 Undo | `packages/core/src/projects/read-store.ts`：借用 Host 池读取投影；`project-trash.ts`：同批恢复、保留期与事务补偿；`file-paths.ts`：逻辑路径和关系元数据规则；`undo.ts`：owner/版本预检、资源顺序及快照。Host 保留物理访问和 PG/旧记录兼容适配，不新增文件对象身份 |
| 文件相对引用 | `packages/core/src/files/relative-references.ts`：路径编码、逐段目录解析、scope 根和文件优先规则；Host 绑定可信 owner/scope 查询及公开 DTO，Core 不接收数据库文件 ID 作为定位依据 |
| 日历管理列表与详情 | `packages/core/src/calendar/application/event-read.ts`：`createCalendarEventReader`；`packages/core/src/calendar/read-store.ts`：实际 PG/SQLite 读取，不以管理查询代替 Agent 提醒聚合 |
| 站内全局搜索 | `packages/core/src/search/`：查询解析、来源能力、分组及实际 PG/SQLite 读端口；Host 仅注入后端，未接来源明确不可用，不能把 Web 查询公共化算作 Agent 工具或 RAG 完成 |
| 实时消息 envelope 与安全字段裁剪 | `@gugu/core/live-message`：共享业务消息校验及敏感字段裁剪；Web Host 保留认证、Redis 订阅、SSE 与账户状态复核 |
| 普通笔记生命周期 | `packages/core/src/mind/note-lifecycle.ts`：精确软删/恢复与最近gugu目标解析；`note-mutations-sql.ts`：共享CAS/Undo和借用事务，快照保留非零微秒；回执复用note-read的detail投影 |
| 画布放置与几何 | `packages/core/src/mind/canvas-layout.ts`：世界坐标/端点纯规则；`canvas-placement.ts`：借用事务创建canvas_note、引用和视图，复用原SQL服务，不在工具里复制数据库业务 |
| Agent画布批量编辑 | `packages/core/src/mind/canvas-edits.ts`：布局、视图移除、画布便签字段更新复用原SQL服务和外层事务；工具组持久收据与Undo共同提交，事件在提交后发布 |
| Agent画布候选和技能元数据目录 | `packages/core/src/mind/canvas-read.ts`：owner限定候选检索及旧分页探测；`packages/core/src/agent/skills/user-read.ts`：Markdown head定义和含停用项的用户Skill元数据，不使用可加载catalog替代管理目录 |
| 用户 Skill 写入 | `packages/core/src/agent/skills/user-management.ts` 的准备端口供 Agent 把共享写入纳入 Run 收据事务，REST 使用同一管理器的创建和更新入口。Host 提供当前租约的事务内授权及提交后通知。 |
| Unicode 数字分类与转换 | `packages/core/src/shared/unicode-decimal.ts`：固定 Unicode 16 分类，区分 Nd 十进制和更宽泛的数字字符；工具整数/日期/行号与项目编号共用，不使用 Node 较新 Unicode 属性扩大可接受输入；Python 格式的代码生成脚本仅为维护工具，不是运行依赖 |

| IM 身份与入站规则 | `packages/core/src/im/access.ts`、`inbound-preflight.ts`、`inbound-batch.ts`、`shortcut.ts`：可信 Bot 对照后的角色/工具/上下文、控制消息优先、批次排序和快捷意图；Host 必须提供当前权限、冻结的取消目标和真实消费事务，不能把纯规则当认证 |
| IM 上下文、引用与检索 | `apps/web-host/src/modules/im/gateway/context-services.ts`、`context-reference-codec.ts`、`memory-search.ts`、`group-context.ts`：真实业务来源、附件归属、当前Run租约及群/记忆scope；检索Schema与执行复用同一ToolRegistry，成员白名单不能因端口可用而扩大 |
| IM 注意力与成功送达 | `packages/core/src/im/attention/directive.ts`、`im/run-delivery.ts`：冻结决策/回复门与可携带证据的投递契约；Host `attention-runtime.ts`、`pending-ask-dispatch.ts`、`attention-ledger.ts` 提供真实覆盖/当前策略/内部唤醒/原子accepted事实，不能用assistant历史、入站布尔或缺失Redis证明补齐 |
| IM 持久流式 | `gateway/platforms/feishu/persistent.ts`、`platforms/qq/persistent.ts`、`platforms/telegram/persistent.ts` 共用Run投递器及 `delivery/store.ts` 平台独立加密/CAS；QQ只用可信Markdown＋开关，不能在旧正文/流收据未决时切换发送器。TG draft不等同最终送达，保活与外层收据SQL共用FIFO，Host在释放投递租约前close排空。未知副作用不重发；投递表由统一数据库迁移显式创建，启动仅检查 |
| IM 即时反馈与成员恢复 | Core `im/shortcut.ts` 即时表情及 `im/access.ts` 展示策略；Host `connections.ts` 只在新鲜永久准入后反馈，QQ附件按可信群策略/格式与Bot目标冷却，失败不吞消息。`production-reflection-bindings.ts:rebuildMemberSnapshot` 仅从真实owned checkpoint按原member scope恢复，公开group无快照仍defer，不能借owner权限 |
| Web / IM Provider 配置 | `apps/web-host/src/modules/agent/llm/settings.ts`：固定提示词、版本密钥和有效模型解析；来源各自绑定访问范围，IM 不复用 Web 的 owner/私聊特例 |
| IM Provider私有续接 | `modules/agent/run/reasoning/active.ts:createProviderReasoningPersistence` 与 `modules/agent/run/reasoning/bridge.ts`：四协议活动值与checkpoint同事务加密，原ref精确恢复；Responses/Anthropic 发布协议原生的跨 Run 成功状态。Anthropic完整响应块仅存活动侧表，off仍允许当前Run工具私有恢复；绑定实际adapter身份，不把配置原字符串当协议身份，不把私有wire写进Canonical或回复 |
| IM 独立语音识别与音频处理 | `apps/web-host/src/modules/im/gateway/media/config.ts`、`media/voice.ts`、`audio.ts`：活动 voice preset/当前 speech_to_text BYOK、每次HTTP与转码的版本/授权复核、Core三种ASR协议和有界ffmpeg；不借聊天模型凭据，不信平台duration，不让清理或预检失败伪装空识别 |
| IM 语音卡片结果 | `apps/web-host/src/modules/im/gateway/media/transcripts.ts`：同事务client验证整个密封批次，只更新本消息首个非quoted voice卡片，借用既有RunScope，禁止另写宽松HMAC/归属规则 |
| IM daily沉淀 | Core `memory/im-group-daily-compaction.ts` / `owner-daily-compaction.ts`：群100条、owner50条触发，冻结旧尾部、最旧100条批次、不同日期保留规则与有界历史参考；Host `gateway/memory/daily.ts` / `memory/owner.ts` / `memory/files.ts`：独立真实Provider、前后授权、CAS和逐响应用量。持久调度复用`memory/jobs.ts`，不得把群私人召回开关当作owner学习禁令、借主快照/工具补造维护输入、丢掉坏JSON已产生的数值用量或把缺报当零 |
| IM owner周期维护 | Core `memory/owner-periodic.ts`：profile/pattern独立100/+30/7天/失败1小时门限及输出校验；Host `gateway/memory/periodic.ts` / `memory/files.ts`：正式提示词、最多一次结构纠正、列表和metadata CAS。复用加密Job和owner锁；仅活跃owner反思后登记，不新增全局模型扫描。无计划的未知请求结果不重发，数据库已有计划优先恢复，费用共用`reflection-usage.ts`，不得以缺报冒充零 |
| Redis RESP 与连接规则 | `apps/web-host/src/adapters/cache/redis-protocol.ts`：有界 RESP、命令编码、URL/TCP/TLS；订阅使用 `redis-live-subscription.ts`，IM Streams 使用 `redis-stream-commands.ts`，未知写结果不得自动重发 |
| 凭据交互提交事务 | `apps/web-host/src/modules/agent/interactions/secrets.ts`：`consumeSecretInteractionLocked` 借用同一事务；Web 全字段和 IM 私聊逐字段输入均复用校验/加密/恢复门 |

新增稳定复用入口时，在本节补充契约与路径；删除或迁移入口时同步更新，避免清单过期。

## Desktop 出站网络

- Desktop 内由应用发起的外部工具请求和链接读取统一使用 `@gugu/core/providers/node` 的 `desktopTransportOptions`。代理关闭时由该入口禁用环境代理，正常使用系统 DNS。macOS 的默认解析全为 Fake IP 时，改用活动物理网卡的 DHCP DNS。没有真实结果时返回网络错误。
- Desktop 主进程自托管服务的直连 HTTP 使用 `apps/desktop/src/main/network.ts`，与工具共用 DNS 策略。自托管入口可使用用户指定的局域网地址。公网工具仍须走固定目标校验和逐跳重定向校验。
- 新增应用内的 HTTP 入口时复用上述入口。由外部浏览器打开的链接遵循浏览器的网络设置。

## 后端目标与历史参考

- 所有新后端实现、修复、测试和运行验收均以 Node.js 为目标：共享规则优先进入 `packages/core/`，数据库公共能力进入 `packages/database/`，IM 网关能力进入 `packages/gateway/`，宿主差异留在 `apps/web-host/` 或 `apps/desktop/`。
- Python 实现只作为历史行为和迁移数据的只读参考。不得新增 Python API、运行依赖、双运行时、兼容桥或 fallback；无需为 Node 改动运行 Python pytest。需要保留的行为应转化为 Node 契约，并通过 Node 单测、集成测试或端到端路径验证。
- 迁移清单用于追踪 Node 实现的功能覆盖和未完成项，不要求将旧 Python 后端重新实现或维持为平行目标。仅注册路由或验证未认证请求返回 401，不能单独作为业务功能完成证据。
- 修改共享模块前检查工作区和并行会话的编辑范围；发生职责重叠时先协调并保留其他会话的未提交改动。完成通用收敛后通知相关会话复用入口和边界规则。
