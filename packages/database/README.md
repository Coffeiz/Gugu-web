# @gugu/database

Database 负责类型化表访问的基础设施。职责包括 Kysely 实例装配、表类型、驱动、事务和引擎差异，以及结构迁移和校验。领域负责自己的 IR、仓储、权限和业务事务。普通读写使用 Kysely。

## 现有入口

| 入口 | 当前用途 |
| --- | --- |
| `@gugu/database/schema` | 共享 Kysely 表类型和结构定义 |
| `@gugu/database/postgres/kysely` | 装配 PostgreSQL 实例或接入已有池适配器 |
| `@gugu/database/sqlite/kysely` | 从原生句柄装配 SQLite 实例，写事务使用 `BEGIN IMMEDIATE` |
| `@gugu/database/postgres` | PostgreSQL 迁移 |
| `@gugu/database/postgres/transaction` | 通用 PostgreSQL 事务执行器 |
| `@gugu/database/sqlite` | SQLite 初始化和迁移 |
| `@gugu/database/sqlite/driver`、`@gugu/database/sqlite/validate` | SQLite 驱动、配置和结构验证 |
| `@gugu/database/command`、`@gugu/database/error`、`@gugu/database/version` | 迁移命令和结果、基础错误、SQLite 与侧车共用结构版本 |

两端通过 Database 工厂装配 `Kysely<Database>`。Web Host 注入 PostgreSQL 实例，Desktop 的 Core Host 校验并升级 SQLite 文件后接入工厂，再将实例交给 Core 业务运行时。

- Web Core 的 PostgreSQL 连接池在首次查询时创建，运行时关闭时由 Kysely 销毁。Web Host 的其他池由宿主关闭。
- 借用 PostgreSQL 事务时，外层调用方管理提交、回滚和连接释放。借用适配器只关闭自身 Kysely 实例。
- Desktop 关闭运行时时先销毁 Kysely，再清理尚未被驱动关闭的原生句柄。文件校验或升级失败时由打开文件的一方关闭句柄。

## 领域仓储

IM 收件、去重、领取和投递恢复由 IM 领域处理。Web 的 PostgreSQL 仓储和 Telegram 游标事务位于 Web Host 的 IM Gateway 模块。Desktop 的 SQLite 仓储位于 Core 的 IM 模块，与附件登记、会话绑定及 Run 恢复在同一领域流程内协作。Database 提供这些流程使用的表结构、Kysely 实例和事务原语。

## 数据库迁移

| 路径 | 用途 |
| --- | --- |
| `src/shared/` | 统一的 `check` / `apply` 命令和退出语义 |
| `src/migrations/baseline/` | PostgreSQL 和 SQLite 当前基线 |
| `src/migrations/catalog.ts` | 双端共用的增量迁移清单 |
| `src/postgres/`、`src/sqlite/` | 引擎执行器、驱动与结构校验 |

新库先安装 `0000_baseline`，再执行该引擎适用的清单项目。现有开发库如果使用压平前的台账，会收到不兼容错误，迁移命令会保留原结构和数据。要启用新基线，请使用新的 PostgreSQL schema 或新的 SQLite 文件。

```sh
# Web Host，先构建并在进程环境中提供 GUGU_WEBUI_DATABASE_URL
pnpm --filter @gugu/webui migrate apply
pnpm --filter @gugu/webui migrate check

# Desktop，先构建 Core 后指定本地文件
pnpm --filter @gugu/core migrate apply --database "<数据库文件>"
pnpm --filter @gugu/core migrate check --database "<数据库文件>"
```

- `check` 只读取迁移状态和结构。待执行时输出 `pending` 并退出 2，状态完整时输出 `applied`。
- `apply` 成功后输出 `applied`。已应用且检查通过时输出 `unchanged`。遇到结构冲突或版本不兼容时以非零状态退出。
- PostgreSQL 在目标 schema 使用事务级锁和 `gugu_schema_migrations` 记录顺序、SQL 校验和与结构指纹。所有待执行步骤在同一事务提交。
- SQLite 新库通过临时文件初始化后原子发布，已有库先检查基线，再运行当前执行器支持的增量步骤。
- 新增迁移统一登记在 `src/migrations/catalog.ts`，每项指定稳定编号、目标引擎和受管理对象。
- `build` 返回 Kysely 可编译语句，执行器在数据库事务内运行 SQL 和参数。共有步骤写一次，引擎差异放在该项的 `after.postgres` 或 `after.sqlite`。已登记的脚本及目标引擎清单保持稳定。
- PostgreSQL 共用原有迁移账本和锁。SQLite 在基线初始化或验证后执行逻辑迁移，用 `BEGIN IMMEDIATE` 串行写入独立的逻辑迁移账本，并校验受管理对象。
- 首条共享迁移 `0049_conversation_role_sequence` 为会话列表按角色查询最新消息提供索引。新增对象若涉及 PostgreSQL 基线已跟踪的表，需要更新基线的结构跟踪规则。
- `0050_agent_chat_receipts` 为两端加入聊天准入回执表。Core 管理请求指纹与重放，迁移只管理表、唯一键及随会话或消息删除的外键。

`src/postgres/test-fixtures/` 保留部分供测试使用的 DDL 夹具。测试仍通过原有子路径访问，正式迁移清单只加载当前基线和逻辑迁移。

开发验收使用临时 SQLite 文件和隔离 PostgreSQL schema。提供专用测试数据库地址后，两端可用同一条命令验收。

```sh
: "${GUGU_WEBUI_TEST_DATABASE_URL:?请配置隔离 PostgreSQL 测试库}"
pnpm --filter @gugu/database build
pnpm --filter @gugu/webui exec node --import tsx --test tests/migrations/logical.test.ts
```

见 [数据库基础层实施计划](../../docs/architecture/database-implementation.md)。

## 定时任务数据适配

`@gugu/database/scheduled-tasks` 导出一次性和周期任务仓储、触发收据、SQLite 租约，以及列表和删除 SQL。查询接受经过调用方校验并按数据库编码的 owner。停用、删除的关联更新通过回调复用原事务，调用方负责工作区授权、索引更新和提交后通知。
