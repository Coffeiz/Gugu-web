# 更新日志 · Changelog

本项目所有显著的更新都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased] · 文件库回收站多选

### 新增 · QQ 机器人接入（单聊 C2C，每用户自带 BYO）

- **QQ 官方机器人**（botpy WebSocket 长连接，C2C 单聊）：用户私聊自己的 QQ 机器人，带完整人格/记忆/工具回复。和飞书长连接同模式——**不需要公网、备案前可用**
  - `agent/adapters/qq.py`：收 C2C 消息入队（payload 与飞书同构，带 `message_id` 供被动回复 + `owner_user_id`）；**收**凭据从 env 注入、**发**消息按 bot id 现查 DB（`send_c2c` token 失效自动重建重试）
  - `requirements.txt` 加 `qq-botpy>=1.2.0`
- **BYO 模型（每用户自带 bot）**：每个用户在「个人设置 → 接入咕咕 → QQ」填自己在 q.qq.com 建的 bot 凭据，咕咕为其起独立网关；bot 收到的消息天然归属 owner，**无需再做用户绑定**
  - 新增 `user_bots` 表 + `app/api/v1/user_bots.py`（`/me/bots` 用户级 CRUD，secret 打码，仅能管自己的）
  - `supervisor.py`：飞书走 override 文件 + argv、QQ 走 `user_bots` 表 + 环境变量注入凭据（避免 ps 泄漏）；常驻 loop 复用 engine，DB 抖动保活不误杀
  - `worker.py`：QQ 用 payload 的 `owner_user_id` 直接认人
  - 前端「QQ（自带机器人）」：**扫码自动连接**为主、手动填 AppID/Secret 兜底 + 我的 bot 列表（启停/删除）
- **QQ 扫码自动连接**（复刻 QwenPaw/OpenClaw 的 q.qq.com bind_task 流程，实测无需合作方资质）：
  - `app/api/v1/qq_connect.py`：`POST /me/qq/connect` 调 `q.qq.com/lite/create_bind_task` 建任务 → 前端二维码 → 手机 QQ 扫码选 bot 授权 → `GET /me/qq/connect/{task_id}` 轮询 `poll_bind_result`，完成则 **AES-256-GCM 解出 AppSecret 自动写入 UserBot**（无需手动复制）
  - 安全：aes_key 仅存服务端（Redis，按 task_id），secret 加密回传只有本端能解；端点本身无鉴权但不暴露明文

### 变更 · 飞书统一到 BYO 扫码自动连接（重构 + 清理旧共享 bot）

- **飞书也改为 BYO + 扫码自动创建**（与 QQ 统一），复刻 QwenPaw 的 **OAuth 2.0 设备授权流（RFC 8628）**，实测无需合作方资质：
  - `app/api/v1/feishu_connect.py`：`POST /me/feishu/connect` 调 `accounts.feishu.cn/oauth/v1/app/registration`（init→begin 拿 device_code + 扫码 URL）→ 手机飞书扫码授权创建 PersonalAgent 应用 → `GET /me/feishu/connect/{poll_id}` 轮询（device flow 等待时返回 400+`authorization_pending`，已兼容）→ 成功拿 `client_id`/`client_secret` 自动写入 `user_bots`
  - `agent/adapters/feishu.py` 重写为 BYO：收凭据从 env 注入、发凭据按 bot id 查 `user_bots`、payload 带 `owner_user_id`
  - `supervisor.py` 统一：飞书 + QQ **都从 `user_bots` 表读 + 环境变量注入凭据**（不再读 override 文件）
  - `worker.py`：飞书也用 `owner_user_id` 直接认人
  - 前端「接入咕咕」统一：飞书 / QQ 都是「扫码连接」+ 按平台分列 bot 列表
- **清理旧的共享 bot + OAuth 绑定那套**：
  - 删 `feishu_bind.py`（OAuth 扫码绑定）、`feishu_event.py`（事件订阅 Webhook 模式）
  - 删 `PlatformBinding` 模型（两平台均 BYO，bot 即归属，不再需要平台用户↔咕咕用户绑定）
  - 删 Admin「频道」面板（tab + bots CRUD + 飞书回调地址）——IM 接入全部改为用户自助
  - 删 `FeishuSettings` / `active_im_bots`（config）、前端 `feishuApi` / config.js 的 feishu 段
  - ⚠️ 旧的共享飞书 bot（config.override.json 的 `bots`）不再自动连接，需重新扫码连一个

### 修复

- **IM 对话没有上下文（"聊着聊着变新会话"）**：`run_collect`（飞书/QQ 的非流式大脑入口）一直**没读会话历史**，每条消息都孤立处理 → 无连续对话。现与网页版同口径：`agent/runner.py` 找/建会话 → 读历史窗口（按 token 预算裁剪）→ 存用户+回复消息+用量 → 对话后反思（报错不入历史/不反思）；`worker.py` 按 `(平台, 平台用户)` 在 Redis 存稳定 `session_id`（滑动 TTL 12h，空闲超时才起新会话）。飞书、QQ 一并修复

### 新增 · 404 页 + 部署/运维

- **404 页**：咕咕风格的 NotFound 页（路由 catch-all 改为渲染，不再 redirect 到登录）
- **systemd 单元按安装目录自动生成**：`start.sh install` 用 `__APP_DIR__`/`__RUN_USER__` 占位符按当前 backend 目录填路径 + 建可写目录(uploads/logs/override)并授权——换部署目录不再手改、不再撞 `226/NAMESPACE`；运行用户可 `RUN_USER=xxx make install` 覆盖
- **deploy.md nginx**：补 admin 子站 `location /admin` SPA 回退 + 带 hash 资源强缓存/HTML no-cache + gzip 建议
- **vite**：`server.allowedHosts` 加 `myhome.coffeiz.space`（自定义域名/内网穿透访问 dev）

