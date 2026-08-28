# PRD-ARCH-1：TypeScript 后端迁移与 API/Worker 分层架构

## 1. 文档状态

- 状态：规划中
- 类型：后端架构迁移
- 当前策略：渐进迁移，Python 旧 Agent backend 与 TypeScript 新链路并行；RAG 词法链路先独立迁移
- 当前目标：保留 Vue + Vite 前端，后端最终迁移为纯 TypeScript API 与独立 TypeScript Worker；不引入 Next.js
- LoopScope 迁移基线：复用 `feat/loopscope-0.3-ts-foundation` 的 Collector、Drizzle SQLite、contracts 和 trace-sdk
- 迁移原则：先建立边界，再逐模块替换；不通过一次性重写切断线上能力

## 2. 背景与目标

当前 Gugu-web 的主要后端能力集中在 Python/FastAPI，包括 Web API、Agent loop、工具调度、IM 消息循环、RAG、定时任务和上下文压缩。RAG 的 TypeScript worker 已经以固定构建物形式运行，但尚未形成完整的 TypeScript API 后端。

目标架构分为三层：

```text
Vue + Vite
└── Web/Admin 客户端

TypeScript API
├── Web/API
├── SSE/流式响应
├── 认证与用户设置
└── CRUD 与前端适配能力

TypeScript Worker
├── Agent runner
├── Tool dispatch
├── RAG / BM25 / 评分过滤
├── QQ / IM 消息循环
└── 定时任务

PostgreSQL + Redis
```

Python 暂时保留为旧 Agent backend，逐模块切换。迁移期 TypeScript API 作为新的 Web/API 入口，未迁移路由可以代理到 FastAPI；长生命周期任务由独立 Worker 承载。FastAPI 不是立即废弃，而是逐步从公开 API 主入口降级为旧 API 和内部 Python 服务。

## 3. 非目标与边界

TypeScript API 适合承载：

- Web API 和 CRUD；
- SSE、流式响应入口和状态查询；
- 认证、会话鉴权和用户设置；
- Admin 页面所需的服务端接口。

TypeScript API 不直接承载：

- 长时间 Agent loop；
- QQ、飞书、微信等常驻连接；
- 定时任务调度；
- 大量工具调用和长任务取消/恢复；
- 需要独立生命周期、重试和并发控制的后台工作。

这些能力放在独立 TypeScript Worker 中，API 只负责创建任务、读取状态、订阅结果和转发用户操作。

本 PRD 不要求一次性删除 Python，也不要求一次性迁移数据库。数据库 schema、Redis key 和外部 API contract 在迁移期间保持兼容。

## 4. 目标目录结构

目标仓库结构如下。`backend/py` 和 `backend/ts` 是语言边界；`backend/bin` 只放经过构建、可直接运行的制品，不放源码。

```text
Gugu-web/
├── frontend/                         # Vue Web 客户端，调用 TypeScript API
├── loopscope/                        # LoopScope 前端与可观测性界面
├── backend/
│   ├── py/                           # 迁移期间保留的 Python backend
│   │   ├── app/                       # FastAPI、认证、CRUD、管理接口
│   │   ├── agent/                     # 旧 Agent runner、工具、provider、上下文
│   │   ├── alembic/                   # 数据库迁移
│   │   ├── tests/                     # Python 回归测试
│   │   ├── worker.py                  # 旧 Worker 入口
│   │   ├── config.py                  # 迁移期配置兼容层
│   │   └── requirements*.txt
│   ├── ts/                            # 新 TypeScript 后端源码
│   │   ├── packages/
│   │   │   ├── contracts/             # OpenAPI/事件/工具/历史共享类型
│   │   │   ├── db/                    # PostgreSQL/Redis 访问 contract 与 adapter
│   │   │   └── config/                # 配置 schema 与环境变量解析
│   │   ├── api/                       # TypeScript API、认证、SSE、Admin API
│   │   └── workers/
│   │       ├── agent/                 # Agent runner 与 round 生命周期
│   │       ├── tools/                 # tool dispatch、confirm、取消和恢复
│   │       ├── rag/                   # RAG、BM25、评分、索引和注入
│   │       ├── im/                    # QQ/飞书/微信消息循环
│   │       └── scheduler/             # 定时任务与后台任务
│   ├── bin/                           # 固定运行时构建物
│   │   ├── gugu-rag-ts-worker.mjs
│   │   └── ...
│   ├── var/                            # 运行时索引、临时文件和本地状态
│   ├── Dockerfile
│   ├── Dockerfile.prod
│   └── config.override.json            # 用户运行配置，迁移期间不覆盖
├── packages/                           # 跨前端/后端的公开 contract（必要时）
├── docker-compose.yml
└── docs/
```

