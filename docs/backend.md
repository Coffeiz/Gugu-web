# PM Studio — 后端开发文档

## 技术栈

| 层次 | 技术 |
|------|------|
| Web 框架 | FastAPI 0.111+ |
| ORM | SQLAlchemy 2.0 async |
| 数据库 | PostgreSQL（asyncpg 驱动） |
| 迁移 | Alembic（async 模式） |
| 鉴权 | JWT（python-jose + bcrypt） |
| 配置 | pydantic-settings + .env + config.override.json |
| 存储 | 本地文件系统 / 阿里云 OSS（可切换） |
| AI | OpenAI 兼容接口（默认 qwen-max） |

---

## 目录结构

```
backend/
├── app/
│   ├── main.py               # FastAPI 应用入口、CORS、路由注册
│   ├── core/
│   │   └── config.py         # 配置加载（BaseSettings + override 热加载）
│   ├── db/
│   │   ├── base.py           # DeclarativeBase
│   │   └── session.py        # async engine、get_db 依赖、create_all_tables
│   ├── models/
│   │   └── __init__.py       # 所有 SQLAlchemy 模型
│   ├── schemas/
│   │   └── __init__.py       # 所有 Pydantic v2 schema（camelCase 输出）
│   └── api/
│       └── v1/
│           ├── admin_auth.py  # POST /admin/auth/login, GET /admin/auth/me
│           ├── projects.py    # CRUD /projects
│           ├── files.py       # 文件上传 / 版本管理
│           ├── events.py      # 日历事件 CRUD
│           ├── clients.py     # 客户 CRUD
│           ├── config.py      # Admin 配置热写（需 Token）
│           ├── agent.py       # AI 对话接口
│           └── tasks.py       # 后台任务（预留）
├── alembic/
│   ├── env.py                 # Alembic async 配置
│   └── versions/              # 迁移脚本
├── alembic.ini
├── requirements.txt
└── .env                       # 本地环境变量（不进 git）
```

---

## 本地启动

### 1. 准备环境

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. 配置 .env

```env
# 数据库
DB__HOST=localhost
DB__PORT=5432
DB__NAME=pm_studio
DB__USER=pm
DB__PASSWORD=pm123

# JWT 密钥（生产环境必须修改）
SECRET_KEY=change-me-in-production
ACCESS_TOKEN_EXPIRE_MINUTES=10080   # 7 天

# 文件存储
STORAGE__BACKEND=local
STORAGE__LOCAL_PATH=./uploads

# AI（可选）
AI__PROVIDER=qwen
AI__API_KEY=your-key
AI__MODEL=qwen-max

# 调试模式（开启 SQLAlchemy 日志）
DEBUG=false
```

### 3. 创建数据库

```bash
psql -U postgres -c "CREATE USER pm WITH PASSWORD 'pm123';"
psql -U postgres -c "CREATE DATABASE pm_studio OWNER pm;"
```

### 4. 启动

```bash
uvicorn app.main:app --reload --port 8000
```

开发阶段启动时会自动调用 `create_all_tables()` 建表，无需手动运行迁移。

访问 API 文档：http://localhost:8000/docs

---

## 配置系统

配置优先级（由低到高）：

1. 代码默认值
2. `.env` 文件
3. 环境变量
4. `config.override.json`（通过 Admin UI 写入，热加载，无需重启）

嵌套配置使用双下划线分隔，例如 `DB__HOST=localhost`。

`get_settings()` 使用 `@lru_cache`，应用生命周期内只加载一次。Admin 写入 override 后调用 `get_settings.cache_clear()` 触发重新加载。

---

## 数据库模型

### Project（项目）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | 自增主键 |
| name | String(200) | 项目名称 |
| client | String(200)? | 客户名称 |
| status | String(20) | `pending` / `active` / `done` |
| start_date | String(10)? | ISO 日期 `YYYY-MM-DD` |
| deadline | String(10)? | ISO 日期 `YYYY-MM-DD` |
| color | String(300) | CSS 渐变字符串 |
| progress | Integer | 0–100 |
| stages_json | Text | JSON 存储 `[{key, label}]` 阶段列表 |
| current_stage | String(100)? | 当前阶段 key |
| notes | Text | 备注 |
| created_at / updated_at | DateTime | 时间戳 |

`stages_json` 通过 `@property stages` 提供 Python 列表访问，`setter` 自动序列化。

### File（文件）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| display_name | String(300) | 文件名（不含扩展名） |
| ext | String(20) | 扩展名大写，如 `PSD` |
| project_id | FK → projects? | 关联项目（可为空） |
| project_name | String(200)? | 冗余字段，避免 join |
| project_color | String(300)? | 冗余字段，从项目 color 提取十六进制色 |
| stage | String(100) | 所属阶段标签 |
| created_at | DateTime | |

### FileVersion（文件版本）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| file_id | FK → files CASCADE | |
| v | Integer | 版本号，从 1 开始递增 |
| size | String(50) | 人类可读大小，如 `2.3 MB` |
| note | String(500) | 版本备注 |
| storage_path | String(500) | 本地路径（绝对路径）或 OSS key |
| date_str | String(10) | 显示日期，如 `06/15` |

### CalendarEvent（日历事件）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| title | String(300) | |
| date | String(10) | `YYYY-MM-DD` |
| type | String(50) | `deadline` / `milestone` / `meeting` / `event` |
| client | String(200)? | |
| project_id | FK → projects? | |

### Client（客户）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK | |
| name | String(200) | |
| contact | String(200)? | 联系人 |
| email | String(300)? | |
| phone | String(50)? | |
| notes | Text | |

