# 更新日志 · Changelog

本项目所有显著的更新都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 定时任务 · 提醒工作流重构（结果走通知/IM，不进对话）

> 定时任务的产出不再作为消息塞进对话框，改为独立工作流：到点跑 agent → 推送到侧边栏铃铛通知 + IM 主动投递。

- **结果不入对话**：`execute_task` 改用 `run_ephemeral`（`agent/runner.py`）跑 agent——不建/不复用 `ConversationSession`、不写 `conversation_messages`、不推 `sessions` SSE 事件，因此定时任务的回复不会出现在「⏰ 咕咕提醒」会话或任何聊天窗口。
- **投递改两路**：① `events.publish(uid, notification={title, content})` → SSE → 前端 `live.js` → `ui.js` 通知 store → 侧边栏铃铛角标实时弹出；② `_deliver_im` 主动 DM（飞书可主动，QQ best-effort）。
- **移除 `reminder` 动作类型**：用户能建的动作只剩 `agent`（`_ACTIONS = {"agent"}`），删掉前端类型选择器与后端 `reminder` 分支；简单提醒和复杂任务统一交给 agent，可调用工具。
- **上下文注入消歧**：触发时把 payload 包成「[定时任务触发：{name}]\n现在是 {now}，用户设置了一条定时任务：{payload}\n请以咕咕的身份完成这项任务……」，让 agent 明确 payload 里的「我」指用户而非自己。
- **编辑模态改版**：任务名置顶（白底描边输入框、聚焦才显边框）、重复改周一~周日圆形 day chips（多选、无选=不重复）、各区块分割线，与新建项目卡同款 squircle 风格。

### 性能 · SSE 不再占连接池 + 连接池调优 + 试运行不阻塞

> 修复「每次试运行 / 前后端重启后整站卡死」——根因是 SSE 长连接长期占着 DB 连接，把连接池（默认 15）耗尽。

- **SSE 鉴权不查 DB**：`/live/stream` 原经 `get_current_user`（`Depends(get_db)`）拿用户，DB session 在 SSE 整个生命周期不释放——每条长连接占一个池连接。新增 `get_current_user_id`（仅解 JWT、不碰 DB），SSE 端点改用它，长连接不再占池。
- **连接池调优**（`app/db/session.py`）：`pool_size=15`、`max_overflow=25`（峰值 40/进程，web+worker ≤80，留 ~20 给 pgAdmin）、`pool_timeout=10`（等不到快速失败而非挂 30s）、`pool_recycle=1800`。
- **试运行返回各渠道结果**：`POST /scheduled-tasks/{id}/run` 同步执行并返回每个渠道的投递状态（`已发送` / `无可触达地址` / `失败`），前端弹窗直接显示——不再静默、不用猜哪个平台没收到。连接池已修复，同步 await 一条试运行只占一个连接、不会像 SSE 那样耗尽。

### 定时任务 · 多平台精确投递（按平台存地址 + 连接时存址 + 解绑清址）

> 让用户能**分别勾选** web 通知 / 飞书 / QQ，且各平台独立投递、互不覆盖；并杜绝解绑后误发旧账号。

- **渠道拆分**：原单一「飞书/QQ」(`im`) 拆成 **`web` 通知 · `feishu` · `qq`** 三个独立勾选；后端 `execute_task` 按勾选的渠道分别投递（`web`→SSE 通知；`feishu`/`qq`→对应平台 DM）。旧 `chat`/`im` 作历史别名兼容。
- **可触达地址按平台存**：`imreach:{uid}:{platform}`（原来是单条 `imreach:{uid}` 互相覆盖，导致「发了 QQ 飞书地址就没」）。`get_imreach(uid, platform)` 精确取该平台地址，合并键仅作兜底。
- **飞书连接时存地址**：`feishu_connect.poll` 成功后把 owner `open_id` 存进 imreach → **选了飞书无需先聊天即可主动投递**（QQ 受平台限制仍需首条消息学习地址）。
- **飞书按 open_id 发**：`feishu._do_send` 按收件人前缀自动判断 `ou_`(open_id) / `oc_`(chat_id)，`worker._send` 无 chat_id 时用 open_id。
- **解绑双保险（防误发旧账号）**：① 解绑 bot 时 `clear_imreach` 删该平台地址；② 投递前 `_deliver_im` 校验该平台有 enabled bot，**无活绑定一律不发**——即使地址残留也发不出去；重绑生成新 app + 新地址。
- **设置界面**：某平台已绑 bot 时**隐藏「扫码连接」按钮**（显示「已连接·删除后可重连」），UI 层定死「每用户每平台一个 bot」。

### 通知面板 · 弹窗高度自适应不溢出

- 弹窗高度按视口动态算（`maxHeight = 视口高 − 上下边距`），铃铛太靠下时整体上移让出空间，**底部绝不超出页面**；列表在弹窗内滚动。

### 文档 · 并发优化 roadmap 收口

- `开发链路-roadmap.md` 重命名为 **`并发优化ROADMAP.md`**（单一权威：诊断依据 + P0–P4 + ①–⑨ backlog）；合并并删除旧的 `并发与性能优化.md`（诊断数据已抢救进新文档）；`agent.md` 相应章节砍成指针。回填状态：⑤ DB 池、② 标题/反思 fire-and-forget 标记已完成。

### 项目看板 · 进度条瀑布动画

> 点击阶段卡片时，进度条按顺序依次填充/退回，视觉上形成瀑布流效果。

