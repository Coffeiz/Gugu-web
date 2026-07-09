# 咕咕 · 项目文档

> 最后更新：2026-07-02
> 代号：咕咕 · 域名：gugugu.site

---

## 易读概述

**给不熟悉代码、想快速了解"咕咕是什么"的人看。**

咕咕是一个帮个人用户管理项目进度的网页应用，同时内置一个能聊天、能帮你干活的 AI 伙伴。可以把它理解成"看板 + 日历 + 网盘 + AI 助理"合体：

- 你在里面建项目、拖看板卡片、传文件、标日程；
- AI（就是"咕咕"）能通过对话帮你新建项目、查文件、改日程、发文件——不用你自己点来点去；
- 咕咕还接了飞书、QQ、微信，你在这些平台上直接跟它聊天也能操作你的项目和文件，网页端会实时同步；
- 咕咕会记住跟你相处的细节（喜好、习惯、最近状态），越聊越懂你，而不是每次都从零开始。

目标用户是任何"手头有项目要推进"的个人——上班、搞创作、学习、过日子都算，创作者是重点照顾的人群。目前是多用户产品（每个人的数据互相隔离），未来会往团队/企业场景（ToB）扩展。

**当前进展**：核心功能（项目、日历、文件库、AI Agent、IM 接入、记忆系统）都已经上线，处于打磨体验、准备小范围内测的阶段（具体清单见 `mvp.md`）。

---

## 专业细节

### 一、项目简介

**咕咕** 是陪伴**个人成长**的 AI 伙伴 + 项目管理工具，面向任何有目标要推进的个人用户（工作、创作、学习、生活皆可，创作者是重点群体之一），**多用户产品**，所有数据按 `user_id` 隔离。核心功能是统一管理项目进度、文件归档、排期提醒与日常记录，通过自然语言 Agent 完成管理操作，未来扩展至团队/企业（ToB）。

**功能空间：**

| 空间 | 说明 | 状态 |
|------|------|------|
| 项目 | 看板管理、阶段跟踪、截止日期、文件附件 | ✅ 完成 |
| 日历 | 月视图 + 周视图（时间轴）、项目排期可视化、自定义事件、活动提醒、中国节假日标注 | ✅ 完成 |
| 文件库 | 按项目/文件夹归档，本地/OSS 双后端，文件预览 | ✅ 完成 |
| 总览 | 统计卡片、近期节点、最近文件、月历面板 | ✅ 完成 |
| 自然语言管理 | AI Agent 对话完成项目/日历/文件/客户操作（SSE 流式，多工具，删除二次确认） | ✅ 完成 |
| Agent 记忆系统 | 私有 `.agent/` 五层档案（facts.json 结构化 / daily / memory / summary 时间衰减 / lens 解读先验），对话后反思增量提炼（facts 增删 + summary + lens_hint + correction + perception）+ 自动压缩沉淀，persona 纯人格 + 反思驱动 stance 行为模块选相处方式 | ✅ 完成 |
| 感知系统 | 感知遥测 + 误判捕获（分感知误读/数据执行错）+ Admin 诊断面板；行为模块库（baseline/companion/execution/record/query/reflect 等）；per-user 解读先验 lens | ✅ 完成 |
| IM 接入 | 飞书 + QQ + 微信（BYO 扫码自连），文件双向收发、PDF/Office 读取、音视频理解 + 语音条，实时同步到网页 | ✅ 完成 |
| 通知系统 | 通知气泡（打字动画、5s 自动消失）+ 侧边栏通知中心 + 后台广播（Redis pub/sub + SSE） | ✅ 完成 |
| 新手引导 | 独立子系统 `backend/onboarding/`：注册播种教程项目/文件/日历活动 + 欢迎/引导气泡，一账号一次 | ✅ 完成 |
| 定时任务 | 用户自定义一次性/周期任务 + 提醒，推送进 IM 会话历史（接得上上下文） | ✅ 完成 |
| 思维 | 创意画布（节点图） | 🔜 预留 |
| 客户 | 客户信息管理（后端已完成，前端待开发） | 🔜 规划中 |

---

