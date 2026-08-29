# PRD-ARCH-3 LoopScope 后端 TypeScript 迁移

## 1. 文档状态

- 状态：Phase 0、Phase 1、Phase 2、Phase 3 已完成，Phase 4 待实施
- 前置：LoopScope 0.1、0.2 已完成；`PRD-ARCH-2-pnpm依赖管理迁移` 负责统一 JavaScript/TypeScript 包管理。
- 可复用基础：`feat/loopscope-0.3-ts-foundation` 已提供 TypeScript Collector、Drizzle SQLite、shared contracts 和 trace-sdk 的基础实现。
- 目标：将旧的独立 FastAPI + SQLite 服务迁移为 TypeScript Collector，同时保持 Collector 协议、SQLite 数据和 LoopScope 前端行为兼容。

## 2. 背景与目标

LoopScope 是 Gugu 的开发调试工具，不承载 Agent 主链路。当前后端使用 Python FastAPI，主要负责接收完整 Run snapshot、写入 SQLite，并为前端提供 Session、Run、Span 查询。

迁移的目标是：

1. 让 LoopScope 后端与未来 TypeScript API、Worker 使用同一语言和共享类型体系。
2. 保留 LoopScope 的独立进程、独立数据库和独立仓库边界。
3. 不改变 Gugu Agent 的 Trace 上报协议和 best-effort 特性。
4. 在迁移期间允许 Python 版本和 TypeScript 版本并行对照运行，并可无损回退。
5. 为后续 Trace schema、Run diff、实时事件和权限控制预留明确边界。

本次不从零重写。优先从 `feat/loopscope-0.3-ts-foundation` 提取已经完成的后端基础，再围绕当前 Vue 前端和 0.2 API 补齐兼容差异。

## 3. 非目标

- 本 PRD 不迁移 Gugu Python Agent、FastAPI 主 API、QQ/IM worker 或 scheduler。
- 不把 LoopScope 数据库直接并入 Gugu PostgreSQL。
- 不在迁移时引入 Next.js；LoopScope API 服务和 Gugu TypeScript API 是两个独立服务。
- 不把 LoopScope 前端重写成 React 或 Next.js 页面，继续使用 Vue + Vite。
- 不改变现有 Trace payload 的语义，不通过兼容层吞掉非法字段。
- 不在采集接口中写入 token、密钥、用户正文或未脱敏凭据。

## 4. 当前实现盘点

### 4.1 服务边界

当前目录：

```text
loopscope/apps/collector/
├── pyproject.toml
├── Dockerfile
├── loopscope/
│   ├── main.py
│   └── storage.py
└── tests/
    ├── test_api.py
    ├── test_storage.py
    └── test_storage_v02.py
```

`main.py` 只有以下接口：

```text
GET  /api/health
POST /api/collector/runs
GET  /api/sessions
GET  /api/sessions/{session_key}/runs
GET  /api/runs/{run_id}
GET  /api/runs/{run_id}/spans
```

### 4.2 数据层

`TraceStore` 使用同步 SQLite，默认开启 WAL 和外键：

```text
loopscope/data/loopscope.db
```

当前表：

```text
sessions
  session_key TEXT PRIMARY KEY
  external_session_id TEXT
  source TEXT
  title TEXT
  created_at REAL
  updated_at REAL

runs
  id TEXT PRIMARY KEY
  session_key TEXT REFERENCES sessions(session_key)
  trace_id TEXT
  status TEXT
  started_at REAL
  ended_at REAL
  duration_ms REAL
  input_json TEXT
  output_json TEXT
  attributes_json TEXT
  usage_json TEXT
  raw_json TEXT

spans
  id TEXT PRIMARY KEY
  run_id TEXT REFERENCES runs(id)
  parent_span_id TEXT
  kind TEXT
  name TEXT
  status TEXT
  started_at REAL
  ended_at REAL
  duration_ms REAL
  input_json TEXT
  output_json TEXT
  attributes_json TEXT
  code_json TEXT
  usage_json TEXT
  token_impact_json TEXT
  ordinal INTEGER
```

Collector 使用 `INSERT OR REPLACE` 写入 Run，并先删除再重建该 Run 的 spans，因此重复上报同一个 Run 是幂等的。

### 4.3 主要耦合