- **Per-stage 填充数组**（`animFills = ref(null)`）：抛弃原单一 `animFill` 数值，每个阶段独立存储当前宽度，彻底解决「完成阶段越多进度条越窄」的坐标系 bug。
- **全局 ease-out + 时间槽错开**：对全局进度 `t = 1-(1-raw)²` 统一缓动，每个变化阶段分配错开的时间槽（`t·nc - k`），保证动画整体非线性减速且各段顺序填充，而非各段独立缓动。
- **只对变化阶段分配槽位**：过滤掉填充量变化 ≤ 0.5% 的阶段，后退动画自动倒序，避免无意义补间。
- **`toFills` 预测 setStage 副作用**：`setStage` 前进时对途经阶段 auto-complete todos（`autoCompleted: true`），后退时还原（`_savedDone`）。`toFills` 预先计算 setStage 执行后的真实填充值，避免动画结束后 `segFill` 与动画终态不一致造成视觉 snap。
- **`ProjectCard.vue` 与 `ProjectList.vue` 同步**：两处 `clickStage` 使用相同动画逻辑和 `toFills` 计算，保持仪表盘列表与项目页行为一致。

### 项目看板 · 滚动条优化

- 各列 `.col-body` 加 `scrollbar-gutter: stable`，滚动条出现/消失时卡片宽度不再跳变。
- 通过 `margin-right: -8px` + `padding-right: 14px` 将滚动条推入列右侧 padding 区域，远离卡片内容。

### 通知面板 · Markdown 渲染

- 通知内容（`n.content`）从纯文本 `{{ }}` 改为 `v-html`，经 `marked.parse()` 渲染，支持加粗、列表、行内代码、标题等 Markdown 格式。
- 高度限制：初版 `max-height: 60vh`，后改为按视口动态算、底部不溢出（见上「通知面板 · 弹窗高度自适应不溢出」）。

### 定时任务 · 试运行不关闭 @once 任务

- **根因**：`execute_task` 对 `cron` 以 `@once:` 开头的任务执行后自动 `enabled = False`，试运行也走了同一路径，导致点「试运行」后任务卡片立即变灰。
- **修复**：`execute_task` 增加 `is_trial: bool = False` 参数；试运行端点 `POST /{id}/run` 传 `is_trial=True`，跳过 `enabled = False` 逻辑。

### Bug 修复

- **`ProjectCard.vue`**：`animFills` 为 `const ref`，误写 `animFills = [...]` 赋值常量导致 `TypeError`，改为 `animFills.value = [...]`。
- **`ProjectModal.vue`**：`activeStageIdx` / `stageProgress` 声明在 `watch({ immediate })` 调用之后，`recalcStageState` 访问时命中暂时性死区（TDZ）报 `Cannot access before initialization`；将两个 `ref` 声明前移至 watch 之前。

### 用户定时任务（DB 驱动 · 执行 · 投递）

> 用户自定义定时任务。引擎 APScheduler（`AsyncIOScheduler`），挂在 **worker 单实例进程**（web 多 worker 不重复跑，呼应「周期任务单实例化」）。

- **DB 驱动**：`scheduled_tasks` 表（`action_type`、`payload`、`cron`、`channels`、`enabled`）。worker 每 ~30s 从 DB **reconcile** 到 APScheduler——增/删/改/开关即时生效、不重启（同 supervisor 读 `user_bots` 的套路）。
- **动作**（`app/scheduled_tasks.py`）：到点跑一条咕咕指令（`agent`）。〔后续重构：移除 `reminder`、结果改走通知/IM，见本节顶部「提醒工作流重构」〕
- **投递渠道**：侧边栏铃铛通知（SSE）+ `im` 按 Redis 存的「可触达地址」(`imreach:{user_id}`，worker 收消息时记一份) 主动 DM（飞书可主动，QQ 主动受限 best-effort）。〔原 `chat` 进会话渠道已废弃〕
- **用户「定时任务」页**（`/schedules`，侧边栏入口，glass 大版面 + 任务小卡片）：自定义任务 CRUD + 「试运行」后台执行一次（结果走通知/IM）+ 排程选择器（周一~周日 day chips + 时间，前端构造 cron；一次性任务用 `@once:<ISO>`）。后端 API `GET/POST/PATCH/DELETE /scheduled-tasks`（cron 校验）+ `POST /{id}/run`。
- **Admin 服务状态页可见**：worker 心跳带上已挂定时任务（id/name/下次运行时间），服务页 worker 卡片下列出。

> 注：曾做过的「系统级任务 / 内置截稿提醒 / Admin 系统任务配置」按需求已移除，只保留用户自定义任务。

### IM 斜杠强制命令（/stop · /status · /help）

> 比自然语言「算了/取消」更可靠的确定性中断手段。

- **网关层斜杠命令**（`agent/router.py` 的 `parse_command` + `decide`，网关零改动）：绕过关键词分类，确定性触发。
  - `/stop`（及 `/取消` `/x`，半/全角斜杠都认）→ **无条件置取消标志**中断当前任务——不受「是否判定为忙」约束、无关键词漏判，比自然语言取消稳；空闲时回「现在没有在跑的任务」。
  - `/status` 看当前进度（按状态机回话术）、`/help` 列命令。
- 非命令（如粘贴路径 `/Users/...`、未知命令）**不被吃掉**，照常走对话；自然语言取消「算了/还在吗」仍并存。
- 中断的实际粒度沿用 core 的取消检查（轮顶 + 流式途中每 24 token），故需配合 worker 上的取消修复一起部署。

### IM 自然语言取消 · 流式途中可打断（修复）

> 现象：IM（QQ/飞书）生成时发「取消/算了」打不断，答案照样说完。

