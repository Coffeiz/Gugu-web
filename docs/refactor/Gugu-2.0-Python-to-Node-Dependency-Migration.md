# Gugu 2.0 — Python → Node.js / TypeScript 全量依赖迁移矩阵

> **专题参考**：整体架构、目录职责、完成状态与当前任务统一见 [架构与迁移任务清单](Gugu-2.0-架构与迁移任务清单.md)。本表不作为另一份实施路线或完成率清单。
> **2026-11-12 对齐**：首批 Core 已采用 Kysely、Zod、better-sqlite3、pg 与 Node 26；Drizzle 等并列项保留为原始候选，不代表同时采用。其他依赖只有存在真实迁移调用链及验收结果时才能标为已替换。
> 下文的 PR #116 和 Python 包位置是盘点基线；原 Python Core/Desktop 包当前分别位于 `compat/core-python/`、`compat/desktop-python/`。仍有调用方的 Python 依赖不能直接删除。

> 状态：技术迁移计划草案（待 PoC 与回归确认）\
> 基准：`Coffeiz/Gugu-web` PR #116，`codex/core-data-desktop-v2`，提交 `020ed06100bbd1f946ee2f277afa2b537fd64677`\
> 编制日期：2026-11-11\
> 目标：以 TypeScript 为统一业务/Agent Core，Node.js 承载 SaaS 和桌面 Runtime，Vue 3 + Vite UI 与 Tauri 2 尽量保持。移动端共享**可移植 TS Core**，不假定可运行完整 Node.js。\
> 本文是**依赖替换与迁移验收清单**，不是“npm 包功能已经与 Python 完全等价”的声明。

## 0. 范围、原则与标记

**盘点范围**

- `backend/requirements.txt`：全部生产直接声明及安全约束依赖。
- `backend/requirements-dev.txt`：全部开发与测试依赖。
- `gugu-core/pyproject.toml`：`sqlalchemy[asyncio]`、`aiosqlite`、可选 `asyncpg`、构建系统。
- `gugu-desktop/pyproject.toml`：Python Desktop Host 及其 `gugu-core` 依赖。
- 系统级/运行时：FFmpeg、Poppler、Cython 原生内核、数据库、Redis、MXC、文件监听、Tauri Sidecar 与进程管理。
- 依据现有代码路径标注行为兼容要点。**没有完成全仓动态 import 与 transitive dependency 穷举**；应在实施时自动化扫描并锁定最终 npm 依赖树。

**迁移等级**

- **E（容易）**：Node 标准库或成熟替代品，API 重写为主。
- **M（中）**：业务/协议/事务语义需要适配与回归。
- **H（困难）**：原生模块、数据质量、跨平台或者复杂行为等价。
- **N/A**：Python 生态的构建/传递依赖；移除旧依赖即可，但必须重审新依赖图。

**状态**：`候选` = 尚未通过 Gugu 场景验收；`复用` = 系统组件继续使用；`移除` = TS 架构无需对应库。所有候选都要求安装、许可证、安全与平台可用性复核。

## 1. 生产依赖：逐项完整映射

### 1.1 HTTP、数据库、事务、任务

| Python 依赖（原约束） | 用途 | Node/TS 目标候选 | 难度 | 必须验收 |
|---|---|---|---|---|
| `fastapi>=0.111.0` | REST、依赖注入、SSE | `fastify`（推荐）/ `hono` / Nitro | M | API 状态码、OpenAPI、鉴权、取消、流式行为 |
| `uvicorn[standard]>=0.29.0` | ASGI 服务与进程 | Node HTTP / Fastify 服务器；`ws` | E | graceful shutdown、代理头、SSE 断连 |
| `sqlalchemy>=2.0.0` | ORM、事务、模型 | `drizzle-orm` 或 `kysely`（择一） | H | 原 SQL、跨域事务、CAS、查询顺序、所有者隔离 |
| `aiosqlite>=0.20,<1` | Core SQLite、本地/测试库 | `better-sqlite3`（桌面 Node）或 `node:sqlite`（经验证） | M | WAL、锁、忙等待、崩溃恢复、备份、迁移 |
| `greenlet>=3.0.0` | SQLAlchemy 异步桥 | 无需对应库 | N/A | 无残留 Python 桥接 |
| `alembic>=1.13.0` | PostgreSQL 迁移 | `drizzle-kit` / `kysely` migration | H | **必须承接全部历史 revision**、不能破坏现有生产库 |
| `asyncpg>=0.29.0` | PostgreSQL 驱动 | `postgres`（postgres.js）或 `pg` | E | Pool、事务、JSONB、时区、超时 |
| `redis>=5.0.0` | Streams、PubSub、锁、队列 | `ioredis`（推荐）/ `redis` | M | XREADGROUP、ack、pending 恢复、Lua 锁、重连 |
| `apscheduler>=3.10.0` | cron/interval/once、运行窗口 | `cron-parser` + DB 调度层；按需 BullMQ | H | coalesce、misfire、时区/DST、重复触发、恢复 |
| `python-multipart>=0.0.9` | Multipart 上传 | `@fastify/multipart` / Web `FormData` | E | 大文件限额、流式上传、路径/类型安全 |

