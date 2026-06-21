# 咕咕 · 项目文档

> 最后更新：2026-06-21
> 代号：咕咕 · 域名：gugugu.site

---

## 一、项目简介

**咕咕** 是面向创作者（插画、动画等）的 AI 驱动项目管理工具，**多用户产品**，所有数据按 `user_id` 隔离。核心功能是统一管理项目进度、文件归档和排期提醒，通过自然语言 Agent 完成管理操作，未来扩展至团队/企业（ToB）。

**功能空间：**

| 空间 | 说明 | 状态 |
|------|------|------|
| 项目 | 看板管理、阶段跟踪、截止日期、文件附件 | ✅ 完成 |
| 日历 | 项目排期可视化、自定义事件、中国节假日标注 | ✅ 完成 |
| 文件库 | 按项目/文件夹归档，本地/OSS 双后端，文件预览 | ✅ 完成 |
| 总览 | 统计卡片、近期节点、最近文件、月历面板 | ✅ 完成 |
| 自然语言管理 | AI Agent 对话完成项目/日历操作（SSE 流式） | 🚧 开发中 |
| 思维 | 创意画布（节点图） | 🔜 预留 |
| 客户 | 客户信息管理（后端已完成，前端待开发） | 🔜 规划中 |

---

## 二、技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端框架 | Vue 3 + Vite | Composition API，`<script setup>` |
| 状态管理 | Pinia | 按业务拆分 store |
| UI 组件库 | Arco Design Vue | 飞书出品 |
| 后端框架 | FastAPI (Python) | 异步 |
| 数据库 | PostgreSQL + SQLAlchemy 2.0 | 异步驱动 asyncpg |
| 文件存储 | 本地磁盘 / 阿里云 OSS | Admin 面板可热切换，无需重启 |
| AI | Anthropic / OpenAI / 通义千问 / DeepSeek / MiniMax | 共用 OpenAI-compatible 接口，可切换 |
| 认证 | JWT（jose + bcrypt） | User Token + Admin Token 分离 |

---

## 三、目录结构

```
Gugu-web/
├── docs/                         ← 项目文档
├── frontend/
│   └── src/
│       ├── assets/styles/
│       │   ├── variables.css     ← CSS 设计 Token
│       │   └── global.css
│       ├── router/index.js
│       ├── stores/
│       │   ├── projects.js
│       │   ├── audio.js          ← 音频播放器全局状态
│       │   ├── clipboard.js      ← 文件剪切/复制状态
│       │   ├── filesCache.js     ← 全量文件元数据缓存 + 乐观更新
│       │   └── preview.js        ← 文件预览状态
│       ├── services/
│       │   ├── api.js            ← 所有 API 封装
│       │   └── cache.js          ← filesCache（sessionStorage 持久化）+ uploadSignal
│       ├── composables/
│       │   └── useThumbCache.js  ← 模块级 blob Map + thumbLoadedIds + preloadTinyThumbs
│       ├── components/common/
│       │   ├── AppSidebar.vue
│       │   ├── AiFloatBall.vue   ← AI 悬浮球 + 迷你播放器
│       │   ├── BaseModal.vue     ← 所有弹窗基类
│       │   ├── ContextMenu.vue   ← 右键菜单
│       │   ├── FilePreviewModal.vue
│       │   ├── FloatPreviewWindow.vue
│       │   └── viewers/          ← PdfViewer / ImageViewer / VideoViewer / TextViewer
│       └── views/
│           ├── Dashboard/
│           ├── Projects/
│           ├── Calendar/
│           ├── Files/
│           └── Admin/
└── backend/
    └── app/
        ├── main.py
        ├── core/
        │   ├── config.py         ← StorageSettings / AISettings / DBSettings
        │   └── security.py       ← JWT + stream token
        ├── api/v1/
        │   ├── auth.py
        │   ├── admin_auth.py / config.py
        │   ├── projects.py
        │   ├── files.py          ← 含 /all /version /copy /download /stream /thumb
        │   ├── folders.py        ← 含 /all；支持 parent_id 无限嵌套
        │   ├── trash.py          ← list/restore/hard-delete/empty；定时清理
        │   ├── events.py
        │   ├── clients.py
        │   └── agent.py          ← SSE 流式，Anthropic/OpenAI 双路由，工具调用
        ├── models/__init__.py
        ├── schemas/__init__.py
        ├── services/storage/     ← StorageBackend / LocalStorageBackend / OSSStorageBackend
        └── db/session.py         ← 自动迁移 _MIGRATIONS
```

---

## 四、路由结构

### 主 App

| 路径 | 页面 | 状态 |
|------|------|------|
| `/dashboard` | 总览 | ✅ |
| `/projects` | 项目看板 | ✅ |
| `/calendar` | 日历 | ✅ |
| `/files` | 文件库 | ✅ |
| `/mind` | 思维画布 | 🔜 即将推出 |

### 管理后台

| 路径 | 页面 | 状态 |
|------|------|------|
| `/admin/login` | 管理员登录 | ✅ |
| `/admin/config` | 系统配置（DB / Storage / AI） | ✅ |

---

## 五、后端 API