- **根因**：core 工具循环只在**每轮 LLM 开始前**查取消标志（轮顶）。最常见的「生成」是单轮、无后续工具——网关把取消标志写进了 Redis，但 core 永远等不到「下一轮」去读它，于是整段答案照常流完。
- **修复**（`agent/core.py`，Anthropic + OpenAI 两路）：流式输出循环里**每 24 个 token**（`_CANCEL_CHECK_EVERY`）协作查一次取消标志，命中即退出 `async with` / `stream.close()` —— **关闭流、断开上游请求、真正掐断生成**（不是只丢弃后续 token）。
- 进程内伪流测验证：取消标志在第 30 个 token 生效后，生成在第 48 个 token（首个检查点）停下，而非流完 1000 个。
- 固有局限（已记 [`agent-决策环.md`](docs/agent-决策环.md)）：取消粒度约 24 token（亚秒级延迟，短于 24 token 的回答会说完）；**工具执行途中**（慢 `web_search`/文档生成）不查取消，等工具跑完到下个检查点。

### Admin 服务状态页 · 队列水位监控

- **后端** `services_admin.py` 的 `GET /admin/services` 增 `queue` 段：读 `im:inbound` 流 `length` + `agent-workers` 消费组 `lag`（已进队列没被取走＝真积压）/ `pending`（取走没 ack＝处理中）。
- **前端** 服务状态页加队列水位条（队列长度 / 积压待取 / 处理中），`lag>20` 或 `pending>10` 标黄预警 —— 一眼判断 worker 吃不吃得消。
- `consumers` 字段（消费组历史 pid 累积、非活 worker 数）刻意不显示，免误导。

### 咕咕聊天 · 多会话流式隔离 + 切换实时续看

- **修「回复串到别的会话」**：流式回复原来一直往全局共享的 `messages` 写，发完消息切到另一个会话，正在生成的 token 就渲染进了**当前所看会话**的视图（从没真正存进去 → 切换/重载即消失，纯视觉串台）。现在每个流**绑定归属会话**，切走后 `detached` 不再碰别的视图；`session_id` / `session_title` 事件按本流会话处理、不抢当前焦点；空回复兜底气泡也加 `!detached` 守卫
- **切换后仍实时（思考/生成动画不丢）**：改为「UI 始终只有一个流式消费者，绑当前所看会话」——切走时 `abort` 当前 SSE（后端 `genstream` 生成已解耦、继续跑、不受影响），切到的会话若 `active` 就 `resumeStream` 重连：续看端点先补已生成快照（完整 partial 文本 + 文件 + 当前工具态）再订阅后续，所以切过去/切回都立刻看到当前进度并继续实时刷新；切回已生成完的会话则从 DB 载入完整回复
- `send` / `resumeStream` 收尾加 **ownership 守卫**（`sessionId === 本流会话` 才重置 `streaming/thinking/activeTool/abortCtrl`），避免切走后旧流的 finally 清掉新会话续看流的状态；`consumeStream` 对 abort 优雅收尾（不当网络错）

### OSS 预签名直传（自适应上传）

> 背景：文件上传此前走服务器中转（浏览器 → FastAPI → OSS），文件过两遍服务器、带宽双倍消耗。
- **自动适配后端**：`storage.backend == 'oss'` 时自动切 OSS 直传；`local` 时继续走服务器代理；Admin 切换后端后下一次上传立即生效，无需重启
- **新端点 `POST /files/presign`**：计算 `storage_key`、检查配额，OSS 后端返回 `{ mode:'oss', upload_url, storage_key, final_name, ext }`（presigned PUT URL 有效期 10 分钟），本地后端返回 `{ mode:'proxy' }`
- **新端点 `POST /files/confirm`**：OSS 直传完成后由浏览器调用，验证 `storage_key` 归属（必须以 `{user_id}/` 开头）+ 验证 OSS 对象实际存在，写入 DB 记录，返回 `FileResponse`
- **存储后端新增 `OSSStorageBackend.presign_put(key, mime_type, expires=600)`**：封装 `oss2.Bucket.sign_url("PUT", ...)`，返回带签名的 PUT URL
- **前端**：`api.js` 新增 `filesApi.presign` / `filesApi.confirm` + `uploadDirectWithProgress(url, file, onProgress)`（原生 PUT XHR，无 Authorization 头，OSS 预签名 URL 自带鉴权）；`UploadModal.vue` 上传循环先调 `/presign`，按 `mode` 分支走直传或原有代理流程，进度条 OSS 路保留 5% 给 confirm 阶段

### 存储↔DB 对账与修复工具（Admin · 数据库）

> 起因：DB 曾在两台服务器间迁移、两边 `uploads/` 都有物理文件，改配置后「DB 记录」与「磁盘对象」串了——出现 DB 有记录但文件没了（幽灵）、文件在磁盘但 DB 无记录（孤儿）。需要一个以**物理存储为准**的核对 + 修复手段。
- **对账（只读）`GET /admin/config/reconcile-storage`**：逐一比对 `files.storage_key` 与存储后端实际对象，返回 `db_file_rows / storage_objects / matched / ghost_count / orphan_count` 及幽灵/孤儿明细。内部 key（`.agent/`、`.chat_staging`、`.thumbs/`、`avatars/` 等）由 `_is_internal_key` 过滤，不计入孤儿
- **修复（写）`POST /admin/config/reconcile-storage/repair`**，`action` 两选项都给：
  - `delete`：删除孤儿物理文件（清磁盘垃圾，如永久删除残留的 `trash/` 文件）
  - `import`：把孤儿重建成 DB 记录（解析 `storage_key` 反推 user/空间/项目/文件夹，回填 `File` 行）
  - 逐 key try/except，返回 `done / failed / done_keys`，单条失败不影响其余
- **存储后端补 `exists(key)` / `list_keys()`**（`StorageBackend` 基类 + Local 用 `rglob`、OSS 用 `ObjectIterator`），供对账枚举/核对
- **Admin → 系统配置 → 数据库**新增「存储对账」按钮：跑对账出报告（亮色文字适配深色面板），每条孤儿配「导入 / 删除」按钮 + 批量「全部导入 / 全部删除」
- **修复 import 500**：`reconcile_repair` 漏 import `get_storage` → `NameError` → 点「导入」报「服务器内部错误」。补上函数内 import，import/delete 两动作端到端实测通过

