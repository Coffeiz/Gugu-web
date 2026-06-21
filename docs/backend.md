# 咕咕 · 后端开发文档

> 最后更新：2026-06-21

---

## 技术栈

| 层次 | 技术 |
|------|------|
| Web 框架 | FastAPI（async lifespan） |
| ORM | SQLAlchemy 2.0 async + asyncpg |
| 数据库 | PostgreSQL |
| 鉴权 | JWT（python-jose + bcrypt），User Token / Admin Token 分离 |
| 配置 | pydantic-settings + `.env` + `config.override.json`（热加载） |
| 存储 | 本地磁盘 / 阿里云 OSS，Admin 面板热切换无需重启 |
| AI | Anthropic / OpenAI / 通义千问 / DeepSeek / MiniMax，共用 OpenAI-compatible 接口 |

---

## 目录结构

```
backend/
├── Makefile                      # make start / stop / restart
├── requirements.txt
├── .env                          # 本地环境变量（不进 git）
└── app/
    ├── main.py                   # FastAPI 入口，路由注册，lifespan（建表 + 后台任务）
    ├── core/
    │   ├── config.py             # pydantic-settings，StorageSettings / AISettings / DBSettings
    │   └── security.py           # JWT 签发 / 验证，get_current_user 依赖
    ├── db/
    │   ├── base.py               # DeclarativeBase
    │   └── session.py            # async engine，get_db，create_all_tables，_MIGRATIONS
    ├── models/__init__.py        # 所有 SQLAlchemy 2.0 模型（见下方）
    ├── schemas/__init__.py       # 所有 Pydantic v2 schema（camelCase 输出）
    ├── services/
    │   ├── storage/__init__.py   # StorageBackend 抽象 + LocalStorageBackend + OSSStorageBackend
    │   └── agent/__init__.py     # LangChain / Anthropic SSE 流式 Agent 逻辑
    └── api/v1/
        ├── auth.py               # POST /auth/register, /auth/login, GET /auth/me
        ├── admin_auth.py         # POST /admin/auth/login, GET /admin/auth/me
        ├── config.py             # GET/PATCH /admin/config（需 Admin Token）
        ├── projects.py           # CRUD /projects
        ├── files.py              # 文件上传/下载/缩略图/版本/全量/同步
        ├── folders.py            # 文件夹 CRUD
        ├── trash.py              # 回收站列出/恢复/删除/清空
        ├── events.py             # 日历事件 CRUD
        ├── clients.py            # 客户 CRUD
        ├── preferences.py        # GET/PATCH /preferences（用户偏好）
        ├── agent.py              # POST /agent/chat（SSE 流式 AI 对话）
        └── tasks.py              # 后台任务（预留）
```

---

## 数据库模型

所有表含 `user_id`（外键 → `users.id` CASCADE），全面用户隔离。

### User

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| username | String(100) unique | |
| email | String(300) unique | |
| hashed_password | String(200) | bcrypt |
| is_active | Boolean | |
| created_at | DateTime | |

### UserPreferences

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| user_id | FK → users unique | 每用户仅一行 |
| data_json | Text | JSON blob，存 `stageTemplates`、`lastStages` 等偏好 |
| updated_at | DateTime | |

`data` property 自动解析/序列化 JSON。

### Project

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
| notes | Text | |
| archived | Boolean | |
| done_at | DateTime? | 标记为完成时的时间戳 |
| created_at / updated_at | DateTime | |

### File

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| user_id | FK → users | |
| display_name | String(300) | 文件名（不含扩展名） |
| ext | String(20) | 扩展名小写，如 `pdf` |
| space | String(20) | `personal` / `project` / `mind` / `asset` |
| project_id | FK → projects? | NULL = 个人文件 |
| folder_id | FK → folders? | NULL = 所属空间根目录 |
| stage_name | String(100) | 文件标签（非导航层级） |
| mind_map_id | FK → mind_maps? | 预留 |
| storage_key | String(500) | 相对于 `UPLOAD_DIR` 的路径，OSS 迁移直接复用 |
| size | String(50) | 人类可读，如 `2.3 MB` |
| size_bytes | BigInteger | |
| mime_type | String(200)? | |
| img_width / img_height | Integer? | 图片尺寸（上传时提取） |
| deleted_at | DateTime? | 非 NULL = 已进回收站 |
| created_at / updated_at | DateTime | |

