# 咕咕 · Gugu

> 代号：**咕咕**　|　域名：[gugugu.site](https://gugugu.site)

一个面向**自由职业创作者**（插画、动画、设计等）的项目管理工具。统一管理项目进度、文件归档与排期提醒，未来可通过自然语言完成项目管理操作，并扩展至团队 / 企业协作（ToB）。

![status](https://img.shields.io/badge/status-active-success)
![frontend](https://img.shields.io/badge/frontend-Vue%203-42b883)
![backend](https://img.shields.io/badge/backend-FastAPI-009688)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## ✨ 核心特性

| 功能 | 状态 | 说明 |
|------|:---:|------|
| 📋 项目看板 | ✅ | 阶段跟踪、截止日期、改名联动存储目录 |
| 📅 日历排期 | ✅ | 项目节点可视化 + 自定义事件 |
| 🗂️ 文件库 | ✅ | 四空间（项目/思维/素材/个人），支持本地 / OSS 双后端 |
| 🏠 总览 | ✅ | 统计卡片 + 近期节点 + 最近文件 |
| 🧠 思维画布 | 🔜 | 节点图创意空间，可挂文件 |
| 🎨 素材板 | 🔜 | 素材管理 + 自动打 tag |
| 👤 客户管理 | 🔜 | 客户信息归档 |
| 💬 自然语言管理 | 🔜 | 对话即可管理项目、归档文件、设置提醒 |
| ⚙️ 管理后台 | ✅ | DB / Redis / Storage 在线配置 + 热更新 |

---

## 🛠️ 技术栈

### 前端
- **框架**：Vue 3（Composition API + `<script setup>`）
- **构建**：Vite 5
- **状态**：Pinia
- **UI 库**：Arco Design Vue
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
- **进程管理**：systemd unit（`gugu-backend.service`）

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
├── docs/                       # 项目文档
│   ├── overview.md             # 总览 / 技术栈 / 进度
│   ├── backend.md              # 后端开发参考
│   ├── design.md               # UI/UX 设计规范
│   ├── storage.md              # 文件存储规范（权威）
│   ├── wishlist.md             # 功能 Wishlist
│   └── dev-log.md              # 早期开发日志
├── design/
│   └── prototype.html          # 可交互原型稿
├── frontend/                   # Vue 3 前端
│   └── src/
│       ├── views/              # Dashboard / Projects / Calendar / Files / Admin
│       ├── components/         # 通用 + 业务组件
│       ├── stores/             # Pinia stores
│       ├── services/           # API + 缓存信号
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
│           ├── storage/        # LocalStorage / OSSStorage
│           └── agent/          # 智能助手（规划中）
├── docker-compose.yml
├── .env.example
└── PROJECT.md
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
| `GET` | `/api/v1/files/tree` | 文件库导航树 |
| `POST` | `/api/v1/files` | 上传文件（四空间） |
| `PATCH / DELETE` | `/api/v1/files/{id}` | 重命名 / 删除（同步磁盘） |
| `GET/POST/PATCH/DELETE` | `/api/v1/events` | 日历事件 CRUD |
| `GET/POST/DELETE` | `/api/v1/clients` | 客户 CRUD |

### Admin API（需 Admin Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/admin/auth/login` | 管理员登录 |
| `GET/PATCH` | `/api/v1/admin/config` | 系统配置读写（热更新） |
| `POST` | `/api/v1/admin/config/test-connection` | 测试 DB / Redis / OSS |

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

权威规范见 [`docs/storage.md`](docs/storage.md)。

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
- [ ] 自然语言管理（对话完成项目 / 文件 / 提醒操作）
- [ ] 思维画布（节点图）
- [ ] 团队 / 企业版（ToB）
- [ ] 客户管理

详细规划见 [`docs/wishlist.md`](docs/wishlist.md)。

---

## 📖 文档索引

| 文档 | 内容 |
|------|------|
| [docs/overview.md](docs/overview.md) | 项目总览、技术栈、API、进度 |
| [docs/storage.md](docs/storage.md) | 文件存储结构（权威） |
| [docs/backend.md](docs/backend.md) | 后端开发参考 |
| [docs/design.md](docs/design.md) | UI/UX 设计规范 |
| [docs/wishlist.md](docs/wishlist.md) | 功能规划 |
| [docs/dev-log.md](docs/dev-log.md) | 早期开发记录 |

---

## 🤝 贡献

欢迎 Issue 与 PR！开发流程：

1. Fork → 新建 feature 分支
2. 提交前确保 lint / typecheck 通过
3. PR 描述清楚改动与原因

---

## 📄 License

[MIT](./LICENSE)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/coffeiz">coffeiz</a>
</p>