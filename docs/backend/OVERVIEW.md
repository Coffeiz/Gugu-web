# 咕咕 · 后端现状总览

> 最后更新：2026-08-26
>
> 本文是代码盘点，不是目标架构或 PRD。涉及具体功能时，以当前 `backend/` 实现和测试为准；尚未完成的重构会在文末单列。

---

## 一、易读概述

### 这是什么

咕咕后端是一个 FastAPI 服务，支撑网页端的项目管理 + 文件库 + 日历，同时是"咕咕"这个 AI 陪伴角色的大脑——网页对话、QQ/飞书/微信等 IM 渠道收到的消息，最终都走到同一套 Agent 逻辑上，由它决定要不要调用工具（查项目、传文件、建日历事件、发消息……）、要不要记忆点什么。

### 大致怎么组织

- **业务 API**（`app/api/v1/`）：项目、文件、文件夹、回收站、日历、客户等常规的增删改查，前端网页直接调。
- **Agent 系统**（`agent/`，独立于 `app/`）：统一承接 Web、QQ、飞书、微信和定时任务的 Agent 执行。这里包含上下文快照、连续历史、压缩、模型适配、能力注册、工具、Skill、记忆和跨渠道编排。
- **Admin 后台**：一整套独立鉴权的管理端 API（配置热切换、用户管理、数据分析、系统日志、存储对账……），路由文件名多带 `_admin` 后缀。
- **配置系统**：`.env` 打底，Admin 后台改的配置写进 `config.override.json`，改完不用重启就能生效。
- **存储**：本地磁盘或阿里云 OSS 二选一，聊天附件另有 draft/attached 所有权生命周期；存储细节见 [`storage.md`](./storage.md)。

### 谁在用它

- 网页前端（`frontend/`）：走 `/api/v1/*` 用户态接口。
- Admin 管理面板：走同一套 `/api/v1/*` 但挂了 `require_admin` 依赖的一批路由。
- IM 网关（QQ 官方机器人、飞书、微信）：作为独立进程/协程跑在同一个后端里，把外部消息喂给 Agent，Agent 的回复再发回去。

### 当前服务形态

生产部署不是单一进程：`gugu-backend` 提供 FastAPI/uvicorn，`gugu-worker` 消费 Redis `im:inbound` 并执行 IM Agent，`gugu-supervisor` 按 `user_bots` 配置拉起 QQ/飞书/微信网关子进程；启用生产 Shell 沙盒时，`gugu-sandboxd` 独立承接 Rootless Docker 执行。三者共享 PostgreSQL、Redis 和本地/OSS 存储，但职责不同。

### Shell 沙盒与临时公网出口

普通用户的生产 Shell 请求必须经过 `sandboxd -> DockerSandboxExecutor`，Docker 不可用时不会回退到宿主机执行器。默认容器使用 `network=none`，只挂载对应用户的沙盒/工作区，使用固定 digest 镜像、非 root 用户、只读 rootfs 和资源限制。

Docker Compose 额外提供 `egress-proxy`（Squid）和内部网络 `gugu-sandbox-egress`。临时公网访问时，沙盒只加入这个内部网络并把 HTTP(S) 请求交给代理；代理连接默认网络访问公网，沙盒不能直接加入默认网络绕过代理。`sandboxd` 会在执行前检查代理、网络名、网络存在性和会话授权，Web/Worker 不持有 Docker socket。详细配置和运维步骤见 [`docs/ops/deploy.md`](../ops/deploy.md) 与 [Shell 沙盒 PRD](../product/PRD/PRD-SHELL-1-工作区Shell沙盒.md)。

### 本文边界

本文覆盖 HTTP API、ORM/迁移、Agent 上下文和工具系统、IM 消息链路、配置/安全、进程和测试入口。RAG 详细方案、存储 key 规则、IM 平台协议和前端行为仍以各自 PRD/专题文档为准。

---

## 二、专业细节

### 2.1 技术栈

