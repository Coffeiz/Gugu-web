# 轻量单机部署模式

> 状态：🔲 待实施，已完成现状调查与方案定稿
> 创建：2026-08-31
> 最近更新：2026-08-31
> 关联模块：`backend/app/core/config.py`、`backend/app/db/session.py`、`backend/app/core/redis.py`、`backend/app/core/events.py`、`backend/worker.py`、`backend/app/main.py`、`backend/alembic/`、`docker-compose.yml`
> 背景参考：当前后端 PostgreSQL/Redis 运行链路、`docs/prds/【已完成】PRD-ARCH-5-从安全原点恢复FASTAPI与PYTHON后端.md`、`docs/prds/【已完成】PRD-AGENT-4-统一CONTEXTBUDGET上下文压缩重构.md`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| PostgreSQL 生产模式 | ✅ 已完成 | 当前默认数据库连接使用 `postgresql+asyncpg`，支持现有多进程部署。 |
| Redis 生产模式 | ✅ 已完成 | Redis Streams、Pub/Sub、去重、上下文 revision 和跨进程协调均已接入。 |
| SQLite 轻量模式 | 🔲 待评估 | 代码存在测试用 `aiosqlite`，业务生产连接和迁移尚未完成跨方言收口。 |
| 无 Redis 单机模式 | 🔲 待评估 | 当前 IM 入站队列和事件广播不能直接移除 Redis，需要本地持久队列与进程内事件总线。 |
| 轻量安装/启动入口 | 🔲 待评估 | 尚无统一的模式选择、依赖检查、数据目录初始化和运行状态提示。 |
| PostgreSQL 到 SQLite 迁移 | 🔲 待评估 | 不作为首个交付的自动切换路径，需要单独导出、导入和校验工具。 |

## 1. 背景与目标

### 1.1 背景

当前部署默认依赖 PostgreSQL 和 Redis。对多用户、多个 worker、IM 网关和前端实时刷新而言，这套组合是合理的；但对单人本地使用者，它会带来额外的数据库、缓存服务、端口、密码和容器维护成本。

调查确认两项依赖不是简单的“可选连接”：

- `backend/app/db/session.py` 使用 `postgresql+asyncpg`，初始化还执行 `JSONB`、`CREATE INDEX ...` 和 `pg_try_advisory_xact_lock` 等 PostgreSQL 相关语句。
- `backend/app/core/redis.py` 的 Streams 用于 IM 入站队列和消费确认；同步网关也会写入 Redis，并依赖 Redis 做消息去重。
- `backend/app/core/events.py` 通过 Redis Pub/Sub 为前端 SSE 和 TS Data Runtime 发布失效事件，并保存上下文 revision。
- `backend/worker.py` 是独立进程，当前通过 Redis 消费 IM、反思和清理任务，并依赖消费组的 ack、pending 和 stale claim 语义。
- 调度器和部分后台任务可以在单进程内运行，但不能因为 Redis 不可用而静默丢弃需要持久化的任务。

### 1.2 目标

为个人用户提供一个明确的“轻量单机模式”：

1. 默认使用本地 SQLite，不要求用户安装或维护 PostgreSQL。
2. 默认不要求 Redis；单机内的队列、事件通知、去重和短期缓存使用 SQLite/进程内实现。
3. 保留 Web、Admin、项目、文件、日历、画布、记忆、Agent Loop 和基本定时任务能力。
4. 在单进程或受控少进程范围内继续支持 IM；消息必须可恢复、可确认，不能用内存队列替代持久事实。
5. 标准模式继续使用 PostgreSQL + Redis，不改变现有生产拓扑和多实例能力。
6. 安装向导能告诉用户当前模式、资源边界、不可用能力和切换代价。

### 1.3 明确不做

- 不把 Redis 或 PostgreSQL 的异常静默吞掉后继续假装是完整标准模式。
- 不支持轻量模式下的多实例横向扩展、跨主机 worker、跨进程可靠锁和高可用故障转移。
- 不在首次交付中提供在线原地把 PostgreSQL 数据库切换成 SQLite 的隐式迁移。
- 不把 SQLite 文件放进容器临时层；用户数据、备份和数据库必须位于显式持久化数据目录。
- 不为兼容 SQLite 保留第二套业务查询实现；方言差异集中在数据库适配、迁移和基础设施层。

