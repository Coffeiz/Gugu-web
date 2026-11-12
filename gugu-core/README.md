# @gugu/core

独立 TypeScript 领域与 Node 数据运行时。当前迁移项目、联系人、SQLite/PostgreSQL 事务及桌面数据 Host；Web/Agent 继续使用显式的 Python 兼容包，后续按完整业务命令切换。

## 开发与验证

使用 Node 26.13+ 的 26 LTS 和 pnpm 10.15.0。从仓库根执行：

```bash
npm install --global pnpm@10.15.0
pnpm --filter @gugu/core install --frozen-lockfile
pnpm --filter @gugu/core test
```

包发布编译后的 ESM JS 与声明，运行不需要 TypeScript 加载器或 Python。浏览器/移动宿主只导入 `@gugu/core/contracts` 或 `/domain`；`/local` 和 `/data` 是 Node 入口。SQLite/PG 驱动按后端加载，缺少驱动时明确失败。

```ts
import { randomUUID } from 'node:crypto'
import { LocalRuntime } from '@gugu/core/local'

const runtime = await LocalRuntime.initialize('./core-data.db')
try {
  const operationId = randomUUID()
  const project = await runtime.call('projects.create', { name: '本地计划' }, { operationId })
  const receipt = await runtime.call('operations.get', { operation_id: operationId })
} finally {
  await runtime.close()
}
```

本地用例在专属 Worker 中串行执行完整事务，控制通道不运行同步 SQL。上下文来自本地稳定身份；调用者不能在字段中覆盖 owner。跨域命令 `projects.createWithClient` 共享一个事务。项目使用版本 CAS，联系人保留无版本的原有更新语义。

服务端使用 `createPostgresRuntime({ url, schema, maxConnections })` 和 `dataContext(ownerUUID)`；连接 URL 来自宿主安全配置，Core 不自动读取环境文件或建表，不提供任意用户 HTTP 入口。一个事务只用同一连接，所有查询和写入带 owner 条件。

## 旧库、收据与升级

新库 schema 为 3，新增 `core_operation_receipts`；持久收据与业务写入同事务提交。相同操作 ID、相同方法与参数返回原结果；不同内容冲突。进程超时可能已提交，应凭操作 ID 查询或读取权威数据，不自动重试修改。

v2 文件可通过显式 `allowLegacySchema` 用于差分验证，字段编码保持可被旧 Python 包重读；该模式没有持久收据。正式桌面协议 v2 要求 schema 3，遇到旧库拒绝隐式迁移。停止相关运行时后显式执行：

```bash
pnpm --filter @gugu/core build
pnpm --filter @gugu/core cli --database <本地数据库文件> migrate
```

v1/v2 升级先锁定写入、生成并校验独立备份，再事务性升级。失败回滚 DDL 与版本。新库初始化先构建完整临时文件，再以不覆盖目标的方式发布；不会把失败的半初始化库当成有效文件。

旧 Python 不能打开 v3。回滚需停止新版、恢复升级前备份并配套旧代码，不让旧进程直接写新 schema。用户 Web `.env` 和 `config.override.json` 不参与迁移。

## 差分与真实数据库

Python 参考测试保留在 `backend/tests/core/`。额外安装 `compat/core-python`，显式指定参考解释器，再执行：

```bash
pnpm --filter @gugu/core test:golden
```

`GUGU_CORE_GOLDEN_PYTHON` 指向安装了参考包的解释器。PostgreSQL 回归只在显式提供 `GUGU_CORE_TEST_POSTGRES_URL` 时连接隔离测试库，使用随机临时 schema；不要提供用户部署数据库。

目标架构、目录职责、迁移 checklist 与当前回归测试对齐任务统一见 [架构与迁移任务清单](../docs/refactor/Gugu-2.0-架构与迁移任务清单.md)。历史方案和验证记录见 [归档索引](../docs/refactor/_archive/gugu-2.0/README.md)。