### 项目删除遗留孤儿文件（结构性修复）

> 现象：用户个人文件视图里冒出本应属于已删项目的文件（A 开头、01–08 等）。Safari/Chrome 都有、清缓存无效——不是缓存问题。
- **根因**：`File.project_id` 外键是 `ON DELETE SET NULL`，删项目时文件 `project_id` 被抹成 `NULL` 但 `space` 仍是 `'project'` → 成「孤儿文件」；而前端 `filesCache` 按「`projectId` 为空就归个人」分组，把这些孤儿漏进了个人空间视图
- **修复**：删项目前先 `rehome_project_files_to_personal`（`space='personal'`、`project_id/folder_id/stage_name` 置空），文件干净归个人而非变孤儿；物理文件 `storage_key` 不动（仍可访问，路径残留无害）。HTTP `DELETE /projects/{id}` 与 Agent `delete_project` 工具两条路都接入
- **教训留档**：排查时一度误判「文件已删/是浏览器缓存/连错库」，实为孤儿泄漏——`skills.md` 已强化「被质疑数量/可见性时跨全空间重查、勿先甩锅给缓存」

### 用户反馈功能

- **反馈入口**：侧边栏底部独立按钮 → 移入用户卡片弹出菜单首项（PhFlag 图标），点击头像弹窗即可触达，不占导航空间
- **FeedbackModal 分类图标**：emoji 换成 Phosphor 图标（Bug → `PhWarningOctagon`、建议 → `PhLightbulb`、其他 → `PhChatCircle`），选中时仅色/背景变、字重固定避免宽度抖动
- **后端**：新 `Feedback` 表、`POST /api/v1/feedback` 用户提交端点、`GET /api/v1/admin/feedback` 分页列表；`BackgroundTasks` 异步触发 SMTP 邮件通知

### Admin · 邮件系统（SMTP）配置

- **系统配置页新增「邮件系统」卡片**：SSL（465）/ STARTTLS（587）快速切换、服务器 / 端口 / 账号 / 密码 / 发件人 / 收件人六字段，卡片图标用 `PhEnvelopeSimple`
- **测试发送**：新后端端点 `POST /api/v1/admin/config/test-smtp`，用当前面板输入参数（密码留空回退已保存值）异步发一封测试邮件，即时回报成功/失败
- **Config Store**：新增 `smtp` 节，`fetchConfig` / `saveConfig` / `resetDraft` 均一并处理，与 DB/Redis/Storage 同等公民
- 邮件服务 `app/services/email.py`：`send_email` / `notify_feedback`，无 SMTP 配置时静默跳过

### Admin · 用户反馈页重写

- 全面改用深色 glass-morphism 风格（`rgba(255,255,255,0.05)` 卡片 + `backdrop-filter: blur`），与其他管理面板视觉一致
- 分类过滤按钮、刷新按钮图标换 Phosphor（`PhList` / `PhWarningOctagon` / `PhLightbulb` / `PhChatCircle` / `PhArrowClockwise`）
- 修复刷新按钮 SVG 旋转偏移：给 `.spin-icon` 补 `transform-box: fill-box; transform-origin: center`，Phosphor SVG 现在绕中心旋转

### Admin · 导航图标全换 Phosphor

- `AdminLayout.vue` 十二个导航项的手绘 SVG 全替换为 Phosphor 组件（PhGear / PhRobot / PhChartLine / PhFlag / PhTicket / PhUsers / PhStack / PhPulse / PhClipboard / PhTerminal / PhBug / PhSignOut），品牌 Logo SVG 保持不变

### 细节修复

- **toggle-btn 宽度抖动**：`font-weight` 从 500/600 切换改为始终 600，选中态仅变背景色与边框，按钮宽度不再跳动（影响存储后端切换、SMTP SSL 切换）

### 卡片拖拽物理效果（项目卡 / 文件卡）

> 原生 HTML5 拖放的 ghost 由浏览器接管，无法做弹簧跟随、占位收合、落点让位。新 `composables/usePhysicsDrag.js` 在**保留原有拖放逻辑不变**的前提下叠一层纯视觉物理层（隐藏原生 ghost、克隆体跟手飞、FLIP 占位动画）。接入看板项目卡、文件库网格卡、项目编辑卡（ProjectModal）文件卡。
- **跟手 + 拎起感**：克隆体弹簧跟随（低通平滑去抖）、挂在指针下方、按速度轻微后仰（上小下大）；拾起时源卡隐藏、占位用 **FLIP 动画收合**邻居（不再突然空出）
- **松手按落点三态**：① 换状态/换列（看板进行中→已完成）→ **双克隆同轨迹飞行**，飞行途中 `scale` 把卡片伸缩到落点卡尺寸（已完成卡在月份分组里尺寸不同）+ 交叉淡变完成样式切换，落点邻居 FLIP **让位**；② 拖进文件夹/折叠分组 → 缩小**吸入**；③ 原地/拖出范围 → 实心飞回、占位 FLIP **展开归位**
- 缓动统一为不回弹的强 ease-out；落点判定放在 `drop` 后下一帧、paint 前完成，避免闪一下
- 修一串迭代中的坑：同步 `display:none` 源卡会取消原生拖拽（改即时透明 + 延后收合）、克隆体首帧停在 (0,0)、落进折叠分组时飞到左上角、**拖出有效区松手要等 ~250ms**（无效拖放的浏览器 snap-back 延迟 → 拖拽期间 `preventDefault` 让整页可放置，松手即时归位）
- **换列/归位落点滚动到位（列已满时）**：落点卡若滚出列视口，松手后**快速滚动**（自实现 rAF 补间，避开 `scrollBy({smooth})` 在 drop / reduce-motion 下退化成瞬间）把它带进可视区，克隆体飞到滚动后的最终位置一起落定。根因是浏览器**原生拖拽边缘自动滚动**在拖动时就把列滚到底（`dy≈0` 没东西可滚）→ 拖拽期间锁住 `.col-body` 滚动（`overflow:hidden`，3px overlay 滚动条不引起位移），松手解锁再受控滚；归位（同列）也滚回原位（展开源卡后还原被锁列夹小的 `scrollTop`）
- 去掉曾加的 `clip-path` 裁剪：有了滚动到位，克隆体本就落在视口内、不探出列，裁剪反而会在滚动途中把克隆体裁没