| 层次 | 技术 |
|------|------|
| Web 框架 | FastAPI（async lifespan） |
| ORM | SQLAlchemy 2.0 async + asyncpg |
| 数据库 | PostgreSQL |
| 缓存/消息 | Redis（配置热加载、聊天附件暂存元数据、通知 pub/sub 等） |
| 鉴权 | JWT（`python-jose` 签发验证 + `bcrypt` 直接哈希密码），User / Admin / Stream 三种 Token 分离 |
| 配置 | pydantic-settings + `.env` + `config.override.json`（热加载） |
| 存储 | 本地磁盘 / 阿里云 OSS，Admin 面板热切换无需重启，详见 [`storage.md`](./storage.md) |
| AI | Anthropic / OpenAI / 通义千问 / DeepSeek / MiniMax 等，共用 OpenAI-compatible 或 Anthropic 两套接口格式，支持多 key 分流（`ai_presets`，见配置系统） |
| IM 接入 | 飞书（`lark-oapi` WebSocket 长连）、QQ 官方机器人（`qq-botpy` WebSocket，C2C/群聊）、微信 iLink；统一进入 Redis inbound stream + Agent IM loop |

`requirements.txt` 里的框架版本用 `>=` 而非精确锁定（如 `fastapi>=0.111.0`、`sqlalchemy>=2.0.0`、`langchain>=0.2.0`），无 `pyproject.toml`。`passlib` 虽在依赖列表里，但代码里已不再使用（密码哈希直接调 `bcrypt`），是个遗留依赖。

### 2.2 目录结构

```
backend/
├── Makefile                      # make dev-web / dev-worker / start / stop / restart
├── requirements.txt
├── config.override.json          # Admin 写入的配置覆盖（不进 git）
├── .env                          # 本地环境变量（不进 git）
├── onboarding/                   # 新手引导子系统（独立路由，见 app/main.py）
├── agent/                        # AI Agent 核心逻辑（独立顶层目录，不在 app/ 下）
│   ├── core.py                   # 主循环：工具调用轮次、验证轮次
│   ├── runner.py / router.py     # 请求路由、多渠道分发
│   ├── llm/                      # 模型选择、token、模型上下文与 driver
│   ├── providers/                # Anthropic/OpenAI-compatible/本地模型适配
│   ├── capabilities/             # Tool/Skill 注册、权限快照、选择与诊断
│   ├── interactions/             # confirm/ask_user/stream event 交互协议
│   ├── im/                       # IM 会话、身份、媒体、引用、回复编排
│   ├── runtime/loopscope_trace/  # Agent run/round/span 旁路可观测性
│   ├── memory/                   # 记忆系统（store / lens / reflection / compress）
│   ├── context/                  # 上下文构建、token 预算、对话压缩
│   ├── sandbox/                  # Rootless Docker sandboxd、执行器、网络与配额边界
│   ├── gateway/                 # web / qq / wechat / supervisor 等渠道适配器
│   └── tools/                    # Skill 化工具注册（含 call_tool/use_skill 元工具）
└── app/
    ├── main.py                   # FastAPI 入口，路由注册（约 30 个 router），lifespan
    ├── core/
    │   ├── config.py             # pydantic-settings，见 §2.6
    │   ├── security.py           # JWT 签发 / 验证，get_current_user 依赖
    │   ├── chat_attach.py        # 聊天附件暂存（见 storage.md）
    │   ├── redis.py               # Redis 客户端（异步 + 同步两套）
    │   └── ...                   # ownership / tz / health / scheduler / media_transcode 等
    ├── db/
    │   ├── base.py               # DeclarativeBase
    │   └── session.py            # async engine，get_db，create_all_tables，_MIGRATIONS
    ├── models/__init__.py        # 所有 SQLAlchemy 2.0 模型，当前 30 个模型（见下）
    ├── schemas/__init__.py       # 所有 Pydantic v2 schema（camelCase 输出）
    ├── services/
    │   ├── storage/__init__.py   # StorageBackend 抽象 + LocalStorageBackend + OSSStorageBackend
    │   └── agent/__init__.py     # SSE 流式响应封装
    └── api/v1/                   # 约 34 个路由文件，见 §2.5
```

### 2.3 数据库模型

所有表含 `user_id`（外键 → `users.id` CASCADE，除个别系统级表外），全面用户隔离。`User.id` 是 **UUID（uuid7）**，不是自增整数——其余大部分表仍用 `Integer` 自增主键。

#### 核心业务表