### 二、技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端框架 | Vue 3 + Vite | Composition API，`<script setup>`；正渐进迁移到 TypeScript（详见 `前端-JS转TS迁移指南.md`） |
| 状态管理 | Pinia | 按业务拆分 store |
| UI 组件库 | Arco Design Vue | 飞书出品 |
| 后端框架 | FastAPI (Python) | 异步 |
| 数据库 | PostgreSQL + SQLAlchemy 2.0 | 异步驱动 asyncpg |
| 文件存储 | 本地磁盘 / 阿里云 OSS | Admin 面板可热切换，无需重启 |
| AI | Anthropic / OpenAI / 通义千问 / DeepSeek / MiniMax / MiMo | 共用 OpenAI-compatible 接口，可切换 |
| 认证 | JWT（jose + bcrypt） | User Token + Admin Token 分离 |

> 版本号参考：`frontend/package.json` 当前 `0.15.2`；后端依赖详见 `backend/requirements.txt`。

---

### 三、目录结构

```
Gugu-web/
├── docs/                         ← 项目文档（按主题分类）
│   ├── agent/                    ← Agent/AI 相关：架构、记忆系统、感知系统、IM 接入、提示词
│   ├── backend/                  ← 后端开发文档、存储规范
│   ├── product/                  ← 产品文档：本文件、MVP、Wishlist、设计规范、迁移指南
│   ├── ops/                      ← 部署、性能、并发压测/优化
│   ├── security/                 ← 隐私脱敏、商用就绪评审、安全加固记录
│   └── devlog.md                 ← 早期开发记录 / 排障笔记（根目录，不分类）
├── frontend/
│   └── src/
│       ├── assets/styles/
│       │   ├── variables.css     ← CSS 设计 Token
│       │   └── global.css
│       ├── router/index.ts
│       ├── stores/
│       │   ├── projects.ts
│       │   ├── audio.ts          ← 音频播放器全局状态
│       │   ├── clipboard.ts      ← 文件剪切/复制状态
│       │   ├── filesCache.ts     ← 全量文件元数据缓存 + 乐观更新
│       │   └── preview.ts        ← 文件预览状态
│       ├── services/
│       │   ├── api.ts            ← 所有 API 封装（已泛型化，含 OpenAPI 生成类型）
│       │   └── cache.ts          ← filesCache（sessionStorage 持久化）+ uploadSignal
│       ├── composables/
│       │   └── useThumbCache.ts  ← 模块级 blob Map + thumbLoadedIds + preloadTinyThumbs
│       ├── components/common/
│       │   ├── AppSidebar.vue
│       │   ├── GuguChat.vue      ← AI 悬浮球 + 迷你播放器
│       │   ├── BaseModal.vue     ← 所有弹窗基类
│       │   ├── ContextMenu.vue   ← 右键菜单
│       │   ├── NotificationBubble.vue ← 通知气泡
│       │   ├── FilePreviewModal.vue
│       │   ├── FloatPreviewWindow.vue
│       │   └── viewers/          ← PdfViewer / ImageViewer / VideoViewer / TextViewer
│       └── views/
│           ├── Dashboard/
│           ├── Projects/
│           ├── Calendar/         ← 月视图 + 周视图（时间轴）
│           ├── Files/
│           └── Admin/
└── backend/
    └── app/
        ├── main.py
        ├── core/
        │   ├── config.py         ← StorageSettings / AISettings / DBSettings
        │   ├── security.py       ← JWT + stream token
        │   └── ownership.py      ← 多用户隔离统一收口（get_owned）
        ├── api/v1/
        │   ├── auth.py / admin_auth.py / config.py
        │   ├── projects.py / files.py / folders.py / trash.py
        │   ├── events.py / clients.py / preferences.py
        │   ├── notifications.py / notifications_admin.py
        │   ├── scheduled_tasks.py / feedback.py
        │   ├── feishu_connect.py / qq_connect.py / wechat_connect.py / user_bots.py
        │   ├── admin_analytics.py / users_admin.py / audit_log.py / system_logs.py
        │   ├── agent.py          ← 薄层：构造 AgentRequest → 调 agent 包 → SSE；会话 CRUD 端点
        │   └── agent_admin.py / agent_perception.py / ops_admin.py / services_admin.py / admin_debug.py
        ├── models/__init__.py
        ├── schemas/__init__.py
        ├── services/storage/     ← StorageBackend / LocalStorageBackend / OSSStorageBackend
        └── db/session.py         ← 自动迁移 _MIGRATIONS

backend/agent/                    ← 独立 Agent 包（不依赖 FastAPI）
├── core.py                       ← LLMRunner：统一 Anthropic/OpenAI 工具循环
├── confirm.py                    ← 删除二次确认保底（跨轮强制）
├── models.py                     ← AgentRequest / AgentResponse
├── context/                      ← builder（组装 prompt）/ loaders / tokens（按 token 裁历史）
├── skills/                       ← base + registry；projects/calendar/files/clients/overview 等技能
├── behaviors.py                  ← 反思驱动的 stance 相处方式选择
├── memory/                       ← store / reflection：五层档案 + 增量反思
├── profiles/                     ← DefaultProfile（技能集 + prompt 模板）
└── adapters/web.py               ← SSE 编排（配额→上下文→会话→core→持久化）

backend/onboarding/                ← 独立新手引导子系统（seed/state/routes）
```