### 新增

- **回收站多选 / 框选**：文件库回收站支持选择模式
  - 工具栏新增「选择」按钮（原仅在普通视图显示，回收站亦可用）
  - 直接点击文件行即可选中 / 取消（无需先开启选择模式，因回收站文件不可打开）
  - 支持从列标题区向下框选批量圈定文件
  - 选中后浮动操作栏显示**恢复选中**和**永久删除**两个批量操作
  - 取消选中、关闭选择模式与普通文件视图行为一致

### 修复

- **点击回收站文件行选中后立即被清除**：最外层 `files-page` 的 `@click` 会调 `clearSelection()`，文件行缺少 `.stop` 导致冒泡消掉选中状态；现为行点击加 `@click.stop`，并调整 `onPageClick` 在已有选中时跳过清除
- **框选无法命中文件行**：误将 `.list-head` 加入 `onMainMouseDown` 排除列表，导致列标题区下方的整个拖拽起点都失效；恢复为仅排除 `button` 元素，列标题背景区可作为框选起点

### 新增 · 飞书 Webhook 接入

- **飞书事件订阅「请求地址」(Webhook) 模式**：作为长连接的替代，已有公网 HTTPS 时可少跑一个 supervisor 进程
  - 新端点 `POST /api/v1/feishu/event/{channel_id}`：复用 lark `EventDispatcherHandler.do()` 解密 + 校验 Token + 验签 + 自动回 `challenge`，再派发到与长连接**同一个** `_make_on_message` 回调入队（payload 完全一致，worker/绑定/人格记忆链路零改动）
  - Admin 频道弹窗（飞书）新增「事件订阅 Webhook」区：显示该频道**专属回调地址**（带 `channel_id`，可一键复制）+ Encrypt Key（打码）/ Verification Token 字段；env 兜底 `FEISHU__ENCRYPT_KEY` / `FEISHU__VERIFICATION_TOKEN`
  - 修正 Starlette 头大小写问题：补齐 lark 验签所需的精确大小写 `X-Lark-*` 头

### 变更

- **精力恢复改为固定 6h 重置**：原 6h 配额是**滑动窗口**（按"过去 6 小时"累计），现改为按 UTC 整点 `00/06/12/18` 切固定桶、**到点整段清零**（与每周配额同口径）。`/quota` 返回 `reset_6h_at`（下次重置时刻，取代 `oldest_6h_at`）；拦截（`web.py`）、Admin 用户列表用量同步对齐；前端文案改「X 小时后重置精力」

---

## [0.11.0] - 2026-06-23 · 记忆系统、联网搜索、IM 接入（飞书）

### 新增

- **Skill 一等公民**：Profile 改为组合 skill 名，`tool_names` 由 registry 从 skill 派生，消除"加工具改两处"的双重维护
- **记忆系统（Phase 2a · 伙伴化）**：咕咕能记住用户。三层 markdown 记忆存用户私有 `.agent/`（经 `StorageBackend`，本地/OSS 通吃，单库无同步问题）：
  - `facts.md` 稳定档案 —— 反思每轮**调和重写**（修正矛盾 / 合并 / 去重 / 防误删）
  - `daily.md` 近期记忆 —— 滚动保留 30 条，累积 40 触发压缩
  - `memory.md` 长期沉淀 —— daily 老条目 LLM 摘要而来，越压越精
  - 对话后**反思** fire-and-forget 提炼写盘；琐碎应答（嗯/好的/谢谢…）跳过反思省调用；`remember` 工具主动记
  - 反思 / 压缩提示词文件化（`prompts/reflection.md`、`compress.md`，热读 + Admin「系统提示词」可在线编辑）
- **联网搜索**：`web_search`（Tavily）—— 第 41 工具；Admin 配 key（打码）；**每日次数配额**（`search_usage` 表 + 配额管理页设上限）
- **IM 平台接入（飞书）**：用户私聊咕咕机器人，带完整人格 / 记忆 / 41 工具回复。
  - 平台无关骨架：Redis Streams 队列 + 非流式 runner（`run_collect`）+ 独立 worker 进程
  - 飞书网关：`lark-oapi` WebSocket 长连收发，**不用公网 URL、不用 OpenClaw**
  - **频道管理面板**（Admin → Agent 配置 → 频道）：增删启停各平台 bot、填密钥；卡片网格 + 中间弹窗
  - **多频道动态网关**（`supervisor` 进程级管理）：每频道一个子进程，面板增删约 5s 内连接起停（lark 无 stop，故 kill 子进程断开）
- **prompt 缓存**：`core.py` Anthropic/MiniMax 路 system 打 `cache_control`，多轮工具循环命中缓存省 ~90%（实测 MiniMax M3）

### 调整

- **记忆模型简化**：砍掉 weekly 中间层，压缩定为 `daily → memory` 两段
- **成本结论**（1M 上下文 + 缓存背景下）：记忆/工具/人格注入近乎免费，无需 trim；`context_tokens` 维持；写侧（反思）靠琐碎门槛省

### 修复

- **系统日志**：traceback 区框选文字、松开鼠标不再误关展开（`@click.stop`）；新增「复制日志」按钮
- **worker Redis 阻塞读超时**：`get_redis` 设 `socket_timeout=None`，治 `XREADGROUP block` 反复 `TimeoutError`