## 2. 功能需求

### FR-LITE-001：部署模式选择

安装或首次启动时支持 `light` 与 `standard` 两种模式。`light` 是单机模式，`standard` 保持当前 PostgreSQL + Redis 模式。模式写入受保护的本地运行配置，Admin 页面展示当前模式和关键依赖状态。

模式切换必须是显式操作：切换前展示数据目录、备份要求、预计不可用能力和是否需要重新导入数据；不能因为连接失败自动切换数据库或队列实现。

### FR-LITE-002：SQLite 数据库

轻量模式使用 `sqlite+aiosqlite`，数据库文件位于用户指定的数据目录。必须启用外键约束、合理的 busy timeout 和单写者事务边界，避免多个请求同时写入时出现难以解释的锁错误。

业务模型应优先使用 SQLAlchemy 通用类型。PostgreSQL 专用类型、索引和初始化 SQL 必须通过 dialect 分支处理；数据结构和归属校验保持一致。

### FR-LITE-003：跨方言迁移

Alembic 迁移必须能识别目标 dialect。SQLite 不支持的 PostgreSQL DDL 要么改写为通用迁移，要么通过明确的 SQLite 重建表流程完成，不能在启动时执行 PostgreSQL SQL 并把错误转成“数据库不可用”。

初始化、升级和降级都要输出结构化的迁移结果，并在失败时保留数据库文件和备份，不得继续启动半迁移状态的业务服务。

### FR-LITE-004：本地持久化队列

轻量模式以 SQLite 队列表作为单机消息事实来源，至少支持 `pending`、`processing`、`done`、`failed` 状态、租约过期回收、有限重试、幂等键和顺序字段。

IM 入站消息、需要跨进程执行的后台任务和必须重启后恢复的任务进入本地队列。单进程模式可以由同一 FastAPI 进程消费，也可以启动一个受控本地 worker，但两者不能同时消费同一队列。

### FR-LITE-005：进程内事件与前端刷新

轻量模式使用进程内事件总线向当前进程的 SSE 订阅者发送资源刷新和上下文 revision 事件。事件发布失败不能回滚已经成功的业务写入；前端重新连接后必须通过 API 重新读取资源，不依赖事件补齐历史。

标准模式继续使用 Redis Pub/Sub。两种模式共享 canonical event payload 和资源命名，不允许形成两套业务事件格式。

### FR-LITE-006：本地去重、锁和缓存

- 消息去重使用 SQLite 唯一约束或本地持久化去重表，去重窗口和幂等键语义与 Redis 版本一致。
- 单机互斥使用数据库租约/事务锁和进程内锁组合；锁必须包含 owner、创建时间、过期时间和释放结果。
- 仅用于性能优化的短期缓存使用进程内缓存，并标注“重启即失效”。需要跨进程或跨重启保持的状态必须写数据库。
- 轻量模式不得把 Redis key 当成会话 pending、业务状态或任务完成事实。

### FR-LITE-007：Agent、IM 与定时任务边界

轻量模式保留 Agent Loop 的业务编排和工具权限检查。Web 请求直接在当前进程执行；IM 和定时任务通过本地持久队列进入同一套 Loop，保持会话串行、幂等、确认门和错误回执。

如用户启用需要独立平台网关的 IM 能力，启动器必须明确显示该能力占用额外本地进程；不允许把多个网关实例绑定到同一个本地消费身份。

### FR-LITE-008：RAG 与文件存储

轻量模式继续使用本地文件存储和现有 TS RAG sidecar 制品。RAG 索引、文件、缩略图、上传暂存和 SQLite 数据库都必须位于可备份的数据根目录，并按现有用户归属边界隔离。

### FR-LITE-009：可观测性与诊断