| 位置 | 耦合内容 | 迁移影响 |
|---|---|---|
| Gugu `loopscope_trace` hook | `POST /api/collector/runs` payload | 必须保持请求字段和失败语义 |
| LoopScope 前端 | 6 个 HTTP API、分页参数和返回字段 | 保持 URL、JSON shape、错误状态 |
| SQLite 文件 | 已有 `loopscope.db` | TypeScript 必须可直接读取旧库 |
| Docker Compose | `4320`、`/data` volume、health | 保持服务名、端口和卷路径 |
| `/dev` bootstrap | LoopScope 地址与 Gugu API 连接配置 | 不改变 token/地址传递方式 |

## 5. 难度与结论

### 5.1 难度评估：低到中

业务逻辑少，接口数量少，数据模型清晰，因此核心迁移难度较低；但以下三项需要认真处理：

1. **SQLite 驱动与并发写入**：Node SQLite 驱动、WAL、事务和连接关闭行为必须稳定，不能因为异步并发导致数据库锁冲突或半写入。
2. **历史数据库兼容**：现有数据库通过启动时 `ALTER TABLE` 增加列，TypeScript 版本必须继续兼容已有表和旧版本数据。
3. **Collector 隔离**：采集接口必须继续快速返回，写入失败只影响调试数据，不阻塞 Gugu Agent；不能把数据库慢写入传播到 Agent 请求。

### 5.2 推荐路线

推荐先迁移为**独立 TypeScript + Node HTTP 服务 + SQLite**，暂不引入 Next.js。分支中的 Collector 已采用 Node 原生 HTTP；除非兼容测试证明需要，否则不额外替换 HTTP 框架。

原因：

- LoopScope 后端是独立的采集/查询服务，不需要 Next.js 的页面渲染或用户 CRUD。
- 保持独立服务可以降低对 Gugu 主后端的影响面。
- TypeScript Worker、LoopScope 和未来共享 contract 可以复用同一套类型包。
- 未来如果确实需要统一入口，可以再由 TypeScript API 代理 LoopScope API，而不是让 LoopScope 自己承担 Gugu 业务鉴权。

### 5.3 分支复用边界

允许直接复用或提取：

- `loopscope/apps/collector/src/server.ts` 的 HTTP Collector 骨架；
- `loopscope/apps/collector/src/store.ts` 的 Run/Span 写入和查询逻辑；
- `loopscope/packages/db` 的 Drizzle schema、SQLite WAL 和增量迁移；
- `loopscope/packages/contracts` 的 Zod 输入校验与 Trace 类型；
- `loopscope/packages/trace-sdk` 的 TypeScript 上报 SDK；
- `loopscope` 根部的 pnpm workspace 组织方式。

不直接复用：

- `loopscope/apps/web` 的 Next.js + React 前端；
- 分支中删除旧 Vue 前端和 Python 后端的提交；
- 与 LoopScope 无关的 Gugu 前端、Runtime 或样式变更。

## 6. 目标目录结构

迁移后建议保持 LoopScope 前后端目录边界，同时将后端纳入仓库 pnpm workspace：

```text
loopscope/
├── backend/
│   └── src/
│       ├── main.ts                 # HTTP 服务启动
│       ├── app.ts                  # 路由与中间件装配
│       ├── config.ts               # 环境变量与默认值
│       ├── routes/
│       │   ├── health.ts
│       │   ├── collector.ts
│       │   ├── sessions.ts
│       │   └── runs.ts
│       ├── storage/
│       │   ├── sqlite.ts            # SQLite 连接、WAL、事务
│       │   ├── schema.ts            # 建表与增量迁移
│       │   ├── trace-store.ts       # Session/Run/Span 持久化
│       │   └── serializers.ts       # JSON 字段读写与 shape 校验
│       ├── contracts/
│       │   ├── collector.ts         # Collector 输入类型
│       │   └── trace.ts             # API 返回类型
│       └── errors.ts
│   ├── tests/
│   │   ├── api.test.ts
│   │   ├── storage.test.ts
│   │   ├── storage-migration.test.ts
│   │   └── collector-idempotency.test.ts
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   └── ...
└── data/
    └── loopscope.db              # 运行时 volume，不提交 Git
```

共享类型优先放入：

```text
backend/ts/packages/contracts/src/loopscope.ts
```

但 LoopScope 后端仍应保留 HTTP 边界自己的输入校验，不能只相信内部 TypeScript 类型。

## 7. API 兼容契约

### 7.1 Collector

`POST /api/collector/runs`：