### 文档 / 运维

- **`deploy.md` 完全重写**：开发 + 生产完整教程（venv / 依赖 / 配置 / 数据库 / nginx / systemd 含 worker+supervisor / 排错 / 备份）
- 新增 **`feishu接入指南.md`**（从零到跑通 + 频道面板原理 + 排错表）；`agent.md` Phase 4 补频道架构
- **`.env.example`** 更新为当前嵌套格式（`DB__/AI__/REDIS__/FEISHU__`）；`requirements.txt` 补 `lark-oapi`
- **`.gitignore`** 补 root `uploads/`（含咕咕 `.agent/` 记忆）+ `*.pid`，防误提交用户数据

---

## [0.10.1] - 2026-06-23 · 咕咕聊天体验修复

### 修复

- **AI 创建项目缺少默认阶段**：`_create_project` 技能之前创建空 `stages_json = "[]"`，AI 建出的项目没有任何阶段。现在自动注入三个默认阶段（计划 / 执行 / 交付），与前端手动新建保持一致
- **工具调用后出现空窗期**：`tool_done` 事件后 `activeTool` 和 `thinking` 同时清零，导致工具完成到 AI 开始回复之间无任何气泡。改为 `tool_done` 时切换到思考气泡（`thinking = true`），直到首个 `token` 到来才熄灭
- **小窗切换大窗再返回后不再向上扩展**：`exitExpanded()` 未重置小窗高度基准，返回后 `_baseScrollH` 过期、新消息触发的 MutationObserver 无法正确计算增量。现在返回小窗时同步更新基准 (`_baseScrollH = el.scrollHeight`, `msgsGrowth = 0`)，后续新消息可正常延伸

### 调整

- **工具/思考气泡视觉统一**：去掉工具气泡的 `opacity: 0.85`（与思考气泡的全不透明保持一致），统一水平内边距为 `13px`（与普通气泡对齐）
- **三类气泡高度统一**：按单行文字气泡高度（约 38px）反推：思考气泡 `padding` 调整为 `16px 13px`（圆点 6px + 上下各 16px ≈ 38px），工具气泡调整为 `10px 13px` + 标签字号改为 `12px`（行高 18px + 上下各 10px ≈ 38px）

---

## [0.10.0] - 2026-06-22 · Agent 工具系统与伙伴人格

### 新增

- **Agent 包化重构**：业务逻辑从单文件 `app/api/v1/agent.py`（637 行）迁出为独立 `backend/agent/` 包（`core` LLM 循环 / `context` 上下文组装 / `skills` 工具 / `profiles` / `adapters/web` 编排 / `confirm` 删除保底 / `sanitize` 清洗）；`agent.py` 瘦身为 106 行薄层，对外 SSE 接口不变
- **工具体系（39 个）**：单一声明自动派生 Anthropic/OpenAI 双格式 + 全局 registry 统一分发
  - 项目：查/建/改、`get_project`（完整结构）、阶段增删改（`add_stage`/`remove_stage`/`rename_stage`）、待办增删（`add_todo` 批量/`remove_todo`）、`set_priority`、`set_color`、归档、删除
  - 日历：建/查/改/删
  - 文件：查/读/改、`create_document`（md/txt/json/csv 直写，docx/pdf/xlsx 经 LibreOffice 转）、重命名/移动/复制（`copy_file`）、文件夹建/列/改/删、删除（回收站）
  - 客户：查/建/改/删；回收站：列/还原/永久删除；聚合：近期待办/总览统计
- **删除二次确认保底（显式 confirm 参数）**：`agent/confirm.py` 的 `needs_confirmation(args, summary)`，不可逆操作（删项目/事件/客户、永久删除）未带 `confirm=true` 时返回影响详情、不执行；用户明确同意后带 `confirm=true` 再调一次才删。物理保底（不带 confirm 绝不删）+ 贴合模型自然行为，避免早期"跨轮强制"导致的反复确认、删不掉
- **伙伴人格 `prompts/persona.md`**：四种相处状态（做事/推进/记录/决策探索）、主动思考（有推进空间才多想一句、决策探索不强推）、风格与内容边界；builder 最先加载、所有 profile 共享
- **防编造铁律（persona + `default.md`）**：只陈述工具真实返回，不脑补文件名/数量/id；报告"已创建/移动/删除"前必须真调用了工具并收到 success，批量逐个确认，杜绝"跳过工具直接编成功"
- **Admin 可在线编辑人格**：Agent 面板系统提示词 Tab 新增「人格」入口（`persona`），带"谨慎修改"提示，保存即热更新（`agent_admin` 放行 persona 读写）
- **文件夹拖拽移动**：文件库网格/列表视图的文件夹卡片支持 `draggable`，可拖入其他文件夹或面包屑导航节点；后端新增 `PATCH /folders/{fid}/parent`，含循环依赖检测（遍历父链，拒绝移入自身或后代），前端乐观更新 + 失败回滚

### 调整

- **历史窗口按 token 预算裁剪**：`context/tokens.py` CJK 感知估算，从最新往回按预算（接 `settings.ai.context_tokens`）裁剪，替代原按条数 `limit(10)`
- **LLM 单次流式调用（Anthropic 路）**：原"探测-再流式"是两次调用——第一次（带 tools）已生成答案却被丢弃，第二次让模型看到相同输入"觉得刚说过"而敷衍。改为**单次 `messages.stream`（带 tools）**：实时流式输出文本的同时，结束后从 `get_final_message` 取 tool_use 决定是否执行工具。既保留真流式、又消除双调用敷衍；`max_tokens`/`temperature`（离散度）接入配置并应用
- **每轮注入"文件/文件夹概览"**：`loaders.load_files_overview` + builder `{files}` 占位 + `default.md` 文件区——咕咕每轮开局即看到最新文件夹列表、文件总数、最近 25 个文件，治"读不到最新文件"（之前上下文只有项目+日历、没有文件）