**User**（`users`）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Uuid PK | `uuid7`，非自增整数 |
| username / email | String unique | |
| hashed_password | String(200) | bcrypt |
| display_name | String(100)? | |
| avatar | String(500)? | |
| is_active | Boolean | |
| is_developer | Boolean | 开发者标记，数据面板可一键排除，看真实用户数据 |
| token_limit_monthly / token_limit_6h / token_limit_weekly | Integer? | 精力（Token 配额）系统上限，None=不限 |
| storage_limit_bytes | BigInteger? | 存储空间上限 |
| search_limit_daily | Integer? | 每日联网搜索次数上限 |
| last_active_at | DateTime? | 索引，最近活跃时间 |
| created_at | DateTime | |

**UserPreferences**（`user_preferences`）：`user_id` unique（每用户一行），`data_json`（Text，JSON blob，`data` property 代理），`updated_at`。

**Project**（`projects`）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| user_id | FK → users | |
| name | String(200) | 改名时联动重命名磁盘目录 |
| client | String(200)? | |
| status | String(20) | `pending` / `active` / `done` |
| start_date / deadline | String(10)? | `YYYY-MM-DD` |
| color | String(300) | CSS 渐变字符串 |
| progress | Integer | 0–100 |
| stages_json | Text | JSON `[{key, label}]`，`stages` property 代理 |
| current_stage | String(100)? | |
| priority | String(20)? | 新增字段 |
| version | Integer | 乐观锁，`PATCH` 时校验并 +1，冲突返回 409 |
| archived | Boolean | |
| done_at | DateTime? | 标记为完成时的时间戳，回退状态时清空 |
| created_at / updated_at | DateTime | |

**File**（`files`）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| user_id | FK → users | |
| display_name | String(300) | 文件名（不含扩展名） |
| ext | String(20) | 扩展名小写 |
| space | String(20) | `personal` / `project` / `mind` / `asset`，详见 [`storage.md`](./storage.md) |
| project_id | FK → projects? | NULL = 个人文件 |
| folder_id | FK → folders? | NULL = 所属空间根目录 |
| stage_name | String(100) | 文件标签（非导航层级） |
| mind_map_id | FK → mind_maps? | 预留，思维画布功能未开发 |
| storage_key | String(500) | 相对于 `UPLOAD_DIR` 的路径 |
| size | String(50) | 人类可读，如 `2.3 MB` |
| size_bytes | BigInteger | |
| mime_type | String(200)? | |
| img_width / img_height | Integer? | 图片尺寸（上传时提取） |
| deleted_at | DateTime? | 索引，非 NULL = 已进回收站 |
| created_at / updated_at | DateTime | |

**Folder**（`folders`）：`project_id`（NULL=个人文件夹）、`parent_id`（自引用，NULL=根目录，支持无限嵌套，`ON DELETE CASCADE`）、`name`。删除文件夹级联删除子文件夹，文件 `folder_id` SET NULL。

**CalendarEvent**（`calendar_events`）：`title`、`date`（`YYYY-MM-DD`）、`time` / `end_time`（`HH:MM`，可选，空=全天）、`type`（`deadline`/`milestone`/`meeting`/`event`）、`client`、`project_id`、`description`、`version`（乐观锁）。

**Client**（`clients`）：`name`、`contact` / `email` / `phone`、`notes`。

**ConversationSession**（`conversation_sessions`）：除 `title/title_locked`、`summary`、`source` 外，还保存 IM 作用域（`bot_id`、`chat_id`、`platform_user_id`、`chat_type`）、`workspace_id`，以及 Agent 会话快照字段：`context_epoch`、`session_context`、`session_info_hash`、`snapshot_hash`、`snapshot_expires_at`、`baseline_message_id`、`baseline_message_hash`。普通轮次复用快照，TTL（当前 30 分钟）或上下文 revision 变化时重建。

**ConversationMessage**（`conversation_messages`）：`role`、`content`、`content_json`（结构化文本/工具块/交互块）、`files`、`quoted_text`、`sent_at`，以及 IM 平台用户、机器人和群聊字段。工具历史以 provider-neutral canonical block 落库，再由 adapter 渲染为 Anthropic 或 OpenAI wire format。

**InteractionPrompt / InteractionAction**（`interaction_prompts` / `interaction_actions`）：持久化 `confirm`、`ask_user` 等待用户操作的提示、一次性 action token 摘要、过期和消费状态，Web 与 IM 共用同一交互服务。

