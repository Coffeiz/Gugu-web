<div align="center">

# 咕咕

### 事情，应该有自己的节奏。

<!-- 演示 GIF（基本操作 + IM 对话）弄好后取消下面这行注释，图片放 docs/assets/banner.gif -->
<!-- <img src="docs/assets/banner.gif" alt="咕咕演示" width="720"> -->

[![project](https://img.shields.io/badge/个人项目管理-596780?style=flat)](docs/product/overview.md)
[![mind](https://img.shields.io/badge/思维画布-7B78A8?style=flat)](docs/product/思维面板/设计草案.md)
[![assistant](https://img.shields.io/badge/咕咕协作-5B8E7D?style=flat)](docs/agent/00-总览.md)
<br>
[![status](https://img.shields.io/badge/status-active-success?style=flat)](https://gugugu.site)
[![beta](https://img.shields.io/badge/阶段-私人%20Beta-8A7A63?style=flat)](#贡献)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](LICENSE)

</div>

这是一个连接项目、文件和想法的个人工作空间。

咕咕重新思考了个人项目的管理方式。

项目不只是一个任务列表，而是一段持续发展的过程。文件、记录和想法，会随着时间自然聚集在一起，留下属于项目自己的轨迹。

每一个细节都经过认真打磨，让工具退后一步，让你专注于真正重要的事情。

需要的时候，你也可以和咕咕对话，搜索和整理项目中的信息，让事情继续向前。

> 这是一个持续迭代中的私人 Beta。欢迎朋友 Fork、试用，并通过 Issue 或 PR 一起把它打磨得更好。

---

## 🌱 可以怎么用

**从一个项目开始。** 新建项目、拆成几个阶段，补上截止日期；相关文件会跟着项目沉淀下来，日历也会显示接下来的节点。

**把零碎想法先记下来。** 在思维记录里用 Markdown 随手写，按日期回看；它不要求你一开始就把想法整理成一个完整项目。

**需要时再铺到画布上。** 新建画布，把便签、项目、文件和日历活动贴进去，拖出连线，慢慢看清一件事之间的关系。

**把重复操作交给咕咕。** 直接说“帮我找上周的方案”“把这个活动改到周五”或“记录一下这个想法”；网页、飞书、QQ 和微信里的内容会回到同一套项目数据里。

---

## ✨ 核心特性

| 功能 | 状态 | 说明 |
|------|:---:|------|
| 📋 项目看板 | ✅ | 阶段跟踪、截止日期、改名联动存储目录 |
| 🗂️ 文件库 | ✅ | 四空间（项目/思维/素材/个人），支持本地 / OSS 双后端和文件预览 |
| 🧠 思维画布 | ✅ | 无限画布记想法：富文本便签 + 项目/文件/活动引用卡 + 拖拽建立关联连线，时间流视图按天回顾 |
| 📅 日历排期 | ✅ | 月/周视图、项目节点、自定义事件、活动提醒 |
| 🏠 总览 | ✅ | 统计卡片 + 近期节点 + 最近文件 |
| 💬 自然语言管理 | ✅ | SSE 流式对话，支持 Anthropic / OpenAI / 通义 / DeepSeek / MiniMax / MiMo |
| 🤖 IM / 机器人接入 | ✅ | 飞书 / QQ / 微信机器人常驻网关，群聊私聊直接跟咕咕对话，操作项目/文件/日程 |
| ⏰ 定时任务 | ✅ | 一次性/周期提醒，失败自动延迟重试，支持通知与 IM 推送 |
| ⚙️ 管理后台 | ✅ | 配置热更新、用户管理、审计日志、运维监控、数据分析 |
| 🎨 素材板 | 🔜 | 素材管理 + 自动打 tag |
| 👤 客户管理 | 🔜 | 后端已就绪，前端页面待开发 |

---

## 🛠️ 技术栈

**前端** · Vue 3 · Vite 5 · Pinia · Arco Design Vue · TipTap · Vue Router 4

**后端** · FastAPI · SQLAlchemy 2.0 + PostgreSQL 16 · Redis · Alembic · APScheduler · JWT

**IM 接入** · 飞书（WebSocket 长连）· QQ 官方机器人 · 微信

**部署** · 生产用裸机 + systemd（[`backend/start.sh`](backend/start.sh)）· 本地开发用 Docker Compose，见下方「快速开始」

---

## 🚀 快速开始

### 前置环境

- Docker 20+ & Docker Compose v2（本地开发，见方式一）
- 或本地：Node.js 20+ / Python 3.12+（方式二）

### 方式一：Docker Compose（本地开发，推荐新人上手）

只覆盖 web（uvicorn）+ worker（IM 消息处理）+ Postgres + Redis，跑 vite dev server 带热更新；
不是生产部署方式（生产用裸机 systemd，见上方「部署」）。

```bash
# 1. 克隆
git clone https://github.com/coffeiz/gugu-web.git
cd gugu-web

# 2. 准备环境变量（注意路径在 backend/ 下，不是仓库根目录）
cp .env.example backend/.env
# 编辑 backend/.env，填入 SECRET_KEY / AI__API_KEY 等；DB__*/REDIS__* 已由
# docker-compose.yml 覆盖成容器网络地址，不用改

# 3. 一键启动（首次启动会自动跑 alembic 迁移）
docker compose up -d

# 4. 浏览器访问
# 前端  → http://localhost:9595
# 后端  → http://localhost:8000/docs

# 常用：docker compose logs -f backend worker   查日志
#      docker compose down                      停止（加 -v 连数据卷一起删）
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

## 📚 开发参考

| 想了解 | 从这里开始 |
|--------|------------|
| 产品与代码 | [项目总览](docs/product/overview.md) · [完整文档导航](docs/README.md) |
| 咕咕协作 | [对话引擎架构](docs/agent/00-总览.md) |
| 后端与文件 | [后端与 API](docs/backend/backend.md) · [存储规范](docs/backend/storage.md) |
| 本地与生产 | [部署文档](docs/ops/deploy.md) |

接口以运行中的 [OpenAPI 文档](http://localhost:8000/docs) 为准；后端常用运维命令可通过 `backend/start.sh --help` 查看。

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

## 🗺️ 路线图

- [x] 项目看板、日历、文件库、总览
- [x] 管理后台（在线配置 + 热更新）
- [x] 本地 / OSS 存储双后端
- [x] 自然语言管理（SSE 流式对话，支持多个模型服务商）
- [x] 定时任务（一次性 / 周期提醒，通知或 IM 推送）
- [x] 思维画布（无限画布、引用卡、关联连线）
- [x] IM / 机器人接入（飞书 / QQ / 微信）
- [ ] 素材板（素材管理 + 自动打 tag）
- [ ] 客户管理前端页面
- [ ] 团队 / 企业版（ToB）

详细规划见 [`docs/product/wishlist.md`](docs/product/wishlist.md)。

---

## ⚠️ 当前限制 / 已知问题

- 微信（iLink）引用消息暂不支持识别原文——平台协议限制，非代码 bug。
- QQ 引用较早消息时，可能因平台时效窗口拿不到引用上下文。

完整记录（现象/影响/结论/规避）见 [`docs/ops/known-issues.md`](docs/ops/known-issues.md)。

---

## 📖 文档索引

`docs/` 按主题分成 `agent/`（对话引擎相关，含子目录 `proposals/`/`_archive/`）、`backend/`、`product/`、`ops/`、`security/` 五类，完整导航见 [`docs/README.md`](docs/README.md)。常用入口：

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