---

## API 端点

所有端点前缀 `/api/v1`，返回 camelCase JSON。

### 健康检查

```
GET /health
```

### 管理员认证

```
POST /api/v1/admin/auth/login    body: {username, password}  → {access_token, token_type, user}
GET  /api/v1/admin/auth/me       Header: Authorization: Bearer <token>
```

默认账号 `admin` / `admin123`（上线前修改 `admin_auth.py` 中的 hash）。

### 项目

```
GET    /api/v1/projects           列表（按创建时间倒序）
POST   /api/v1/projects           创建
GET    /api/v1/projects/{id}      单条
PATCH  /api/v1/projects/{id}      部分更新
DELETE /api/v1/projects/{id}      删除
```

**ProjectCreate / ProjectUpdate 字段（camelCase）：**
`name`, `client`, `status`, `startDate`, `deadline`, `color`, `progress`, `stages`, `currentStage`, `notes`

### 文件

```
GET    /api/v1/files              列表，支持查询参数 project_id、ext、q
POST   /api/v1/files              上传文件（multipart/form-data）
POST   /api/v1/files/{id}/versions  上传新版本（multipart/form-data）
DELETE /api/v1/files/{id}         删除（同时删除磁盘文件）
```

上传字段：`file`（二进制）、`project_id`（可选）、`stage`、`note`。

文件按用户隔离存储，详见 `docs/file-storage.md`。

### 日历事件

```
GET    /api/v1/events             列表，支持 year、month 过滤
POST   /api/v1/events             创建
PATCH  /api/v1/events/{id}        部分更新
DELETE /api/v1/events/{id}        删除
```

### 客户

```
GET    /api/v1/clients            列表
POST   /api/v1/clients            创建
DELETE /api/v1/clients/{id}       删除
```

### Admin 配置（需 Token）

```
GET  /api/v1/admin/config         读取当前配置
POST /api/v1/admin/config         写入 override（部分字段，热加载）
```

---

## Schema 设计规范

所有 schema 继承 `CamelModel`：

```python
class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,   # snake_case → camelCase
        populate_by_name=True,       # 同时接受 snake_case 输入
        from_attributes=True,        # 支持 ORM 对象直接转换
    )
```

这样前端无需任何转换，直接使用 `project.startDate`、`file.displayName` 等字段。

---

## 鉴权

目前仅 `/api/v1/admin/*` 路由需要 Admin JWT Token，其余用户路由需要 User JWT Token：

```python
# main.py
app.include_router(
    config_router.router,
    prefix="/api/v1",
    dependencies=[Depends(require_admin)],
)
```

Token 由 `POST /api/v1/admin/auth/login` 签发，默认有效期 7 天，使用 HS256 算法。Payload 包含 `sub`（用户名）和 `role`（`superadmin` / `admin`）。

---

## Alembic 迁移

**仅生产环境使用**，开发阶段由 `create_all_tables()` 自动建表。

```bash
# 生成迁移脚本
alembic revision --autogenerate -m "add_xxx_table"

# 执行迁移
alembic upgrade head

# 回滚一步
alembic downgrade -1

# 查看当前版本
alembic current
```

`alembic/env.py` 使用 `async_engine_from_config` + `asyncio.run()`，完整支持 asyncpg。

---

## 文件存储

当前使用本地存储，文件按用户隔离保存：

```
uploads/
  {user_id}/
    {file_id}_v{version}_{original_name}
```

详细说明（命名规则、DB 对应关系、上传/删除流程、用户隔离保证）见 `docs/file-storage.md`。

切换阿里云 OSS：在 `.env` 中设置 `STORAGE__BACKEND=oss` 并填写 `STORAGE__OSS_*` 变量（`files.py` 中尚需实现 OSS 分支逻辑）。

---

## 前端集成

前端通过 `frontend/src/services/api.js` 统一调用，读取 `VITE_API_URL` 环境变量（默认 `http://localhost:8000/api/v1`）。

采用 **mock + API 双轨策略**：各 store 和页面内置 mock 数据作为初始值，API 在线时覆盖，离线时保留 mock，确保开发体验不依赖后端。

---

## 添加新端点（步骤）

1. **模型**：在 `app/models/__init__.py` 添加新 SQLAlchemy 模型类
2. **Schema**：在 `app/schemas/__init__.py` 添加 `XxxCreate`、`XxxUpdate`、`XxxResponse`（继承 `CamelModel`）
3. **路由**：在 `app/api/v1/` 新建 `xxx.py`，定义 `APIRouter`
4. **注册**：在 `app/main.py` `import` 并 `app.include_router(xxx.router, prefix="/api/v1")`
5. **迁移**：`alembic revision --autogenerate -m "add_xxx"` → `alembic upgrade head`
6. **前端**：在 `frontend/src/services/api.js` 添加对应 `xxxApi` 对象

---

## 常见问题

**Q: 启动报 `asyncpg.exceptions.InvalidPasswordError`**
确认 PostgreSQL 用户名密码与 `.env` 一致，或检查 `pg_hba.conf` 是否允许本地连接。

**Q: 上传文件报 `500 OSError`**
检查 `STORAGE__LOCAL_PATH` 目录是否存在且有写权限；或检查磁盘空间。

**Q: JWT Token 过期**
重新 `POST /api/v1/admin/auth/login` 获取新 Token。

**Q: 修改配置不生效**
若修改了 `.env`，需重启 uvicorn；若通过 Admin API 写入 override，自动热加载，无需重启。