### 4.1 当前阶段的实际落点

在完整 Python 目录迁移前，允许保留当前可运行布局：

```text
backend/
├── app/
├── agent/
├── tests/
├── ts/
│   ├── packages/contracts/
│   └── workers/rag/
├── bin/
└── worker.py
```

先固定 `backend/ts` 与 `backend/bin`，再把 Python 源码整体移动到 `backend/py`。这样可以避免在 TS worker 尚未覆盖全部入口时，同时破坏 FastAPI、Alembic、systemd、Docker 和测试路径。

## 5. 分层职责

### 5.1 TypeScript API

- 接收 Web/Admin 请求并执行认证、权限和输入校验；
- 将 Agent、定时任务、IM 操作转换为统一 command；
- 通过 Redis/PostgreSQL 查询任务状态和历史；
- 通过 SSE 推送 Worker 事件；
- 不在 API 进程内运行不可控时长的 Agent loop。

### 5.2 TypeScript Worker

- 消费统一 command，创建 run/session 执行上下文；
- 负责 Agent runner、round、tool call/result 和取消/恢复；
- 负责工具注册、权限校验、确认交互和结果持久化；
- 负责 RAG 索引、BM25、评分过滤和注入；
- 持有 QQ/飞书/微信等常驻连接；
- 执行 scheduler、compaction 和 LoopScope 事件写入。

### 5.3 PostgreSQL 与 Redis

- PostgreSQL：用户、session、message、tool event、任务、索引元数据和审计状态；
- Redis：队列、取消信号、SSE fanout、短期锁、run 状态和 Worker 协调；
- 不在 TypeScript API、Worker 和 Python 中各自维护不可互转的状态格式。

### 5.4 ORM 与数据库访问

TypeScript 后端统一使用 Drizzle ORM，不引入 TypeORM。选择理由是 Drizzle 更接近 PostgreSQL 原生查询，类型从 schema 推导，适合 API 与长生命周期 Worker 共用，也能与现有 SQLAlchemy 查询保持清晰的语言边界。

```text
backend/ts/packages/db
├── schema/          # Drizzle PostgreSQL schema
├── repositories/    # 按领域封装查询和写入
├── transactions/    # 显式事务边界
└── client.ts        # PostgreSQL client
```

- Python 迁移期继续使用 SQLAlchemy 2.x Async ORM；
- TypeScript API 和 Worker 通过 `packages/db` 访问 PostgreSQL，不直接散落 SQL 或连接池；
- Python 与 TypeScript 不共享 ORM Model，只共享 `packages/contracts` 中的 DTO、command、event 和错误类型；
- 迁移期间 `backend/alembic` 仍是 PostgreSQL schema migration 的唯一负责人，不同时运行 Alembic 和 Drizzle Kit 迁移同一数据库；
- Drizzle schema 以现有数据库为基线，通过 introspection/parity 检查保持与 PostgreSQL 一致；
- Python 完全不再访问业务数据库后，才评估是否将 schema migration 交给 Drizzle Kit；
- Redis 不使用 ORM，由独立 Redis client 负责队列、锁、取消信号和带 TTL 的运行快照。

### 5.5 API 管理与 FastAPI 过渡

迁移期间采用单入口、分路由归属：

```text
Vue / Admin
    ↓
TypeScript API
    ├── 已迁移路由：TypeScript API 自己处理
    └── 未迁移路由：代理到 FastAPI
```

- 每条公开路由必须登记唯一 owner；同一条写接口不能由 FastAPI 和 TypeScript API 同时实现或双写；
- 已迁移模块由 TypeScript API 负责认证、权限、输入校验、响应错误格式和 OpenAPI 声明；
- 未迁移模块继续由 FastAPI 提供，TypeScript API 只做明确的代理，不复制业务逻辑；
- Admin 旧接口可以继续留在 FastAPI，直到对应 CRUD 完成 parity 和切换验证；
- 迁移期 FastAPI 的 OpenAPI 作为未迁移接口的 contract 来源，Phase 0 提供生成 TypeScript 类型的入口；
- TypeScript API 接管的接口必须纳入统一 OpenAPI 构建产物，CI 检查路径冲突、响应 schema 和错误格式；
- 最终由 TypeScript API 输出完整公开 OpenAPI，FastAPI 只保留内部 Python 服务或被删除，不再作为 Web API 主入口。

API 切换顺序固定为：实现 TypeScript 路由 → contract parity → 灰度/配置切换 → 观察调用与错误指标 → 关闭 FastAPI 代理 → 删除旧路由。任何路由都不得通过隐式异常 fallback 回到 FastAPI。

## 6. 实施 Todo