### 修复

- **所有工具支持按"名字"操作（不再依赖 id）**：项目/文件/文件夹/客户/事件的查改删工具，过去要求传 `xxx_id`，而咕咕常不知道 id → 猜错 → 工具失败却被误报成功。改为每类实体统一加"按名解析"（`project`/`file`/`name`/`client`/`event` 等），优先精确名、退化为包含匹配；重名时文件夹优先顶层、项目优先未归档，仍歧义则返回候选让其指明，找不到则报错并列出可选项——杜绝"猜 id 失败还谎报成功"
- **MiniMax tool-call 标记泄漏**：`agent/sanitize.py` 流式清洗，token 流出现 `]<]minimax` 标记即截断其后泄漏内容（处理跨块拆分）
- **聊天气泡偶发消失**：`GuguChat.vue` 消息列表改用稳定 `:key="msg.id"`（含发送/接收/历史加载全程生成 id），替代数组索引 key
- **流式中气泡内容闪烁/消失**：流式过程中半截 markdown（表格/代码围栏）被 `marked` 解析成残缺结构而隐藏；改为流式中按纯文本显示、消息完成后再渲染 markdown（`msg.streaming` 标记驱动）
- **咕咕回看历史出现空气泡**：`GET /sessions/{id}/messages` 过滤 `content_json IS NOT NULL` 的工具中间消息，仅返回正文对话
- **咕咕展开后不在底部**：`toggleOpen` 改为 async，展开时 `nextTick` 后滚到列表底部
- **生成完成后时间戳被截掉**：`finally` 补一次 `scrollBottom`，等 markdown 重渲染后内容高度稳定再滚
- **工具轮次之间出现空气泡**：`_new_round` 转发至前端后静默处理，不触发 `thinking = true`

### 调整

- **咕咕大窗宽度**：展开模式改为右锚约 60% 视口宽（`left = max(导航栏右边界, vw×0.4 - 12)`），两侧气泡距离更紧凑

### 移除

- 废弃的 agent worktree（`worktree-agent-ac26f7f41d9ad32b2`）及其分支：内容已并入 main，无独有提交

---

## [0.8.0] - 2026-06-22

### 新增

- **Admin 独立入口**：Admin 面板从主应用拆分为独立 Vite 入口（`admin/index.html` + `src/admin.js`），Dev Server 端口 5174（`npm run dev:admin`），打包产物分离至 `dist/admin/`；Nginx 将 `admin.gugugu.site` 指向 `dist/admin/index.html` 即可实现独立域名
- **用户管理面板**：全用户列表（头像、昵称、用户名、邮箱、注册时间、本周 Token、存储用量、配额状态），支持搜索过滤、封禁/解封、删除；操作写审计日志
- **配额管理页**（独立路由 `/quota`）：三区块设计——全局默认配额（热保存至 `config.override.json`，无需重启）、用户覆盖列表（自定义配额用户）、所有用户表（可编辑任意用户配额）
- **Token 用量限制**：6 小时滑动窗口 + 每周上限（周一 00:00 UTC 重置），对话前双重拦截；per-user 覆盖优先于全局默认，均为 `None` 时不限制
- **存储空间限制**：上传前检查 `used + size > limit`，超限返回 400；同样支持全局默认与用户覆盖
- **`QuotaSettings` 配置类**：`default_token_limit_6h` / `default_token_limit_weekly` / `default_storage_limit_bytes`，纳入 `AppSettings` 热更新流程；User 模型新增对应字段（migrations `20260622000006` / `20260622000007`）
- **邀请码系统**：Admin 生成/管理邀请码（格式 `GUGU-XXXX-XXXX`），注册时校验，使用后标记失效；支持批量生成（1–20 个）、过滤（全部/有效/已用）、复制（非 HTTPS 降级 `execCommand`）
- **Agent Admin 面板**：LLM 配置（provider 预设切换）、系统提示词（profile 热编辑）、行为配置（记忆参数）、用量统计四个 Tab
- **用量统计**：每次对话记录 token（`AgentUsage` 表），统计面板含今日/总计汇总卡、SVG 折线图（对话/输入/输出三指标，可切换月份）、按模型分组表格
- **审计日志 & 系统日志**：后端写入 + Admin 页面查看，关键操作（配置修改、用户管理、配额变更）全程可追溯

### 调整

- **去除 Onboarding 页面**：改为由 Agent 在首次对话中主动了解用户；移除路由守卫、`identity_done` localStorage 标记及 `/me/identity` 接口
- **Admin 路由去前缀**：路由从 `/admin/*` 简化为 `/*`，`AdminLayout` 链接同步更新，对齐独立域名部署
- **存储配额预设**：全局配额卡与用户编辑弹窗统一为 5 GB / 20 GB / 50 GB / 100 GB
- **去除 Admin「返回主界面」链接**：两个应用完全独立，侧边栏与登录页均已移除

### 修复

- **配额页刷新后变无限制**：config store 缺少 `cfg.quota` 初始化，`fetchConfig` 未读取 `data.quota`；已补全
- **用户覆盖列表始终为空**：`overrideUsers` 过滤条件错误引用已废弃字段 `token_limit_monthly`，修正为 `token_limit_6h || token_limit_weekly || storage_limit_bytes`
- **Admin 登录跳转路径**：从 `/admin/config` 修正为 `/config`，对齐新 Router base