**ChatAttachment**（`chat_attachments`）：聊天附件所有权与复用索引，区分 `draft` / `attached`，支持引用消息附件复用，物理文件只有在无存活引用时才清理。

**MindMap**（`mind_maps`）：思维画布，表结构已建但**明确标注"暂不开发，预留结构"**，无对应 API 路由。

#### 记忆、交互与运营表

| 表 | 用途 |
|------|------|
| `AgentUsage` | 每次 Agent 调用记一行：`tokens_in/out`、`model`、`provider`、`tools_used`（JSON），配额统计用 |
| `SearchUsage` | 深度研究 Provider 用量计数，`web_search`（自建 SearXNG）不计配额 |
| `UserBot` | 用户自带 IM 机器人凭据（BYO），目前用于 QQ（`platform=qq`） |
| `AuditLog` | 管理员操作审计 |
| `SystemLog` | 系统级错误/警告日志 |
| `FrontendEvent` | 前端行为埋点 |
| `Feedback` | 用户反馈（bug/建议/其他） |
| `ScheduledTask` | 定时任务：`user_id` 为空=系统级任务，`event_id`（不设 DB 外键，应用层级联删除）绑定日历提醒时使用 |
| `SiteNotification` / `NotificationRead` | 站内通知广播 + 按用户已读记录 |
| `MemoryReflectionJob` / `MemoryReflectionCursor` | 记忆反思异步任务和增量游标 |
| `MemoryEntry` / `MemorySource` / `MemoryScopeTombstone` | 记忆正文、来源和作用域删除墓碑 |
| `Workspace` | 用户工作区与会话归属 |
| `MindNode` / `MindCanvasItem` / `MindRelation` | 思维画布节点、画布视图位置和关系边；相关 API 已存在 |

### 2.4 自动迁移

数据库迁移由 deploy/migrate 步骤统一执行 Alembic；生产 systemd 的多 worker 启动不会再执行 DDL。`create_all_tables()` 仅保留给单进程本地初始化（`GUGU_STARTUP_MIGRATIONS=1`），并在 PostgreSQL advisory lock 下顺序执行 `_MIGRATIONS`。这样避免启动期 `ALTER TABLE` 与业务查询并发形成死锁；生产新增字段或数据修复必须先完成迁移再重启服务。

### 2.5 API 端点

所有端点前缀 `/api/v1`，返回 camelCase JSON。`app/main.py` 当前注册 35 个路由模块，分为公开认证、用户态、连接/新手引导和 Admin 四组；完整文件清单以 `backend/app/api/v1/` 与 `app/main.py` 为准。

**用户认证**（`auth.py`，公开路由）
```
POST /api/v1/auth/register        {username, email, password} → {access_token, user}
POST /api/v1/auth/login           {username, password} → {access_token, user}
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
GET  /api/v1/auth/me
PATCH /api/v1/auth/profile
POST /api/v1/auth/avatar
GET  /api/v1/auth/quota           查配额（精力系统）
GET  /api/v1/auth/avatar/{user_id}
```

**管理员认证**（`admin_auth.py`，公开路由）：`POST /admin/auth/login`、`GET /admin/auth/me`。默认账号 `admin / admin123`（上线前必须修改）。

**项目**（`projects.py`）
```
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{id}
PATCH  /api/v1/projects/{id}    乐观锁校验 version；改名时联动重命名磁盘目录 + 批量更新 storage_key
DELETE /api/v1/projects/{id}    项目下文件软删（进回收站），文件夹随 CASCADE 自动删除
```

**文件 / 文件夹 / 回收站**：详见 [`storage.md`](./storage.md)，那边有完整的端点表和存储 key 规则。这里只提示 `files.py` 是目前最大的路由文件（约 1100 行），新增了 `GET /files/tree`、`GET /files/storage`（用量统计）、`PUT /files/{id}/content`（内容编辑保存）、`POST /files/batch-download`、OSS 直传的 `POST /files/presign` + `POST /files/confirm` 等端点。

**日历事件**（`events.py`）：`GET/POST /events`、`PATCH/DELETE /events/{id}`（`PATCH` 同样走乐观锁 `version`，`DELETE` 会级联删除绑定的 `ScheduledTask` 提醒）。

**客户**（`clients.py`）：`GET/POST /clients`、`DELETE /clients/{id}`。

