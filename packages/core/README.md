# @gugu/core

共享 TypeScript 业务能力与 Node 数据运行时，供 Web Host 和桌面 Host 按需装配。2.0 目标以 Node 为唯一运行时；Python 后端仅作为迁移期行为与回归参考，不作为运行时回退。各业务的实际迁移和验收状态以[迁移任务清单](../../docs/refactor/Gugu-2.0-迁移任务清单.md)为准。

认证和用户资料能力已拆到独立包：`@gugu/auth` 提供认证业务、远程认证客户端及契约，`@gugu/users` 提供用户资料、头像等共享能力。Web Host 与 Desktop Host 按需装配这些包；Core 继续接收可信身份，处理各业务自身的归属和授权规则。

## Core 与各端 Host 的职责边界

Core 按业务域承载可跨端复用的领域规则、数据契约和完整业务用例；Web、桌面等 Host 建立可信身份，装配存储与平台能力，并将各自协议转换为 Core 调用。共享用例应覆盖事务、归属、并发、Undo 和提交后事件等属于该业务的完整行为，不能只共享模型或校验函数，再由各端分别实现规则。

| 职责 | 共享 Core | Web Host `modules/` | Desktop Host / IPC |
| --- | --- | --- | --- |
| 业务规则与用例 | 业务校验、状态变更、归属规则及用例编排 | 调用共享用例；仅保留服务端专属业务 | 调用共享用例；仅保留桌面专属能力 |
| 事务与数据 | 定义业务一致性和数据契约；可复用的 SQL/数据实现归数据层 | 装配 PostgreSQL 和服务端事务/适配 | 装配 SQLite 和本地事务/适配 |
| 身份与授权 | 接收可信上下文，执行可共享的归属与业务授权规则 | 认证用户并建立可信 owner | 校验窗口、来源和命令，建立可信本地身份 |
| 入口与事件 | 提供与传输无关的输入、结果和业务错误 | HTTP DTO、状态码、Cookie、SSE 和路由 | 受限 IPC 命令、输入/错误映射和事件 |
| 文件与平台 | 定义业务需要的文件操作和路径契约；复用共享 FS 能力 | 建立用户授权根并注入平台适配 | 建立本地授权根并注入平台适配 |
| Agent | Runner、上下文、工具规则及可共享任务生命周期 | Web 会话、Redis、SSE、服务端装配 | 本地会话、IPC 事件、本地执行能力装配 |

例如修改项目时，HTTP 路由与 IPC 各自校验入口、解析输入并传入可信身份，再调用同一个 Core 用例；项目状态、版本冲突和 Undo 不分别维护两套。Core 可以协调事务，但连接池、SQLite 实例和生命周期由 Host 管理；PG 与 SQLite 的锁、查询和编码差异可分别适配，不要求强行共用全部 SQL。

IPC 仅暴露明确声明的业务命令，不允许渲染进程指定任意 owner、SQL、通用文件路径或 IPC channel。Web 路由同样不能相信请求体中的 owner。Core 不依赖 Fastify、Electron 或具体 Host；可移植契约不引入 Node、SQL 或平台 SDK，Node 数据运行时及平台能力通过明确入口和注入使用。

自部署 Admin 管理业务位于 Web Host；未来 SaaS 的管理后端独立设计和维护。Admin 及运维不要求桌面 IPC 或 SQLite 适配；Cookie、HTTP、SSE、Electron 窗口和系统对话框留在 Host。只有确有跨端用途的规则才收敛到 Core，不为单一调用方制造空层。Agent Runtime 的可复用编排归 Core，Provider 凭据、执行授权、队列和平台事件由 Host 提供。

2.0 目标以授权本地 FS 为文件事实源，按授权根下路径定位；不重新引入文件正文与数据库副本的 watcher 对账。通用 Agent 文件 CRUD 目标收敛到受授权 Shell，删除现有工具须先验证隔离、确认门和用户可观察行为；没有 Shell 的端不能假定具备任意命令能力。

工作区、个人文件和项目文件的磁盘操作由 `@gugu/fs/node` 提供，Host 将可信存储根和目录键绑定到文件操作实例。Core 保留工作区绑定、项目归属和文件引用等共享业务；回收站和附件引用按领域逐步迁移。

Agent 业务工具注册通过 `@gugu/core/tools/owner` 共用。宿主传入可信授权与领域端口，按实际能力注册 Schema、发现和派发。Web 配置白名单和 PostgreSQL 会话的幂等键生成由 Web Host 装配，Desktop 可提供自己的会话键与本地执行端口。

上述是目标职责，不代表现有业务均已完成共享化、双库适配或端到端验收。新增跨端能力直接遵循该边界；存量按完整业务切片迁移，保留旧 Python 的用户可观察行为与回归作为基准。更详细设计见[架构说明](../../docs/refactor/Gugu-2.0-架构说明.md)。

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

## SQLite 初始化与操作收据

Desktop 首次启动会以 `0001_initialize` 基线创建 SQLite。也可以用统一的 `migrate check|apply` 命令显式检查与初始化：

```bash
pnpm --filter @gugu/core build
pnpm --filter @gugu/core migrate apply --database "<本地数据库文件>"
pnpm --filter @gugu/core migrate check --database "<本地数据库文件>"
```

新库先在临时文件中完成建表和校验，再原子发布。已有文件必须带当前基线记录并通过校验，旧格式请使用新的文件路径。数据库记录的迁移编号和 Desktop IPC 使用的 schema 版本是独立字段。目录和行为见 [数据库迁移](../database/README.md)。