### 1.2 安全、网络与结构验证

| Python 依赖（原约束） | 用途 | Node/TS 目标候选 | 难度 | 必须验收 |
|---|---|---|---|---|
| `python-jose[cryptography]>=3.3.0` | JWT | `jose` | M | 旧 JWT 可验证、alg 白名单、过期/受众校验 |
| `cryptography>=50.0.0` | AES/HKDF 等 | `node:crypto`（优先）/ WebCrypto | M | 已存 IM 凭据**原样可解密**、密钥派生一致 |
| `passlib[bcrypt]>=1.7.4` | 密码哈希兼容 | `bcrypt` 或 `bcryptjs` | M | 旧 hash 前缀/成本因子可验证；不强制用户重置 |
| `pydantic-settings>=2.0.0` | 配置装载与验证 | `zod` + 明确的配置加载器 | M | 配置优先级、脱敏、热加载、默认值 |
| `httpx==0.28.1` | HTTP 客户端/自定义传输 | `undici` / `fetch` + 自定义 dispatcher | H | `_PinnedHTTPTransport` 的 DNS、连接、重定向与 SSRF 约束 |
| `httpcore==1.0.9` | HTTPX 内部 transport | `undici` 对应底层能力（非逐 API 替代） | H | 不可只用 fetch 而丢失内网地址拦截 |
| `h2>=4.1,<5` | HTTP/2 | `node:http2` / 客户端协议栈 | M | 代理协商、长连接、流控 |
| `aiohttp>=3.14.4` | 异步 HTTP/WS | `undici` + `ws` | M | IM/WebSocket 心跳、断线与背压 |
| `jsonschema>=4.23.0,<5.0.0` | JSON Schema 校验 | `ajv`（JSON Schema）/ `zod`（领域） | M | Draft 方言、additionalProperties、默认值/错误格式 |
| `httpx2>=2.10.0,<3.0.0` | MCP TS-like HTTPX2 桥接 | MCP TS SDK transport + 应用受控 HTTP 层 | H | 会话、streamable HTTP、安全传输桥接契约 |

### 1.3 AI、协议、IM、云服务

| Python 依赖（原约束） | 用途 | Node/TS 目标候选 | 难度 | 必须验收 |
|---|---|---|---|---|
| `openai>=3.31.0,<4.0.0` | OpenAI-compatible provider | 官方 `openai` Node SDK | M | 兼容厂商、tool_calls、usage、错误/stream chunk |
| `anthropic>=1.14.0,<2.0.0` | Anthropic 协议 | `@anthropic-ai/sdk` | M | 异常事件顺序、缺块停止、参数截断恢复 |
| `mcp==2.3.0` | MCP 会话/Client/Server | `@modelcontextprotocol/client` + `@modelcontextprotocol/server` v2 | H | stdio/HTTP、鉴权、工具发现、取消与断线恢复 |
| `lark-oapi>=1.7.4,<2.0.0` | 飞书 WS 长连/API | `@larksuiteoapi/node-sdk` | M | 消息事件顺序、卡片交互、重连、媒体上传/下载 |
| `oss2>=2.18.0` | 阿里云 OSS | `ali-oss`（候选） | M | 分片上传、签名 URL、分页、权限、迁移回滚 |

> QQ 目前为 raw WebSocket + HTTP；微信 iLink 有独立适配代码，它们**虽不是上述 pip 包**，仍须迁移消息、媒体、幂等、Gateway、trace_id 与重试逻辑。