### Folder

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| user_id | FK → users | |
| project_id | FK → projects? | NULL = 个人文件夹 |
| parent_id | FK → folders? | 自引用，NULL = 根目录，支持无限嵌套 |
| name | String(200) | |
| created_at | DateTime | |

删除文件夹时级联删除子文件夹，文件 `folder_id` SET NULL。

### CalendarEvent

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| user_id | FK → users | |
| title | String(300) | |
| date | String(10) | `YYYY-MM-DD` |
| type | String(50) | `deadline` / `milestone` / `meeting` / `event` |
| client | String(200)? | |
| project_id | FK → projects? | |
| description | Text? | |
| created_at | DateTime | |

### Client

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| user_id | FK → users | |
| name | String(200) | |
| contact / email / phone | String? | |
| notes | Text | |
| created_at | DateTime | |

### ConversationSession / ConversationMessage

AI 对话会话和消息，结构已建，前端持久化待开发。

### MindMap

思维画布，表结构已建，前端待开发。

---

## 自动迁移

不使用 Alembic，开发阶段由 `session.py` 的 `create_all_tables()` 自动建表：

```python
_MIGRATIONS = [
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL",
    # 新增 nullable 列在此追加，幂等安全
]
```

启动时自动执行所有迁移 SQL，新增 nullable 列直接追加即可。

---

## API 端点

所有端点前缀 `/api/v1`，返回 camelCase JSON。

### 用户认证

```
POST /api/v1/auth/register      {username, email, password} → {access_token, user}
POST /api/v1/auth/login         {username, password} → {access_token, user}
GET  /api/v1/auth/me            → 当前用户信息
```

### 管理员认证

```
POST /api/v1/admin/auth/login   {username, password} → {access_token}
GET  /api/v1/admin/auth/me
```

默认账号 `admin / admin123`（上线前必须修改）。

### 项目

```
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{id}
PATCH  /api/v1/projects/{id}    改名时联动重命名磁盘目录 + 批量更新 storage_key
DELETE /api/v1/projects/{id}
```

### 文件

```
GET    /api/v1/files                    列出（project_id / folder_id / ext / q 过滤）
GET    /api/v1/files/all                全量文件元数据（前端全量缓存用）
GET    /api/v1/files/version            状态摘要 count:max_updated:max_deleted（前端变更感知）
POST   /api/v1/files                    上传（multipart），后台预生成缩略图
PATCH  /api/v1/files/{id}              重命名 / 移动（更新 storage_key）
DELETE /api/v1/files/{id}              软删除（移入回收站）
POST   /api/v1/files/batch-delete      批量软删除
POST   /api/v1/files/{id}/copy         复制到指定目录
GET    /api/v1/files/{id}/download     下载，Authorization Bearer 鉴权
GET    /api/v1/files/{id}/stream       视频流
GET    /api/v1/files/{id}/thumb        缩略图（?size=tiny|card|full），Authorization Bearer 鉴权
GET    /api/v1/files/{id}/preview-pdf  Office → PDF 转换（LibreOffice headless）
```

**缩略图规格：**

| size | 分辨率 | 格式 | 用途 |
|------|--------|------|------|
| `tiny` | 20px | WebP q75 | blur-up 模糊占位 |
| `card` | 192px | WebP q82 | 网格卡片 |
| `full` | 原图 | 原格式 | 全尺寸预览 |

- 后端磁盘缓存：`uploads/.thumbs/{fid}_{size}.webp`
- 请求 tiny 或 card 时，两个尺寸同时生成并缓存（避免重复 I/O）
- 上传时 BackgroundTasks 立即预生成 tiny + card
- 删除文件时同步清理缩略图缓存

### 文件夹

```
GET    /api/v1/folders                  列出（project_id / parent_id 过滤）
GET    /api/v1/folders/all              全量文件夹元数据
POST   /api/v1/folders                  新建
PATCH  /api/v1/folders/{id}            重命名
DELETE /api/v1/folders/{id}            删除（级联子文件夹，文件 SET NULL）
GET    /api/v1/folders/{id}/download-zip  打包下载
```

### 回收站