**用户偏好**（`preferences.py`）：`GET/PATCH /preferences`，部分更新 merge 写入。

**实时业务事件**（TypeScript Live）：网页通过 `VITE_LIVE_API_URL` 或当前主机的 8585 端口直接请求 `GET /live/stream`；TypeScript 服务负责 JWT 用户鉴权、Redis 用户频道订阅、canonical envelope 校验和 SSE 生命周期，systemd 单元为 `gugu-live.service`。FastAPI 不再提供 Python Live 代理入口。聊天生成流、Admin 日志流和文件下载流不经过该服务。

**AI Agent**（`agent.py`）
```
POST /api/v1/agent/chat                 SSE 流式，支持 Anthropic / OpenAI-compatible 双路由
GET  /api/v1/agent/sessions/{id}/stream  断线重连续接
GET  /api/v1/agent/sessions              会话列表
GET  /api/v1/agent/sessions/{id}/messages
GET  /api/v1/agent/greeting              开场白
GET  /api/v1/agent/ui-labels             状态标签
POST /api/v1/agent/upload                聊天内联上传（走暂存，见 storage.md）
GET  /api/v1/agent/attachment/{id}/thumb|download|preview-pdf
DELETE /api/v1/agent/attachments | /memory | /sessions/{id}
```
Agent 主循环上限是 `MAX_ROUNDS = 8`、工具调用上限是 `MAX_TOOL_CALLS = 10`；写操作另有最多 `MAX_VERIFY = 5` 的验证轮预算。`agent/tools/` 当前由多个 Skill 注册业务工具，能力注册层再按用户权限、Profile 和当前上下文生成 `CapabilitySnapshot`。固定入口包括 `call_tool`、`use_skill`、`ask_user`，按需能力通过 selector 注入；`canonical_tool_history.py` 将工具调用、结果、工具 schema 和 Skill schema 统一成 provider-neutral 历史，再由 Anthropic/OpenAI adapter 转换。

工具覆盖项目/阶段/待办/优先级、文件/文件夹/回收站、日历/定时任务、客户、画布、记忆、联网搜索/深度研究、图片/附件、IM 和对话历史等。当前统一通过固定 `call_tool`、`use_skill`、`ask_user` 入口注入；业务 Schema 和工具往返使用 canonical history。

**定时任务**（`scheduled_tasks.py`）：用户自定义 cron 任务的 CRUD，与日历事件提醒（`ScheduledTask.event_id`）是两套概念但共用一张表。

**Admin 配置**（`config.py`，需 Admin Token）
```
GET    /api/v1/admin/config
PATCH  /api/v1/admin/config                    热更新，写入 config.override.json，无需重启
POST   /api/v1/admin/config/init-db
POST   /api/v1/admin/config/test-connection    测试 DB / OSS 连通性
POST   /api/v1/admin/config/test-search        测试 SearXNG / 深度研究 Provider / 相似图搜索
POST   /api/v1/admin/config/test-smtp
GET    /api/v1/admin/config/reconcile-storage         存储↔DB 对账（只读），见 storage.md §十
POST   /api/v1/admin/config/reconcile-storage/repair  对账修复
```

**其余 Admin 路由**（均挂 `Depends(require_admin)`）：`agent_admin`（Agent/Skill/模型行为配置）、`agent_perception`、`audit_log`、`system_logs`、`users_admin`、`services_admin`、`admin_debug`、`admin_analytics`、`ops_admin`、`folder_doctor_admin`、`feedback.admin_router`、`notifications_admin`。

**IM 平台连接**（用户态）：`qq_connect.py`、`feishu_connect.py`、`wechat_connect.py`——扫码绑定/解绑自己的 IM 账号。`user_bots.py` 管理自带机器人凭据。

**其他用户态路由**：`search.py`（联网搜索代理）、`track.py`（埋点上报）、`feedback.py`（用户反馈提交）、`notifications.py`（站内通知）、`onboarding`（新手引导，独立子系统 `backend/onboarding/`）。实时事件 SSE 由 `backend/ts/api/live.ts` 独立提供。

**说明**：`app/api/v1/tasks.py` 文件存在但内容为空（0 字节），`main.py` 里也未导入，属于历史遗留的占位文件，不代表真实功能。

### 2.6 Agent 请求与上下文流水线