### 1.4 搜索、多语言、日期和通用工具

| Python 依赖（原约束） | 用途 | Node/TS 目标候选 | 难度 | 必须验收 |
|---|---|---|---|---|
| `rjieba==0.2.2` | 中文 RAG 分词（jieba-rs） | `@node-rs/jieba` | M | HMM=false、词典/版本、Token 与 BM25 排序 |
| `pypinyin>=0.50.0` | 中文拼音 | `pinyin-pro` | M | 多音字、文件名搜索候选、索引迁移 |
| `SudachiPy>=0.6.11` | 日语切词/读音 | `kuromoji` 或 Rust Sudachi 桥接（PoC 决定） | H | 专有名词、SplitMode.C、词典差异 |
| `sudachidict_small>=20260723` | Sudachi 日语词典 | Node 词典包或同源 Sudachi 词典 | H | 字典版本/体积/许可证、日语索引重建 |
| `romkan2>=0.1.1` | 假名罗马音 | `wanakana` + Gugu 归一化 | M | Hepburn 长音、片假名、边界 |
| `uuid6>=2024.1.12` | UUIDv6 | `uuid`（验证 v6 支持） | E | 字符串规范、排序、跨端实体 ID |
| `email-validator>=2.0.0` | 邮件地址验证 | `validator` / `isemail` | M | IDN、Unicode、输入策略一致 |
| `pendulum>=3.0.0` | 时区与时间 | `@js-temporal/polyfill` / `luxon` | M | UTC、DST、cron/时区转换、序列化 |
| `python-dotenv>=1.0.0` | 环境配置 | Node `--env-file` / `dotenv` | E | 配置层级、生产密钥不泄露 |
| `msgpack==1.2.3` | MessagePack | `@msgpack/msgpack` | M | 二进制协议、扩展类型、兼容旧数据 |
| `setuptools==84.0.0` | Python 构建与安全固定 | `pnpm` + `tsup`/`rolldown`，移除 Python 打包 | N/A | 锁文件与供应链扫描 |

### 1.5 媒体、网页与 Office 文件

| Python 依赖（原约束） | 用途 | Node/TS 目标候选 | 难度 | 必须验收 |
|---|---|---|---|---|
| `Pillow>=13.0.0` | 图片读取、缩略图 | `sharp` | M | EXIF、方向、透明图、多帧、大图安全限制 |
| `pillow-heif>=0.16.0` | iPhone HEIC/HEIF | `sharp`（经验证的 HEIF/libheif build）/ 独立 `libheif` | H | 实机 HEIC/HEIF、授权/编解码器、跨平台包 |
| `pilk>=0.2.4` | QQ/微信 SILK → PCM | SILK 原生解码器或 WASM 包；FFmpeg 后处理 | H | 腾讯头、24k/单声道、错误音频、Windows/macOS；许可证审查 |
| `trafilatura>=2.0.0` | 网页正文抽取 → Markdown | `@mozilla/readability` + `jsdom`，必要时 `cheerio` | H | 中文页面、动态站点、链接、表格与正文质量 |
| `python-docx==1.1.2` | DOCX 文本 | `mammoth` 或 OOXML 解析 | M | 段落顺序、表格、页眉脚、批注 |
| `openpyxl==3.1.5` | XLSX 文本 | `exceljs` / `xlsx`（许可证确认） | M | 公式缓存、合并单元格、多个 sheet |
| `xlrd==2.0.1` | 旧 XLS | 支持 BIFF8 的 XLS 解析器（PoC 选型） | H | .xls 兼容性、日期序列、编码 |
| `python-pptx==1.0.2` | PPTX 文本 | OOXML 专用抽取适配器 | H | 文字框、组合形状、表格、备注、排序 |
| `striprtf==0.0.28` | RTF 文本 | RTF parser / 转换工具（PoC） | H | Unicode 转义、嵌套样式、容错 |
| `odfpy==1.4.1` | ODF 文本 | ODF ZIP/XML 自定义抽取 / 适配库 | H | ODT/ODS/ODP 格式、命名空间、表格 |

### 1.6 Python 传递依赖与安全约束（同样逐项记录）

这些目前出现在 `requirements.txt`，主要为了约束 Python 依赖树的安全版本。**不要**在 npm 中按名字硬找替换；应对新的 Node 依赖树重新做漏洞审计。