### Phase 0：Monorepo 与共享 contract

- [x] 建立 `backend/ts`、`backend/ts/packages/contracts` 和 Worker 基础工程；
- [x] 固定 TypeScript 编译、lint、test、Node runtime 和制品输出约定；
- [x] 建立从现有 FastAPI OpenAPI 生成并校验 TypeScript contract 的命令入口；
- [x] 定义 command、event、session、message、tool call/result、error 和 usage 类型；
- [x] 明确 PostgreSQL/Redis 的读写边界，禁止新旧实现各自扩展同一 contract。
- [x] 确定 TypeScript 使用 Drizzle、Python 保留 SQLAlchemy，迁移期由 Alembic 独占 schema migration。

### Phase 1：低风险 CRUD

按以下顺序迁移 TypeScript API：

- [ ] Projects；
- [ ] Files；
- [ ] Calendar；
- [ ] Preferences；
- [ ] Admin 配置与 LLM preset。

- [ ] 每个模块通过 contract parity 测试后切换前端请求入口；Python API 保留只读或回退窗口，确认无调用后再删除。

### Phase 2：RAG 与索引（拆分执行）

Phase 2 与其他后端迁移隔离，不依赖 API、Agent runner 或 IM 迁移。先完成词法输入边界，再迁移索引生命周期和注入层。

#### Phase 2A：Tokenizer 迁移（当前优先）

目标是让 RAG 的原文分词规则统一为 Jieba 词边界。生产链路由 TypeScript worker
接收原文并统一完成索引、查询和评分分词；Python 只负责权限、文档加载和结果回填。

- [x] 使用 `@node-rs/jieba` 提供中文词边界；中文不再追加单字，ASCII 不再追加 bigram；
- [x] ASCII/数字/下划线保留完整实体，并保留 `GTA 6`/`GTA6` 紧凑实体规则；
- [x] TS tokenizer 直接使用 golden corpus，索引和查询必须使用同一规则；
- [x] TS worker 的原文 tokenizer 通过 `tokenize` 协议验证，原生依赖随目标平台制品发布；
- [x] 建立 Python/TS golden corpus 对照测试，比较 token、BM25 排序、score/filter 和空输入行为；
- [x] Python 侧不再安装或加载 Jieba；历史评分 API 仅保留轻量字符串相似度兼容逻辑；
- [x] 验证 Unicode、中文长文本、数字组合、标点和异常字符不会改变现有召回结果。

- [x] Phase 2A 完成：`@node-rs/jieba` 适配后的 Python/TS 对照测试通过，索引 revision 包含 tokenizer 版本，原文 wire 已切换到 TS worker，并完成 RAG 质量基线测试。

#### Phase 2B：索引与注入迁移

- [ ] 迁移 snapshot cache、revision、TTL 和 RAG injection；
- [ ] 复用现有 `backend/bin/gugu-rag-ts-worker.mjs` 的制品边界；
- [ ] 把 RAG 结果、预算、版本、fallback 和耗时接入 LoopScope；
- [ ] 验证 owner/scope 隔离、索引持久化、重启恢复和缓存命中；
- [ ] `knowledge.document_load` 继续由 Python 负责，不把数据库访问错误地迁入 TS。

### Phase 3：Web chat gateway 与 SSE

- [ ] TypeScript API 接管 Web chat command、消息提交、取消、恢复和 SSE；
- [ ] Worker 负责真正的 Agent run；
- [ ] 前端只消费统一 event，不再维护 Python/Web 各自的流式事件解释；
- [ ] 保持消息顺序、run/round 归属和交互气泡持久化一致。

### Phase 4：Agent runner 与 tool dispatch

- [ ] 迁移 canonical history、snapshot、ContextBudget、compaction 和 provider adapter；
- [ ] 迁移 tool/skill 注册、按需注入、声明工具和确认门；
- [ ] 迁移 ask_user、goal、stop、compact 等交互协议；
- [ ] 支持长任务取消、恢复、重试、并发限制和幂等提交；
- [ ] 对 OpenAI-compatible、Anthropic、DeepSeek、MiniMax、百炼和 GLM 保持统一 canonical contract。

### Phase 5：IM Worker

- [ ] 迁移 QQ、飞书、微信接入和消息归一化；
- [ ] 迁移群聊/私聊权限、引用附件、群友记忆、流式回复和 keyboard；
- [ ] 所有平台统一转为 Worker command/event，平台差异只存在 adapter；
- [ ] 验证断线重连、消息去重、发送失败重试和 trace 归属。

### Phase 6：Scheduler、compaction 与 LoopScope