### 项目进度口径统一为「总完成度」

- **统一口径**：看板卡 / 总览页 / 项目编辑卡头部 / 日历项目条 / Dashboard 近期节点胶囊，进度数字一律 = **所有阶段待办「已完成 / 总数」**（不再是「(当前阶段+1)/阶段数」的阶段位置百分比）；无任何待办时退回按阶段位置。抽出共享 `utils/projectProgress.js` 作单一口径，日历/胶囊前端现算、不再读持久化 `progress`
- **阶段条各阶段独立**：每段填充按**自己的待办完成度**涨（阶段2 待办做完阶段2 就涨，不受当前阶段限制），无待办的阶段按是否推进到/过此阶段
- 持久化 `progress` 字段与「最后阶段满→自动完成」判定暂未改（仍阶段位置口径），仅显示层统一

### 已完成列「最近完成」置顶

- 已完成列顶部加「最近完成」区，按完成时间倒序直接显示最近 3 个项目（无需展开年/月文件夹），并从下面的归档分组里排除避免重复

### 文件工具「集合操作」化（批量 + 文件夹递归整搬）

> 起因：Agent 一次只能移/改一个文件、且没法移文件夹，多文件操作要调 N 次——既慢又容易丢步、乱报数量。改为「让 Agent 表达意图、后端负责展开」的集合操作。
- **`move_items`**（取代单文件 `move_file`）：`files` + `folders` 混合一次移到同一 `target`。**移文件夹连里面的文件、子文件夹一起递归搬**（后端展开，Agent 不必知道里面有几个）——同项目内只改 `parent_id`（便宜）、跨项目/空间则级联改子孙 `project_id/space` + 物理重搬；防自移入自身/子孙；逐项回报成功/失败
- **`rename_file` 批量**：`renames=[{file,new_name},...]` 一次改多个，适合「按顺序编号」（Agent 自己排序号一次传）
- **`edit_file` 批量**：`edits=[{file,mode,...},...]` 一次改多个（多文件统一查找替换、或各自不同编辑）
- 三者都**逐项如实回报** `moved/renamed/edited_count + failed`，呼应防幻觉（不许笼统宣布"全部完成"）
- `skills.md` 同步：引导优先用批量入口、移文件夹递归不必枚举；**改掉旧准则**「批量操作每一个都各自调用工具」（它会让模型一个个调、白瞎批量），改为「用批量工具一次处理 + 按后端逐项回报如实汇报」

### 执行准则：工具循环 6 → 10 + 改文件前读最新

- **`MAX_ROUNDS` 6 → 10**：复杂多步任务留余量；批量工具已压低实际轮次，10 不会经常摸到
- **改文件内容前先 `read_file` 拿最新**（`skills.md`）：用户可能在网页/IM 自己改过/传过/删过文件，几轮前的 `read_file` 内容可能已过期——尤其 `replace_all` 整体覆盖前必须先读，别覆盖掉用户的外部改动；文件存在/位置/数量则以每轮注入的实时「文件概览」为准

### 修复（续）

- **`read_file` 读 PDF/Office 报「找不到文件」误导 Agent 劝用户删好文件**：服务器没装 `pdftotext`/`libreoffice` 时，`doctext` 抛的 `[Errno 2] No such file or directory: 'pdftotext'`（指**命令**不存在）被模型误读成「用户文件丢了」，进而建议删除/重传——而文件完好。`doctext._run` 捕获 `FileNotFoundError`，改报「服务器未装「X」命令、用户文件完好、切勿建议删除/重传」

### 轻量 Intent Router + State Manager（Phase 1.7 · 关键词版 · 仅 IM）

- **网关入队前置路由**（`agent/router.py` + `agent/runtime_state.py`）：任务进行中的「还在吗 / 算了 / 嗯」**不进队列、不进主模型**，网关据 Redis 状态机直接回话术。关键洞察：IM 是单 worker 顺序消费队列，忙时看不到队列后续消息，故状态查询/取消必须在**网关层**短路
- **State Manager**：`IDLE/THINKING/SEARCHING/GENERATING` 走 Redis（worker 写、网关读，带 TTL 防卡死）；worker `handle` + core 工具循环据 `TOOL_STATE`（web_search→SEARCHING、create_document→GENERATING）打点
- **自然语言取消**：网关置取消标志 → core 工具循环**每轮协作检查** → 命中即中断（粒度 = 轮与轮之间，单次 LLM 流式调用切不了）；`AgentResponse.cancelled` 透传，worker 不补发（网关已回「先不继续啦」）
- 误判取舍：整条匹配 + 短词才判取消/情绪，宁漏判进主模型、不误判短路（「算了」仅在忙时当取消）。web 路无 imctx，core 的取消/打点恒 no-op，不受影响

### Agent 防幻觉增强（数量诚实 + 被质疑重查）

> 起因：一次批量删文件，MiniMax 谎报"删了 23 个"，被质疑时又编"13 个被系统吞了、不是我的锅"——实际只删了 9 个个人文件、其余在项目空间安然无恙（无数据丢失）。