| 当前约束 | TypeScript 迁移处理 | 验收 |
|---|---|---|
| `anyio>=4.14.2` | 移除；Node Promise/AbortSignal 与事件循环 | 取消与超时语义 |
| `certifi>=2026.10.19` | 移除 Python CA 包；使用系统/Node CA 与明确代理配置 | TLS 根证书、企业代理 |
| `Mako>=1.4.2` | 随 Alembic 退出；若有运行时模板调用则单独换模板引擎 | 模板引用扫描 |
| `multidict>=6.9.1` | HTTP 依赖转移；Node Headers/Map | 重复响应头语义 |
| `pyasn1>=0.6.4` | 随 JOSE/密码学依赖退出 | ASN.1/签名格式实际互通 |
| `urllib3>=2.8.0` | 随 Python HTTP 栈退出；使用 undici | 连接重试/重定向 |
| `cryptography>=50.0.0` | 已在 §1.2 主表列明 | 凭据可解密 |
| `setuptools==84.0.0` | 已在 §1.4 主表列明 | 无 Python wheel 构建需求 |

## 2. 开发 / 测试依赖：全部映射

| Python 开发依赖 | Node/TS 方案 | 难度 | 迁移要求 |
|---|---|---|---|
| `pytest>=8.0` | `vitest` | M | 将行为契约转换为 TS 测试 |
| `pytest-asyncio>=0.23` | Vitest async/Promise | E | 异步取消、竞态与失败注入 |
| `Cython>=3.1` | 优先复用 TS/Rust RAG；必要时 N-API/WASM | H | `cython_native` 算法与排序行为等价 |
| `setuptools>=68` | TS 构建链；删除 `pyximport` | N/A | 无剩余构建时 Python import |
| `aiosqlite>=0.20` | 本地 SQLite 测试与测试数据库 | M | 事务、WAL、并发一致性 |
| `fakeredis[lua]>=2.30` | 真实隔离 Redis 优先；`ioredis-mock` 仅做单元 mock | M | Lua 锁、Streams 不可仅靠 mock 证明 |
| `watchfiles>=0.21` | `chokidar` / Node watch / `tsx watch` | E | 热重载、文件事件去重与跨 OS |
| `pytest-cov==7.1.0` | `@vitest/coverage-v8` | E | 覆盖率范围、阈值 |
| `lizard==1.23.0` | 保留 `lizard` CLI（跨语言）或 ESLint complexity | E | CRAP/圈复杂度报表口径 |
| `mutmut==3.8.0` | `@stryker-mutator/core` + Vitest runner | M | 先迁移人工运行规范、变异目标与阈值 |
| `pytest-xdist>=3.5` | Vitest pool/sharding | M | 测试隔离、每 worker 独立 DB/Redis |

> **不要**因 TS 迁移而简单删除现有 5,000+ Python 测试；保留 Python Golden Runner，直至对应功能的 TS 差分测试及生产回归达标。

## 3. PR #116 新增包与桌面 Host 的迁移表

| 当前部分 | 目标 | 处理方式 | 风险 |
|---|---|---|---|
| `gugu-core` Python wheel | `packages/core` TypeScript | Domain/Application 逐域迁移 | 中 |
| `gugu_core/data` SQLAlchemy | `packages/data` + Drizzle/Kysely | **跨域事务整体迁移**，不得 Python/Node 双写 | 高 |
| `gugu_core.data.runtime.LocalRuntime` | Node SQLite Host | 显式 initialize/open/migrate/close | 高 |
| `gugu_core.data.migrations` | SQLite 增量迁移器 | 现有 v1→v2 路径、备份恢复继续有效 | 高 |
| `gugu-desktop-host` Python 管道进程 | Node Sidecar | 保留 Tauri Rust IPC，替换底层子进程 | 中 |
| `gugu-desktop` Tauri 2 / Rust | **复用** | 只修改 Sidecar 的启动/通信层 | 低～中 |
| `@microsoft/mxc-sdk@1.0.1` | **复用（PoC）** | 继续独立验证 Windows 原生隔离 | 高 |
| `@tauri-apps/cli@2.12.4` | **复用** | 升级时检查 Tauri 版本和权限模型 | 低 |
| Vue `frontend/` 独立 desktop 入口 | **复用** | 调用统一的 Core Client/DTO | 低 |
| `gugu-desktop` Node engines 约束 | 统一 Node LTS 选型 | 冻结 CI、构建、Runtime 的 Node 主版本 | 中 |
| Tauri Desktop Node sidecar | 自包含可执行包 / 内嵌 Node | Windows/macOS 双架构打包签名验收 | 高 |