持久收据与业务写入同事务提交。相同操作 ID、方法与参数返回原结果，内容不同则报冲突。进程超时后，可凭操作 ID 查询是否已经提交。

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

v2 ready 声明 `undo_mind_v1` 后，本地 Worker 可在同一事务中提交 Mind 撤销状态与操作收据；相同请求重放不重复返回事件。调用方须保存写请求 UUID，结果未知时查询收据并重读数据。该能力不代表其他资源撤销或桌面 Mind 编辑流程已接通；v1 不开放 Undo。

## Agent 运行模块

实现按 Python 原职责放在 `agent/runner.ts`、`core.ts`、`models.ts`、`ports.ts`、`context/`、`run/`、`interactions/` 和 `memory/`。原 `agent/harness/` 已移除，不提供旧包导出或转发层。对应测试按职责分布在 `tests/agent/{context,core,run,interactions}/`。Provider、工具及持久 Job、租约与 outbox 通过显式端口接入。详见 [目录职责](src/agent/README.md)。

`@gugu/core/agent` 提供可移植的 Canonical 上下文与 Run 编排；`createCanonicalContextPort` 连接历史准备、稳定引用 checkpoint、工具轮次、交互结果替换和预算/压缩，`createAgentRunner` 协调启动/恢复/取消、工具调度、终态与 outbox。`@gugu/core/executor/runtime` 是现有共用 Executor 的可移植协调器，原 `/executor/platform` 保留同一类的兼容导出；原生后端仍由 Host 显式装配。

推荐通过 `createCanonicalRunner` 的 `runPreparation` 接入标准准备主链：owned 来源读取后并发发现工具与召回 RAG，再按可信入口/主体过滤能力、组装系统规则和技能快照，最后进入 Canonical。能力目录只接收过滤后 Schema 与当前 query；用户 Skill 元数据随首次 session snapshot 候选冻结，后续 Run 复用。定时任务不注入交互历史或 RAG，当前输入仅用于请求。选择后的名称和公开 schema 随 Run context 冻结，Provider 必须使用这一快照；未开放的工具声明在实际派发前拒绝。端口查询须响应取消并在返回前释放资源。自定义完整 `context.load` 可以省略标准准备选项，但必须提供同等准备结果及能力快照，缺失时入口明确失败。

这些入口不自动创建数据库、连接 Provider、注册工具或接管 Web/IM。生产装配必须实现 owner/session 互斥租约、fenced CAS RunStore、单次交互授权、Provider 归一事件与续接、稳定附件引用、错误清洗和事件发布。`prepareRequest` 必须按 Run 身份恢复同一冻结前缀，不能重启后套用新配置。成功 finalize 的 Canonical delta、用量、摘要水位与 outbox 必须同事务；中间 checkpoint 仅保留可恢复状态，失败不应用待提交压缩，取消只保存允许的中断 delta。工具处于未知状态时只查询收据，不自动重发修改。

完整反思 wire 快照仅保留进程内；Run checkpoint 不含媒体载荷、签名 URL、私有推理或授权材料。续接记录 ID 不是实现完成的证明，真实 Provider/Reasoning/Data 适配及重启恢复仍需独立验收。各 Python 行为与实际 TS 测试状态见 [Harness 映射](../../docs/testing/node-agent-harness-parity.md)，未闭合项不得解释为全部 Agent 已迁移或允许切换生产调用方。

## Provider 协议与 Harness 接线

`@gugu/core/providers` 提供实际的 Chat Completions、Responses、Anthropic 和 Ollama 原生请求、历史投影、流解析及非聊天分支。`connectProviderHarness` 将这些实现接入现有 Canonical Harness；Provider 不拥有 Run 状态、工具授权或执行器。可信 Host 必须提供选模/凭据解析、稳定模型和访问范围身份，以及已有上下文的引用 codec、请求准备和持久化端口。解析后的配置不从 Core 自动读取用户运行文件。

Node HTTP/DNS/TLS/代理实现单独从 `@gugu/core/providers/node` 导入。可移植入口不会隐式装载 Node、数据库或平台 SDK。传输固定已校验的 DNS 地址、拒绝自动重定向，连接/写/读空闲/池等待分别有预算；本地网络同时需要 Host 和显式 local/ollama 配置授权。Host 显式提供代理、CA 及 `networkIdentity`，网络配置改变后须使客户端池键失效；自定义 CA 不自动读取 `SSL_CERT_FILE`/`SSL_CERT_DIR`，SOCKS 代理明确不支持。

原生 thinking/signature 和实际请求 wire 仅存在有界进程内状态中，绑定 owner/session/run/model/访问范围；引用过期、进程重启或成功收尾后明确拒绝续接。该实现不是加密的跨进程 ReasoningStore。缓存前缀协调默认只在进程内排序，不共享模型答案；Redis 租约和续租仍需共享 runtime/Host adapter。完整请求探针只交给显式受控 sink，不能直接用于公开日志或用户事件。

Provider 的真实协议逻辑使用注入 HTTP 测试；测试替身只替换外部网络和存储，不能据此宣称已切换 Web/IM/Worker 或完成 BYOK、Tools、RAG、媒体文件探测/转码、数据库/Redis、持久 Job。逐 Python 定义、生产调用点及差异见 [Provider 回归映射](../../docs/testing/node-agent-provider-parity.md)。

目标架构、目录职责、迁移 checklist 与当前回归测试对齐任务统一见 [架构与迁移任务清单](../../docs/refactor/Gugu-2.0-架构与迁移任务清单.md)。历史方案和验证记录见 [归档索引](../../docs/refactor/_archive/gugu-2.0/README.md)。