- **结构 · 概览注入真值**：`load_files_overview` 每轮多注入「各空间文件数 + 回收站数」，模型每轮都看到真值（如「项目 9、个人 1；回收站 9」），数量类问题不靠记忆瞎报
- **提示词 · 数量诚实**（`skills.md`）：报"删了/移了 N 个"，N 只能数本轮实际 success 回执，失败逐条说
- **提示词 · 被质疑铁律**：用户质疑数量/结果（"怎么只有 X 个 / 少了 / 没删掉吧"）时**必须重调 `list_files`/`list_trash` 核实**，用最新数据答；**明令禁止**编"系统吞了/并发/不是我的锅"甩锅，真有出入就如实承认"我刚才报错了"
- **提示词 · 时间别臆测**（`default.md` `{now}` 旁）：`{now}` 本就每轮新鲜组装（`datetime.now()`，每条消息重算），但模型曾在闲聊里凭感觉编时间（明明 14:05 却说"凌晨 4 点多还在啃手册"）。在 `{now}` 旁补一句：涉及「现在几点 / 星期几 / 时段问候」一律以 `{now}` 为准、不得臆测，拿不准就别提时段

### 注册页内测提示 + 自定义勾选框

- 注册表单增加内测免责提示勾选：文案「测试阶段数据随时可能清空，我已知晓并会自行备份」，勾选后方可点击注册按钮（`Register.vue`）
- 自定义勾选框样式：隐藏原生 `<input>`，未勾时半透明白底 + 淡紫边框与输入框同风格，已勾时紫色渐变填充 + 白色对勾 SVG + 淡紫阴影，与注册按钮视觉呼应

### 修复

- **文件夹文件数不随删除下降**：`/folders` 列表端点（及 `_file_count` 辅助）算 `file_count` 时漏了排除回收站文件（`deleted_at`），而 `/folders/all` 是对的。导致 ProjectModal 里删文件后文件夹计数不降、项目总数（根文件 + Σ文件夹数）也跟着不降——看着像"实时刷新失效"，实则重新拉到的数据本身就错。两处补 `File.deleted_at.is_(None)`，与 `/folders/all` 对齐
- **项目卡左上角双层圆角**：`.proj-card` 用 `corner-shape: squircle`，但 `corner-shape` 不随 `border-radius: inherit` 继承 → `::after` 叠加层拿到 squircle 半径 + 默认 round 形状，内高光描的圆角与卡片不重合。`::after` 显式补 `corner-shape: squircle`；顺手扫全项目，文件库 / ProjectModal 的 `.drop-overlay`（宿主是 squircle 的 `.glass-card`）同隐患，补 `corner-shape: inherit`
- **已完成项目卡进度条被挤下移、卡片变高**：「✓ 完成」胶囊 `.done-label` 的 `border` + 纵向 `padding` 比正文多撑约 4px，把 footer 行撑高。改用 `inset` 阴影代替 border、去纵向 padding，胶囊高度 ≤ 正文行高 → 进度条不再下移，与进行中卡同高
- **待办事项悬停显示完整文字**：待办输入框加 `:title="todo.text"`，文字被省略号截断时悬停可见全文（ProjectModal + NewProjectModal）

### 站内全局搜索（顶栏）

- 新 `GET /api/v1/search?q=`：一个关键词跨 **项目 / 文件 / 文件夹 / 日程 / 客户 / 对话** 检索（按 `user_id` 隔离，ILIKE 子串匹配对中文有效、无需全文索引）；文件排除回收站，对话同时搜会话标题与消息正文并给命中片段；各类型分组、各取前 6 条
- 顶栏把原静态占位做成真搜索框：Phosphor 图标（与侧栏导航同款）、250ms 防抖 + 防乱序、分组下拉（白底毛玻璃对齐 `.add-event-popup` / 右键菜单，**Teleport 到 body** 让 backdrop blur 生效并浮于内容之上）
- 点击跳转：项目→开项目弹窗；文件/文件夹→进入文件库对应目录（沿 `parentId` 复原面包屑、文件高亮闪烁，复用客户端文件缓存、后端零改动）；日程→日历；对话→打开咕咕聊天并切到该会话；客户暂提示（页面未做）

### 多模态看图增强（大图压缩 / HEIC / 读库内图）

- **大图自动压缩**：聊天图 >5MB 或超 2048px 时，喂模型前等比降采样 + 逐级降质重压成 JPEG（只压喂模型的副本、原图不动）。修「发高清插画看不出图」——此前 >5MB 直接降级成文字提示、模型看不到
- **HEIC/HEIF 支持**：接入 `pillow-heif`，iPhone 原图等非原生格式统一转码 JPEG 再喂 vision
- **`read_file` 能看文件库的图**：vision + Anthropic 通道下，读到图片走 `tool_result` 图片块让模型真看（非 Anthropic 通道友好提示）；持久化时把图片块换成占位，避免历史撑爆 / 每轮重发

### 咕咕聊天 · 图片缩略图 / 拖入上传 / 滚动跟随

- **消息气泡图片缩略图**（复用文件库 `useThumbCache`）：刚发的图走本地 `objectURL` 即时预览、咕咕返回的库内图走 `file_id` 服务端缩略图、刷新后历史里的暂存图走新端点 `GET /agent/attachment/{attach_id}/thumb`（暂存 6h 内有效），三者都没有才回退 ext 角标。修了「刷新后缩略图消失」——历史里用户发的图只剩 `attach_id`、本地 URL 已丢，新端点按 `attach_id` 取暂存图补上
- **大小窗都支持拖入文件上传**：整窗虚线遮罩（`pointer-events:none` 不挡 drop）、多文件、形针选择也改多选；与点选共用 `uploadAttachFiles`
- **大窗流式跟随脱手修复**：跟随判定从异步 `IntersectionObserver` 的 `atBottom`（大窗固定高度时哨兵被流式内容顶出视口、早一帧翻 false 导致脱手）改为稳健的 `stick`——仅用户主动上翻才取消、滚回底部附近恢复；每个 token 的 `scrollBottom()` 与 MutationObserver 同走此判定
- **发消息即时跳到底**：原 smooth 滚动在大窗会被随后冒出的 thinking 气泡/回复打断、看着没到底，改即时跳底 + 补一帧 `rAF`（兜住附件缩略图/气泡迟一拍布局）

