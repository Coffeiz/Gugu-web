# @gugu/core

独立 TypeScript 领域与 Node 数据运行时。当前迁移项目、联系人、SQLite/PostgreSQL 事务及桌面数据 Host；Web/Agent 继续使用显式的 Python 兼容包，后续按完整业务命令切换。

## 开发与验证

使用 Node 26.13+ 的 26 LTS 和 pnpm 10.15.0。从仓库根执行：

```bash
npm install --global pnpm@10.15.0
pnpm --filter @gugu/core install --frozen-lockfile
pnpm --filter @gugu/core test
```

包发布编译后的 ESM JS 与声明，运行不需要 TypeScript 加载器或 Python。浏览器/移动宿主可导入 `@gugu/core/contracts`、`/desktop`、`/domain`、`/executor` 契约或 `/executor/policy`；`/local`、`/data`、`/ipc` 与 `/executor/platform` 是 Node 入口。SQLite/PG 驱动和原生执行后端按需加载，不能从 portable 入口隐式导入 MXC、进程或 Electron。

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

## 分层、差分与真实数据库

`tests/suites.json` 显式记录 marker、layer 和用途；发现文件与清单不一致、选择为空或所需服务/解释器缺失均失败。`process` / `external_service` 自动归入 `slow`，快速层和集成层按 pytest 相同表达式选择。`test` 默认执行快速层及 Node IPC；完整门禁使用 `test:all`，不会把未连接的 PG 当成通过。

```bash
pnpm --filter @gugu/core test:list
pnpm --filter @gugu/core test:unit
pnpm --filter @gugu/core test:ipc
pnpm --filter @gugu/core typecheck:tests
```

Python 参考测试保留在 `backend/tests/core/`。额外安装 `compat/core-python`，显式指定参考解释器，再执行：

```bash
pnpm --filter @gugu/core test:golden
```

`GUGU_CORE_GOLDEN_PYTHON` 指向安装了参考包的解释器；`test:parity` 与 `test:golden` 等价。`test:postgres` 必须提供 `GUGU_CORE_TEST_POSTGRES_URL`，连接显式隔离测试库并使用随机临时 schema；不要提供用户部署数据库。`test:integration` / `test:all` 同时要求 PG 与参考解释器，各集合内不重复执行同一文件。根分层、fast、affected 与清单工具已经接入 Core。

共用数据契约在 SQLite/PG 分别覆盖联系人维护、owner 隔离、事务回滚、时间精度、归档/墓碑和关闭状态；Python 对照保护共享语料、维护序列、旧库互读及备份恢复。具体映射及已有严格校验差异见 [回归对照清单](../docs/testing/node-core-parity.md)。

正式桌面 stdio 位于 `runtime/transport/stdio.ts`，以独占连接防止同一库被多个数据进程并行使用；可注入的进程 IPC 适配复用同一命令/收据契约，不依赖 Electron，也不自动切换传输。Executor 只接受 Host 已建立的授权，实际隔离交给选定后端；不提供无沙箱回退。当前执行去重属于进程内保护，持久 Job/Run 恢复仍属后续 Agent 阶段。

目标架构、目录职责、迁移 checklist 与当前回归测试对齐任务统一见 [架构与迁移任务清单](../docs/refactor/Gugu-2.0-架构与迁移任务清单.md)。历史方案和验证记录见 [归档索引](../docs/refactor/_archive/gugu-2.0/README.md)。