Admin 状态页展示：部署模式、数据库类型和连接状态、Redis 是否需要、队列积压、过期租约、后台任务失败数和存储路径摘要。日志只记录脱敏的 id、计数、状态和 fingerprint，不记录聊天正文、附件名、Token 或密钥。

轻量模式的基础设施降级必须是显式状态，例如 `redis_required=false`、`queue_backend=sqlite`，不能只靠一条“Redis 连接失败”日志让用户猜测当前实际模式。

## 3. 技术方案

### 3.1 模式与依赖矩阵

| 子系统 | 标准模式 | 轻量模式 | 事实来源 |
|---|---|---|---|
| 关系数据库 | PostgreSQL + `asyncpg` | SQLite + `aiosqlite` | SQLAlchemy session |
| IM 入站队列 | Redis Streams + consumer group | SQLite durable queue | 队列表状态和幂等约束 |
| SSE/数据失效 | Redis Pub/Sub | 进程内事件总线 | 业务写入成功后的 canonical event |
| 跨实例锁 | Redis lease | SQLite lease + 进程锁 | 带 owner/expiry 的持久记录 |
| 短期缓存 | Redis 或现有实现 | 进程内缓存 | 重启即失效的性能优化 |
| 调度 | APScheduler/现有后台任务 | 单进程 scheduler | 持久化任务记录 |
| RAG | 固定 TS sidecar | 固定 TS sidecar | 文件索引与 revision |

建议新增 `runtime.mode` 或同等命名的顶层配置，避免用“Redis 能不能 ping 通”推断模式。配置校验规则：

- `standard` 必须配置可用的 PostgreSQL；需要 Redis 的功能必须可连接 Redis。
- `light` 必须配置可写数据目录和 SQLite 文件；Redis 配置可以为空，但不应继续创建 Redis 客户端。
- 任何模式都不能从环境变量或 override 中读取到密钥后写回日志或前端响应。

### 3.2 数据库适配边界

建议收口以下位置：

```text
backend/
├── app/core/config.py              # runtime.mode、数据库/Redis依赖声明
├── app/db/
│   ├── session.py                  # engine URL、连接参数、初始化入口
│   ├── dialect.py                  # 方言能力和事务锁适配
│   └── local_queue.py              # SQLite 队列仓储
├── app/models/__init__.py          # 通用字段类型和队列表模型
├── app/core/
│   ├── redis.py                    # 仅 standard 模式的 Redis 实现
│   ├── events.py                   # canonical event facade
│   └── local_events.py             # light 模式进程内事件实现
├── app/api/v1/runtime.py           # 模式和依赖状态接口
├── agent/queue/                    # 队列 facade 与消费生命周期
├── worker.py                       # standard Redis worker / light 本地 worker 入口
├── alembic/versions/               # 双方言迁移
└── scripts/
    ├── export_standard_data.py     # 显式导出
    └── import_light_data.py        # 显式导入与校验
```

`app/db/session.py` 不应让业务层直接判断数据库 URL。数据库 URL、连接池参数、SQLite pragma 和迁移锁都由数据库基础设施层处理。`create_all_tables()` 不能继续无条件执行 PostgreSQL DDL；生产启动应优先使用 Alembic，开发初始化也要走同一 dialect-aware 入口。

### 3.3 本地队列状态机

本地队列表最少包含：`id`、`kind`、`dedup_key`、`payload_json`、`status`、`available_at`、`attempts`、`lease_owner`、`lease_expires_at`、`created_at`、`finished_at` 和 `last_error_code`。聊天正文不进入可见日志；队列诊断只输出队列 id 的 fingerprint、kind 和计数。

领取流程使用短事务：选择到期的 `pending` 或 `processing` 记录，写入 owner 和租约，再提交；处理完成后以 dedup key 和 owner 条件更新为 `done`。进程崩溃后由下一个本地 worker 回收过期租约。非幂等操作必须沿用现有确认门，队列重试不能绕过确认状态。

### 3.4 Redis facade

