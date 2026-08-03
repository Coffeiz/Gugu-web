# 咕咕 · 后端开发文档

> 最后更新：2026-07-02

---

## 一、易读概述

### 这是什么

咕咕后端是一个 FastAPI 服务，支撑网页端的项目管理 + 文件库 + 日历，同时是"咕咕"这个 AI 陪伴角色的大脑——网页对话、QQ/飞书/微信等 IM 渠道收到的消息，最终都走到同一套 Agent 逻辑上，由它决定要不要调用工具（查项目、传文件、建日历事件、发消息……）、要不要记忆点什么。

### 大致怎么组织

- **业务 API**（`app/api/v1/`）：项目、文件、文件夹、回收站、日历、客户等常规的增删改查，前端网页直接调。
- **Agent 系统**（`agent/`，注意这是独立顶层目录，不在 `app/` 下）：AI 对话的核心逻辑、工具集、记忆、跨渠道适配器。这一块比业务 API 复杂得多，工具数量已经到了大几十个（项目/文件/日历/客户/定时任务/搜索/记忆……），远不只是"聊天+建日历"。
- **Admin 后台**：一整套独立鉴权的管理端 API（配置热切换、用户管理、数据分析、系统日志、存储对账……），路由文件名多带 `_admin` 后缀。
- **配置系统**：`.env` 打底，Admin 后台改的配置写进 `config.override.json`，改完不用重启就能生效。
- **存储**：本地磁盘或阿里云 OSS 二选一，同样是 Admin 热切换（详见 [`storage.md`](./storage.md)）。

### 谁在用它

- 网页前端（`frontend/`）：走 `/api/v1/*` 用户态接口。
- Admin 管理面板：走同一套 `/api/v1/*` 但挂了 `require_admin` 依赖的一批路由。
- IM 网关（QQ 官方机器人、飞书、微信）：作为独立进程/协程跑在同一个后端里，把外部消息喂给 Agent，Agent 的回复再发回去。

### 这份文档没覆盖的

`onboarding/`（新手引导，独立子系统）、IM 网关具体协议细节、精力/配额系统的计费逻辑，这些体量较大，值得单独开文档，这里只在数据模型/路由清单里带一笔。

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
| IM 接入 | 飞书（`lark-oapi` WebSocket 长连）、QQ 官方机器人（`qq-botpy` WebSocket 长连，C2C 单聊）、微信 |

`requirements.txt` 里的框架版本用 `>=` 而非精确锁定（如 `fastapi>=0.111.0`、`sqlalchemy>=2.0.0`、`langchain>=0.2.0`），无 `pyproject.toml`。`passlib` 虽在依赖列表里，但代码里已不再使用（密码哈希直接调 `bcrypt`），是个遗留依赖。

### 2.2 目录结构