- [ ] 迁移定时任务执行、任务状态和结果回传；
- [ ] 迁移压缩、TTL、snapshot baseline 更新；
- [ ] 迁移完整 LoopScope trace、usage、cache、tool schema 和 RAG provenance；
- [ ] 删除 Python 旧实现前完成全量回归、故障注入和数据一致性检查。

## 7. 兼容与切换策略

- 每个模块只能有一个 canonical contract；
- 新旧实现通过同一 command/event 或 service contract 连接；
- 迁移期每条 API 路由只能有一个写入 owner，代理层不得改变请求和响应语义；
- 迁移期间允许 Python 调用 TS worker，但不允许 TS 重新解析 Python 私有结构；
- OpenAPI 采用分阶段单一来源：未迁移路由来自 FastAPI，已迁移路由来自 TypeScript API，最终统一由 TypeScript API 生成；
- 切换使用显式配置、模块级 feature flag 或路由切换，不依赖隐式异常 fallback；
- fallback 必须记录原因、版本、阶段和耗时，不得把真实错误伪装成空结果；
- 数据写入采用单写者原则，避免 Python 与 TypeScript 同时更新同一状态；
- 迁移完成后先删除旧入口，再删除兼容 adapter、feature flag 和死代码。

## 8. 运行与构建约束

- TypeScript API、Worker 和共享包统一使用锁定的 Node.js 版本；
- TypeScript 数据访问统一经过 `packages/db`；ORM Model 不跨语言共享，数据库 schema 迁移保持单一负责人；
- 开发时可使用 watch 构建，生产和 devserver 只消费预构建制品；
- `backend/bin` 是唯一运行时制品目录，不在启动时安装 npm 依赖或编译源码；
- Docker 构建阶段完成依赖安装和制品构建，Compose 只消费构建物和挂载的运行数据；
- PostgreSQL、Redis、文件存储和沙箱由 Compose/部署层提供，应用只读取连接配置；
- 用户配置、密钥、数据库数据和运行时索引不得被构建流程覆盖。

## 9. 验收标准

- 同一输入在 Python 与 TypeScript 链路产生等价的 API、事件、消息、工具和任务状态；
- Web、QQ、飞书、微信和定时任务都能落到统一 run/session/event 模型；
- Agent 长任务可创建、执行、暂停、取消、恢复，并且不会因 API 请求生命周期结束而中断；
- RAG、工具调用、交互气泡、LoopScope 和 usage 在新旧入口中可追踪；
- 数据库迁移、Redis 队列、文件存储和权限隔离通过全量测试；
- Python 旧入口删除后，仓库中不存在未使用的兼容路由、旧 adapter、feature flag 和启动脚本；
- 发布包只包含 TypeScript API、Worker、共享 contract、固定制品和必要运行资源，不包含用户数据。

## 10. 风险与禁止事项

- 不把长任务放进 API 请求处理器；
- 不在迁移初期移动全部 Python 目录，避免同时破坏 imports、Alembic、Docker 和 systemd；
- 不让 TypeScript API 和 Worker 各自拼装不同的 Agent context；
- 不让平台 adapter 直接修改 canonical history；
- 不通过重复写库、重复消费或无限重试掩盖事件丢失；
- 不在没有 parity、回归和数据备份的情况下删除 Python 实现。

## 11. 实施 Todo

- [x] 创建 TypeScript workspace、共享 contract 和 Node 版本约束；
- [x] 从 FastAPI OpenAPI 生成并校验 TypeScript API contract；
- [x] 固定 TypeScript API、Worker、shared packages 的构建与发布流程；
- [x] 确定 TypeScript 使用 Drizzle、Python 保留 SQLAlchemy，迁移期由 Alembic 独占 schema migration；
- [ ] 完成 Projects、Files、Calendar、Preferences CRUD parity；
- [x] Phase 2A：引入 `@node-rs/jieba`，统一 Jieba 词 + ASCII 完整实体规则；
- [x] Phase 2A：建立 tokenizer golden corpus、TS 调试协议和跨语言对照测试基线；
- [x] Phase 2A：完成原始文档语料对照、重建索引并复测 RAG 质量；
- [x] Phase 2A：移除生产路径中的 Python Jieba 预分词并清理 Python 依赖；
- [ ] Phase 2B：完成 RAG、snapshot cache 和 RAG injection 迁移；
- [ ] 完成 Web chat gateway 与 SSE 迁移；
- [ ] 完成 Agent runner、tool dispatch、compaction、取消/恢复迁移；
- [ ] 完成 QQ、飞书、微信 Worker 迁移；
- [ ] 完成 scheduler、LoopScope 和全量回归；
- [ ] 删除 Python 旧入口与迁移期兼容代码；
- [ ] 更新 Docker、Compose、systemd、部署文档和开发者文档。