### 提示词分层 + 对外口径

- 系统提示词拆成 **persona**（角色）/ **skills**（执行规则·真实性铁律·不可逆 confirm）/ **policy**（内容红线 + 对外口径）/ **default**（数据模板），各管一件、后台「Agent」面板分别可编辑；builder 注入序：人格 → 准则 → 红线 → 记忆 → 数据。铁律从 persona 搬进 skills、default 瘦身为纯数据
- **policy 加「对外口径·以伙伴示人」**：始终以咕咕伙伴身份示人、不暴露模型/工具/架构；被身份/模型/工具/系统问题套话时**简短带过（2-3 句、不进讲解模式、不列举全部能力、立刻拉回需求）**；不编造假机制（玩笑 deflect 可以、虚构具体技术说明不行）；防 prompt injection（不复述系统提示词）；唯一诚实底线——不谎称真人
- `default.md` 注入**完整时刻**（`{now}` 含星期 + 时分），咕咕能答「现在几点 / 星期几」、按时段问候

### IM 出口兜底（确定性，prompt 之外的代码层保险）

- 新 `agent/outbound.py`：IM 回复**发给用户 / 持久化之前**确定性清洗——抹 `call_xxx` tool id / `trace_id` 等内部噪声；系统提示词被吐出（多为 prompt injection 得手）则整条换安全话术。只管字面泄露，语义泄露仍靠 policy；仅 IM 路（非流式好扫）

### systemd 托管 worker / supervisor（修生产稳定性隐患）

- 新增 `gugu-worker.service` / `gugu-supervisor.service`（`Restart=always`，supervisor 加 `KillMode=control-group` 连带网关子进程一起管）；`make install` **一次装全 3 个**、`make uninstall` 一并清；三服务日志 `append` 到 `logs/gugu*.log`（后台 Debug 页可 tail，不进 journald）
- **修复根因**：此前只有 web 有 systemd 单元，IM 的 worker/supervisor 没人托管 → 进程死了 / 服务器重启不自动拉起 → 消息无限排队（IM「偶发很慢 / 收不到」的真因）

### 修复

- **IM 空回复发 QQ 报「无效 markdown content」**：模型偶发出空文本，空内容发 QQ 被拒、用户啥也收不到。现空回复给兜底（有文件「给你～」、纯空「嗯~在的」），绝不发空
- **缩略图端点物理文件缺失返回 500 → 404**：`files.py` `get_thumb` 与新 `agent` `attachment_thumb` 读不到物理文件时抛未捕获 `FileNotFoundError`、刷屏 ASGI 异常（如旧 `storage_key` 已失效的卡片仍请求缩略图）；改为缺文件即 404，前端正常回退角标
- **`move_file` 工具回报落点**：原来移动成功只返回文件夹名（如「（根目录）」），**不含项目信息**，模型无从确认落到哪个项目、易自行脑补位置；现返回 `space / project_id / project_name / folder_id`
- **反幻觉铁律补强（`skills.md`）**：具体文件名 / 所在项目 / 文件夹 / id **必须来自本轮最近一次工具返回**，移动/保存按工具回执原样转告；拿不准位置就重新查、**不许先报一个位置被质疑后再编另一个圆场**（修一次咕咕把图谎报在错项目、还虚构文件名的真因）
- **换头像不实时更新（需刷新）**：头像 URL 路径固定（`/api/v1/auth/avatar/{id}`），换图后字符串不变 → Vue `:src` 不刷新、浏览器命中旧缓存（导航栏 + 个人设置都卡）。现 `UserResponse.from_user` 给 URL 挂上以头像文件 `mtime` 为版本号的 `?v=`，换图即变 URL、迫使重渲染 + 重取，无需刷新；版本绑内容、所有查看处一致
- **Admin 工具调用分布接口 500（`cannot extract elements from a scalar`）**：`admin_analytics.py` `/tool-distribution` 用 `jsonb_array_elements_text(tools_used)` 展开工具数组，但 `agent_usage.tools_used` 部分行存的是 **JSON 标量值**（多为 JSON `null`，`tools_used IS NOT NULL` 拦不住它，因为那是 SQL NOT NULL 而非 JSON null）→ 展开标量抛 `asyncpg.InvalidParameterValueError`。WHERE 追加 `AND jsonb_typeof(tools_used::jsonb) = 'array'`，只展开真正的数组行
- **顶栏下方白色伪影带（Chrome/macOS）**：顶栏绝对定位 + `backdrop-filter`，其 backdrop 取自下方 `.page-content`；页面内容（日历日期格、总览项目卡等）hover 改背景触发重绘时，Chrome/macOS 下顶栏的 backdrop-filter 栅格失效、在其下沿渲染出一条白带（Safari 无此问题，与具体页面无关）。给 `.topbar` 加 `transform: translateZ(0)` 提升为独立 GPU 合成层、稳定 backdrop-filter 栅格
- **项目卡文件计数漏算文件夹内的文件**：项目列表后端查询仅按 `files.project_id` 聚合，但文件夹内文件在某些上传路径下只有 `folder_id` 而无 `project_id`，导致计数偏低。后端改用关联子查询同时统计直属项目的文件与通过项目文件夹关联的文件（`OR folder_id IN (SELECT id FROM folders WHERE project_id = project.id)`，`OR` 避免重复计数）；前端 `liveFileCounts` 同步用 `allFolders` 建立 `folderId → projectId` 映射兜底，保证 live count 与后端计数口径一致

---