```
GET    /api/v1/trash                    列出回收站文件
POST   /api/v1/trash/{id}/restore       恢复
POST   /api/v1/trash/batch-restore      批量恢复
DELETE /api/v1/trash/{id}               永久删除
DELETE /api/v1/trash/empty              清空
```

每小时后台任务自动永久删除 `deleted_at` 超过 30 天的文件。

### 日历事件

```
GET    /api/v1/events       （year / month 过滤）
POST   /api/v1/events
PATCH  /api/v1/events/{id}
DELETE /api/v1/events/{id}
```

### 客户

```
GET    /api/v1/clients
POST   /api/v1/clients
DELETE /api/v1/clients/{id}
```

### 用户偏好

```
GET   /api/v1/preferences   → {stageTemplates, lastStages, ...}
PATCH /api/v1/preferences   部分更新，merge 写入
```

### AI Agent

```
POST /api/v1/agent/chat     SSE 流式，支持 Anthropic / OpenAI-compatible 双路由
```

最多 5 轮工具调用，支持：查询/创建/更新项目，创建日历事件。

### Admin 配置（需 Admin Token）

```
GET   /api/v1/admin/config
PATCH /api/v1/admin/config              热更新，写入 config.override.json，无需重启
POST  /api/v1/admin/config/test-connection  测试 DB / OSS 连通性
```

---

## 配置系统

优先级（低 → 高）：代码默认值 → `.env` → 环境变量 → `config.override.json`

| 分区 | 关键字段 |
|------|---------|
| `db` | host / port / name / user / password |
| `storage` | backend(`local`\|`oss`) / local_path / oss_* |
| `ai` | provider / api_key / base_url / model |

`get_settings()` 使用 `@lru_cache`，Admin 写入 override 后调用 `get_settings.cache_clear()` 触发重新加载。

---

## 鉴权设计

| Token 类型 | 签发 | 用途 |
|-----------|------|------|
| User JWT | `POST /auth/login` | 所有用户数据 API |
| Admin JWT | `POST /admin/auth/login` | Admin 配置 API |

两类 Token 均为 HS256 / 7 天有效期。User Token payload 含 `sub`（user_id）；Admin Token payload 含 `role`（`superadmin`/`admin`）。

---

## 启动流程（lifespan）

1. `create_all_tables()` 建表（5s 超时，超时后跳过并后台重试）
2. 清理旧 JPEG 缩略图缓存（迁移到 WebP 后遗留文件）
3. 启动 `_auto_cleanup_loop()`：每小时清理过期回收站文件 + 每 24 小时驱逐冷缩略图（TTL 30 天）
4. 启动 `_db_retry_loop()`：DB 不可达时每 30 秒重试建表

---

## Schema 规范

所有 schema 继承 `CamelModel`：

```python
class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,   # snake_case → camelCase（前端直接用 displayName 等）
        populate_by_name=True,
        from_attributes=True,       # 支持 ORM 对象直接 .model_validate()
    )
```

---

## 本地启动

```bash
cd backend
make start      # 等价于：source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
make stop       # kill 进程
make restart
```

访问：`http://localhost:8000/docs`（Swagger UI）

---

## 添加新端点

1. 在 `models/__init__.py` 添加 SQLAlchemy 模型，在 `_MIGRATIONS` 追加 `ALTER TABLE`
2. 在 `schemas/__init__.py` 添加 `XxxCreate`、`XxxUpdate`、`XxxResponse`（继承 `CamelModel`）
3. 在 `api/v1/` 新建 `xxx.py`，定义 `APIRouter`，注入 `get_current_user`
4. 在 `main.py` `import` 并 `app.include_router(xxx.router, prefix="/api/v1")`
5. 在 `frontend/src/services/api.js` 添加对应 `xxxApi` 对象

---

## 常见问题

**Q: 启动报 `asyncpg.exceptions.InvalidPasswordError`**
确认 PostgreSQL 用户名密码与 `.env` 一致，检查 `pg_hba.conf` 是否允许本地连接。

**Q: 上传文件报 `500 OSError`**
检查 `STORAGE__LOCAL_PATH` 目录是否存在且有写权限。

**Q: 修改配置不生效**
修改 `.env` 需重启；通过 Admin UI 写入 override 自动热加载，无需重启。

**Q: 缩略图不更新**
删除 `uploads/.thumbs/` 目录下对应文件（或全部），下次请求时重新生成。