```
backend/
├── Makefile                      # make start / stop / restart
├── requirements.txt
├── config.override.json          # Admin 写入的配置覆盖（不进 git）
├── .env                          # 本地环境变量（不进 git）
├── onboarding/                   # 新手引导子系统（独立路由，见 app/main.py）
├── agent/                        # AI Agent 核心逻辑（独立顶层目录，不在 app/ 下）
│   ├── core.py                   # 主循环：工具调用轮次、验证轮次
│   ├── runner.py / router.py     # 请求路由、多渠道分发
│   ├── llm_select.py             # 模型选择（pool/router 分流、mimo 识别等）
│   ├── memory/                   # 记忆系统（store / lens / reflection / compress）
│   ├── context/                  # 上下文构建、token 预算、对话压缩
│   ├── gateway/                 # web / qq / wechat / supervisor 等渠道适配器
│   └── tools/                    # 工具集，15 个文件，约 60 个工具（见下）
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
    ├── models/__init__.py        # 所有 SQLAlchemy 2.0 模型，16 个表（见下）
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

**ConversationSession**（`conversation_sessions`）：`title`（默认"新对话"）、`summary`（一句话摘要，供跨 session 查找/续接）、`source`（`web` 等）。

**ConversationMessage**（`conversation_messages`）：`role`、`content`、`content_json`（JSON，结构化内容块）、`files`（JSON，咕咕发的文件卡片 `[{file_id,name,ext,size_bytes}]`）。

**MindMap**（`mind_maps`）：思维画布，表结构已建但**明确标注"暂不开发，预留结构"**，无对应 API 路由。

#### 运营/系统表（10-06-21 版文档未收录）

| 表 | 用途 |
|------|------|
| `AgentUsage` | 每次 Agent 调用记一行：`tokens_in/out`、`model`、`provider`、`tools_used`（JSON），配额统计用 |
| `SearchUsage` | 深度研究（Tavily）用量计数，`web_search`（自建 SearXNG）不计配额 |
| `UserBot` | 用户自带 IM 机器人凭据（BYO），目前用于 QQ（`platform=qqbot`） |
| `InviteCode` | 邀请码，注册走邀请制 |
| `AuditLog` | 管理员操作审计 |
| `SystemLog` | 系统级错误/警告日志 |
| `FrontendEvent` | 前端行为埋点 |
| `Feedback` | 用户反馈（bug/建议/其他） |
| `ScheduledTask` | 定时任务：`user_id` 为空=系统级任务，`event_id`（不设 DB 外键，应用层级联删除）绑定日历提醒时使用 |
| `SiteNotification` / `NotificationRead` | 站内通知广播 + 按用户已读记录 |

### 2.4 自动迁移

不使用 Alembic，开发阶段由 `session.py` 的 `create_all_tables()` 自动建表 + 顺序执行 `_MIGRATIONS` 列表里的 SQL（目前 5 条，含 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 幂等语句，也有个别一次性数据修复 UPDATE）。新增 nullable 列直接在 `_MIGRATIONS` 追加即可。

### 2.5 API 端点

所有端点前缀 `/api/v1`，返回 camelCase JSON。`app/main.py` 里实际 `include_router` 的文件约 30 个，下面按业务分组列出主要的（IM 平台连接、Admin 数据分析等长尾路由不逐一展开，命名规律是 `xxx_connect.py` / `xxx_admin.py`）。

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
工具调用轮次不是固定 5 轮：`agent/core.py` 里 `MAX_ROUNDS = 6`（"多步任务通常 2~3 轮就完成，设 6 给复杂任务留余量"），另有 `MAX_VERIFY = 5` 的自我验证机制——写操作后会强制多跑一轮确认真的生效，极端情况下单轮对话的工具调用总数可达 6 + 10 = 16。工具规模也远超"查询/创建/更新项目，创建日历事件"：`agent/tools/` 下 15 个文件、约 60 个工具，覆盖项目全生命周期（含阶段/待办/优先级/归档）、文件与文件夹增删改查、回收站、日历事件与提醒、客户、通用定时任务、对话历史检索、记忆写入、联网搜索/深度研究等。

**定时任务**（`scheduled_tasks.py`）：用户自定义 cron 任务的 CRUD，与日历事件提醒（`ScheduledTask.event_id`）是两套概念但共用一张表。

**Admin 配置**（`config.py`，需 Admin Token）
```
GET    /api/v1/admin/config
PATCH  /api/v1/admin/config                    热更新，写入 config.override.json，无需重启
POST   /api/v1/admin/config/init-db
POST   /api/v1/admin/config/test-connection    测试 DB / OSS 连通性
POST   /api/v1/admin/config/test-search        测试 SearXNG / Tavily
POST   /api/v1/admin/config/test-smtp
GET    /api/v1/admin/config/reconcile-storage         存储↔DB 对账（只读），见 storage.md §十
POST   /api/v1/admin/config/reconcile-storage/repair  对账修复
```

**其余 Admin 路由**（均挂 `Depends(require_admin)`）：`agent_admin`（Agent 行为配置）、`agent_perception`、`invite_codes`、`audit_log`、`system_logs`、`users_admin`、`services_admin`、`admin_debug`、`admin_analytics`、`ops_admin`、`feedback.admin_router`、`notifications_admin`。

**IM 平台连接**（用户态）：`qq_connect.py`、`feishu_connect.py`、`wechat_connect.py`——扫码绑定/解绑自己的 IM 账号。`user_bots.py` 管理自带机器人凭据。

**其他用户态路由**：`search.py`（联网搜索代理）、`track.py`（埋点上报）、`feedback.py`（用户反馈提交）、`notifications.py`（站内通知）、`live.py`、`onboarding`（新手引导，独立子系统 `backend/onboarding/`）。

**说明**：`app/api/v1/tasks.py` 文件存在但内容为空（0 字节），`main.py` 里也未导入，属于历史遗留的占位文件，不代表真实功能。

### 2.6 配置系统

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
| `quota` | 全局默认配额上限（Token / 存储 / 搜索次数），None=不限 |
| `search` | Tavily API Key（深度研究）+ SearXNG 地址与引擎列表 |
| `smtp` | 邮件发送配置（反馈通知、密码重置） |
| `state_labels` | 对话中"状态指示"文案的自定义覆盖 |

嵌套配置类特意用 `BaseModel` 而非 `BaseSettings`——避免 `apply_override` 调 `model_validate` 时触发二次 env 读取，把 override 值覆盖掉（`config.py` 文件头注释原话）。`get_settings()` 用 `@lru_cache`，Admin 写入 override 后调用 `get_settings.cache_clear()` 触发重新加载。加新的嵌套配置段务必在 `apply_override()` 里显式合并，否则该段会静默变成裸 dict 或不生效（有过实际踩坑）。

### 2.7 鉴权设计

| Token 类型 | 签发 | 用途 | 有效期 |
|-----------|------|------|--------|
| User JWT | `POST /auth/login` | 所有用户数据 API | `access_token_expire_minutes`，默认 10080 分钟（7 天） |
| Admin JWT | `POST /admin/auth/login` | Admin 配置 API | 同上 |
| Stream JWT | `create_stream_token()` | 文件流式播放的短期鉴权 | 10 分钟 |

三类 Token 均为 HS256、`payload["role"]` 区分用途：`user` → `get_current_user`/`get_current_user_id`；`admin`/`superadmin` → `main.py` 的 `require_admin`；`stream` → `verify_stream_token`。User Token payload 含 `sub`（UUID 字符串形式的 user_id）；Admin Token payload 含 `sub`（username）+ `role`；Stream Token 额外带 `fid`（file_id）。密码哈希直接调用 `bcrypt.hashpw`/`checkpw`，未经 passlib 封装。

### 2.8 启动流程（lifespan）

1. `create_all_tables()` 建表（`DB_STARTUP_TIMEOUT` 环境变量控制超时，默认 5s，超时后跳过并后台重试）
2. 清理旧 JPEG 缩略图缓存（历史遗留，迁移到 WebP 后的清理逻辑）
3. 启动 `_auto_cleanup_loop()`：每小时清理过期回收站文件 + 每 24 小时驱逐冷缩略图（TTL 30 天）
4. 启动 `_db_retry_loop()`：DB 不可达时每 30 秒重试建表，连上即建表退出
5. 启动 `flush_log_queue()`：日志队列落盘任务

### 2.9 Schema 规范

所有 schema 继承 `CamelModel`（`app/schemas/__init__.py`）：

```python
class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,   # snake_case → camelCase（前端直接用 displayName 等）
        populate_by_name=True,
        from_attributes=True,       # 支持 ORM 对象直接 .model_validate()
    )
