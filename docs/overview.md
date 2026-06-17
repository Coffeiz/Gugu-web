# 咕咕 · 项目文档

> 最后更新：2026-06-17
> 代号：咕咕 · 域名：gugugu.site

---

## 一、项目简介

**咕咕** 是一个面向自由职业创作者（插画、动画等）的 AI 驱动项目管理工具。核心功能是用自然语言 Agent 管理项目进度、文件归档和排期提醒，未来扩展至团队/企业（ToB）。

**规划功能空间：**

| 空间 | 说明 | 状态 |
|------|------|------|
| 项目 | 看板管理、阶段跟踪、截止日期 | ✅ 完成 |
| 日历 | 项目排期可视化、自定义事件 | ✅ 完成 |
| 文件库 | 按项目/阶段归档，本地/OSS 双后端 | ✅ 完成（重构后） |
| 总览 | 统计卡片、近期节点、最近文件 | ✅ 完成 |
| 思维 | 创意画布（节点图），可挂文件 | 🔜 预留 |
| 素材板 | 素材管理，自动打 tag | 🔜 预留 |
| 客户 | 客户信息管理 | 🔜 规划中 |
| AI Agent | 自然语言对话，记忆/提醒 | 🔜 规划中 |

---

## 二、技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端框架 | Vue 3 + Vite | Composition API，`<script setup>` |
| 状态管理 | Pinia | 按业务拆分 store |
| UI 组件库 | Arco Design Vue | 飞书出品 |
| 后端框架 | FastAPI (Python) | 异步，AI 生态丰富 |
| 数据库 | PostgreSQL + SQLAlchemy 2.0 | 异步驱动 asyncpg |
| 缓存 | Redis | 会话缓存、实时推送（预留） |
| 文件存储 | 本地磁盘 / 阿里云 OSS | Admin 面板可热切换，无需重启 |
| AI | 通义千问（OpenAI 兼容格式） | 可切换 5 个 provider |
| 认证 | JWT（jose + passlib） | 用户 Token + Admin Token 分离 |
| 容器化 | Docker Compose | 本地一键启动全栈 |

---

## 三、目录结构

```
Gugu-web/
├── docs/
│   ├── overview.md       ← 本文件（主文档）
│   ├── backend.md        ← 后端开发参考
│   ├── design.md         ← UI/UX 设计规范
│   ├── storage.md        ← 文件存储结构规范（权威文档）
│   ├── wishlist.md       ← 功能 Wishlist
│   └── dev-log.md        ← 早期开发记录
├── docker-compose.yml
├── design/
│   └── prototype.html    ← 可交互原型稿
├── frontend/
│   └── src/
│       ├── main.js
│       ├── assets/styles/
│       │   ├── variables.css     ← CSS 设计 Token
│       │   └── global.css
│       ├── router/index.js
│       ├── stores/               ← projects / ui / config / admin
│       ├── services/
│       │   ├── api.js            ← projectsApi / filesApi / eventsApi / clientsApi
│       │   └── cache.js          ← uploadSignal（跨组件刷新信号）
│       ├── layouts/
│       │   ├── DefaultLayout.vue
│       │   └── AdminLayout.vue
│       ├── components/common/
│       │   ├── AppSidebar.vue
│       │   ├── NavItem.vue
│       │   ├── AiFloatBall.vue
│       │   └── DatePicker.vue
│       └── views/
│           ├── Dashboard/
│           ├── Projects/
│           ├── Calendar/
│           ├── Files/
│           │   ├── index.vue
│           │   └── UploadModal.vue
│           └── Admin/
└── backend/
    └── app/
        ├── main.py
        ├── core/
        │   ├── config.py         ← StorageSettings / AISettings / DBSettings
        │   └── security.py
        ├── api/v1/
        │   ├── auth.py
        │   ├── admin_auth.py
        │   ├── config.py
        │   ├── projects.py
        │   ├── files.py
        │   ├── events.py
        │   ├── clients.py
        │   └── agent.py          ← 待实现
        ├── models/__init__.py    ← User/Project/File/MindMap/CalendarEvent/Client
        ├── schemas/__init__.py
        ├── services/
        │   └── storage/          ← StorageBackend / LocalStorageBackend / OSSStorageBackend
        └── db/
```

---

## 四、路由结构

### 主 App

| 路径 | 页面 | 状态 |
|------|------|------|
| `/dashboard` | 总览 | ✅ |
| `/projects` | 项目看板 | ✅ |
| `/calendar` | 日历 | ✅ |
| `/files` | 文件库 | ✅（重构后） |
| `/mind` | 思维画布 | 🔜 即将推出 |

### 管理后台

| 路径 | 页面 | 状态 |
|------|------|------|
| `/admin/login` | 管理员登录 | ✅ |
| `/admin/config` | 系统配置（DB / Redis / Storage / AI） | ✅ |

---

## 五、后端 API

### 用户 API（需 User Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST/PATCH/DELETE` | `/api/v1/projects` | 项目 CRUD；改名时联动重命名存储目录 |
| `GET` | `/api/v1/files` | 列出文件（支持 space/project_id/stage_name/ext/q 过滤） |
| `GET` | `/api/v1/files/tree` | 文件库导航树（项目→阶段汇总） |
| `POST` | `/api/v1/files` | 上传文件（支持四空间） |
| `PATCH` | `/api/v1/files/{id}` | 重命名/移动文件（同步磁盘） |
| `DELETE` | `/api/v1/files/{id}` | 删除文件（同步磁盘） |
| `GET/POST/PATCH/DELETE` | `/api/v1/events` | 日历事件 CRUD |
| `GET/POST/DELETE` | `/api/v1/clients` | 客户 CRUD |