**特别说明**：桌面 Node Sidecar 是桌面方案，不能推导出 Android/iOS 也能运行同一 Node 宿主。移动端必须分离 `portable` 业务协议/规则与 Node 特有的 FS、数据库驱动、进程、沙箱及定时任务适配。

## 4. 不属于 pip，但必须纳入迁移的系统能力

| 系统/依赖 | 现状 | Node 方案 | 验收重点 |
|---|---|---|---|
| FFmpeg / ffprobe | IM 音频/视频转码与时长 | 继续使用，`child_process` 安全调用 | 可执行路径、打包、超时、进程树回收 |
| Poppler `pdftotext` | PDF 文本解析 | 保留 CLI 或 `pdfjs-dist`（按质量 PoC） | 扫描件、中文字符、页码、CPU 限制 |
| LibreOffice/字体 | 历史/部署路径可能存在；核心 Office 抽取已转纯 Python | 按实际调用决定保留/移除 | 不能因 requirements 不含它便当作无依赖 |
| PostgreSQL | SaaS 多用户事实库 | **保留** | 兼容历史数据/Alembic、零重建 |
| Redis | SaaS IM/协调/通知 | **保留** | Streams 重试、锁、通知 |
| SQLite | Desktop 数据库 | **保留** | WAL/备份/恢复/迁移 |
| Cython 原生 RAG 内核 | 现有 Python/Cython 算法 | TS / `@node-rs/jieba` / Rust N-API | BM25、分词/投影、索引版本 |
| Python RAG/记忆对象文件 | 非全部存在 DB | 统一 Node 内容 Store | 数据迁移完整性、删除屏障 |
| Linux sandboxd/容器 | Web/NAS 执行隔离 | 保留或实现同协议 Adapter | 防止 Host fallback |
| Windows MXC | PR #116 有受限验证 | 保留 Rust SDK/能力端口 | Node/MCP/PTY 严格隔离尚未证明 |
| macOS sandbox | 尚未验收 | 原生 Adapter（待选型） | 签名、公证、文件授权、进程树 |
| 文件监听 | Python watcher / TS Sidecar | `chokidar` 或 OS watcher Adapter | rename、丢事件、恢复对账 |
| CLI、Shell、PTY、MCP stdio | sandboxd/Unix socket 与 Python 桥 | Node `spawn` + OS Sandbox Broker | 取消、stdio、终止信号、权限 |
| SSE / Redis 事件总线 | 浏览器跨页状态通知 | Fastify SSE + Redis | event ID、重连、顺序 |
| Docker/Compose | 当前 Python 构建镜像 | Node 多阶段构建 | 非 root、健康检查、版本回滚 |
| 数据可移植归档 | Web 归档、Desktop 导入未完成 | 协议不变、实现迁移 | 不能把 DB 复制当作文件/记忆完整迁移 |
| 身份与用户模型 | Web 多用户，Desktop 单用户 | DataContext/Owner 保留 | 端侧不接受外部 owner_id 覆写 |
| 加密凭据与 SecretStore | 当前后端配置/加密数据 | Host SecretStore + Node crypto | 迁移中无明文暴露 |
| CI/许可证与 SBOM | pip、Cargo、pnpm 三套 | pnpm/Cargo，移除 Python 后更新 | 锁文件、许可证、SCA、原生包 |

## 5. 不能仅“替换 npm 包”的跨语言契约