## [0.11.1] - 2026-06-24 · IM 全接入、文件收发、Agent 执行策略

> 本版把 IM 接入做全（飞书 + QQ，BYO 扫码自连），打通文件双向收发与 PDF/Office 读取，
> 并重构 Agent 提示词分层、引入执行策略。下面按主题归并（开发期约 25 个迭代小节）。

### IM 接入（飞书 + QQ · BYO 扫码自连）

- **飞书 + QQ 统一 BYO**：每用户自带 bot，「接入咕咕」扫码自动连接——飞书走 OAuth 设备授权（RFC 8628）、QQ 走 q.qq.com bind_task（均复刻 QwenPaw，实测无需合作方资质），凭据 AES 解密自动写入 `user_bots`。收凭据从 env 注入、发凭据按 bot id 查库，bot 即归属、无需用户绑定。`supervisor` 统一从 `user_bots` 拉起网关
- **清理旧共享 bot**：删 `PlatformBinding` / `feishu_bind` / `feishu_event` / Admin「频道」面板，IM 接入全改用户自助（旧共享飞书 bot 需重新扫码）
- **飞书 Webhook 模式**（长连接替代，有公网时少跑一个进程）：`POST /feishu/event/{channel_id}` 复用 lark handler 解密验签，派发到与长连接同一回调
- **IM 上下文修复**：`run_collect` 原来不读历史 → 每条孤立处理（聊着变新会话）。现与网页同口径读历史窗口 + 按 `(平台,用户)` 在 Redis 存稳定 session_id（滑动 TTL 12h）
- **飞书 markdown**：回复改交互卡片渲染粗体/列表/代码，GFM 表格 → 飞书原生 table 组件
- **IM 新会话 AI 标题**（此前只 web 有，IM 永远首句截断）；标题生成移出关键路径改后台
- **飞书秒回表情**：网关收到即用关键词本地判一个 emoji 即时点上（赶在 LLM 之前），默认 OnIt 而非 👍

### 文件收发 + PDF/Office 读取

- **用户 → 咕咕发文件**（网页上传 / 飞书 / QQ）：暂存（`chat_attach`：字节走 storage、元数据走 Redis TTL 6h）→ 咕咕看内容 + `save_uploaded_file` 存库；QQ 收文件瞬发「文件收到啦」
- **咕咕 → 用户发文件**（网页卡片 / 飞书 / QQ）：`send_file` 工具 → `worker._send_files` 按平台发。飞书图 10MB/文 30MB（超限兜底）；QQ 富媒体（本地 base64 ≤10MB、配 OSS 自动走签名 URL 无限制），msg_seq 用 Redis 按 msg_id 跨进程发号
- **`read_file` 读 PDF/Word/Excel/PPT**（新 `app/core/doctext.py`：pdftotext + LibreOffice 提取，无新依赖），文件库与聊天附件共用
- ⚠️ QQ 表情回应做不了（reaction 只对频道 guild）；图片看内容需 vision；扫描件 PDF 无文字层需 OCR

### Agent 执行策略与工具

- **提示词分层**：拆成 persona（角色）/ skills（执行规则·铁律）/ policy（内容红线）/ default（数据模板），各司其职、后台可分别编辑（builder 注入序：人格 → 准则 → 红线 → 记忆 → 数据）
- **执行策略 skills.md**：任务分级（聊天 0 / 查询 1-2 / 做完即停 / 先规划后执行）、成本意识（别重复验证与查询）、真实性铁律、不可逆 confirm 两步流程
- **`MAX_ROUNDS` → 6**（早期 5→16，现配合强工具 + 准则，多步任务 2~3 轮够用，逼出低成本执行）
- **项目工具增强**：`create_project` 带 `stages`（一次建阶段 + 待办）、`set_stages`（声明式整体替换、保留同名阶段待办）、`update_todo`（改文本/完成态 + 移到别的阶段）
- **咕咕能读历史对话**（新 `conversations` skill：search / read，严格多用户隔离）
- **健壮性**：工具异常不冲垮对话（`dispatch` try/except 把错当结果返给 LLM）；错误文案友好分类（网络/超时/精力）

### 实时与流式

- **实时刷新（Redis pub/sub → SSE）**：咕咕改数据 / IM 来消息 → 网页自动刷新。挂点 `registry.dispatch`，粗粒度刷视图 + 消息级追加气泡；按用户隔离频道
- **网页生成解耦**（新 `genstream`）：生成脱离 HTTP 请求、跑后台任务 → 刷新不丢回复、还能续看
- **OpenAI 路真流式**（DeepSeek 等）：`stream=True` 逐 token，原来是非流式假切片
- **IM 多轮修复**：MiniMax 重述开场白 → `_collect` 按轮去重；IM 对话在网页分两次推（先用户消息、再回答），不再一轮结束整体蹦出
- 修复：实时回复空气泡、`agent_usage.tools_used` 缺列、文件库不实时刷新、`create_document` 缺 name 死循环

### 界面 / 性能

- **PDF 预览换回 iframe 原生引擎**（PDFium，大文件 / 多页流畅；之前 pdfjs 自渲染性能一般且白屏/漂移）
- 文件卡片气泡化、隐藏导航悬停 URL、回收站多选 / 框选、一批界面细节（placeholder 统一、侧栏 IM/网页分组、看板与总览样式）
- **精力恢复改固定 6h 重置**（UTC 整点 00/06/12/18 切桶、到点整段清零）

### 文档 / 运维

- 新增 `并发与性能优化.md`（诊断 + 分档方案）、Admin Debug 实时日志页、咕咕风格 404 页、systemd 按安装目录自动生成、deploy.md nginx 补充
- 迁移：`20260623000001`（messages.files）/ `20260623000002`（sessions.source）/ `20260623000003`（agent_usage.tools_used）——**部署须 `make migrate`**

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