Web、IM 和定时任务最终都进入 `agent.runner` / `agent.core`，差异只在入口协议和回复出口：

```text
HTTP SSE / Redis IM inbound / scheduler
        ↓
AgentRequest + owner/session/IM context
        ↓
ensure_snapshot()
  ├─ 命中：复用 session_context、system/session info 和 baseline
  └─ 失效：按 context revision/TTL 重新加载项目、日历、文件、memory、时区、偏好、IM channel
        ↓
固定前缀 + baseline/history + 本轮消息 + 动态尾部
        ↓
provider adapter → LLM round
        ↓
canonical tool history / interaction event / output
        ↓
持久化消息、checkpoint/TTL、LoopScope trace、Web/IM 回复
```

快照的业务输入由 Redis 中的用户级 `context-revision:{user_id}` 失效：项目、日历、文件、记忆、偏好、时区和 IM channel 的变更都应推进 revision；SSE 是否通知前端与 Agent 快照是否失效是两条独立语义。普通消息不会把整块业务快照重新拼到每轮尾部，压缩只处理 baseline 之后的连续历史，并按工具调用原子单元避免切断 `tool_call/tool_result`。

工具/Skill 采用注册表与权限快照：`use_skill` 负责加载 Skill 正文并追加相关 canonical schema，`call_tool` 在固定入口调用已授权工具，交互工具通过 `agent/interactions` 生成可持久化提示。Provider 只在边界把 canonical history 转成对应 wire format；不要在 gateway 或 Web 入口复制一套上下文组装逻辑。

### 2.7 配置系统

优先级（低 → 高）：代码默认值 → `.env` / 环境变量（`AppSettings`，`env_nested_delimiter="__"`）→ `config.override.json`（Admin UI 写入，最高优先级）。

配置分区已从早期的 db/storage/ai 三块扩展为：

| 分区 | 用途 |
|------|------|
| `db` | host / port / name / user / password |
| `redis` | host / port / password |
| `storage` | backend(`local`\|`oss`) / local_path / oss_* |
| `ai` | 主模型 provider / api_key / base_url / model / vision / api_format 等 |
| `voice` | 独立语音识别模型（继承 `AISettings`），空=不支持语音识别 |
| `ai_presets` | 多 key 分流池：`strategy`（active 单一激活 / pool 多 key 分流 / router 智能路由）+ `items[]` |
| `agent` | Agent 行为：记忆开关、Reflection 阈值、worker 并发数、对话压缩开关等 |
| `capabilities` / Agent 配置 | Tool/Skill 注册、按需能力、交互展示、模型与本地能力覆盖等 Admin 配置 |
| `quota` | 全局默认配额上限（Token / 存储 / 搜索次数），None=不限 |
| `search` | 外部研究/搜索 Provider 与 API Key + SearXNG 地址与引擎列表；百度 Provider 使用普通百度搜索 API |
| `smtp` | 邮件发送配置（反馈通知、密码重置） |
| `state_labels` | 对话中"状态指示"文案的自定义覆盖 |

嵌套配置类特意用 `BaseModel` 而非 `BaseSettings`——避免 `apply_override` 调 `model_validate` 时触发二次 env 读取，把 override 值覆盖掉（`config.py` 文件头注释原话）。`get_settings()` 用 `@lru_cache`，Admin 写入 override 后调用 `get_settings.cache_clear()` 触发重新加载。加新的嵌套配置段务必在 `apply_override()` 里显式合并，否则该段会静默变成裸 dict 或不生效（有过实际踩坑）。

### 2.8 鉴权设计

| Token 类型 | 签发 | 用途 | 有效期 |
|-----------|------|------|--------|
| User JWT | `POST /auth/login` | 所有用户数据 API | `access_token_expire_minutes`，默认 10080 分钟（7 天） |
| Admin JWT | `POST /admin/auth/login` | Admin 配置 API | 同上 |
| Stream JWT | `create_stream_token()` | 文件流式播放的短期鉴权 | 10 分钟 |

三类 Token 均为 HS256、`payload["role"]` 区分用途：`user` → `get_current_user`/`get_current_user_id`；`admin`/`superadmin` → `main.py` 的 `require_admin`；`stream` → `verify_stream_token`。User Token payload 含 `sub`（UUID 字符串形式的 user_id）；Admin Token payload 含 `sub`（username）+ `role`；Stream Token 额外带 `fid`（file_id）。密码哈希直接调用 `bcrypt.hashpw`/`checkpw`，未经 passlib 封装。