- `id` 和 `session_key` 缺失时返回 HTTP 400。
- 相同 `id` 重复上报必须覆盖同一 Run，而不是产生重复 spans。
- spans 按输入顺序生成稳定 `ordinal`。
- 写入失败返回明确 5xx，并记录脱敏诊断；不能返回成功假象。
- 不记录 raw payload 到日志；数据库中的 `raw_json` 是否继续保存，需要在实施阶段确认保留期限和隐私策略。

### 7.2 查询

- 保持现有路径、分页参数、字段命名和排序。
- `GET /api/runs/{run_id}` 找不到时返回 404。
- `include_spans=false` 时不查询或返回 spans。
- spans 分页继续返回 `items`、`offset`、`limit`、`hasMore`。
- JSON 字段解析失败不得静默改成空对象；应返回可诊断的存储错误，或在迁移前完成数据修复。

### 7.3 健康检查

`GET /api/health` 至少返回：

```json
{
  "ok": true,
  "version": "0.2.0",
  "db": "/data/loopscope.db"
}
```

路径可以脱敏为逻辑路径，但字段含义保持兼容。

## 8. 数据库迁移策略

### 8.1 不更换数据库

第一阶段继续使用 SQLite，不迁移 PostgreSQL。这样可以：

- 直接复用已有 LoopScope 数据；
- 保持单机开发和 Docker volume 体验；
- 避免把调试数据引入 Gugu 生产数据库；
- 将迁移范围限制在 HTTP 服务和数据访问层。

### 8.2 启动迁移

TypeScript 启动时执行幂等 schema migration：

1. 创建缺失表和索引。
2. 检查并补齐 `usage_json`、`code_json`、`token_impact_json` 等历史列。
3. 不删除旧列、不清空历史数据、不重建数据库文件。
4. 迁移失败时服务启动失败，不能使用空库继续运行。
5. 正式迁移前备份 `/data/loopscope.db`，并在测试中验证旧库读取。

## 9. 分阶段实施 TODO

### Phase 0：分支实现审查与契约冻结 ✅

- [x] 基于 `feat/loopscope-0.3-ts-foundation` 审查 Collector、DB、contracts 和 trace-sdk，记录可直接提取的文件与需要改写的部分。
- [x] 确认分支中的 Drizzle schema、SQLite migration、Collector 和 trace-sdk 可以作为 Phase 1 基础。
- [x] 记录 Python 版本接口响应与 SQLite schema 快照，冻结旧 API、字段和分页兼容要求。
- [x] 明确 Node、pnpm、`better-sqlite3`、Drizzle 和 Node HTTP 的迁移组合。
- [x] 建立脱敏 payload 对照范围；真实用户 trace 不进入仓库，fixture 在 Phase 1 测试中补齐。

验收：已完成分支代码审查和兼容边界冻结；未切换当前 `dev` 的 LoopScope 服务，未触碰用户数据库。

### Phase 1：提取 TypeScript Storage Core

- [x] 从 `feat/loopscope-0.3-ts-foundation` 提取 SQLite 连接、WAL、外键、事务和关闭流程。
- [x] 复用并审查其 schema 初始化与历史列迁移，不重复实现第二套迁移器。
- [x] 复用 `TraceStore` 的 ingest/list/get 方法，补齐当前 Python API 所需行为。
- [x] 保持重复 Run 上报幂等。
- [x] 为旧 SQLite fixture 增加读写回归。

验收：已建立 `@loopscope/db`、`@loopscope/contracts` 和 `@loopscope/storage`；类型检查通过，临时新库/旧库迁移/重复 Run 上报测试通过。未切换当前 Python 服务，未触碰现有用户数据库。

### Phase 2：HTTP API 兼容补齐

- [x] 复用分支 Collector 的 health、collector、sessions、runs 路由。
- [x] 补齐旧版 `/api/runs/{run_id}/spans` 接口。
- [x] 补齐 `list_runs` 的 `limit`、`before` 分页参数和当前排序。
- [x] 增加请求 shape 校验、分页边界和错误映射。
- [x] 用前端现有服务逐项验证 API，不修改前端 URL。
- [x] 保持 CORS 配置行为和 `4320` 默认端口。

验收：Collector 类型检查和构建通过；隔离临时库 HTTP smoke test 已验证 health、ingest、Session Run 分页、Run Span 分页和 404；未切换当前 Python 服务或生产端口。

### Phase 3：并行对照与切换