业务调用方应依赖统一的 queue/event/lease facade，而不是在各处直接调用 `get_redis()`。标准实现映射到 Redis，轻量实现映射到 SQLite 或进程内事件。不能在 Redis 连接异常时自动改写当前运行模式，因为这会让同一条消息在两套队列中重复或丢失。

### 3.5 数据目录与备份

轻量模式的数据根目录至少包含：

```text
Gugu-data/
├── app.sqlite3
├── users/
├── indexes/
├── queue/
├── backups/
└── runtime/
```

具体目录名以现有 Storage 配置为准，PRD 目录树表达的是职责边界。备份必须以一致性快照或停写窗口复制 SQLite 文件，并同时保存 schema 版本、模式配置和 RAG 索引版本。恢复前生成带时间戳的备份，恢复后校验用户、会话、文件元数据、任务和索引状态。

## 4. 验证与上线

### 4.1 自动化验收

轻量模式至少覆盖：

- SQLite 全量迁移、重启、并发读写、外键、锁等待和损坏文件拒绝启动。
- 本地队列的入队、幂等、顺序、ack、失败重试、租约过期回收和进程崩溃恢复。
- Web/IM/定时任务进入同一 Agent Loop，单会话串行且不会重复回复。
- 进程内 SSE 事件刷新、断线重连后的 API 重读，以及事件失败不影响业务写入。
- 无 Redis 启动时不会创建 Redis 客户端；标准模式仍执行 Redis Streams/Pub/Sub 回归测试。
- 轻量模式下 system Shell、危险命令、跨实例 worker 和未授权路径访问仍被拒绝。
- 数据导出、导入、备份恢复后归属校验、敏感字段脱敏和 RAG scope 结果一致。