1. **事务真源**：PR #116 通过 `bind_services(session, ...)` 借用 Web SQLAlchemy 事务。Node 不能跨进程共享该 Session；迁移时必须将 API、项目/联系人写入、关联跨表操作及 UoW 一起切换，否则破坏原子性。
2. **所有者与授权**：所有资源查询、更新和删除严格带 `owner_id`；Desktop 从可信本地身份导出，不接受 IPC 请求体覆盖。保持 `get_owned` 的非枚举语义。
3. **版本并发**：`UPDATE ... WHERE id AND owner_id AND version` 的 CAS、软删墓碑、重读结果和错误码保持一致。
4. **幂等与未知状态**：Sidecar 写入超时后可能已提交。对修改动作使用稳定 `operation_id`、持久化收据及查询机制，避免重试重复创建。
5. **初始化与备份**：SQLite 新库初始化需具备故障恢复；显式迁移先备份、再事务升级、验证一致性。不可自动重建用户数据库。
6. **Agent Loop 行为**：消息顺序、上下文预算、写后读回、确认门、Provider 事件与空回复恢复，必须有 Golden Tests。
7. **IM 交付语义**：入站去重、batch、trace_id、事务收据、出站账本和 Redis Streams pending 恢复不可在迁移时简化。
8. **RAG 兼容**：Tokenizer 版本、中文 HMM、日语候选、BM25、confidence、索引重建与 ACL 过滤必须验收。
9. **执行隔离**：任何 Shell、PTY、MCP stdio 均须经过平台 Broker；禁用无沙箱时回退宿主执行。
10. **移动平台边界**：可移植 Core 不调用 `node:fs`/`child_process`/原生数据库模块，所需能力由 Host Port 实现；Mobile 默认能力集不同于 Desktop。
11. **同步和数据归属**：每个领域须明确单一权威写入方，云同步与跨 Runtime 任务转交不应成为迁移期的隐式双写。
12. **许可证**：尤其 SILK 解码、Office XLS 包、原生编解码器、MXC 及各 npm 供应链，需在商业桌面发行前审计。

## 6. 推荐目标栈（候选，并非锁定清单）

```text
apps/
  web/                  Vue 3 + Vite
  api/                  Fastify + Zod/OpenAPI
  worker/               Node.js runtime + Redis Streams
  desktop/              Tauri 2 + Node Sidecar + SQLite
  mobile/               Capacitor + portable TS Core + native adapters（后续）

packages/
  protocol/             DTO / JSON Schema / Zod / Capabilities
  core/                 Domain / Application / Agent（不依赖 Node 私有 API）
  data/                 PostgreSQL + SQLite + migrations / UoW
  runtime-node/         Agent Host / Scheduler / IM / Process Lifecycle
  execution/            Broker Port 与隔离适配
  retrieval/            Jieba / BM25 / CJK 规则
  content/              文件、附件与文档抽取
  testing-contracts/    Python/TS 差分输入输出与故障场景
```

- Web：优先 **Vue 3 + Vite**；不为“全 TS”而强制换 Nuxt 或 Next.js。
- API：`fastify` 优先，原因是独立 Node 服务更贴近现有 FastAPI/Worker 边界；可另做 Hono PoC。
- 数据层：Drizzle/Kysely **只选其一**，先验证现有 SQL 和 Alembic 迁移的兼容策略。
- 进程/任务：不要把耗时 Agent Run 放到 HTTP handler 内；独立 Worker、租约与持久 Job。
- 桌面：复用 PR #116 的 Rust IPC 与 Tauri 2；替换 Python 管道 Host 为 Node Sidecar。
- Mobile：首先作为入口/远程 Runtime 客户端，随后仅移植 Portable Core 与本地受限能力。

## 7. 切片迁移次序与退出门槛

| 阶段 | 内容 | 退出门槛 |
|---|---|---|
| M0 | 冻结 #116 Python Golden Baseline | 关键数据/权限/IPC/Agent 行为快照可复现 |
| M1 | 项目+联系人 Domain / Data / SQLite | TS 与 Python 写入、CAS、回滚、失败恢复等价 |
| M2 | Tauri Node Sidecar | 实际 Windows/macOS 二进制、签名/更新/重启、无 Python 安装 |
| M3 | Web 项目/联系人事务切换 | 由 Node 唯一写入，PG 历史数据不变，事件/权限/撤销一致 |
| M4 | 会话、Job、调度、事件总线 | Canonical History、Redis Stream、幂等、恢复一致 |
| M5 | RAG、记忆、媒体、Office | 质量基准通过，旧索引有明确重建路径 |
| M6 | Agent Loop、Provider、工具、IM | 跨 provider 流式 Golden Tests、IM 接入与安全门通过 |
| M7 | 全量切换与撤除 Python | 无 Python 生产入口、可回滚制品、安全/许可证复核通过 |