> 目录树只列到子目录层级，未逐文件列出；具体文件以代码仓库实时为准。

---

### 四、路由结构

#### 主 App

| 路径 | 页面 | 状态 |
|------|------|------|
| `/dashboard` | 总览 | ✅ |
| `/projects` | 项目看板 | ✅ |
| `/calendar` | 日历（月/周视图） | ✅ |
| `/files` | 文件库 | ✅ |
| `/mind` | 思维画布 | 🔜 即将推出 |

#### 管理后台

| 路径 | 页面 | 状态 |
|------|------|------|
| `/admin/login` | 管理员登录 | ✅ |
| `/admin/config` | 系统配置（DB / Storage / AI） | ✅ |

> 管理后台实际页面已扩展出运维监控、数据分析（总览/使用分析两页）、用户管理、通知管理等多个子页，此处只列核心入口，完整清单以 `frontend/src/router/index.ts` 为准。

---

### 五、后端 API

> 以下按 `backend/app/api/v1/` 实际文件核对，仅列主要端点；每个路由文件内部还有更多细分端点，完整清单以代码为准。

#### 用户 API（需 User Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST/PATCH/DELETE` | `/api/v1/projects` | 项目 CRUD；改名时联动重命名存储目录 |
| `GET` | `/api/v1/files` | 列出文件（支持 project_id/folder_id/ext/q 过滤） |
| `GET` | `/api/v1/files/all` | 当前用户所有文件元数据（全量缓存用） |
| `GET` | `/api/v1/files/version` | 文件表状态摘要（count:max_updated:max_deleted），前端用于感知变更 |
| `GET` | `/api/v1/files/tree` | 文件库导航树 |
| `POST` | `/api/v1/files` | 上传文件（本地代理路径） |
| `POST` | `/api/v1/files/presign` | 签发 OSS presigned PUT URL（OSS 直传准备阶段） |
| `POST` | `/api/v1/files/confirm` | OSS 直传完成后注册 DB 记录 |
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
| `GET/POST` | `/api/v1/notifications`、`/notifications/bubble`、`/notifications/read` | 通知列表 / 待弹气泡 / 标已读 |
| `GET/POST` | `/api/v1/scheduled-tasks` | 用户自定义定时任务 |
| `POST` | `/api/v1/feedback` | 用户反馈提交 |
| — | `/api/v1/user-bots`、`/qq/connect`、`/feishu/connect`、`/wechat/connect` | IM 平台自连（BYO 扫码） |

#### Admin API（需 Admin Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/admin/auth/login` | 管理员登录 |
| `GET/PATCH` | `/api/v1/admin/config` | 读取/更新系统配置（热更新） |
| `POST` | `/api/v1/admin/config/test-connection` | 测试 DB / OSS 连通性 |
| — | `admin_analytics.py` | 数据总览 / 使用分析（日活曲线、留存、会话深度分布等） |
| — | `users_admin.py` | 用户管理（含开发者标记、封禁、删除注销） |
| — | `ops_admin.py` | 运维监控（安全事件计数、失败率/延迟指标） |
| — | `audit_log.py` / `system_logs.py` / `admin_debug.py` | 审计日志 / 系统日志 / Debug 面板 |
| — | `agent_admin.py` / `agent_perception.py` | Agent 用量统计 / 感知系统诊断面板 |
| — | `notifications_admin.py` | 后台广播通知管理 |

---

### 六、数据库模型

| 表 | 说明 | 状态 |
|----|------|------|
| `users` | 用户账号（含 `is_developer` 开发者标记） | ✅ |
| `projects` | 项目（含 stages_json、done_at） | ✅ |
| `files` | 文件（deleted_at 软删除，storage_key 物理路径） | ✅ |
| `folders` | 文件夹（parent_id 自引用，无限嵌套） | ✅ |
| `calendar_events` | 日历事件（含活动提醒关联） | ✅ |
| `clients` | 客户信息 | ✅ |
| `conversation_sessions` | AI 对话会话 | ✅ |
| `conversation_messages` | AI 对话消息 | ✅ |
| `user_preferences` | 用户偏好（阶段模板、last_stages，按 user_id 隔离） | ✅ |
| `mind_maps` | 思维画布（预留） | ✅ 表结构已建 |