### 架构

- **Agent 设计方向确立**：咕咕定位为伙伴而非助理，记忆系统为核心；用户主动输入仅昵称一处，其余由咕咕自主观察积累；压缩路径 daily → weekly → memory.md，无 monthly 层；`summary.md` 由 Reflection（importance ≥ 4）触发更新
- **用户档案目录确立**：`.agent/` 下 `identity.json` / `summary.md` / `facts.json` / `preferences.md` / `memory.md` / `daily/` / `weekly/`，每个文件回答一个独立问题

---

## [0.7.2] - 2026-06-22

### 新增

- **个人设置 Modal**：左导航分栏（900×600），与 AppSidebar 同风格毛玻璃；三大板块：个人信息、账号设置、偏好设置，另有「咕咕设置」入口
- **头像上传**：头像圆圈 hover 显相机图标，支持 JPEG/PNG/WebP/GIF ≤5MB，存储至 `uploads/avatars/`，`GET /api/v1/auth/avatar/{user_id}` 提供服务；AppSidebar 同步显示
- **昵称与登录名解耦**：新增 `display_name` 字段（migration `20260622000005`），登录名全局唯一不可改，昵称可随时修改；所有展示位优先显示昵称，fallback 至登录名
- **用户 ID 迁移至 UUID v7**：`users.id` 及子表 `user_id` 外键从自增整数迁移至 UUID v7（有序、不暴露注册量，migration `20260622000004`）；UID 在设置页展示为前 12 位大写十六进制
- **多标签页音频互斥**：`BroadcastChannel` 跨标签页协调，新标签页播放时其他自动停止
- **401 自动登出**：任何 API 返回 401 时前端清除 token 并跳转登录页
- **用户弹窗重设计**：底部用户卡弹窗改用 `.popup-menu` 风格；去除管理后台入口，新增「个人设置」按钮
- **全局表单输入框样式**：新增 `.form-input` CSS class，统一所有表单输入框

### 调整

- **日历右键菜单宽度**：从 140px 收窄至 110px
- **日历完成勾号范围**：仅保留右侧当日列表与近期节点胶囊，移除格内 chip、多日条、「更多」弹窗中的重复标记
- **日历今日保底颜色**：选中其他日期时今日格子保留淡紫色（周末淡红色）底色

---

## [0.7.1] - 2026-06-22

### 新增

- **项目优先级**：看板卡片与总览项目行右上角新增三星优先级按钮（高/中/低），点击直接设置等级，再次点击同级取消；优先级字段持久化至后端（`priority` 列，Alembic migration `20260622000001`）
- **乐观锁（Optimistic Locking）**：项目与日历活动新增 `version` 字段，每次 PATCH 自动携带当前版本号，后端不匹配返回 409；项目 store 捕获 409 后自动重新拉取最新数据；活动 409 弹提示并重载（migration `20260622000002`）
- **项目状态快速前进**：看板卡片右侧新增 `>` 按钮，点击将项目状态前进一列（待开始→进行中→已完成）；总览项目行状态胶囊可直接点击前进（仅前进，不可退回）
- **日历「更多」弹窗定位**：弹窗从「更多」按钮正上方/下方弹出（依剩余空间自动决定），动画的 `transform-origin` 随方向动态设置，不再从弹窗中间展开
- **日历「更多」弹窗进度条**：更多列表中的项目条目显示进度渐变背景（与日历条/胶囊一致）
- **分段进度条**：看板卡片与总览项目行的进度条按阶段数等分为独立段，每段可点击直接切换至对应阶段；悬浮时仅该段放大（`scaleY`，不影响卡片高度）；点击星级或进度段时卡片不触发下沉动画（CSS `:has()` 排除）
- **阶段自动打勾/还原**：前进阶段时，经过的阶段未完成待办自动标记完成（`autoCompleted: true`，记录 `_savedDone` 快照）；退回阶段时，目标阶段及之后阶段的自动打勾待办精确还原至快照状态；手动勾选/取消任何待办会清除 `autoCompleted` 标记，退回时不再还原该项；逻辑持久化至后端 stages JSON，刷新页面后仍有效
- **最后阶段自动完成**：当前阶段为最后阶段且进度达到 100% 时，项目自动标记为「已完成」；退回非末阶段或待办进度不满时自动回退至「进行中」；从看板「已完成」列拖回时同步还原所有 `autoCompleted` 待办至快照状态
- **新建项目 modal 日期预填**：日历页多选日期范围后点击顶栏「新建项目」，开始/截止日期自动填入选区
- **全局标题编辑框样式**：新增 `.title-edit-input` 全局 CSS 类，统一弹窗/卡片标题内联编辑框样式
- **日历完成标记**：所有日历位置（格内 chip、多日条、近期节点胶囊、「更多」弹窗、右侧当日列表）的已完成项目在名称后显示绿色 ✓ 勾号；同时保留项目颜色球
- **日历今日保底颜色**：选中其他日期时，今日格子保留淡紫色（周末淡红色）底色，不再与普通格子相同

### 调整

- **排序规则全面统一**：所有项目列表（看板列、总览列表、日历格内、日历侧栏当日/近期节点）统一为优先级降序 → 开始日期升序 → 截止日期升序 → 创建时间兜底；已完成项目始终排在最后
- **已完成列排序**：由纯完成时间降序改为优先级降序 → 完成时间降序
- **新建项目 modal 顶部**：名称输入区高度固定 52px，输入框字体与显示态统一
- **项目编辑卡填写框底色统一**：阶段重命名框、待办输入框聚焦态底色统一为 `rgba(255,255,255,0.72)`
- **`saveTodos` 走 `_patchProject`**：修复直接调 `projectsApi.update` 不携带 `version` 触发 409 的问题