**每个切片只能有一个写入真源。** 迁移中可以短期双读/影子计算，但不允许没有事务协议的双写；若需并行运行，采用旧 Python 作为参考实现，Node 干跑比对，不提交副作用。

## 8. 建议建立的验证数据集

- **数据库**：同一套项目、联系人、归档、回收站、乐观锁、批量跨域提交；SQLite/PG 各运行一遍。
- **RAG**：中文日期/月份、英语实体、拼音、日语专有名词、未登录词；记录 Token 列表、候选、排序和 ACL。
- **HTTP/LLM**：重定向 SSRF、DNS rebinding、代理、超时；部分 SSE chunk、tool_calls 截断、事件乱序。
- **媒体**：QQ/微信 SILK、Feishu Opus、损坏文件、iPhone HEIC、超大 PNG、视频取帧。
- **Office**：DOCX、XLS/XLSX、PPTX、ODT/ODS/ODP、RTF，中文/日文、表格、公式、备注。
- **同步/执行**：请求已提交但 ack 丢失、重复发送、设备离线、Broker 拒绝、Agent 取消、系统强制退出。
- **安全**：跨用户越权、资源枚举、破坏性确认、FS 授权、沙箱降级禁用、密钥不泄漏。
- **打包**：Windows x64/ARM64、macOS Intel/Apple Silicon；Node 原生模块与可执行依赖完整性。

## 9. 未冻结的关键选型（需专门 PoC）

1. **Drizzle vs Kysely**：先在真实项目跨表事务、PG JSONB、SQLite CAS、历史迁移上对比。
2. **SQLite driver**：`better-sqlite3`、`node:sqlite` 的 Node 版本、线程与打包兼容性。
3. **Sudachi / 日语**：同源分词绑定能否降低现有搜索语义差异。
4. **SILK decoder**：可用二进制/WASM 与许可证是否允许商业分发。
5. **Office 提取**：PPTX、RTF、ODF、旧 XLS 不能以“库存在”代替内容质量验收。
6. **Node Sidecar 打包**：Tauri Windows/macOS 发布可行性、调试信息、更新与漏洞扫描。
7. **迁移历史**：Alembic 与新 TS migration 账本共存/交接策略，绝对不能重放建表或重置生产库。
8. **MCP TS v2**：选择与 Python 版 `mcp==2.3.0` 的协议兼容边界，并保证安全 HTTP transport。
9. **SaaS FS 退出**：用户文件/长期记忆原始字节的未来权威归属与同步范围尚待确认。

## 10. 参考与来源

**仓库固定基准**

- [PR #116](https://github.com/Coffeiz/Gugu-web/pull/116)
- [生产 requirements](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/backend/requirements.txt)
- [开发 requirements](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/backend/requirements-dev.txt)
- [Core package](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/gugu-core/pyproject.toml)
- [Desktop host package](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/gugu-desktop/pyproject.toml)
- [RAG Jieba 适配](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/backend/agent/rag/cython_tokenizer.py)
- [中日文读音](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/backend/app/utils/romaji.py)
- [音频转码](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/backend/app/core/media_transcode.py)
- [Core 数据装配](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/gugu-core/src/gugu_core/data/unit_of_work.py)
- [桌面 IPC](https://github.com/Coffeiz/Gugu-web/blob/020ed06100bbd1f946ee2f277afa2b537fd64677/gugu-desktop/src-tauri/src/core_host.rs)

**官方文档/代码参考**

- [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk)
- [Tauri 2 Node.js Sidecar 文档](https://v2.tauri.app/learn/sidecar-nodejs/)
- [Sharp 图像处理文档](https://sharp.pixelplumbing.com/)
- [Drizzle ORM](https://orm.drizzle.team/)
- [Kysely](https://kysely.dev/)
- [Fastify](https://fastify.dev/)
- [Vitest](https://vitest.dev/)

---

**结论**：所列生产与开发依赖均有“替换、保留系统组件或随 Python 架构移除”的路径，但不能推断全部都已具备无损 TS 替代。真正的 P0 是数据库事务与迁移、Agent/IM 行为、RAG 搜索质量、媒体/Office 兼容以及桌面执行隔离。2.0 建议采取**逐域切片 + 单写者 + Golden Test**，而非一次性完全重写。