推荐命令：

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q
python scripts/check_ownership.py
python scripts/check_confirm_gate.py
python -m compileall -q app agent
```

另建轻量模式专用临时数据目录运行测试，不读取或覆盖 `backend/config.override.json`、`.env` 和真实用户数据。

### 4.2 灰度与观测

先以显式 `light` 配置启动独立临时实例，完成 Web、文件、项目、日历、记忆、Agent、定时任务和至少一个 IM 平台的真实回归，再考虑安装向导默认推荐。观测队列积压、SQLite busy/lock 次数、单进程事件订阅数、任务重试数、数据库文件大小和备份耗时。

轻量模式只支持单实例。检测到第二个进程使用同一数据目录时，应拒绝启动或给出明确错误，避免 SQLite 和本地 lease 被误用成多实例协调器。

### 4.3 回滚

代码回滚不等于数据回滚。发布前保存数据库和文件数据备份；升级失败时停止写入、保留失败数据库文件、恢复备份并回到原模式。SQLite 与 PostgreSQL 之间只通过显式导出/导入迁移，不能通过切换配置直接复用同一个数据库文件。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| SQLite 写入锁竞争 | 多请求或 IM 高峰出现延迟、失败 | 单写事务、busy timeout、本地队列串行化，并记录 lock 指标。 |
| 本地队列实现与 Redis Streams 语义不一致 | 重复回复、丢消息或崩溃后无法恢复 | 先定义状态机和幂等约束，再接入 IM；用故障注入测试验证。 |
| PostgreSQL 专用 SQL 遗漏 | 轻量模式启动或升级失败 | 扫描方言调用，迁移按 dialect 测试，禁止启动时无条件执行 PG SQL。 |
| 进程内事件不跨进程 | 多进程部署时页面不刷新 | 轻量模式只允许单实例；标准模式继续使用 Redis Pub/Sub。 |
| 数据目录丢失 | 用户文件、数据库和索引同时丢失 | 安装时明确目录，提供备份/恢复入口，不使用容器临时层。 |
| 轻量模式被误用于公开多用户服务 | 性能和可靠性不足，锁边界被突破 | 启动状态、文档和 Admin 明确单实例限制，必要时拒绝第二进程。 |
| SQLite 缺少 PostgreSQL 部分能力 | 搜索、并发或统计结果差异 | 先列能力差异表；不满足一致性的功能在轻量模式明确标记，而不是静默改变结果。 |

待确认事项：

1. 轻量版是否必须支持 QQ、飞书和微信全部网关，还是首版只保证 Web + 定时任务，IM 作为后续适配？
2. 是否接受轻量模式默认单进程，从而牺牲独立 worker 的隔离和高并发？
3. 是否需要提供 PostgreSQL 导出到 SQLite 的迁移，还是只支持新建轻量实例？
4. 是否把 Redis 彻底从轻量版依赖中移除，还是保留一个可选 Redis 用于高质量实时广播？

## 6. 唯一实施 TODO

### Phase 0：基线和边界

- [ ] `ARCH6-001` 固化 `light`/`standard` 模式配置与能力矩阵；责任边界：`app/core/config.py` 负责模式和依赖校验，Admin 状态接口只展示结果；验收：两种模式的启动检查、状态响应和禁止自动切换测试通过。
- [ ] `ARCH6-002` 建立 PostgreSQL/SQLite 方言差异清单并覆盖现有模型、初始化 SQL、Alembic 迁移和搜索查询；责任边界：`app/db/` 与 `alembic/`；验收：清单中的每项都有通用实现或明确的模式限制，不能遗留未分类的 PostgreSQL 专用路径。

### Phase 1：SQLite 数据层

- [ ] `ARCH6-003` 接入 `sqlite+aiosqlite` engine、pragma、连接生命周期和单实例数据目录锁；责任边界：`app/db/session.py`、`app/db/dialect.py`；验收：空库初始化、重启、并发读写、锁等待和错误恢复测试通过。
- [ ] `ARCH6-004` 将初始化与 Alembic 迁移改为 dialect-aware，并补齐 SQLite 迁移回归；责任边界：`app/db/session.py`、`alembic/versions/`；验收：从空库和至少一个历史 schema 版本升级成功，失败时不产生半迁移启动状态。

### Phase 2：Redis 能力替代

- [ ] `ARCH6-005` 实现本地持久化队列和消费状态机；责任边界：`app/db/local_queue.py`、`agent/queue/`、`worker.py`；验收：幂等、顺序、ack、重试、租约回收和进程崩溃恢复测试通过。
- [ ] `ARCH6-006` 收口 queue/event/lease 调用到 facade，并提供 SQLite/进程内实现；责任边界：`app/core/redis.py`、`app/core/events.py`、`app/core/local_events.py` 及调用方；验收：轻量模式不初始化 Redis，标准模式原有 Redis 测试保持通过，两种模式的 canonical event 一致。
- [ ] `ARCH6-007` 将 IM、定时任务和后台任务接入轻量队列生命周期；责任边界：`worker.py`、`app/core/scheduler.py`、`agent/im/`；验收：单会话连续消息不乱序、不重复、不丢失，重启后 pending 任务可恢复。

### Phase 3：安装、运维和数据

- [ ] `ARCH6-008` 增加轻量模式安装/启动检查、数据目录初始化、单实例保护和状态诊断；责任边界：`backend/start.sh`、`backend/docker-entrypoint.sh`、Admin runtime API；验收：无 PostgreSQL/Redis 的干净环境可完成启动，错误提示包含修复动作和能力边界。
- [ ] `ARCH6-009` 提供显式数据备份、导出/导入和恢复校验工具；责任边界：`backend/scripts/`、Storage 服务；验收：测试数据恢复后用户归属、文件元数据、会话、任务和索引校验通过，敏感数据不进入日志。

### Phase 4：完整验证与发布

- [ ] `ARCH6-010` 完成轻量模式 Web、Admin、文件、项目、日历、画布、记忆、Agent、定时任务和 IM 真实回归；责任边界：测试与 devserver；验收：轻量专用测试集和标准模式回归集均通过，记录资源占用、队列延迟和已知限制。
- [ ] `ARCH6-011` 更新安装文档、Admin 提示和部署矩阵，确认轻量模式单实例边界；责任边界：`README`、`docs/`、前端状态页；验收：新用户无需手动配置 PostgreSQL/Redis 即可完成轻量启动，切换标准模式前能看到备份和迁移说明。