```

### 2.10 本地启动

```bash
cd backend
make start      # 等价于：source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
make stop       # kill 进程
make restart
```

访问：`http://localhost:8000/docs`（Swagger UI）

### 2.11 添加新端点

1. 在 `app/models/__init__.py` 添加 SQLAlchemy 模型，在 `_MIGRATIONS` 追加 `ALTER TABLE`
2. 在 `app/schemas/__init__.py` 添加 `XxxCreate`、`XxxUpdate`、`XxxResponse`（继承 `CamelModel`）
3. 在 `app/api/v1/` 新建 `xxx.py`，定义 `APIRouter`，注入 `get_current_user`
4. 在 `app/main.py` `import` 并 `app.include_router(xxx.router, prefix="/api/v1")`（需要 Admin 鉴权的话加 `dependencies=[Depends(require_admin)]`）
5. 在 `frontend/src/services/api.js` 添加对应 `xxxApi` 对象

### 2.12 常见问题

**Q: 启动报 `asyncpg.exceptions.InvalidPasswordError`**
确认 PostgreSQL 用户名密码与 `.env` 一致，检查 `pg_hba.conf` 是否允许本地连接。

**Q: 上传文件报 `500 OSError`**
检查 `STORAGE__LOCAL_PATH` 目录是否存在且有写权限。

**Q: 修改配置不生效**
修改 `.env` 需重启；通过 Admin UI 写入 override 自动热加载，无需重启。加新的嵌套配置段本身如果没有在 `apply_override()` 里同步注册合并逻辑，也会表现为"改了不生效"。

**Q: 缩略图不更新**
删除 `uploads/.thumbs/` 目录下对应文件（或全部），下次请求时重新生成。

### 2.13 时间与时区约定

写任何涉及时间的代码，遵循四条（详见 [时区与时钟迁移方案.md](时区与时钟迁移方案.md)）：

1. **存储一律 aware UTC**：datetime 列用 `app/db/types.py` 的 `UtcDateTime`（不是裸 `DateTime`）——两库进出都是 aware UTC（Postgres timestamptz / SQLite naive + 读出补 UTC），业务代码不再有 naive/aware 混用。
2. **当前时间走单一出口 `app.core.tz.now_utc()`**（aware UTC）——**禁止裸调 `datetime.utcnow()`**（已弃用 + naive）。静态守卫 `python scripts/check_utcnow.py` 拦回归，例外加 `# utcnow-exempt` 标记。
3. **只有「展示」和「日期归属」（今天/本周/属于哪天）才碰用户时区**：用 `tz.user_tz(user)` / `tz.day_key/today_str/is_today/is_this_week`；agent 请求内的深层代码（工具等）读 `tz.now_ctx()`（入口已 set contextvar）。绝对时刻的比较/加减一律在 UTC 下做，不碰时区。运维口径（analytics/quota）用服务器 `LOCAL_TZ`，不 per-user。前端展示后端时间统一用 `dateAttribution.ts` 的 `fmtLocalDateTime`/`localDayKey`（查看者浏览器 tz），别用 `iso.slice(0,10)`（那是 UTC）或后端 `fmt_local`（那是服务器 tz）。
4. **SQL 按本地日分桶（GROUP BY DATE）用 `DATE(col AT TIME ZONE <tz>)`，别用 `DATE(col + INTERVAL '±Nh')`**：列迁 timestamptz 后，`col + INTERVAL` 的结果依赖 DB 会话时区（会话非 UTC 时会再偏一次），`AT TIME ZONE` 显式转 naive 本地时间、与会话时区无关且 DST 正确。见 `admin_analytics.py` + `tz.utc_to_local_date_expr`。

---

*待核实：Agent 精力/配额系统（`token_limit_*`、`QuotaSettings`）的具体计费与窗口规则，onboarding 子系统的路由细节——体量较大，建议后续单独开文档覆盖，本文档仅做了存在性确认。*