### 2.9 启动流程（lifespan）

1. 生产部署先执行 `make migrate`，再重启 web/worker；本地单进程可用 `GUGU_STARTUP_MIGRATIONS=1` 启用启动初始化。生产服务默认设置为 `GUGU_STARTUP_MIGRATIONS=0`，不会在业务流量启动时执行 DDL。
2. 清理旧 JPEG 缩略图缓存（历史遗留，迁移到 WebP 后的清理逻辑）
3. 启动 `_auto_cleanup_loop()`：每小时清理过期回收站文件 + 每 24 小时驱逐冷缩略图（TTL 30 天）
4. 启动 `_db_retry_loop()`：DB 不可达时每 30 秒重试建表，连上即建表退出
5. 启动 `flush_log_queue()`：日志队列落盘任务

### 2.10 Schema 规范

所有 schema 继承 `CamelModel`（`app/schemas/__init__.py`）：

```python
class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,   # snake_case → camelCase（前端直接用 displayName 等）
        populate_by_name=True,
        from_attributes=True,       # 支持 ORM 对象直接 .model_validate()
    )
```

### 2.11 本地启动

```bash
cd backend
make dev-web    # Web 热重载，监听 app/agent/onboarding，前台运行
make dev-worker # Worker 热重载（先 make deps-dev，并停止同机 systemd worker）
make start      # 后台 uvicorn，不启用 reload
make stop       # kill 进程
make restart
```

访问：`http://localhost:8000/docs`（Swagger UI）

生产/测试机使用 `start.sh` 或 Makefile 的 systemd 模式管理三个服务：

```bash
make status
make restart
systemctl status gugu-backend gugu-worker gugu-supervisor
```

改动 `agent/gateway` 或机器人凭据后，至少需要重启 `gugu-supervisor`；改动 Agent/worker 代码则需要同步并重启对应 web/worker 进程。不要把网关凭据放入命令行参数，supervisor 通过环境变量注入子进程。

### 2.12 添加新端点

1. 在 `app/models/__init__.py` 添加 SQLAlchemy 模型，在 `_MIGRATIONS` 追加幂等 SQL（当前没有 Alembic 版本链）
2. 在 `app/schemas/__init__.py` 添加 `XxxCreate`、`XxxUpdate`、`XxxResponse`（继承 `CamelModel`）
3. 在 `app/api/v1/` 新建 `xxx.py`，定义 `APIRouter`，注入 `get_current_user`
4. 在 `app/main.py` `import` 并 `app.include_router(xxx.router, prefix="/api/v1")`（需要 Admin 鉴权的话加 `dependencies=[Depends(require_admin)]`）
5. 在 `frontend/src/services/api.js` 添加对应 `xxxApi` 对象

### 2.13 常见问题

**Q: 启动报 `asyncpg.exceptions.InvalidPasswordError`**
确认 PostgreSQL 用户名密码与 `.env` 一致，检查 `pg_hba.conf` 是否允许本地连接。

**Q: 上传文件报 `500 OSError`**
检查 `STORAGE__LOCAL_PATH` 目录是否存在且有写权限。

**Q: 修改配置不生效**
修改 `.env` 需重启；通过 Admin UI 写入 override 自动热加载，无需重启。加新的嵌套配置段本身如果没有在 `apply_override()` 里同步注册合并逻辑，也会表现为"改了不生效"。

**Q: 缩略图不更新**
删除 `Gugu-data/users/.thumbs/` 目录下对应文件（或全部），下次请求时重新生成。

### 2.14 时间与时区约定

写任何涉及时间的代码，遵循四条（详见 [时区与时钟迁移方案](../refactor/【已完成】时区与时钟迁移方案.md)）：