### Admin API（需 Admin Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/admin/auth/login` | 管理员登录 |
| `GET/PATCH` | `/api/v1/admin/config` | 读取/更新系统配置（热更新） |
| `POST` | `/api/v1/admin/config/test-connection` | 测试 DB / Redis / OSS 连通性 |

### 已废弃

- `POST /api/v1/files/{id}/versions` — 版本管理已移除
- `GET/POST/PATCH/DELETE /api/v1/folders/*` — 自定义文件夹已移除

---

## 六、数据库模型

| 表 | 说明 | 状态 |
|----|------|------|
| `users` | 用户账号 | ✅ |
| `projects` | 项目（含 stages_json、done_at） | ✅ |
| `files` | 文件（四空间：project/mind/asset/personal） | ✅ 重构后 |
| `calendar_events` | 日历事件 | ✅ |
| `clients` | 客户信息 | ✅ |
| `mind_maps` | 思维画布（预留，暂不开发） | ✅ 表结构已建 |
| `conversation_sessions` | AI 对话会话 | ✅ |
| `conversation_messages` | AI 对话消息 | ✅ |

**已移除：** `file_versions`、`folders`

文件存储详细规范见 `docs/storage.md`。

---

## 七、文件存储（摘要）

四个独立空间，存储路径均以 `storage_key`（相对路径）标识：

```
{user_id}/
├── {项目名} #{id}/          ← project 空间
│   └── {阶段名}/
├── 思维/{画布名} #{id}/     ← mind 空间（预留）
├── 素材板/                  ← asset 空间（预留）
└── 个人文件/                ← personal 空间
```

存储后端（local / oss）可通过 Admin 面板实时切换，`storage_key` 格式对两种后端完全一致。

详见 `docs/storage.md`。

---

## 八、配置系统

优先级：`.env` → `config.override.json`（Admin UI 写入，热更新无需重启）

| 分区 | 关键字段 |
|------|---------|
| `db` | host / port / name / user / password |
| `redis` | host / port / password |
| `storage` | backend(`local`\|`oss`) / local_path / oss_* / oss_prefix |
| `ai` | provider / api_key / base_url / model |

默认 Admin 账号：`admin / admin123`（**上线前必须修改**）

---

## 九、UI 设计规范（摘要）

**风格：** Glassmorphism + 冷淡灰紫色系

| 变量 | 值 |
|------|----|
| 背景渐变 | `#e8e9ee` → `#9aa2b8`（160deg，fixed） |
| 卡片 | `rgba(255,255,255,0.56)` + `backdrop-filter: blur(20px)` |
| 主色 | `#7b7fb2`（灰紫） |
| 辅色 | `#c4afc8`（粉灰）/ `#7ab8c8`（青灰） |
| 成功 | `#5a9e88` |
| 警告 | `#b07858` |
| 圆角 | 面板 `18px`，元素 `10–14px` |
| 弹窗动画 | **纯 opacity，禁止任何 transform**（backdrop-filter 兼容性问题） |

详见 `docs/design.md`。

---

## 十、本地启动

**Docker Compose（推荐）**
```bash
cp .env.example .env
docker-compose up
```

**分别启动**
```bash
# 后端（必须在 backend/ 目录）
cd backend && uvicorn app.main:app --reload --port 8000

# 前端
cd frontend && npm run dev
```

访问：`http://localhost:5173`（前端）· `http://localhost:8000/docs`（API 文档）

---

## 十一、开发进度

### 已完成 ✅

- 全局布局：侧边栏、顶栏玻璃效果、路由守卫
- 通用组件：AppSidebar（通知弹窗）、NavItem、AiFloatBall、DatePicker
- **总览（Dashboard）**：统计卡片、项目列表、日历面板、文件面板
- **项目看板（Projects）**：三列看板、拖拽、DoneColumn 年月折叠、ProjectModal/NewProjectModal
- **日历（Calendar）**：月视图、项目 bar、事件 chip、实时拖拽预览、跨夜日期自动更新
- **文件库（Files）**：四空间架构重构、项目/阶段树导航、拖拽上传预填、XHR 进度条、local/OSS 存储抽象
- 管理后台：登录、系统配置（DB/Redis/Storage/AI 热更新）
- 后端全套 API + 存储抽象层

### 待开发 🚧

| 优先级 | 功能 |
|--------|------|
| 高 | AI Agent 接口（SSE 流式，接通义千问） |
| 高 | 前端文件库重构（适配新 API） |
| 中 | 客户管理页面 |
| 中 | Admin 面板存储配置 UI（OSS 切换） |
| 低 | 通知系统后端 |
| 低 | 思维画布页面 |
| 低 | 素材板页面 |

---

## 十二、下一步建议顺序

```
前端文件库重构（适配新后端 API）
       ↓
Admin 存储配置 UI（OSS 测试连接 + backend 切换）
       ↓
AI Agent 接入（通义千问 SSE 流式）
       ↓
客户管理页面
       ↓
思维 / 素材板
```