### 修复

- **`api.js` 变量名冲突**：`err` 重复声明导致构建失败，改为 `apiErr`
- **后端 `_to_resp` 缺失字段**：项目响应补入 `priority`、`version`；活动响应补入 `version`
- **`ProjectModal.vue` 缺少 `projectsApi` 导入**：运行时 `ReferenceError`，已补入 import
- **阶段切换待办不实时更新**：改为在 `setStage` 同步替换 `localStages.value`，不再依赖 store 异步回写
- **退回阶段目标阶段本身待办未还原**：还原循环起点从 `newIdx+1` 修正为 `newIdx`
- **`_stageBeforeDone` 记录了末阶段而非原始阶段**：`setStage` 已先修改 `currentStage` 再调 `moveProject` 导致快照 key 错误；改为修改前提前保存
- **拖回已完成后待办全部保持勾选**：`moveProject` done→active 路径补入 `autoCompleted` 还原遍历
- **编辑卡状态胶囊不实时更新**：新增 `watch(() => props.project?.status, ...)` 实时同步 `localStatus`
- **胶囊变色延迟明显**：乐观更新移至第一个 `await` 前，合并为单次 patch
- **上传文件弹窗文件过多时溢出**：`.drop-zone.has-files` 加 `max-height: 320px; overflow-y: auto`
- **进度条鼠标判定区域**：进度段 `::before` 伪元素从 `inset: -4px` 扩展至 `-6px`
- **阶段拖拽排序只重排名称**：拖动仅移动 `label`，todo/key/当前阶段状态保持原位

---

## [0.7.0] - 2026-06-21 / 2026-06-22

### 新增

- **用户偏好持久化**：新建 `user_preferences` 表，`GET/PATCH /api/v1/preferences` 接口；阶段模板与上次使用的阶段存入后端，换设备登录后自动同步，不再依赖 localStorage
- **新建项目重设计**：700px 两栏布局（左：客户 / 项目周期 / 状态 / 颜色 / 备注；右：阶段 + 模板），默认截止日期为一周后
- **新建项目阶段模板**：支持保存、删除、重命名，内置「标准流程」「插画流程」「动画流程」三个默认模板，持久化至后端用户偏好（`preferencesApi`，随账号跨设备同步）
- **新建项目默认阶段**：优先读后端偏好 `last_stages`，其次读 store 最近项目，删除全部项目后仍保留上次填写的阶段
- **DateSpanPicker（连续日期选择器）**：开始 / 结束日期合为一个选择框，支持范围高亮、自动排序；「今天」按钮仅跳转月份；每次打开重置为选开始日期状态
- **日期选择器年份快速切换**：点击月份导航标题进入年份网格（4×3），点击直接跳转，支持翻页
- **项目备注自动保存**：防抖 600ms 写入 store
- **文件双向同步**：Tab 切回时调 `GET /files/version` 摘要接口，版本变化静默重拉全量；本地删除后 `/files/all` 扫描孤儿记录自动硬删
- **日历活动删除**：编辑弹窗右上角新增 × 关闭按钮，右下角新增「删除」按钮（`#b07858` 琥珀色）
- **项目完成时间记录**：状态改为 `done` 时记录精确完成时间戳（前端 `new Date().toISOString()`，后端 `datetime.utcnow()`）；撤回时清除，重新完成时更新为最新时间；已完成列卡片显示「✓ 完成」绿色胶囊 + 完成日期，隐藏原开始/截止日期
- **看板列排序**：待开始按开始日期升序、进行中按截止日期升序（最快到期排最上）、已完成按完成时间戳降序（最近完成排最上）；日期相同时以项目 ID 升序兜底
- **项目进度可视化**：
  - 日历项目条背景改为进度渐变（已完成 `accent` 32% / 未完成 10%），`barSegFill()` 保证跨周多行进度连贯
  - 总览 / 日历侧栏近期节点项目胶囊同步显示进度渐变，活动事件不受影响
  - `.cap-capsule` 背景统一由 CSS 变量 `--cap-bg` 驱动，`capBg()` 函数生成渐变字符串
- **日历周末今日日期框**：今日为周末时渐变改为低饱和红（`#b85c5c → #c97070`），平日保持紫灰
- **阶段待办事项**：ProjectModal 与 NewProjectModal 每个阶段下常驻待办列表（`{ id, text, done }`），支持勾选、内联编辑、Enter 快速追加、Backspace 清空删除；待办数据存入 `stages_json`，持久化至后端，无需新增数据表
- **进度细分**：阶段进度由待办完成比例驱动——有待办时当前阶段进度 = 已完成待办数 / 总待办数 × 阶段权重；无待办时直接计入整个阶段权重（2阶段无待办：选阶段1 = 50%，阶段2 = 100%）；看板卡片与编辑卡头部进度条实时联动
- **阶段模板支持待办**：`useStageTemplates` 模板存储完整 `{ label, todos }` 对象；保存模板时保留各阶段的待办内容，应用模板时还原；模板预览仅展示阶段名称
- **项目编辑卡保存按钮**：删除按钮旁新增绿色保存按钮（`PhCheck`），点击关闭弹窗（数据已实时自动保存）