文件存储详细规范见 `../backend/storage.md`。

---

### 七、配置系统

优先级：`.env` → `config.override.json`（Admin UI 写入，热更新无需重启）

| 分区 | 关键字段 |
|------|---------|
| `db` | host / port / name / user / password |
| `storage` | backend(`local`\|`oss`) / local_path / oss_* |
| `ai` | provider / api_key / base_url / model |

默认 Admin 账号：`admin / admin123`（**上线前必须修改**）

---

### 八、本地启动

```bash
# 后端（必须在 backend/ 目录）
cd backend && make start

# 前端
cd frontend && npm run dev
```

访问：`http://localhost:5173`（前端）· `http://localhost:8000/docs`（API 文档）

---

### 九、开发进度

> 与 `CHANGELOG.md` 对齐（截至 0.15.2，2026-07-01）。

#### 已完成 ✅

- 全局布局：侧边栏、顶栏玻璃效果（`GlassBg` 活玻璃组件，规避 `backdrop-filter` 白带问题）、路由守卫
- **总览（Dashboard）**：统计卡片、项目列表、日历面板（含节假日）、文件面板
- **项目看板（Projects）**：三列看板、拖拽、DoneColumn、ProjectModal（含文件区）、NewProjectModal
- **日历（Calendar）**：月视图、**周视图（时间轴，含全天/日期多日框选 + 右键新建项目/活动）**、事件/项目 bar、实时拖拽预览、中国节假日标注、活动提醒（绑定 event_id 的一次性任务）
- **文件库（Files）**：7 层导航、框选、批量操作、右键菜单、剪贴板、文件预览（PDF/图/视频/文本/Office）、浮动预览窗、缩略图懒加载、全量元数据缓存
- **音频迷你播放器**：集成在 GuguChat，固定/非固定模式
- **AI Agent**：独立 `backend/agent/` 包（core/context/skills/profiles/adapters/behaviors/memory），SSE 流式，Anthropic/OpenAI 双路由 + MiMo 接入，对话历史持久化，token 用量记录 + 配额（精力系统）；多工具覆盖项目/日历/文件（读写整理 + 生成 Word/PDF/Excel）/客户/聚合；不可逆删除带**二次确认保底**（跨轮强制，AST 静态守卫 + 运行时绊线）；历史窗口按 token 预算裁剪
- **Agent 记忆与感知**：`.agent/` 五层档案、反思增量提炼、persona 纯人格 + stance 行为模块（反思驱动选相处方式）、感知遥测与误判捕获、per-user 解读先验 lens
- **IM 接入**：飞书 + QQ + 微信全部打通（文本/图片/语音/文件双向收发，PDF/Office 读取，音视频理解），实时同步到网页
- **通知系统**：通知气泡（打字动画、5s 自动消失）+ 侧边栏通知中心 + 后台广播（Redis pub/sub + SSE）
- **新手引导**：独立子系统，注册播种教程项目/文件/日历活动 + 欢迎/引导气泡（一账号一次）
- **文件双向同步**：Tab 切回时自动校验 `/files/version`，本地手动删除文件自动清理数据库
- **多用户隔离与安全加固**：查询层统一收口（`get_owned`）、删除确认门框架级强制、全链路 trace_id、注销全量清数据（含存储层）
- **前端 TypeScript 迁移**：工具链就绪，api/stores/composables/utils 及 Calendar 视图已迁移完成，`frontend/src/` 已无 `.js` 文件（详见 `前端-JS转TS迁移指南.md`）
- Admin 后台：登录、系统配置热更新、邀请码、审计/系统日志、Agent 用量统计、数据分析（总览+使用分析双页）、运维监控页、用户管理（含开发者标记）

#### 待开发 🚧

| 优先级 | 功能 |
|--------|------|
| 中 | 客户管理页面（后端 API + Agent 工具已就绪，缺前端页） |
| 中 | 前端 TS 迁移阶段 3：5 个巨型视图组件（ProjectModal / Files/index / Admin/Agent/index / GuguChat） |
| 低 | 思维画布页面 |
| 低 | 小修：`_fmt_size` 小文件显示 0 KB；过滤 MiniMax 漏出的 tool-call 标记（待核实是否仍存在） |

> 更细的待办与内测前检查清单见 `mvp.md`；功能规划候选见 `wishlist.md`。