1. **存储一律 aware UTC**：datetime 列用 `app/db/types.py` 的 `UtcDateTime`（不是裸 `DateTime`）——两库进出都是 aware UTC（Postgres timestamptz / SQLite naive + 读出补 UTC），业务代码不再有 naive/aware 混用。
2. **当前时间走单一出口 `app.core.tz.now_utc()`**（aware UTC）——**禁止裸调 `datetime.utcnow()`**（已弃用 + naive）。静态守卫 `python scripts/check_utcnow.py` 拦回归，例外加 `# utcnow-exempt` 标记。
3. **只有「展示」和「日期归属」（今天/本周/属于哪天）才碰用户时区**：用 `tz.user_tz(user)` / `tz.day_key/today_str/is_today/is_this_week`；agent 请求内的深层代码（工具等）读 `tz.now_ctx()`（入口已 set contextvar）。绝对时刻的比较/加减一律在 UTC 下做，不碰时区。运维口径（analytics/quota）用服务器 `LOCAL_TZ`，不 per-user。前端展示后端时间统一用 `dateAttribution.ts` 的 `fmtLocalDateTime`/`localDayKey`（查看者浏览器 tz），别用 `iso.slice(0,10)`（那是 UTC）或后端 `fmt_local`（那是服务器 tz）。
4. **SQL 按本地日分桶（GROUP BY DATE）用 `DATE(col AT TIME ZONE <tz>)`，别用 `DATE(col + INTERVAL '±Nh')`**：列迁 timestamptz 后，`col + INTERVAL` 的结果依赖 DB 会话时区（会话非 UTC 时会再偏一次），`AT TIME ZONE` 显式转 naive 本地时间、与会话时区无关且 DST 正确。见 `admin_analytics.py` + `tz.utc_to_local_date_expr`。

---

### 2.15 安全与可观测性

- 用户数据访问优先走 `app/core/ownership.py` 的 `get_owned()`；跨用户查询不能只依赖前端传入的 ID。
- 外部 URL 复用 URL safety 校验，禁止未经校验的自动重定向；聊天正文、附件名和用户输入不能写入可见日志，诊断日志使用脱敏 fingerprint。
- 删除、永久删除、批量 destructive 操作必须经过 `confirm` 门；IM 的 QQ/飞书/微信凭据由 supervisor 通过环境变量传给子进程，不进 argv。
- Agent run/round/tool/数据库 loader 通过 `agent/runtime/loopscope_trace` 写入旁路 trace；LoopScope 只消费脱敏元数据，不应把 prompt、聊天正文、token 或凭据当作普通业务日志。
- `app.core.logging` 统一处理进程日志；HTTP 未处理异常对外只返回通用错误，原始异常留在服务端诊断日志。

### 2.16 测试与验证

后端测试位于 `backend/tests/`，覆盖 API、模型/迁移、上下文快照与压缩、canonical tool history、能力注册、Provider adapter、Agent runner、IM 网关/回复、交互确认、存储和安全。当前本地验证基线为：

```bash
cd backend
pytest -q
```

最近一次 Phase 5 改动的结果是 `1204 passed`；修改上下文、工具协议或数据库时，应至少再运行对应目录测试和完整 backend suite。前端、Runtime、LoopScope 的联动 CI 不由本文件代替，需按各自仓库/工作流单独验证。

### 2.17 当前已知边界

- 数据库仍采用启动时幂等迁移，没有 Alembic 版本历史；复杂结构变更需要单独设计可回滚脚本。
- `snapshot_hash` 当前主要用于 checkpoint/trace 标识，尚未完全覆盖所有 snapshot 输入的内容哈希；正确性依靠 snapshot payload、TTL 和 context revision。
- 工具能力通过固定 Adapter 暴露；模型需要业务工具定义时调用 `get_tool_schema`，OpenAI/Anthropic 的历史 wire format 仍由 history adapter 兼容转换。
- canonical history 已覆盖工具调用、工具结果、Tool/Skill schema 事件，并使用 `ToolCall`/`ToolResult` 领域对象统一归一；LoopScope 展示 canonical event、Schema digest 和 Adapter 统计。
- RAG 的统一索引、切片和召回以 `PRD-RAG-1-统一知识召回与索引.md`、`PRD-RAG-6-TypeScript词法检索与评分过滤直接替换.md` 为准；当前词法索引与 confidence/filter 正常路径由固定 Node TypeScript worker 执行，Python 负责权限、业务文档和正文回填；历史 Rust 实现不再进入运行时回退。
- 配额模型字段和 onboarding 路由已经存在，但计费窗口、运营规则和完整协议仍应维护在专题文档，不在本总览中重复展开。