- **文件库 Shift 多选**：点击 / 框选后按 Shift+点击可连续选中整段文件；Shift+框选合并到已有选中；Shift 按下时直接选中文件而不触发预览；`lastAnchorIndex` 在框选结束后自动定位到最末项，便于继续延伸
- **日历多日框选**：在日历格空白处按住鼠标拖拽可选中连续日期范围，首尾高亮（周末用红色调），框选期间实时预览；选区保持直到用户重新拖选
- **日历右键菜单**：在日期格空白处右键弹出 `.popup-menu` 风格菜单，可选「新建活动」（预填右键日期）或「新建项目」（预填框选范围为开始/截止日期）；菜单通过 `week-row` 层级捕获事件，避免 bars-layer 遮挡；关闭弹窗后选区不丢失

### 调整

### 修复

- **项目编辑卡状态按钮不实时更新**：补加 `localStatus` ref，点击立即更新 class，与 `localColor` / `localCurrentStage` 模式一致
- **项目编辑卡颜色 / 阶段 / 名称不实时更新**：`localColor`、`localCurrentStage`、`localName` 改为独立 ref，点击立即生效；`startEditName` 不再重置 `localName`
- **项目编辑卡阶段拖动带动进度**：阶段球样式改为位置索引（`activeStageIdx`）驱动，拖动重排只移动标签名，done/active 样式不跟随
- **阶段球 CSS 闪烁**：移除 `.stage-node.active` CSS background 规则与 transition，消除 inline style 与 class 单帧冲突
- **阶段拖动 ghost 倾斜**：去除 `rotate(-1deg) scale(1.02)` 变换
- **`startStageDrag` indexOf 失效**：改为传 v-for 位置索引 `i`，避免 Vue proxy 引用比较失效
- **项目卡截止日期时区错误**：`new Date("YYYY-MM-DD")` 解析 UTC 零点导致凌晨显示「明天」；4 处改为本地日期零点比较
- **项目卡文件数量不实时**：改为从 `filesCache.allFiles` 实时计算
- **`file_count` 含回收站文件**：`GET /projects` 加 `deleted_at IS NULL` 过滤
- **文件库历史残留已删除文件夹**：删除后同步清理 `navHistoryStack`，索引追踪替代 `indexOf` 引用比较
- **跨年日期显示**：年份与当前年不同时前置年份（`2025/12/31`、`2025年12月31日`）
- **添加阶段后立即聚焦**：点击「添加阶段」新输入框自动获焦
- **模板弹窗**：换亮白色背景；click-outside 排除内部点击；重命名时铅笔→对勾，删除按钮保持可见
- **项目备注 `textarea` 未绑定**：补加 `v-model`

- **全局弹出菜单样式**（`global.css`）：提取 `.popup-menu` / `.popup-menu-item` / `.popup-menu-sep` / `.popup-menu-shortcut` 为全局类（背景 `rgba(255,255,255,0.6)` + `blur(24px)`），右键菜单、排序下拉、日历活动弹窗统一复用
- **全局关闭按钮**：`.popup-close-btn` 提取至 `global.css`，Calendar / mini 播放器统一使用
- **mini 播放器图钉 / 音量按钮**：默认无底色，固定态仅保留紫色文字，hover 才显示浅底色
- **浮动预览器 / 抽屉预览器按钮**：默认无底色，hover 显示 `rgba(0,0,0,0.1)` 暗色；判定区域扩大 2px，gap 去除使相邻判定连续
- **PDF 加载状态位置**：`pv-status` 改为 `position: absolute; inset: 0` 绝对居中
- **UI 交互全局优化**：
  - 所有底层玻璃面板加 `backdrop-filter: blur(20px)` 毛玻璃；hover 背景 / 阴影 `0.25s ease` 淡入淡出
  - 彩色胶囊 / 条 hover 统一用 `inset 0 0 0 100px rgba(255,255,255,0.45)` box-shadow，`0.25s ease`
  - 文件卡片 `::after` 叠加 `rgba(255,255,255,0.15)` 白色高亮，提取至 `global.css`；内容层 z-index 分层确保白色仅覆盖缩略图
  - 不可拖动的卡片（如总览最近文件）hover 不浮起（`transform: none`），保留阴影加深
  - 日历侧栏当天日程卡片 hover 加 `rgba(255,255,255,0.2)` 白色高亮 + 黑色外阴影
  - 日历多行项目条 `hoveredBarId` 联动高亮；日期格 hover 改 `mousemove` 方案防止跨层闪烁
- **项目名称颜色**：全局统一 `darkenHex(color, 0.40)`，字重 `font-weight: 500`（Dashboard 项目列表、看板 ProjectCard）
- **总览项目行 hover**：`rgba(255,255,255,0.65)` 白色背景 + 外描边 + 顶边高光；行间添加 1px 分割线
- **看板 ProjectCard**：背景左侧透出项目色（`linear-gradient` 渐变至白）；hover `::after` 向上白色渐变叠加
- **总览文件面板动态列数**：`ResizeObserver` 计算，始终填满一行（`displayCount = colCount - 1`，上传按钮占最后一格）
- **总览文件面板样式**：统一使用文件库 `fc-card` 样式（大图标、ext 角标、渐变遮罩、缩略图）
- **日历近期节点**：过滤 `status === 'done'` 项目
- **日历活动 / 项目弹窗**：统一 `popup-header + × 关闭` 结构；弹窗日期标题修复行高压缩问题
- **导航栏**：选中项 `font-weight: 700`
- **总览日历头部**：三列 grid，年月居中，切换按钮分列两侧
- **缩略图系统**：Authorization header 认证稳定缓存 key；`useThumbCache` 模块级 blob Map 跨页零请求命中；`preloadTinyThumbs()` 全局预热；`thumbLoadedIds` 模块级持久化；`sessionStorage` 持久化文件列表；文件库热缓存加载跳过 `await`
- **项目编辑卡**：左右栏背景统一；文件列表打开时预填防空帧；阶段球平面化
- **文件库**：删除顶栏上传按钮；多选工具栏垂直对齐优化；按钮高度统一
- **删除废弃组件** `ProjectDrawer.vue`

