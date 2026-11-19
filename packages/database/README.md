# Gugu 2.0 数据库迁移

| 路径 | 用途 |
| --- | --- |
| `src/shared/` | 统一的 `check` / `apply` 命令和退出语义 |
| `src/sqlite/` | Desktop 的 SQLite 基线、运行前校验和原子建库 |
| `src/postgres/` | Web Host 的 PostgreSQL 迁移、顺序清单和事务执行器 |

`src/schema.ts` 定义共享的表结构和 Kysely 类型，两种数据库的编号文件分别放在各自的 `migrations/`，入口为 `migrate.ts`。迁移文件按 `四位序号_功能名.ts` 命名，例如 `0001_initialize.ts`、`0007_terminal_sessions.ts`。两种数据库分别编号，按各自的依赖顺序执行。Core 和 Web Host 依赖 `@gugu/database`。Core 保留业务仓储和 Kysely 查询，迁移使用各数据库的原生 SQL 表达约束、触发器和索引。

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
- SQLite 写入 `core_runtime_meta.migration_revision`，从临时文件原子发布。Desktop 首次启动和显式建库复用同一编号基线。
- 2.0 初始化使用新的 PostgreSQL schema 或 SQLite 文件。两端遇到旧结构会拒绝接管。

添加 PostgreSQL 迁移时，在清单末尾登记下一编号，声明依赖和负责的对象。如果新增步骤改变已登记对象，需要随步骤更新受影响对象的结构验证。SQLite 当前只有一条建库基线。后续引入 SQLite 增量迁移时，保留已发布基线，并用新编号记录事务化升级。
