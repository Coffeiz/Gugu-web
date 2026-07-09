# 咕咕 · Gugu

> 代号：**咕咕**　|　域名：[gugugu.site](https://gugugu.site)

一个陪伴**个人成长**的 AI 伙伴 + 项目管理工具——面向任何有目标要推进的人（工作、创作、学习、生活皆可，创作者是重点群体之一）。统一管理项目进度、文件归档、排期提醒与日常记录，通过自然语言完成操作，并扩展至团队 / 企业协作（ToB）。

![status](https://img.shields.io/badge/status-active-success)
![frontend](https://img.shields.io/badge/frontend-Vue%203-42b883)
![backend](https://img.shields.io/badge/backend-FastAPI-009688)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)

---

## ✨ 核心特性

| 功能 | 状态 | 说明 |
|------|:---:|------|
| 📋 项目看板 | ✅ | 阶段跟踪、截止日期、改名联动存储目录 |
| 📅 日历排期 | ✅ | 月/周视图、项目节点、自定义事件、活动提醒 |
| 🗂️ 文件库 | ✅ | 四空间（项目/思维/素材/个人），支持本地 / OSS 双后端和文件预览 |
| 🏠 总览 | ✅ | 统计卡片 + 近期节点 + 最近文件 |
| 🧠 思维画布 | 🔜 | 节点图创意空间，可挂文件 |
| 🎨 素材板 | 🔜 | 素材管理 + 自动打 tag |
| 👤 客户管理 | 🔜 | 后端与 Agent 工具已就绪，前端页面待开发 |
| 💬 自然语言管理 | ✅ | SSE 流式 AI 对话，支持 Anthropic / OpenAI / 通义 / DeepSeek / MiniMax / MiMo |
| ⏰ 定时任务 | ✅ | 一次性/周期提醒，支持通知与 IM 推送 |
| ⚙️ 管理后台 | ✅ | 配置热更新、用户管理、审计日志、运维监控、数据分析 |

---

## 🛠️ 技术栈

### 前端
- **框架**：Vue 3（Composition API + `<script setup>`）
- **构建**：Vite 5
- **状态**：Pinia
- **UI 库**：Arco Design Vue
- **图标库**：Phosphor Icons（`@phosphor-icons/vue`）
- **路由**：Vue Router 4
- **HTTP**：Axios

### 后端
- **框架**：FastAPI（异步）
- **ORM**：SQLAlchemy 2.0（asyncpg 驱动）
- **数据库**：PostgreSQL 16
- **迁移**：Alembic
- **缓存 / 队列**：Redis 7
- **认证**：JWT（python-jose + passlib）
- **文件存储**：本地磁盘 / 阿里云 OSS（运行时可热切换）

### 部署
- **容器化**：Docker Compose 一键起全栈
- **进程管理**：systemd 三服务（`gugu-web` / `gugu-worker` / `gugu-supervisor`）

---

## 🚀 快速开始

### 前置环境

- Docker 20+ & Docker Compose v2
- 或本地：Node.js 18+ / Python 3.11+

### 方式一：Docker Compose（推荐）

```bash
# 1. 克隆
git clone https://github.com/coffeiz/gugu-web.git
cd gugu-web

# 2. 准备环境变量
cp .env.example .env
# 编辑 .env，填入 SECRET_KEY / QWEN_API_KEY / OSS_* 等

# 3. 一键启动
docker compose up -d

# 4. 浏览器访问
# 前端  → http://localhost:5173
# 后端  → http://localhost:8000/docs
```

### 方式二：本地开发

#### 后端
```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 初始化数据库（需先起 PostgreSQL + Redis）
cp ../.env.example .env
alembic upgrade head

# 启动
./start.sh dev             # 或：make start
```

#### 前端
```bash
cd frontend
npm install
npm run dev                # http://localhost:5173
```

---

## 📂 目录结构

```
Gugu-web/
├── docs/                       # 项目文档（按主题分类，导航见 docs/README.md）
│   ├── agent/                   # Agent/AI：架构、记忆、感知、IM 接入、proposals/、_archive/
│   ├── backend/                 # 后端通用架构：backend.md、storage.md
│   ├── product/                 # 产品/前端：overview.md、design.md、wishlist.md 等
│   ├── ops/                     # 部署/性能/并发
│   ├── security/                # 隐私/安全/合规
│   └── devlog.md                # 早期开发日志（根目录，不分类）
├── design/
│   └── prototype.html          # 可交互原型稿
├── frontend/                   # Vue 3 前端
│   └── src/
│       ├── views/              # Dashboard / Projects / Calendar / Files / Admin
│       ├── components/         # 通用 + 业务组件
│       ├── stores/             # Pinia stores（projects / filesCache / preview / audio / clipboard）
│       ├── composables/        # useThumbCache（blob Map 缩略图缓存）
│       ├── services/           # api.ts（所有 API 封装）+ cache.ts（filesCache sessionStorage）
│       ├── layouts/            # DefaultLayout / AdminLayout
│       └── router/
├── backend/                    # FastAPI 后端
│   └── app/
│       ├── api/v1/             # auth / projects / files / events / clients / admin
│       ├── core/               # config / security
│       ├── db/                 # session / base
│       ├── models/             # SQLAlchemy 模型
│       ├── schemas/            # Pydantic schemas
│       └── services/
│           └── storage/        # LocalStorage / OSSStorage
├── backend/agent/              # 独立 Agent 包：工具、记忆、感知、IM 适配、提示词
├── backend/onboarding/         # 新手引导：教程项目/文件/日历活动 + 引导气泡
├── docker-compose.yml
└── .env.example
```

---

## ⚙️ 配置系统

优先级：**`.env`** → **`config.override.json`**（Admin UI 写入，**热更新无需重启**）

| 模块 | 来源 | 用途 |
|------|------|------|
| Database | `.env` + Admin | PostgreSQL 连接 |
| Redis | `.env` + Admin | 缓存、会话 |
| Storage | `.env` + Admin | 本地 / 阿里云 OSS |
| Security | `.env` | JWT Secret / 过期时间 |

管理后台路径：`/admin/config`（首次访问通过 `/admin/login` 登录）。

---

## 🔌 主要 API

### 用户 API（需 User Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST/PATCH/DELETE` | `/api/v1/projects` | 项目 CRUD；改名联动重命名存储目录 |
| `GET` | `/api/v1/files` | 文件列表（多维度过滤） |
| `GET` | `/api/v1/files/all` | 全量文件元数据（前端全量缓存用） |
| `GET` | `/api/v1/files/version` | 文件变更摘要（前端增量感知） |
| `GET` | `/api/v1/files/tree` | 文件库导航树 |
| `POST` | `/api/v1/files` | 上传文件，后台预生成缩略图 |
| `PATCH / DELETE` | `/api/v1/files/{id}` | 重命名 / 软删除（移入回收站） |
| `GET` | `/api/v1/files/{id}/thumb` | 缩略图（tiny/card/full），Authorization Bearer |
| `GET` | `/api/v1/files/{id}/download` | 文件下载 |
| `GET/POST/PATCH/DELETE` | `/api/v1/folders` | 文件夹 CRUD，支持无限嵌套 |
| `GET` | `/api/v1/folders/all` | 全量文件夹元数据 |
| `GET/POST/DELETE` | `/api/v1/trash` | 回收站列出 / 恢复 / 永久删除 |
| `GET/POST/PATCH/DELETE` | `/api/v1/events` | 日历事件 CRUD |
| `GET/POST/DELETE` | `/api/v1/clients` | 客户 CRUD |
| `GET/PATCH` | `/api/v1/preferences` | 用户偏好（阶段模板等） |
| `GET/POST` | `/api/v1/scheduled-tasks` | 用户自定义定时任务 |
| `GET/POST` | `/api/v1/notifications` | 通知列表 / 气泡 / 标已读 |
| `POST` | `/api/v1/feedback` | 用户反馈提交 |
| `POST` | `/api/v1/agent/chat` | AI Agent 对话（SSE 流式） |

### Admin API（需 Admin Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/admin/auth/login` | 管理员登录 |
| `GET/PATCH` | `/api/v1/admin/config` | 系统配置读写（热更新） |
| `POST` | `/api/v1/admin/config/test-connection` | 测试 DB / OSS 连通性 |
| — | `/api/v1/admin/*` | 用户管理、审计日志、系统日志、运维监控、Agent/感知诊断、通知广播 |

完整 OpenAPI 文档：启动后访问 `http://localhost:8000/docs`。

---

## 🗄️ 文件存储规范

四个独立空间，以 `storage_key`（相对路径）统一标识：

```
{user_id}/
├── {项目名} #{id}/              ← project 空间
│   └── {阶段名}/
├── 思维/{画布名} #{id}/          ← mind 空间
├── 素材板/                       ← asset 空间
└── 个人文件/                     ← personal 空间
```

存储后端（local / oss）可**实时热切换**，`storage_key` 格式两种后端完全一致。

权威规范见 [`docs/backend/storage.md`](docs/backend/storage.md)。

---

## 🧰 常用脚本

### 后端 Makefile 快捷命令

```bash
make help        # 查看所有命令
make start       # 启动后端
make stop        # 停止
make restart     # 重启
make status      # 查看状态
make logs        # 跟踪日志
make fg          # 前台运行
make deploy      # 部署
make install     # 安装依赖到 venv
make migrate     # alembic upgrade head
make backup      # 备份数据库
```

完整能力见 `backend/start.sh --help`。

---

## 🗺️ 路线图

- [x] 项目看板、日历、文件库、总览
- [x] 管理后台（在线配置 + 热更新）
- [x] 本地 / OSS 存储双后端
- [x] 自然语言管理（SSE 流式 AI Agent，支持多 provider）
- [x] 定时任务（一次性 / 周期提醒，通知或 IM 推送）
- [ ] 思维画布（节点图）
- [ ] 团队 / 企业版（ToB）
- [ ] 客户管理前端页面

详细规划见 [`docs/product/wishlist.md`](docs/product/wishlist.md)。

---

## 📖 文档索引

`docs/` 按主题分成 `agent/`（AI Agent 相关，含子目录 `proposals/`/`_archive/`）、`backend/`、`product/`、`ops/`、`security/` 五类，完整导航见 [`docs/README.md`](docs/README.md)。常用入口：

| 文档 | 内容 |
|------|------|
| [docs/product/overview.md](docs/product/overview.md) | 项目总览、技术栈、API、进度 |
| [docs/backend/storage.md](docs/backend/storage.md) | 文件存储结构（权威） |
| [docs/backend/backend.md](docs/backend/backend.md) | 后端开发参考 |
| [docs/product/design.md](docs/product/design.md) | UI/UX 设计规范 |
| [docs/product/wishlist.md](docs/product/wishlist.md) | 功能规划 |
| [docs/devlog.md](docs/devlog.md) | 早期开发记录 |

---

## 🤝 贡献

欢迎 Issue 与 PR！开发流程：

1. Fork → 新建 feature 分支
2. 提交前确保 lint / typecheck 通过
3. PR 描述清楚改动与原因

---

## 📄 License

Apache-2.0

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/coffeiz">coffeiz</a>
</p>