### 性能

- **WebP 缩略图根因修复**：补入 `Pillow` 依赖，tiny 缩至几百字节 / card 缩至几 KB，根本解决滚动卡顿
- **缩略图降级**：生成失败输出缩小 JPEG，兜底返回原图；异常打印 traceback
- **HTTP Cache 绕过**：fetch 加 `cache: 'no-cache'`，防止浏览器缓存旧版大图
- **移除 `glass-card` backdrop-filter**：主体面板背后平滑渐变无需 blur，消除 GPU 捕获峰值
- **FilePanel 懒加载**：card 缩略图面板接近视口才解码，tiny 仍即时预热
- **IntersectionObserver 始终启用**：有缓存时也不跳过，防止二次打开批量解码卡顿
- **渐进式动画**：`fc-loaded` 改由 `@load` 事件驱动，二次打开 blur→sharp 效果一致

### 安全

- **用户隔离漏洞修复**（6 处）：`copy_file` / `update_file` / `agent create_event` 目标资源未验证所有者；`update_project` 返回 `file_count` 未过滤 `user_id`
- **回收站路径隔离**：路径由 `trash/{fid}/` 改为 `{user_id}/trash/{fid}/`

---

## [0.6.0] - 2026-06-20 / 2026-06-21

### 新增

- **文件库全量元数据缓存**：进入文件库一次性拉取所有元数据，导航切换无网络请求；乐观更新（失败自动回滚）；新增 `GET /files/all`、`GET /folders/all`
- **图片缩略图**：网格卡片 blur-up 渐进加载（tiny 占位 → card 淡入），IntersectionObserver 懒加载，后端磁盘缓存，上传时自动预生成；文件库 + ProjectModal 均支持
- **面包屑后退 / 前进按钮**（文件库 + 项目编辑卡），根目录或无历史时自动禁用
- **右键「详细信息」弹窗**（`FileInfoPopup.vue`）：独立信息卡，可拖拽，只能按 X 关闭
- **音频播放进度持久化**：刷新时保存，重载后恢复一次，切歌不保存
- **全局图标统一为 Phosphor**：播放器、FilePreviewModal、FloatPreviewWindow、咕咕聊天窗剩余手写 SVG 全部替换
- **日历接入中国法定节假日**：调用 timor.tech API，按年缓存至 localStorage（30 天过期），日历格与 Dashboard 小日历同步显示「休」/「班」标签
- **日历样式优化**：今日 / 选中日期外框改为圆角矩形；周末格子背景与表头加入红色调；选中周末格用红色系；日历格底部安全区 `BOTTOM_PAD = 8`，防止活动条溢出
- **日历活动右键打开编辑**：侧栏列表、近期节点、格内 chip 均支持右键直接打开编辑弹窗

### 修复

- **软删除不释放路径**：软删除时物理文件移至 `trash/{fid}/原文件名`，修复删后上传同名变 `xxx(1)` 的问题；还原时移回并处理命名冲突；`rmdir` 清理空目录
- **PDF/Office 预览页面左移**：`html, body, #app` 加 `overflow: hidden`
- **FilePreviewModal 信息面板超出右侧视口**：改为右对齐定位
- **日历侧栏活动名不换行**：改为 block + `word-break: break-word`，标签 `inline-block` 紧跟名称
- **音乐播放器按钮风格**：关闭 / 固定 / 音量改为圆角矩形，与聊天窗关闭按钮对齐；播放 / 暂停恢复圆形；音量图标改为 fill
- **咕咕聊天窗发送按钮**图标颜色改为白色
- 缺失的 `anthropic` 后端依赖补入 `requirements.txt`
- 面包屑根目录去掉多余右箭头；排序图标 11 → 13；上传按钮不出现在根目录 / 年月层；视频播放器按钮渐变背景，不透明度降低

### 删除

- `AudioViewer.vue`（死代码）

---

## [0.5.0] - 2026-06-20

### 新增

- **文件预览系统**：图片 / 视频可拖拽浮动窗口（多窗口并存、resize、最大化）；PDF / 文本侧边抽屉（翻页、缩放、代码高亮、Markdown 渲染）；音频直接进迷你播放器；所有查看器支持可拖拽信息弹窗
- **文件操作**：右键菜单（文件 / 文件夹 / 空白三种模式）；剪切 / 复制 / 粘贴（`Ctrl/⌘+X/C/V`）；框选多选；列表视图列头排序；7 层导航，文件夹无限嵌套，回收站 30 天自动清理

---

## [0.3.0] - 2026-06-18

### 新增

- **主界面（DefaultLayout）**：顶栏 + 侧边栏玻璃拟态布局、全局导航、用户卡片
- **总览页（Dashboard）**：统计卡片、项目列表、日历面板、最近文件
- **项目页（Projects）**：三列看板、HTML5 拖拽换列、ProjectModal 阶段编辑
- **日历页（Calendar）**：月视图、项目横跨条、事件 chip、年/月快速选择器

### 进行中

- 文件系统重构（四空间架构 + 本地 / OSS 双后端）

---

## 历史版本

更早的变更记录参见 git 提交历史（`git log --oneline`）。