### 用户 API（需 User Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST/PATCH/DELETE` | `/api/v1/projects` | 项目 CRUD；改名时联动重命名存储目录 |
| `GET` | `/api/v1/files` | 列出文件（支持 project_id/folder_id/ext/q 过滤） |
| `GET` | `/api/v1/files/all` | 当前用户所有文件元数据（全量缓存用） |
| `GET` | `/api/v1/files/version` | 文件表状态摘要（count:max_updated:max_deleted），前端用于感知变更 |
| `GET` | `/api/v1/files/tree` | 文件库导航树 |
| `POST` | `/api/v1/files` | 上传文件 |
| `PATCH` | `/api/v1/files/{id}` | 重命名 / 移动文件 |
| `DELETE` | `/api/v1/files/{id}` | 软删除（移入回收站） |
| `POST` | `/api/v1/files/batch-delete` | 批量软删除 |
| `POST` | `/api/v1/files/{id}/copy` | 复制文件 |
| `GET` | `/api/v1/files/{id}/download` | 下载（Bearer token 鉴权） |
| `GET` | `/api/v1/files/{id}/stream` | 视频流播放 |
| `GET` | `/api/v1/files/{id}/thumb` | 图片缩略图（tiny/card/full），Authorization Bearer 鉴权 |
| `GET` | `/api/v1/files/{id}/preview-pdf` | Office → PDF 转换预览 |
| `GET` | `/api/v1/folders` | 列出文件夹 |
| `GET` | `/api/v1/folders/all` | 当前用户所有文件夹（全量缓存用） |
| `POST/PATCH/DELETE` | `/api/v1/folders` | 文件夹 CRUD |
| `GET` | `/api/v1/folders/{id}/download-zip` | 打包下载文件夹 |
| `GET/POST/PATCH/DELETE` | `/api/v1/events` | 日历事件 CRUD |
| `GET/POST/DELETE` | `/api/v1/clients` | 客户 CRUD |
| `GET/DELETE` | `/api/v1/trash` | 回收站列出 / 清空 |
| `POST` | `/api/v1/trash/{id}/restore` | 恢复单个文件 |
| `DELETE` | `/api/v1/trash/{id}` | 永久删除 |
| `GET/PATCH` | `/api/v1/preferences` | 用户偏好（阶段模板、上次使用阶段） |
| `POST` | `/api/v1/agent/chat` | AI Agent 对话（SSE 流式） |

### Admin API（需 Admin Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/admin/auth/login` | 管理员登录 |
| `GET/PATCH` | `/api/v1/admin/config` | 读取/更新系统配置（热更新） |
| `POST` | `/api/v1/admin/config/test-connection` | 测试 DB / OSS 连通性 |

---

## 六、数据库模型

| 表 | 说明 | 状态 |
|----|------|------|
| `users` | 用户账号 | ✅ |
| `projects` | 项目（含 stages_json、done_at） | ✅ |
| `files` | 文件（deleted_at 软删除，storage_key 物理路径） | ✅ |
| `folders` | 文件夹（parent_id 自引用，无限嵌套） | ✅ |
| `calendar_events` | 日历事件 | ✅ |
| `clients` | 客户信息 | ✅ |
| `conversation_sessions` | AI 对话会话 | ✅ 表结构已建 |
| `conversation_messages` | AI 对话消息 | ✅ 表结构已建 |
| `user_preferences` | 用户偏好（阶段模板、last_stages，按 user_id 隔离） | ✅ |
| `mind_maps` | 思维画布（预留） | ✅ 表结构已建 |

文件存储详细规范见 `docs/storage.md`。

---

## 七、配置系统

优先级：`.env` → `config.override.json`（Admin UI 写入，热更新无需重启）

| 分区 | 关键字段 |
|------|---------|
| `db` | host / port / name / user / password |
| `storage` | backend(`local`\|`oss`) / local_path / oss_* |
| `ai` | provider / api_key / base_url / model |

默认 Admin 账号：`admin / admin123`（**上线前必须修改**）

---

## 八、本地启动

```bash
# 后端（必须在 backend/ 目录）
cd backend && make start

# 前端
cd frontend && npm run dev
```

访问：`http://localhost:5173`（前端）· `http://localhost:8000/docs`（API 文档）

---

## 九、开发进度

### 已完成 ✅

- 全局布局：侧边栏、顶栏玻璃效果、路由守卫
- **总览（Dashboard）**：统计卡片、项目列表、日历面板（含节假日）、文件面板
- **项目看板（Projects）**：三列看板、拖拽、DoneColumn、ProjectModal（含文件区）、NewProjectModal
- **日历（Calendar）**：月视图、事件/项目 bar、实时拖拽预览、中国节假日标注
- **文件库（Files）**：7 层导航、框选、批量操作、右键菜单、剪贴板、文件预览（PDF/图/视频/文本/Office）、浮动预览窗、缩略图懒加载、全量元数据缓存
- **音频迷你播放器**：集成在 AiFloatBall，固定/非固定模式
- **AI Agent**：SSE 流式，Anthropic/OpenAI 双路由，最多 5 轮工具调用（查询/创建/更新项目，创建日历事件）
- **文件双向同步**：Tab 切回时自动校验 `/files/version`，本地手动删除文件自动清理数据库
- Admin 后台：登录、系统配置热更新

### 待开发 🚧

| 优先级 | 功能 |
|--------|------|
| 高 | Agent 对话历史持久化，前端 UI 优化 |
| 高 | Agent 工具扩展（修改阶段/配色，查询文件） |
| 中 | 客户管理页面（后端 API 已完成） |
| 中 | 通知系统 |
| 低 | 思维画布页面 |
