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

共用数据契约在 SQLite/PG 分别覆盖联系人维护、owner 隔离、事务回滚、时间精度、归档/墓碑和关闭状态；Python 对照保护共享语料、维护序列、旧库互读及备份恢复。具体映射及已有严格校验差异见 [回归对照清单](../../docs/testing/node-core-parity.md)。

正式桌面 stdio 位于 `runtime/transport/stdio.ts`，以独占连接防止同一库被多个数据进程并行使用；可注入的进程 IPC 适配复用同一命令/收据契约，不依赖 Electron，也不自动切换传输。Executor 只接受 Host 已建立的授权，实际隔离交给选定后端；不提供无沙箱回退。当前执行去重属于进程内保护，持久 Job/Run 恢复仍属后续 Agent 阶段。

## Agent Harness 迁移切片

固定实现树为 `harness.ts` 薄协调、`contracts.ts` 领域类型、`ports.ts` 依赖接口，以及 `run/`、`history/`、`context/`、`streaming/`、`interactions/`。对应测试统一位于 `tests/agent/harness/` 的这五个职责目录。Provider 协议和工具分发实现由外部模块提供，持久 Job、租约与 outbox 的真实共用实现也只通过端口接入；Harness 不建立平台或数据库后端。

`@gugu/core/harness` 提供可移植的 Canonical 上下文与 Run 编排；`createCanonicalContextPort` 连接历史准备、稳定引用 checkpoint、工具轮次、交互结果替换和预算/压缩，`createRunHarness` 协调启动/恢复/取消、工具调度、终态与 outbox。`@gugu/core/executor/runtime` 是现有共用 Executor 的可移植协调器，原 `/executor/platform` 保留同一类的兼容导出；原生后端仍由 Host 显式装配。

推荐通过 `createCanonicalHarness` 的 `runPreparation` 接入标准准备主链：owned 来源读取后并发发现工具与召回 RAG，再按可信入口/主体过滤能力、组装系统规则和技能快照，最后进入 Canonical。能力目录只接收过滤后 Schema 与当前 query；用户 Skill 元数据随首次 session snapshot 候选冻结，后续 Run 复用。定时任务不注入交互历史或 RAG，当前输入仅用于请求。选择后的名称和公开 schema 随 Run context 冻结，Provider 必须使用这一快照；未开放的工具声明在实际派发前拒绝。端口查询须响应取消并在返回前释放资源。自定义完整 `context.load` 可以省略标准准备选项，但必须提供同等准备结果及能力快照，缺失时入口明确失败。

这些入口不自动创建数据库、连接 Provider、注册工具或接管 Web/IM。生产装配必须实现 owner/session 互斥租约、fenced CAS RunStore、单次交互授权、Provider 归一事件与续接、稳定附件引用、错误清洗和事件发布。`prepareRequest` 必须按 Run 身份恢复同一冻结前缀，不能重启后套用新配置。成功 finalize 的 Canonical delta、用量、摘要水位与 outbox 必须同事务；中间 checkpoint 仅保留可恢复状态，失败不应用待提交压缩，取消只保存允许的中断 delta。工具处于未知状态时只查询收据，不自动重发修改。

完整反思 wire 快照仅保留进程内；Run checkpoint 不含媒体载荷、签名 URL、私有推理或授权材料。续接记录 ID 不是实现完成的证明，真实 Provider/Reasoning/Data 适配及重启恢复仍需独立验收。各 Python 行为与实际 TS 测试状态见 [Harness 映射](../../docs/testing/node-agent-harness-parity.md)，未闭合项不得解释为全部 Agent 已迁移或允许切换生产调用方。

## Provider 协议与 Harness 接线

`@gugu/core/providers` 提供实际的 Chat Completions、Responses、Anthropic 和 Ollama 原生请求、历史投影、流解析及非聊天分支。`connectProviderHarness` 将这些实现接入现有 Canonical Harness；Provider 不拥有 Run 状态、工具授权或执行器。可信 Host 必须提供选模/凭据解析、稳定模型和访问范围身份，以及已有上下文的引用 codec、请求准备和持久化端口。解析后的配置不从 Core 自动读取用户运行文件。

Node HTTP/DNS/TLS/代理实现单独从 `@gugu/core/providers/node` 导入。可移植入口不会隐式装载 Node、数据库或平台 SDK。传输固定已校验的 DNS 地址、拒绝自动重定向，连接/写/读空闲/池等待分别有预算；本地网络同时需要 Host 和显式 local/ollama 配置授权。Host 显式提供代理、CA 及 `networkIdentity`，网络配置改变后须使客户端池键失效；自定义 CA 不自动读取 `SSL_CERT_FILE`/`SSL_CERT_DIR`，SOCKS 代理明确不支持。

原生 thinking/signature 和实际请求 wire 仅存在有界进程内状态中，绑定 owner/session/run/model/访问范围；引用过期、进程重启或成功收尾后明确拒绝续接。该实现不是加密的跨进程 ReasoningStore。缓存前缀协调默认只在进程内排序，不共享模型答案；Redis 租约和续租仍需共享 runtime/Host adapter。完整请求探针只交给显式受控 sink，不能直接用于公开日志或用户事件。

Provider 的真实协议逻辑使用注入 HTTP 测试；测试替身只替换外部网络和存储，不能据此宣称已切换 Web/IM/Worker 或完成 BYOK、Tools、RAG、媒体文件探测/转码、数据库/Redis、持久 Job。逐 Python 定义、生产调用点及差异见 [Provider 回归映射](../../docs/testing/node-agent-provider-parity.md)。

目标架构、目录职责、迁移 checklist 与当前回归测试对齐任务统一见 [架构与迁移任务清单](../../docs/refactor/Gugu-2.0-架构与迁移任务清单.md)。历史方案和验证记录见 [归档索引](../../docs/refactor/_archive/gugu-2.0/README.md)。