- [x] 同一脱敏 parity fixture 分别写入 Python 和 TypeScript 临时数据库。
- [x] 对比 Session/Run/Span 查询 JSON，允许仅有 JSON 序列化顺序差异。
- [x] 对比重复上报、部分 spans、错误状态和 usage 数据；大 payload 由 HTTP 24MB 上限和隔离 smoke test 覆盖。
- [x] 在本地以独立端口运行 TypeScript 版本并验证 health、ingest、查询和 404。
- [x] 通过环境变量配置 Collector endpoint，当前默认仍保留 Python 服务，未切换生产入口。

验收：Python 相关对照测试 7 项通过；TypeScript parity/storage/collector 类型检查通过；隔离 HTTP smoke test 通过。发现的 context/usage/artifact 属于 TS 迁移增量，已记录在对照报告中。

### Phase 4：Docker、devserver 与清理

- [x] 新增 `loopscope/apps/collector/Dockerfile`，使用 Node/pnpm 构建 TypeScript Collector。
- [x] 保持 `/data` volume、`4320` 端口，并为 TS Collector 增加 healthcheck。
- [x] 更新 LoopScope Compose、workspace build 脚本和 README；本分支没有独立 LoopScope Makefile/CI，暂不新增重复入口。
- [x] 清理 Python 后端和旧 `.pytest_cache`、egg-info 等构建残留。
- [x] devserver 已切换 `4320` 到 Node TypeScript Collector；使用仓库外的 `~/loopscope-data/loopscope.db` 全新数据库，旧损坏库未接入。
- [x] TypeScript 版本已稳定接管 devserver，删除 Python 入口，不保留双份生产实现。

验收进度：TS workspace 构建、临时数据库启动、前端查询回归和 Python 对照测试通过；devserver 已由 Node TS Collector 监听 `4320`，远端 health 已返回 `runtime=node`、`orm=drizzle`。旧 Python 入口已清理，旧损坏数据库未接入；本机没有 Docker CLI，镜像构建仍待有 Docker 环境验证。

## 10. 测试矩阵

| 类别 | 覆盖内容 |
|---|---|
| 单元测试 | 序列化、分页、排序、状态映射、schema migration |
| 存储测试 | 新库、旧库、WAL、事务回滚、重复 Run、外键级联 |
| API 测试 | 6 个接口、400/404/5xx、CORS、分页边界 |
| 兼容测试 | Python/TypeScript 相同 fixture 的响应和数据库结果对比 |
| 前端 E2E | Session、Run、Span、monitor、空状态、错误状态 |
| 运行测试 | Collector 服务不可达、数据库锁、进程重启、volume 恢复 |
| 安全测试 | 不把 token、凭据、用户正文写入日志；路径和输入不越权 |

## 11. 风险与处理

### SQLite 驱动差异

优先选择有稳定预编译包和 Linux/macOS 支持的驱动。若 native 安装在 CI 或 Docker 不稳定，必须在 Phase 0 评估替代方案，不能等到生产镜像阶段才发现。

### 旧库升级破坏历史数据

所有 migration 必须幂等、可回滚或可从备份恢复。迁移前不得直接操作用户的正式数据库；先复制到临时目录执行读取、写入和重启测试。

### Collector 慢写入影响 Agent

TypeScript Collector 仍应采用快速接收和明确错误返回；Gugu hook 继续 best-effort、带超时、异步发送。LoopScope 不能反向调用 Gugu 获取正文或补全数据。

### 过早引入全栈前端框架

LoopScope 当前没有必要依赖 Next.js。若未来需要统一认证或入口，应由独立 TypeScript API 增加适配层，不能让前端框架的页面请求直接承担 SQLite 长写入和 Trace ingest 的全部职责。

## 12. 完成标准

1. TypeScript 服务完整替代旧 Python LoopScope 生产入口。
2. 旧 `loopscope.db` 无损升级并可查询历史 Session、Run、Span。
3. LoopScope 前端无需修改 API 路径即可正常工作。
4. Gugu Collector 上报成功、失败、重复上报和不可达场景均符合原有语义。
5. Docker、devserver、CI 使用固定 pnpm/Node 构建，默认端口仍为 `4320`。
6. Python 后端入口、旧依赖和兼容实现已清理，不保留两套生产逻辑。
7. 所有日志和测试 fixture 都经过脱敏，不包含真实用户数据、附件内容、token 或签名 URL。
