# 更新日志 · Changelog

本项目所有显著的更新都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 安全

- **IM Bot 凭据补上静态加密**（`app/core/crypto.py` 新增 + `app/models/__init__.py` + 迁移 `20260702000002`）：整理隐私政策时核实发现文档写"AES-256-GCM 加密后存储"，但 `UserBot.app_secret`（飞书/QQ/微信机器人的真正密钥）实际是明文落库——数据库一旦泄露凭据可直接冒用；此前的 AES-256-GCM 只用在 QQ 绑定流程密钥"传输途中"的一次性加解密，不覆盖静态存储。新增 `EncryptedString`（SQLAlchemy `TypeDecorator`，密钥由 `secret_key` 通过 HKDF 派生）让 `app_secret` 读写对业务代码透明加解密；`app_id` 保持明文（它是公开标识符而非密钥本身，且被 QQ/飞书绑定流程用于等值查询去重，加密会打断该匹配）。迁移把列宽松为 `TEXT` 并原地加密历史明文行，已在 devserver 实测：4 条历史行全部转为密文、新写入自动加密、供职中的飞书/QQ/微信网关重启后正常解密重连并处理真实消息。同步订正 `docs/security/privacy.md` 与用户可见的 `frontend/src/views/Privacy.vue`（隐私政策 1.0→1.1），把此前"文档承诺加密、代码实际明文"的合规缺口改成"代码和文档一致"。
- **IM 收发日志脱敏——只留长度+指纹，不打印聊天原文**（新增 `agent/logsafe.py` + `agent/adapters/{qq,feishu,wechat}.py` + `worker.py`）：`qq.py`/`feishu.py`/`wechat.py` 收到消息此前打印前 40 字符，`worker.py` 打印回复全文（不截断，比收到那侧还暴露）；新增的后台 Debug 面板让这些日志变得可搜索、好查阅，把这个老问题放大暴露——聊天内容敏感度高于工具参数（可能涉及健康/感情/工作机密），且与项目已有脱敏红线（决策轨迹脱敏、`agent.traj` 参数脱敏、工具错误信息脱敏）不一致。新增 `logsafe.fingerprint()`：md5 前 8 位，不可逆，只能判断"是不是同一条内容"，看不出内容本身。5 处打印改为长度+指纹：qq/feishu/wechat 收到消息、worker 回复、worker 无发送通道兜底分支，覆盖"收到没/空不空/是否被重复处理"等日常排查，不落原文。分级脱敏的下一层（管理员显式开、带时限的临时明文窗口，审计留痕）按讨论结果暂不实现。

### 改进

- **通知气泡改回只能手动关闭**（`components/common/NotificationBubble.vue`）：0.15.2 把气泡改成打完字 5s 后自动消失（被新气泡顶替则 0.5s），实际用起来经常没看完就没了。撤回自动消失，气泡打完字后停在原地，只能点右上角 ✕ 关；新气泡到来时旧气泡照常堆叠，不再被顶掉。「只弹一次」的语义不受影响——那是 `uiStore._markBubbleSeen` 在气泡创建时独立标记的，跟怎么关闭无关。删掉不再需要的计时器相关代码（`timers`/`scheduleDismiss`/`rescheduleDismiss`/`superseded`）。

### 新增

- **支持拖文件夹上传（保留目录结构）+ 统一三处上传逻辑**（新增 `composables/useFileUpload.ts` + `views/Files/{index.vue,UploadModal.vue}` + `views/Projects/components/ProjectModal.vue`）：上传文件/文件库/项目编辑卡此前拖放全部只读 `event.dataTransfer.files`（扁平 `FileList`），拖文件夹进来会被浏览器当空文件静默失败，且三处各自维护一套上传实现（并发策略互不一致：无限并发/`pLimit` 限流/严格串行）。`readDroppedEntries()` 用 `dataTransfer.items` + `webkitGetAsEntry()` 递归展开拖入的文件夹（处理 `readEntries()` 分批返回），产出 `{file, relativePath}[]`；不支持该 API 的老浏览器退回扁平文件列表，不报错。`resolveFolderTree()` 按相对路径批量建缺失的子文件夹，一次 `foldersApi.all()` 建索引，同名文件夹自动复用不重复创建；`onFolderCreated` 回调让宿主实时同步本地缓存/列表。`uploadFilesWithFolders()` 编排解析+并发调度，具体怎么上传一个文件由宿主的 `uploadOne` 回调决定，不假设本地代理 POST 还是 OSS 直传——`UploadModal.vue`（presign/OSS 双模式）保留原有严格串行+单一进度条 UX，`Files/index.vue`/`ProjectModal.vue` 换成走共享 composable（前者原本无并发上限的上传顺带统一成跟后者一样的 `UPLOAD_CONCURRENCY=3` 限流）。`useUploadQueue.ts` 新增 `createFolderGhost`/`bumpFolderGhost`：拖入的文件夹按顶层目录名分组，汇总成一张"文件夹名 · 完成数/总数"幽灵卡，不再给文件夹里每个文件各出一张卡刷屏。新建的顶层文件夹先攒着不立刻插进可见列表——插了会跟它的进度卡同时出现、看起来像"两个文件夹"；等这组文件全部处理完（不管成功失败）才无缝换成真实文件夹卡片，更深层的子文件夹本来就不在当前视图里，直接插不受影响。

### 修复

- **文件拖拽两处静默失效：`data-folder-key` 混用带前缀字符串导致 `NaN`、面包屑落点判定读到被提前清空的状态**（`composables/useFileDragDrop.ts`、`views/Files/index.vue`）：两个独立 bug，都是拖到文件夹卡片/面包屑上"看起来有反应、实际没移动"，靠浏览器控制台实时打印 `elementFromPoint` 命中元素/属性值才抓出来，光看代码逻辑挑不出错。① 文件夹对象有两个不同语义的 id——`f.id` 是带命名空间前缀的字符串（如 `"f:65"`，给框选/选中态用，跟 DOM `data-folder-key` 属性对齐）、`f.folderId` 才是数据库里的真实数字 id。落点判定代码从 `data-folder-key` 读到 id 后 `Number(...)` 转数字，`Number("f:65")` 是 `NaN`——不管拖到哪个文件夹卡片，发给后端的 `folder_id` 实际都是 `null`；这个错配从最早把文件卡改成 pointer 模式那次就已存在（原生拖拽时代 `@drop="onFolderDrop(f, $event)"` 靠闭包直接拿到 `f` 对象，从不需要从 DOM 属性反查 id，转 pointer 模式后才需要从 `elementFromPoint` 命中的元素反查，没人注意到两个属性该分开）。修复：文件夹卡片/行新增只放真实数字 id 的 `data-folder-id` 属性，跟承担框选职责的 `data-folder-key`（继续放 `f.id`）分开，拖拽逻辑改读前者。② `dispatchDrop` 落地时会立刻清空 `draggingFileIds`/`draggingFolderIds`（让卡片马上退出"拖拽中"视觉态，不等异步移动完成），但判断"面包屑目标接不接受当前拖的东西"的 `_acceptable()` 却在清空之后才被 `dispatchDrop` 自己的面包屑分支、以及 `usePhysicsDrag` 稍后调用的 `resolveAbsorbTarget` 调用，两处读到的永远是空集合——悬浮高亮完全正常（高亮检测发生在清空之前），松手却"没反应"。修复：留一份不随之清空的快照（`_dragSnapshot`）专给这两处收尾逻辑用，不再直接读会被提前清空的活引用。
- **项目编辑卡文件拖拽统一为 pointer 模式，抽取共享 composable**（新增 `composables/useFileDragDrop.ts`；`views/Files/index.vue`、`views/Projects/components/ProjectModal.vue`）：项目编辑卡的文件面板此前仍是原生 HTML5 `draggable`/`dragstart`，跟文件库文件卡改造前一样有归位悬停跳变的风险；而文件库那次改造把"抓取判断单选/多选 → 起物理拖拽 → 拖拽中找落点高亮 → 松手判定目标并派发移动"这套编排写成了内联实现，若项目编辑卡照抄一遍就会有两份逐渐分叉的拖拽逻辑。抽成共享 composable `useFileDragDrop`，文件库从内联实现改为消费它，项目编辑卡首次从原生拖拽转为 pointer 模式、接入同一份编排。两边差异点做成配置项：卡片 data 属性名、文件夹选择器（网格卡/列表行两边 class 不同名）、面包屑每个位置是否可放置及接收文件/文件夹的规则（文件库根节点不可放置、其余段接收文件和文件夹；项目编辑卡根节点可放置但所有段只接收文件——沿用原生版本就有的行为差异，非新增限制）、落地后的 API 调用策略（文件库走乐观缓存+回滚，项目编辑卡走移动后整体重新拉取，且按落点是文件夹卡片还是面包屑分两种刷新粒度）。项目编辑卡原生版本里"列表行退化成朴素 `dataTransfer` 拖影、只有网格卡有物理动画"的特殊处理本次一并收敛，网格卡和列表行现在统一走同一套物理动画。
- **文件卡拖拽改用 pointer 模式，根治归位悬停跳变**（`composables/usePhysicsDrag.ts`、`views/Files/index.vue`）：perf trace 定位根因——文件卡走原生 HTML5 `draggable`/`dragstart`，浏览器从 `dragstart` 起整段暂停 `mouseover`/`mouseout` 派发，抓起卡片那一刻缓存的 `:hover=true` 全程不会被清掉，直到 `dragend` 后才重新判定，这段时间差导致"归位"揭示卡片时经常出现 hover 高亮跳变（`.fc-card:hover` 的 `translateY(-2px)`）。项目看板的拖拽本来就是 pointer 模式（`setPointerCapture` 自建拖拽），完全不触发这个问题，这次照抄同一套思路根治，不再在"揭示时机"上继续打补丁（之前几轮分别试过：合成 mousemove、`elementFromPoint` 单点判定、实时位置轮询、无条件短暂摘掉命中测试，均只是缓解、没有根除）。`usePhysicsDrag.ts` 新增 `onDragOver` 回调（pointer 模式每帧回调指针位置，供调用方自己判定/高亮落点）、`startMultiPhysicsDrag` 补齐完整 pointer 模式支持（原来只有原生拖拽一条路）、新增 `resolveAbsorbTarget` 选项（让调用方决定"吸入文件夹/面包屑"缩小消失动画的有效目标，不再是组件内部硬编码 `.folder-card,.bc-item` 类名匹配）。`Files/index.vue` 文件卡/文件夹卡（网格+列表视图）全部换成 `pointerdown` + 5px 阈值起拖，放置目标判定改成手动 `elementFromPoint`（`data-folder-key`/`data-bc-idx` 定位），移动逻辑复用原有的 `draggingFileIds`/`draggingFolderIds` 响应式状态（本来就不依赖 `dataTransfer`）。顺带修了一个衍生 bug：拖到"全部文件"根节点或拖到自己身上时，原来内部吸入判定跟数据层判定不一致，会出现"文件没真的移动、动画却演了吸入消失"的画面。OS 拖文件上传走独立的页面级原生监听，未受影响；列表视图拖拽顺带补齐了物理动画（原来只有网格视图有）。
- **快速重新抓拖拽落地中的卡片会抓到隐形克隆**（`composables/usePhysicsDrag.ts`）：从 Chrome trace 精确定位——一次拖拽 `pointerup` 到下次 `pointerdown` 只隔 310ms，而落地动画要等 `transitionend`（420~580ms）才把源卡 `display`/`opacity` 复位；`_active` 锁在 `pointerup` 时就立刻清空，挡不住这个窗口（落地动画是后台独立跑的）。这段窗口期内重新抓同一张卡：`getBoundingClientRect` 量到还没复位的 `display:none`，直接读出 0×0，新克隆体宽高在创建那一刻就定死为 0——物理引擎照常运行，但克隆不可见，表现为"卡片凭空消失，其实手上抓着隐形克隆"。`startPhysicsDrag`/`startMultiPhysicsDrag`（含多选 `extras`）入口、量尺寸之前强制复位源卡 `display`/`opacity`，不管它此刻处于上一次拖拽的什么中间态。顺带定版了拖拽克隆的白底/毛玻璃比例：文件/文件夹/项目卡容器自己 `background: rgba(255,255,255,0.5)` + `backdrop-filter: blur(12px)`，单层实现（中途试过的本体不透明+外圈模糊光晕方案在拖拽自带的 3D 后仰变换下会渲染成硬边白框，已放弃，详见 `docs/product/design.md`）；多选拖拽的主克隆/影子叠层不再叠加额外 `opacity`（曾经跟卡片自身透明度相乘严重稀释白底），层次感改靠位置偏移/旋转/缩放/`zIndex`/`box-shadow` 表达；`backdrop-filter` 按层限制（主克隆 12px、第一张影子 6px、更靠后的不做模糊）控制多选拖拽的 GPU 开销。

## [0.15.2] - 2026-07-02 · 商用就绪安全加固（多用户隔离/删除确认门/全链路可观测/隐私合规）+ 窗口系统 + 后台运维面板

> 对照一份外部商用就绪评审逐条核实（[docs/security/商用就绪评审-核实版.md](docs/security/商用就绪评审-核实版.md)）后，把放量前四项必须项（P0-2 多用户隔离、P0-3 删除确认门、P0-4 可观测、P0-5 隐私合规）主体落地，并搭起后端首套自动化测试基础设施（此前是 0）；成本防护（原 P0-1）经产品阶段判断降级为 P2、量起来再做。另有窗口层级系统重构、附件回查、图片搜索、微信语音、后台数据面板拆页等功能更新。

### 新增

- **聊天附件可回查重发 + `list_files` 结果格式化指引**（`backend/agent/tools/files.py`、`agent/skills/file-ops.md`）：修复「把刚刚的图/QQ那张发我一下」这类模糊指代找不到原图的问题——根因不是暂存过期（附件暂存 7 天），而是 `attach_id` 只在收到那一轮的上下文里可见（`resolve_for_message` 把它写进当轮增广文本），存进数据库的历史消息用的是原始 `req.message`、不含 attach_id，且暂存区已有的 `list_staged()` 查询函数从未被注册成 agent 工具——一旦翻篇，模型对「刚才那张图」就彻底失忆。新增 `list_recent_attachments` 工具查该用户暂存区未过期附件（含 `platform`/大致存了多久）；`send_file` 新增 `attach_id` 来源，直接重发暂存附件（不重新下载、不进文件库），复用 `resolve_attach` 现有的容错模糊匹配 + 同渠道收窄逻辑。另外 `list_files` 的工具 description 与 `file-ops.md` 补格式指引：结果按列表呈现（多文件夹/项目分组），别写成一段话堆文件名。
- **后台数据面板拆两页 + 新指标 + 开发者标记**（`api/v1/admin_analytics.py` + `users_admin.py` + `Admin/Analytics/{index.vue,Usage.vue,_shared.ts}` + `Users` + 路由/侧边栏 + 迁移 `20260702000001`）：原「数据分析」单页 7 段太挤，按「生意好不好 / 用户怎么用」拆成 **数据总览**（新增**日活跃用户曲线**〔agent_usage ∪ frontend_events 按日去重〕+ 旅程/行为漏斗 + 新增**项目留存数值**〔创建过项目 / 创建过第 2 个项目 / 注册满一周仍有进行中项目〕+ 用户·项目卡）与 **使用分析**（新增**新建项目曲线**、**会话深度分布**〔每用户最深会话按 1/2–3/4–10/11–30/30+ 轮分档〕、**周活跃维度**〔聊天/项目/日历/文件/提醒，「操作过」口径、纯浏览未埋点不含〕+ 原趋势/工具/模型分布挪入）。**开发者标记**：`users.is_developer` 列 + 用户管理页 DEV 打标按钮/徽章 + 两个数据页「排除开发者」全局开关（localStorage 持久，所有端点支持 `exclude_dev`）——一键看真实用户数据。新端点 `session-depth`/`active-dimensions`；新前端代码全 TS（总览页顺带转 `lang="ts"`）。
- **图片搜索 `image_search` + `send_file` 支持网络图片**（`backend/agent/tools/search.py`、`tools/files.py`）：新增 `image_search` 工具，走自建 SearXNG `categories=images`（免配额），返回候选（标题+来源页+图片直链+缩略图）；`send_file` 加可选 `url` 参数，传入图片直链会下载（SSRF 防护：仅 http/https、挡内网/回环/云元数据地址）后暂存为聊天附件发出，网页端复用既有的 `attach_id` 图片卡片渲染、IM 端（飞书/QQ）由 `worker.py` 新增的 `attach_id` 分支发送——搜到图后可在同一轮直接发给用户，网页和 IM 都能收到。新增独立技能文档 `agent/skills/web-search.md`（联网搜索路由/成本/发图规则，`prompts/skills.md` 精简为一行指针）。管理后台「联网搜索」新增「图片搜索引擎」配置项 + 连通测试（`Admin/Agent/index.vue`，本次顺带转 `lang="ts"`）。
- **微信支持语音消息**（`backend/agent/adapters/wechat.py`）：iLink 语音消息（`item.type==3`）自带 ASR 转写在 `voice_item.text`，不同于图片走 CDN+AES-128-ECB 那套下载解密，直接读转写文字注入对话即可；转写文本包一层「🎤 用户发来一条语音（已转文字）…」提示，语气对齐 QQ/飞书语音处理，转写为空（ASR 失败）给兜底提示、不静默丢消息。字段结构来自开源参考 [hao-ji-xing/openclaw-weixin](https://github.com/hao-ji-xing/openclaw-weixin)，已用真实语音验证跑通。文本/图片/语音三平台（飞书/QQ/微信）至此全部打通。
- **窗口系统：点谁谁到最上层（工作环境式多窗口）**（新 `composables/windowz.ts` + `BaseModal.vue` + 16 个组件接入）：原来 BaseModal(200)/通知气泡(9999)/GuguChat(10000)/预览窗(11000) 四套 z 各自为政、谁盖谁看出生数字。统一为四带：遮罩带 19000 固定 / **窗口带 20000+ 递增（mousedown 置顶）** / 咕咕悬浮球 99999 / 压顶带 100000（通知·拖拽克隆·tooltip）。① **项目编辑卡、图片/视频预览窗、咕咕聊天窗、PDF 预览自由叠放，点谁谁上**；② **BaseModal 遮罩与卡片拆成平级节点**——遮罩固定在一切窗口之下，背景模糊只糊页面、**物理上糊不到预览器等任何窗口**（居中容器 `pointer-events:none`，下层窗口照点）；③ **ESC 只关最顶层**（统一注册制，聊天窗防误关不注册）；④ 右键菜单/日期选择器/文件信息/全局搜索/反馈弹窗每次弹出领新 z，永远盖当前最顶窗口；⑤ 音乐播放器保持与聊天窗 ±1 相对层级。
- **多用户隔离下沉查询层 + 后端首套自动化测试（商用就绪 P0-2）**（`app/core/ownership.py` + `tests/` + 9 个 REST 路由文件）：此前隔离靠每处手写「`db.get` + `if user_id !=`」，属约定而非机制。新增 `get_owned()` 取行+归属校验一体（「不存在」与「不是你的」对外同为 None 防资源枚举；对内打 `ownership.denied` 结构化告警=越权探测信号源），工具层 + REST 层 46 处裸查询全部收敛；配套 pytest + 内存 SQLite 测试基建（<2s 全程）与 7 领域越权用例 + 静态守卫防新增裸查询。
- **删除确认门框架级强制（P0-3）**（`scripts/check_confirm_gate.py` + dispatch 绊线 + 9 测试）：`Tool.destructive` 此前只是文档性标记、确认门靠 handler 作者自觉。补两层机制：AST 静态守卫校验所有 destructive 工具源码必须引用 `needs_confirmation`（漏接提交前即被抓）+ dispatch 运行时绊线兜底。
- **全链路 trace_id + 工具失败率/延迟运维指标（P0-4）**（`agent/trace.py` + `app/core/opsmetrics.py` + `api/v1/ops_admin.py`）：一条消息跨网关/worker 两进程此前日志无共同标识、只能时间戳对账。ContextVar 全链路 trace（IM 网关生成 12 位 hex → 随 payload 入队 → worker 恢复 → 工具轨迹/回复日志同 id）；新增工具失败率/延迟运维指标闭环（此前只有产品口径指标）。
- **账户注销全量清数据 + IM 侧记忆命令 + 三平台 ToS 合规记录（P0-5）**（`app/services/storage/__init__.py` + `api/v1/users_admin.py` + `worker.py` + `agent-im接入架构.md` §3.4）：隐私政策承诺「注销后从数据库和存储中永久删除」，但 `delete_user` 此前只做 DB 级联——AI 记忆（`.agent/`）、上传文件、语音都在存储层，级联碰不到（文档承诺与代码不一致的合规缺口）。新增 `StorageBackend.delete_prefix()`（Local=rmtree 带越界防呆、OSS=批量删），注销按序清：缩略图缓存 → 整个 `{user_id}/` 存储前缀 → Redis 用户数据（聊天暂存元数据+IM 可达地址）→ DB 级联，审计日志记清除对象数；5 个契约测试（清净/不误伤他人/防呆拒空根越界）。`/memory` `/forget` 接入 IM 侧（worker 短路，与 web 同语义：零 LLM、不计精力、不反思），飞书/QQ/微信用户同享隐私控制权。IM 架构文档补三平台条款合规/封号风险评估表（BYO 模型无「官方号被封全体中断」单点；微信🟡中风险建议默认不开启）。
- **后台运维监控页 + 安全事件计数 + Debug 全链路搜索 + 注销清除反馈**（`views/Admin/Ops/index.vue` + `app/core/opsmetrics.py` + `views/Admin/Debug/index.vue` + `views/Admin/Users/index.vue`）：把 P0-4/P0-5 攒下的「有数据没界面」接进后台。① **运维监控**新页（侧边栏系统组）：安全事件横幅（越权拦截 / 确认门绕过两项计数，正常恒 0、非零红色告警）+ 概览卡（调用量/失败率/P99）+ 延迟分布条形图 + 每工具失败率/耗时明细表，今天/7天/14天切换；`opsmetrics` 加 `record_security()` 旁路计数接上 `get_owned` 与 dispatch 绊线两处埋点。② **Debug 日志加关键词搜索框**——贴 `trace=xxxx` 即过滤出一条消息跨网关/worker 的全链路。③ **删除用户后绿色横幅**显示清除的存储对象数，当场确认隐私政策「注销后从存储永久删除」真执行。④ 顺手修了个测试隔离漏洞：越权/确认门测试用例会触发计数旁路、在实时 loop 下污染生产 Redis，加 `pytest in sys.modules` 守卫禁写。前端全 TS。

### 改进

- **毛玻璃三档统一收变量 + 拖拽克隆体毛玻璃**（`variables.css` + `global.css` + 12 个组件）：全站 blur 值此前 4/12/16/20/24/28px 散写。统一为三档、全走变量（改一处全站生效，见 `docs/product/design.md`）：**大面板 `--glass-blur`(20px)**——聊天窗/播放器/BaseModal 卡片/Profile/通知气泡/编辑卡右栏 7 处 28px 归档；**小弹窗 `--popup-blur`(12px)**——右键/排序菜单、日期选择器、活动添加/编辑弹窗、文件信息、通知中心、全局搜索下拉等 10 处 20/24px 归档；**拖拽克隆 `.phys-drag-clone`**（global.css 唯一定义）——新增毛玻璃（白 42% 底 + blur 12px），删掉 multi 拖拽内联硬编码实心白底，文件库/编辑卡/看板拖拽克隆全站一致，z 顺带挪压顶带（窗口系统后 9999 会被窗口盖住）。
- **后台刷新按钮全局统一 + 用户管理操作按钮横排**（`AdminApp.vue` + 12 个 Admin 页面）：① 所有页面的刷新按钮统一为邀请码页样式（34×34 方形图标钮 + PhArrowClockwise + 点击转一圈），样式抽成 **Admin 全局共用**（`AdminApp.vue` 非 scoped style，只进 admin 打包、不影响前台同名 `.icon-btn`），各页删除本地重复定义；服务状态页的纯文字「刷新」、反馈/数据页的「图标+文字」款一并收编；顺手隔离通知页「发送中持续转圈」与新样式的 `.spinning` 类名冲突（改 `spinning-inf`）。② 用户管理操作列 120→178px + 禁折行，修复加 DEV 按钮后「DEV/封禁/删除」被挤成竖排。

### 修复

- **浮动预览窗打开低分辨率图片先猜大窗口再骤缩**（`components/common/FloatPreviewWindow.vue`）：缩略图长边未顶到 `CARD_THUMB_CAP` 时按缩略图真实尺寸定窗口，准；顶到上限时原图真实尺寸未知（可能是低分辨率图，也可能是被压缩过的大图，两者无法区分），此前套 4K 估算兜底——遇到实际是低分辨率图的情况会把窗口猜得远大于真实尺寸，真图加载完再缩回去，观感是「先变超大再骤缩」。改为不猜：顶到上限时窗口暂不出现，等真图加载完直接按正确尺寸定窗（同「快速下载」路径），不做中间的错误估算。
- **多附件误存**（`backend/app/core/chat_attach.py`、`agent/tools/files.py`）：QQ 连发 4 张图后跟一句「存到XX项目」，实际只存了 1 个不相关的语音文件。真因是 `resolve_attach()` 的兜底逻辑"没对上 attach_id 就用最近暂存的一个"，取的是该用户全局暂存池里最后写入的一条，不分类型也不分渠道——图片+语音混存、或多个渠道（飞书/QQ/微信/网页）共用同一暂存池时会误取无关附件。修复：`stage`/`stage_sync` 新增 `platform` 字段打渠道标签；`resolve_attach` 兜底前先按当前渠道（`imctx`）收窄候选，再判断类型是否一致，只有无歧义（单候选或类型全一致）才自动兜底，否则返回歧义候选列表而非静默瞎猜；`save_uploaded_file` 新增 `attach_ids` 批量参数（同 `_rename_file` 的 `renames` 模式），一次调用存多个、不再逐个调用各自回退。
- **项目编辑卡图片文件多选，文件名标签区未被选中暗色覆盖**（`views/Projects/components/ProjectModal.vue`）：`.fc-card.selected` 的选中覆盖层错误地写成 `:not(.fc-has-thumb)::before`（只对无缩略图的卡生效），导致有缩略图的图片卡选中时只有缩略图变暗、下方文件名区域没跟着变。对齐文件库正确实现，去掉多余的 `:not()` 限定。
- **通知气泡改为一次显示、自动消失，无需手动点关闭**（`components/common/NotificationBubble.vue`）：此前只有教程气泡打完字 5s 后自动消失，其它通知（IM/广播）会一直停留、需手动点 ✕。现在所有气泡一视同仁，打完字 5s 后自动消失；气泡本身已有「只弹一次」机制，不受影响。
- **输入框中文候选词回车被误当提交**：中文输入法下敲回车确认候选词，浏览器也会派发一次 keydown Enter，各输入框此前各自手写「回车=提交/确认」的判断、没排除 IME 组合态，候选词还没选完就被误触发提交。新增全局自定义指令 `v-enter`（`directives/enter.ts`，`main.ts`/`admin.ts` 两个应用入口注册），判据用标准 `event.isComposing`；全仓 20 处回车确认输入框统一迁移，GuguChat.vue 原本手写正确的聊天输入框也一并收敛，删掉不再需要的 `isComposing` 状态。
- **网关秒崩无限重启刷日志**（`backend/agent/adapters/supervisor.py`）：`reconcile()` 发现子进程退出就立即重启、完全没有退避——凭据错误等必现问题会导致进程几乎瞬间崩溃，变成每 5s 重启一次的死循环。加指数退避：存活不到 5s 判定「秒崩」，退避 10s→20s→40s…封顶 5 分钟；正常跑了一阵子才挂的（更像网络抖动）不退避、立即重启。退避期间只是暂不重启、不是放弃——凭据修好后最多 5 分钟内自动捡回。
- **重命名输入框自适应宽度提为全局共用样式，补齐项目模板改名遗漏**（`assets/styles/global.css`、`views/Projects/components/{ProjectModal,NewProjectModal}.vue`、`views/Dashboard/components/FilePanel.vue`、`views/Files/index.vue`）：项目模板改名输入框此前用 `flex:1` 撑满整行，不像文件卡/文件夹/文件库的重命名输入框那样随文字自适应宽度——四处重命名 UI 里唯独这一处没跟上，根因是自适应技术（ghost 隐形测量撑开容器宽度 + 输入框绝对定位铺满）在三个文件里各自本地复制了一份，新增时漏抄。提到 `global.css` 做唯一共享定义（`.rename-sizer`/`.rename-ghost`/`.rename-input-inline`），四个文件删掉本地重复定义、类名统一（原来两处用不带 `-inline` 的旧名 `.rename-input`，一并改名），以后新增重命名输入框不会再漏。

## [0.15.1] - 2026-07-01 · 日历磨砂玻璃白带根治（GlassBg 活玻璃）+ 交互反馈打磨 + 视图切换图标修复

> 收尾 0.15.0 日历周视图后的一批体验修复：顶栏/日历工具栏磨砂玻璃在 hover 时闪「白带」根治（改用不依赖 backdrop-filter 的 `GlassBg` 活玻璃）；快速点击面板「变暗」修复；月/周/全天/日期头的 hover 与选中统一为淡入淡出 + 可叠加、点击不再闪现旧态；文件库/项目卡「网格·列表」切换图标被 flex 挤压变小修复。

### 修复

- **日历磨砂玻璃「白带」根治 + `GlassBg` 活玻璃组件**（`layouts/DefaultLayout.vue`、`views/Calendar/index.vue`、`components/common/GlassBg.vue`）：顶栏与日历工具栏在 hover 可点击内容时下沿闪白带——Chrome `backdrop-filter` 在动态背景上的边缘重栅格伪影，各种合成隔离（translateZ/isolation/page-content 提层）均无法根治。改用不依赖 `backdrop-filter` 的 `<GlassBg>`（页面背景副本做半透明磨砂，跨引擎一致、无白带，为将来自定义壁纸留好接入点）。真凶经 perf trace 定位为 `.cal-chip` 的 `box-shadow: inset 0 0 0 100px` 等**主线程重绘**拖累磨砂层，已把日历各 hover/高光改为合成层友好的 opacity 叠层（`.cal-chip`、月格、周日期头、`.wv-ev` 等）。
- **日历快速点击/切换面板「变暗」修复**：真因是 `.glass-card:hover` 的背景过渡（0.56↔0.70）在快速交互时 `:hover` 掉帧、`cal-main` 背景朝基态淡回=变暗。中和 `cal-main:hover`（与基态一致、无可闪变化）。
- **日历 hover/选中统一淡入淡出 + 叠加**（月/周/全天/日期头四处一致）：悬停与选中反馈改为 opacity 淡入淡出、可叠加（悬停已选中格 = 相加变深），并给全天区补上悬停高亮、日期头拆成选中/悬停两层。
- **日历点击选中不再「先变淡 / 闪现旧格」**：全天/日期头/月格的 mousedown 不再提前清空选区（只有真拖到别的天才进 range 选择），单击直接切到选中暗色；月视图多选后点单日不再闪现上一个单日格。
- **周视图交互优化 + 右键菜单精简**（`views/Calendar/index.vue`）：单击/拖选小时格改为只做格子选中，不再点一下就弹出添加活动弹窗，同一格二次单击才弹（拖选、切换到别的格不受影响）；顺带修复弹窗一闪而过的问题——`mouseup` 打开弹窗后紧跟的 `click` 事件被 `handleClickOutside`（捕获阶段监听）误判成「点击外部」随即关掉，加 `_wvFormOpening` 标志屏蔽这一次误关。右键菜单按区域精简：全天区/日期表头只保留「新建项目」，小时格只保留「新建活动」（此前两处都同时显示两个选项，实际全天/日期头从不支持建活动）。
- **文件库 / 项目编辑卡「网格·列表」切换图标变小修复**（`views/Files/index.vue`、`views/Projects/components/ProjectModal.vue`）：工具栏拥挤时 `.view-toggle` 被 flex 挤压，带 `viewBox` 的 SVG 图标随之缩成 2~3px（首屏/从别页回来布局最紧时最明显）。给切换组 + 按钮 + 图标加 `flex-shrink: 0`。

## [0.15.0] - 2026-07-01 · 日历周视图 + 咕咕相处方式重构（反思驱动 stance）+ 前端 TS 迁移 + 定时推送进 IM 会话

> 日历新增周视图（时间轴，含全天/日期多日框选 + 右键新建项目/活动）；咕咕相处方式从「爱推进」重构为反思驱动的 stance 行为模块 + 感知误读案例收集器；前端搭起 TS 工具链并迁移 api/stores/composables/utils/Calendar（`src` 已无 `.js`）；定时推送/主动消息现在写进 IM 会话历史（用户回复能接上上下文）+ 加粗小标题渲染兜底。

### 新增

- **日历周视图（时间轴）**（`views/Calendar/index.vue`）：工具栏加「月/周」切换（在「今天」旁），prev/next/今天按当前视图走。周视图为时间轴布局——左侧 0–23 点刻度 + 周一~周日 7 列、24h 可滚动、整点横线、当前时间红线；有时间的活动按 `time/end_time` 摆成色块、重叠自动并排分栏（结束<开始截到 24:00）；全天行显示跨天项目条（进度填充、封顶 10、每天列各自「更多」复用月视图 `showMore` 弹窗与排序）+ 单日项目 + 无时间活动（合并排序、高度自适应）。交互：拖空白建活动（点=1h/竖拖=多h、选中格作为新建起止时间来源）、悬停高亮小时格、活动块拖体**自由移动**（横向改日期 + 纵向平移时间、保持时长）、拖**上下边缘**改起止时间（按按下位置判定缩放/移动、互不冲突）、单击活动开编辑卡、活动 hover 整体均匀亮起、块内显示时间/名称/描述；改动均走 `eventsApi.update`（version 409 提示刷新）。

- **周视图：全天/顶部日期多日框选 + 右键菜单**（`views/Calendar/index.vue`）：全天区与顶部日期格支持横向拖拽多选（复用月视图 rangeSelect/activeRange，单选也高亮）；右键菜单——全天/日期区「新建项目」（带框选日期区间，单选则单天）、小时区「新建活动」（用左键拖出的选区时间段或右键点击处整点起 1h），菜单按区域智能显隐（时段只显活动）。日选择与时段选择互斥（选一个清另一个）。样式打磨：今日数字改方形圆角（同月视图）、选中/悬停统一为内嵌小底色块（相邻不连片）、配色对齐月视图 in-range（含周末暖红）。

### 改进

- **默认问候接入感知：从「催人门卫」变「热络老友」**（`agent/greeting.py`）：原 prompt 明写「优先挑最近在推进的项目提」→ 一开口就催。系统性重做（都是「默认=推进」病根在问候面的修复，与 stance 行为模块 §2.6 同源）：
  - **不催**：项目/日程从「必提清单」降为「可选话头」，且真提也只问体验/社交角度、绝不谈进度/待办/推进。
  - **接入感知定口吻**：读 per-user `stance`（`.agent/stance.json`，**带 18h 新鲜度闸**，过期不当「最近」提——免得旧对话被说成「刚才」）+ `summary`（时间衰减）——累/情绪→温柔别提活、闲聊→轻松、专注→关心一句留「先歇会儿」空间。
  - **不查岗**：已完成（100%）项目 + 过去事件从上下文剔除；prompt 明令绝不问「X 做完了吗 / 搞定没 / 进展如何」。
  - **暖迎、不评论间隔**：刚聊过 → 暖暖接住、像老友回来了高兴，绝不说「又回来了 / 这么快 / 刚走又来」（读着不欢迎）；确隔多日才用久别语气，且别说「刚才 / 还在…呢」。
  - **引出话题**：结尾主动递一个勾人的轻话头（从近况/当日项目挑，问「好玩不 / 朋友反馈咋样」这种体验·社交角度），别只「想聊啥都行」被动交回、也别每次硬套问句。
- **咕咕相处方式重构：persona 纯人格 + 反思驱动 stance 选行为模块**（`prompts/persona.md` + `prompts/behaviors/*.md` + `agent/behaviors.py` + `memory/{store,reflection}.py` + `context/builder.py`）：解决「总爱把对话往推进项目上带、想闲聊时没闲聊感」。① persona **瘦身为纯人格**（删四态打法 + 主动思考），相处行为全部抽成独立模块；② 新增常驻 `baseline`（四态地图 + 中性默认「先理解、别急着推进」）+ `companion`（陪聊）/`execution`/`record`/`query`/`reflect`，与既有 `emotion-first`/`stuck-first`/`decision-explore` 一起按 **1:1 stance** 点亮；③ 模块选择从「正则猜本句」改为**反思（异步 LLM）产出的 stance 驱动**（= `perception.intent`，落 per-user `.agent/stance.json`、带新鲜度衰减 30min 闸；热路径零 LLM、滞后一轮可接受）。效果：推进从「无脑默认」降为「判成执行/推进 stance 才点亮」，闲聊轮纯陪聊、无压力。详见 `docs/agent/感知系统-架构升级.md` §2.6。
- **错读需求案例收集器 + companion 松绑（感知系统续）**（`memory/reflection.py` + `prompts/reflection.md` + `behaviors/companion.md`）：① 反思检测到「感知误读」纠正时，顺带吐**脱敏**的结构化诊断 `miss{read_as, actual, pattern}`（三字段只认固定枚举（read_as·actual=需求类型、pattern=错读模式），枚举外落「其他」、结构上零泄漏；此为 5 轮真实反思验证逼出——free-text 会行内夹带用户内容），单独收进 Redis `perc:misread_cases`、并**持久化进全局 md `_analytics/misread.md`（跨 Redis 不丢）+ admin 下载端点 `/admin/perception/misread/export`** + **后台 Perception 面板「错读案例」预览栏（最近 30 条 read_as→actual + 模式，`/misread/recent`）+ 「下载完整记录」按钮**——把感知误判从「只有数字、没有原因」补成「有具体（脱敏）、可预览可下载的原因」，给后续「需求发现闭环」攒燃料（见 `docs/agent/感知系统-架构升级.md` §11）。② `companion` 松绑：区分「真上心地帮（查一查 / 给角度）」与「生产力式硬推」，分享时先共情、grounding 配着帮，仍保留「别任务化 / 别拐回推进」。
- **前端引入 TypeScript 工具链 + api 层迁移（JS→TS 阶段 0+1，纯内部、无用户可见变化）**（`frontend/tsconfig.json` + `vite.config.js` + `services/api.ts` + `types/api.ts` + `package.json`）：为渐进式 JS→TS 迁移搭好地基。① **工具链（阶段 0）**：`tsconfig`（`allowJs` + `checkJs:false` + `strict:false` 起步——存量 `.js` 与无 `lang=ts` 的组件**不检查**，只查新写的 `.ts` / `<script setup lang="ts">`）；`npm run typecheck`（`vue-tsc --noEmit`）作类型门禁（基线绿、已验证能抓错）；vite 开 AutoImport/Components 的 `dts`，让 vue-tsc 认得自动导入的 `ref`/`computed` 与 Arco 组件（生成物 gitignore）。② **类型地基（阶段 1）**：`npm run gen:types` 用 `openapi-typescript` 从后端 OpenAPI 生成 `src/types/api.ts`（**入库**，CI/typecheck 不依赖后端在跑、且前后端对齐）；`services/api.js → api.ts`，`request`/`get`/`post`… 泛型化（默认 `any` 不阻塞存量 JS 调用方），projects/events/files/folders/clients/preferences 用 OpenAPI 实体类型标注返回值，其余留 `any` 待增量升级。**约定：新代码一律 TS，改到的 JS 顺带转、不主动批量重写。** 详见 `docs/product/前端-JS转TS迁移指南.md`。
- **导航栏文字对比度提升**（`components/common/NavItem.vue` + `AppSidebar.vue`）：导航项默认文字 `rgba(30,32,40,.62)→.8`、hover `.82→.92`，分组标题 `#8a8fa8→#6e7289`，可读性更清晰（「即将上线」占位项仍保持淡、表示禁用）。
- **Calendar 视图迁移到 TypeScript**（`views/Calendar/index.vue` → `<script setup lang="ts">`，JS→TS 迁移延续）：vue-tsc 0 错；Date 相减改 `+date`、`$event.target`/`dataset` 加 HTMLElement 断言、weekBars 条目补 `row` 占位、两个 `<script>` 块统一 `lang=ts`。

### 修复

- **续聊（重开浏览器接续上次对话）时不再闪默认问候**（`components/common/GuguChat.vue`）：问候由打开对话框时的 `animateGreeting` 显示，它在 `loadSession` 异步加载完替换消息**之前**看到的还是初始问候占位 → 把问候打了出来，造成「续聊的旧对话」与「问候」同时出现。修法：续聊时立刻清空问候占位，加载竞态期不显示；那段会话真没了再恢复问候占位 + 重新生成。
- **周视图活动 409 冲突误用未定义的 `loadEvents()`**（`views/Calendar/index.vue`，TS 迁移时 vue-tsc 抓出的真 bug）：改为 `fetchEvents()`，原会在「活动已被他人修改」的刷新路径上运行时抛错。
- **定时推送/主动消息现在进 IM 会话历史**（`app/scheduled_tasks.py` + `agent/runner.py`）：之前定时任务走 `run_ephemeral`（不建 session / 不存 DB）+ 直发 IM，推送从不进会话历史 → 用户回复时咕咕零上下文（发完新闻速览、用户回「4」咕咕不知道指什么）。修法：投递成功后把推送 append 到该用户 IM 最近会话（`imsession` 指向的那个，无则建普通会话并指过去、刷新 12h TTL）；冷启动时推送是会话首条 assistant（前导会被 sanitize 剥掉）→ 塞进 system prompt 兜底，让咕咕知道自己刚主动发了啥。
- **加粗小标题 `** 标题**`（`**` 后带空格）不渲染加粗**（`components/common/GuguChat.vue`）：模型有时把加粗写成 `** 标题**`，开头 `**` 后带空格是无效 md，marked 原样输出。`renderMd` 前加 `fixLooseBold`：在代码块/行内代码之外把成对 `**` 内侧紧邻空格去掉（`** x**`→`**x**`），不碰代码里的 `x ** 2` / `` `a ** b` ``。全局生效，定时推送新闻的小标题正常加粗。

## [0.14.3] - 2026-06-30 · 日历提醒完整体系 + 文件库 UX 打磨 + DeepSeek 思考可调 + 工具错误脱敏

> md 任务清单可交互、日历活动时间与提醒完整落地（phase 1–3）、工具错误脱敏纵深防御、DeepSeek 思考强度后台可调、文件库多选/拖拽体验对齐、日历已完成项目显示优化。

### 新增

- **md 文件预览任务勾选框可点 + 回存**（`api/v1/files.py` + `viewers/TextViewer.vue` + `services/api.js`）：md 预览里的 GFM 任务清单（`- [ ]` / `- [x]`）此前是只读禁用框，现在可直接点勾/取消、即时改文件并持久化。后端新增 `PUT /files/{fid}/content`（改文本正文，仅文本类、限 1MB、校验 owner）；前端渲染时去掉 marked 默认的 `disabled`、按文档顺序给每个框打 `data-task`，点击翻转源里第 N 个任务行的 `[ ]`↔`[x]` 经 `filesApi.saveContent` 回存、存失败回滚。**仅 md + 真实文件 id 可交互**（聊天附件是 hex id，保持只读）。
- **日历活动时间 + 提醒完整体系**（`models` + `alembic` + `events.py` + `scheduled_tasks.py` + `tools/calendar.py` + `Calendar/index.vue`）：三阶段落地——① **后端 phase 1**：新增 `calendar_events.time`（HH:MM，可选，空=全天）+ `scheduled_tasks.event_id`（绑定到某活动的提醒），含 alembic 迁移 `20260629000001`（**生产 pull 后需 `make migrate`**）；工具 + REST API 全链路收/返 `time`，删活动连带删绑定提醒（应用层级联）。② **网页 UI phase 2**：加/编辑活动弹窗加时间输入 + 侧栏显示时间；编辑面板内「提醒」区列出绑定定时任务、可直接建 `@once` 提醒并实时刷新定时面板。③ **解耦 + 咕咕工具 phase 3**：活动提醒与定时任务**彻底解耦**——`GET /scheduled-tasks` 只返 `event_id IS NULL`，咕咕工具同步屏蔽；新增 `add_event_reminder`/`list_event_reminders`/`remove_event_reminder` 工具，咕咕能像网页一样管理活动提醒；`create_event` 支持一步「建活动+设提醒」；`list_events` 连同每个活动的 reminders 一起返回；新增「渠道测试」（不建任务，直接投测试消息到选定渠道）；加 `end_time`（结束<开始算次日）+ UI 打磨（时间文本输入 + 过去日期隐藏提醒区 + 弹窗自动上抬）。**无新迁移（复用 `event_id` 列）。**

### 安全

- **工具错误信息脱敏（防原始异常透传泄露）**（`agent/tools/base.py`）：在工具执行唯一咽喉 `registry.dispatch` 加 `sanitize_error()` 兜底——dispatch 异常路径 + 工具自返回的 error 字段，统一抹掉**绝对/相对路径、UUID、DB 连接串、API key/token、traceback**，在 tool_result 回模型之前做，一处覆盖全部 55 工具。只动 error 字段、绝不碰正常结果；原始异常仍进服务端日志，排查不丢。详见 `docs/security/安全-工具错误信息脱敏.md`。

### 改进

- **DeepSeek 思考强度（reasoning_effort）后台可调 + 缓存命中监控**（`config.py` + `agent_admin.py` + `agent/core.py` + `Admin/Agent/index.vue`）：DeepSeek 思考模式下 `reasoning_effort`（high/max）是唯一质量/成本旋钮，后台「Agent 配置」在 provider=DeepSeek 且思考开时显示调节控件；修复 create/update/activate 三处字段同步收口成 `_AI_SYNC_KEYS`，防「面板保存了却不生效」。并采集 `prompt_cache_hit_tokens` 进 `_usage` 事件，openai 路缓存命中可观测。
- **DeepSeek 思考开关真正生效 + 反思走结构化输出**（`agent/llm_select.py` + `agent/core.py` + `agent/memory/_llm.py`）：新增 `supports_thinking_toggle`，把思考开关扩到 DeepSeek（`thinking=disabled` 真能关掉、省延迟/token）；记忆/反思 `complete_json` 对 DeepSeek 开 `response_format=json_object + thinking:disabled`，避免推理挤占 `max_tokens` 截断大 JSON。

### 体验

- **文件库多选拖拽 UX 完善**（`usePhysicsDrag.js` + `Files/index.vue` + `ProjectModal.vue`）：文件夹与混合选中（文件+文件夹）拖拽时出现折叠堆叠动画；混合拖拽 drop 同时移动文件夹和文件；文件夹 Shift 范围多选（修复无锚点时误导航 bug）；选中样式统一为白底 + 紫色 `::before` 覆盖层，文件卡和文件夹卡对齐；拖拽克隆视觉修正（影子卡保留 `.selected`，主克隆 opacity 0.88）。两个面板（文件库 / 项目编辑卡）全局生效。
- **日历已完成项目显示优化**（`Calendar/index.vue` + `preferences.js` + `ProfileModal.vue`）：已完成项目不再延伸到截止日，改为显示到实际完成时间（`done_at`）；若提前完成（完成日早于开始日）则在完成日单日显示。个人设置 → 偏好设置 → 日历新增「已完成项目显示」开关，可在「按完成日」（默认）/ 「按截止日」间切换，偏好持久化到后端。

### 修复

- **中断生成不再误报「没有收到回复」**（`GuguChat.vue`）：用户中断流式生成时，`consumeStream` 捕获 `AbortError` 后返回 `aborted: true`，`send()` 检查该标志跳过兜底错误气泡。
- **日历月视图溢出格单日活动不显示**（`Calendar/index.vue`）：月视图首/末行溢出到上/下月的格子，其单日活动此前因 `extraEvents` 只按当月加载而匹配不到。新增 `spilloverEvents` 取上月 + 下月活动，合并成 `visibleEvents`（去重）供网格与侧栏详情使用；切月/实时刷新/删除均同步。

## [0.14.2] - 2026-06-29 · 防「说了没做」意图守卫（A-lite+B 的 B）+ mimo 深度思考可与多轮工具共存 + 反思走 json_object 结构化输出 + 个人设置 UI（重开接续 / 接入咕咕独立面板）

### 改进

- **意图守卫:治「说了要做却没动手」（咕咕"我去查一下"然后停住）**（`agent/core.py`）：回复循环里「自由文字+无工具=终止态」，模型随口宣告意图就触发结束。新增第三类确定性守卫 `_announces_intent`——检测「**我去/我来/这就/稍等我/让我/接下来 + 查/搜/建/改/记/整理…**」这类**将来式宣告**且本轮零工具 → 逼一轮当场调工具（与现有 narration「假装已做完」、decision「擅自不做」守卫并排，anthropic/openai 两路都接）。要求明确的"将要"引导词（避免裸"我+动词"误伤如「我改天再看」）；**问句/征询硬排除**（「要我去查吗?」是在等用户拍板，命中即放过、绝不误逼）。只追一次、不死循环。属「A-lite+B」方案的 phase 1（B），finish 工具 + 翻转终止规则（A-lite 结构件）留待观察后再上。详见 `docs/agent/agent-多步执行与防停顿.md`。
- **mimo 深度思考可与「多轮工具调用」共存 + 记忆/反思走结构化输出（json_object）**（`agent/core.py` + `agent/memory/_llm.py`）：对照 mimo 官方「深度思考」「结构化输出」文档查漏补缺——① **深度思考**：openai 路此前**完全没读 `reasoning_content`**，而 mimo 文档硬性要求「多轮 Function Call 必须把上一轮的 `reasoning_content` 完整回传，否则 400」→ 开思考时 mimo 一旦多步调工具就会 400（此前靠默认关思考绕开）。现在流式里捕获 `reasoning_content`、在**所有** assistant 回填点（工具轮 / narration·decision·verify 各 nudge 轮）统一带回（`_asst` 收口）；只在**当轮内存**回传、不入库（openai 路中间轮本就不持久化），思考关时 `reasoning` 恒空、行为与原先逐字一致。② **结构化输出**：记忆/反思的 `complete_json` 对 mimo 开 `response_format={"type":"json_object"}`（mimo 不支持 json_schema，仅 json_object）让正文必为合法 JSON，比纯靠 prompt + `_parse_json` 抠更稳；并显式 `thinking:disabled`——否则 reasoning 与正文共用 `max_completion_tokens`、大 JSON（如反思回显整份 facts）易被推理挤到截断。两项都**仅 mimo 生效**（`_is_mimo` 门控），MiniMax/Anthropic 与其它 openai 兼容厂商行为不变。
- **个人设置：加「重开浏览器接续上次对话」开关 + 接入咕咕独立成面板**（`ProfileModal.vue` + `GuguChat.vue`）：① 个人设置→咕咕设置新增「对话」区——可选**重开浏览器时「接着上次」/「开新对话」**（默认开新，与历史一致）。会话 id 除 sessionStorage（本标签刷新保留）外再存 localStorage（`gugu_last_session_id`，跨浏览器留最近一段），GuguChat `onMounted` 据设置 `gugu_reopen_resume` 决定接续上次还是开新对话+问候；那段会话被删则退回新对话。② 把「**接入咕咕**」（飞书/QQ/微信 扫码连接、机器人启停删）从「咕咕设置」面板拆出、单独成一个 nav 面板（放咕咕设置下面），咕咕设置只留 精力 / 回复风格 / 对话 / 记忆。

## [0.14.1] - 2026-06-29 · prompt 缓存真正生效 + 独立语音识别模型 + 密码找回 + IM 发图/多图修复 + 缩略图/拖拽/定时等体验打磨

### 新增

- **密码找回（邮件重置链接）**（`api/v1/auth.py` + `ForgotPassword`/`ResetPassword` 页）：`POST /auth/forgot-password` 按邮箱查用户 → `secrets.token_urlsafe(32)` 存 Redis（`pwdreset:tok`，30 分钟 TTL）→ 线程池发重置邮件；邮箱不存在 / 冷却中**都返回同一句**（防枚举），同邮箱 60s 冷却防刷。`POST /auth/reset-password` 校验 token + 新密码 ≥8 位 → 改密 → 删 token（一次性）。重置链接基址取请求 `Origin`（用户当前站点）不写死域名；登录页加「忘记密码？」入口，`reset-password` 不加 `authPublic`（已登录点邮件链接也可用）。
- **独立语音识别模型（与主模型解耦）**（`settings.voice` + `agent/voice.py`）：语音 / 音视频转写改用**独立配置的 ASR 模型**把音频转成文字、再交主模型处理，主模型不再被强切 mimo（根治「主模型非 mimo 时媒体块被静默丢弃、语音被当文件」）。`model` 留空 = 未配置 → 收到语音咕咕直接回「不支持」。固定走 OpenAI 兼容 `input_audio`（chat + base64，纯 ASR 不传 thinking）；Admin「Agent 配置」加语音模型卡（model / base_url / api_key / provider，含 MiMo·Qwen 模板按钮）。
- **IM 连发多图聚合 + 微信图片接收**（`worker.py` + `agent/adapters/wechat.py`·`qq.py`）：QQ/微信「一张图一条消息」，连发的图 + 后面的指令本是一次表达。worker 加**输入防抖**——投 per-user 缓冲、每条把截止时刻推后，**静默 1s** 才把缓冲里所有消息合并成**一轮** `run_collect`（拼文字 + 合并所有附件）、**只回一次**（reset 续上连发的图；ack 推迟到 flush，崩了 claim_stale 60s 重投；**仅单 worker 有效**）。网关侧「收到啦」秒回 ack 加 **10s 冷却**（连发只一次）。**微信图片接入**：iLink 媒体首版只文本，补 `image_item` → 下载 CDN `media.full_url` → **AES-128-ECB 解密**（key=`aeskey` hex 16B）+ 去 PKCS7 → 暂存（kind=image）→ 接上 QQ 同一链路（vision 看图 + 存）；file/voice 项格式未知暂留日志待补。

### 改进

- **MiniMax/Anthropic prompt 缓存真正生效 + 多轮工具滚动缓存**（`agent/context/builder.py` + `agent/core.py`）：原先把整段 system 当**一个** `cache_control` 块——但 system 末尾的「当前时刻」精确到**分钟**、加上每轮变的记忆/行为模块 → 整块每分钟（甚至每轮）就 miss，那个缓存几乎白打。改：① **system 拆成「稳定前缀 ┃ 动态后缀」两块**——builder 在「技能索引」与「记忆」之间插一个不可见断点（`CACHE_BREAK`），缓存块只含人格/工具准则/内容政策/风格/技能索引（一个 session 内不变，**实测 ~12.5K 字**），动态后缀（记忆/分钟级时间/项目日历文件，实测仅 ~300 字）不缓存；两块顺序拼接与原单段**逐字一致**，段落顺序/语义不变；命中后缓存读取便宜 ~90%。② **多轮工具循环加滚动缓存断点**——给发出的 messages 最后一块打 `cache_control`（用副本、不污染要持久化的原 messages），工具密集的多轮把已发生的几轮也缓存住、每轮只重算新增。mimo（小米，其 anthropic 端点不支持缓存）两块都跳过、openai 通道 strip 掉标记。（思维链跨工具轮的 thinking 回传本就正确，未动。）
- **skills.md 瘦身：situational 剧本抽成按需 skill**（`agent/skills/`）：把 `prompts/skills.md`（每轮常驻的工具准则）里三块**针对性 how-to**——项目规划、定时任务、接入 IM——抽成按需 `use_skill` 拉取的 skill（`project-planning` / `scheduled-tasks` / `im-bind`），skills.md 只留**主动触发 + 安全红线**的短指针（如「没真建成定时任务就别口头承诺」常驻）。常驻 prompt 省 ~600-1000 tokens、更聚焦；冗长剧本用到才拉。**安全红线（真实性铁律、删除两步确认）与高频元策略仍常驻、不拆**（按需件只在模型决定动手后才拉，主动触发与安全规则拆了会失效）。线上验证：问「怎么接飞书」→ 模型自动 `use_skill im-bind` → 给出扫码按钮。
- **文件操作 how-to 抽成按需 skill + 编辑后反馈「改了啥」**（`agent/skills/file-ops.md` + `agent/tools/files.py`）：继 skills.md 瘦身，把文件操作 how-to（批量入口 `move_items`/`rename_file.renames`/`edit_file.edits`、改正文前 `read_file` 防覆盖、核对搜全空间、落点照回执转告、`create_document` 报落点、`send_file` 只在明说发我时调、`gugu://open-file` 跳转链接）抽成 `use_skill 文件操作`，常驻只留详细指针；**真实性铁律核心 + 不可逆删除两步确认仍常驻**（红线要动手前生效、不能按需拉）。并让咕咕**编辑文件后一句话反馈改了什么**——`edit_file` 回执新增 `change` 摘要（替换 N 处 X→Y / 末尾追加 N 字 / 整体覆盖 旧→新 字）作事实依据，skill 要求照它简要转述，不再只说「改好了」。线上验证：改 md 某节内容 → 「加好了 ✅『可参考的应用』现在有滴答清单、像素习惯、Forest 三个」。
- **项目规划更克制**（`agent/skills/project-planning.md`）：① 推进项目时**主动让状态跟上进展**——规划完 / 勾首个待办 / 开始动手 → 主动从「待开始」转「进行中」并告知（低风险可逆）；全部做完 → 先问确认再标「已完成」（归档较重）；状态与进展脱节就主动提。② **默认精简、别甩一面墙**——阶段宜少（3~5）、每段只列关键待办（≤4）、不拆微步骤、颗粒度随项目大小缩放；**详细按需展开**（主动给「要哪段拆细」）而非默认，拿不准往少了给。③ **待办本就可选**——长期/单线创作（草图→线稿→上色→交付）阶段即进度、不必每段列待办，只想归拢文件建个项目壳即可，没「具体可勾、用户真会追的动作」就别硬凑。④ **同类型项目尽量同色系**——建项目前看现有同类项目的颜色（`list_projects` 输出补 `color`），新项目沿用同色系让看板按类型成组；判不出类型 / 无同类才随机或问，别为配色专门追问。
- **实时刷新通用模板 + 定时面板补实时**（`composables/useLiveRefresh.js`）：抽出 `useLiveRefresh(资源, fn)` composable 作为「资源变更 → 刷新」的统一订阅入口，替代各处手写 `watch(rev.X, fn)`、新页面照抄一行不会漏。并补齐缺口——**定时任务（`scheduled_tasks`）做成 live 资源**：咕咕在 web/IM 建/改/删（走 `RESOURCE_BY_TOOL`）、过期任务被 GC 自动清 / 一次性任务触发即删（worker `_notify_tasks_changed`）都**实时推到网页定时面板**，不用手动刷新。（现有 store/页面的实时刷新本就工作，未强行迁移，新代码统一走 composable。）

### 修复

- **「咕咕开小差了」——MiniMax 偶发流式解析崩**（`agent/core.py`）：MiniMax 偶尔返回空/异常的流式响应 → anthropic SDK 解析时 `IndexError`/`KeyError` 越界，而这俩不在可重试集 → 直接降级兜底「开小差」。把 `IndexError`/`KeyError` 纳入 `transient`：**出第一个 token 前**退避重试（`emitted` 守卫保证不重复输出），MiniMax 这类偶发抽风多半重试一次就成；重试用尽才降级。
- **重命名图片后没缩略图 + 文件库/项目卡滚动严重闪屏**（`composables/useThumbCache.js` + `useLazyThumb.js` + `views/Files/index.vue`）：批量重命名触发实时刷新 + 一大波缩略图请求瞬时爆发 → 并发限流器（`pLimit` 6 槽）被卡住/超时的请求占死 → 而懒加载指令**单次尝试、失败不重试** → 这些图永久空着 → 卡片只剩 `filter: blur` 的模糊底层 → 滚动时大量「模糊+遮罩+常驻 will-change」合成层重栅格化 = 严重闪屏。三处修：① `getThumb`/`getThumbUrl` 的 `fetch` 加 `AbortController` 15s 超时（卡住的请求不再永久占槽、abort 后释放并触发重试）；② 懒加载指令失败后**有限重试**（≤3 次 + 退避，`updated`/`unmounted` 清定时器），瞬时抖动不再永久空图；③ 去掉 `.fc-thumb-area` 常驻 `will-change: transform`（保留 `translateZ(0)`）——ProjectModal 同款早改过、文件库漏改。（后端实测确认：重命名只改 `display_name`/`storage_key`、不动 `fid`/`ext`/`mime`，缩略图按 `fid` 存盘不受影响，回源重生也正常——纯前端问题。）
- **抓文件拖拽出现浏览器默认「小地球」favicon**（`composables/usePhysicsDrag.js` + `views/Files/index.vue` + `Projects/components/ProjectModal.vue`）：物理拖时 `onFileDragStart` 先 `setDragImage(卡片)`、`startPhysicsDrag` 又设透明 ghost——部分浏览器**只认第一次** setDragImage（卡片），而源卡随后被隐藏 → 拖影变空 → 退回默认小地球。改：走物理拖时不再 `setDragImage(卡片)`，让透明 ghost 当唯一拖影；且透明 ghost 的 1×1 canvas **挂进 DOM 离屏**（脱离 DOM 的 canvas 部分浏览器会忽略 setDragImage → 同样退回小地球）。列表行/多选仍用卡片自身当拖影。
- **IM 发图咕咕「看不到 / 没回复」**（`agent/runner.py` + `sanitize.py` + `core/chat_attach.py` + `llm_select.py`）：三层真因——① **图片识别崩溃真凶**：`resolve_for_message` 图片分支 `data, media = fitted` 把音视频列表变量 `media` 覆盖成图片 mime 字符串 → `aug_media` 变 `str` → `run_collect` 见 `if aug_media:`（非空串=真）触发 `voice.transcribe(str)` → `'str' object has no attribute 'get'` 崩 → 图那轮被吞。改名 `img_media_type` 根治（凡喂图必崩）。② **IM 路从未调 `sanitize_messages`**（清空块、修 tool_use/tool_result 配对、`_clean_block` 去 None 字段——**只 web 路调过**）：IM 把原始历史直发 MiniMax，SDK 响应残留的非标字段（`caller`/`citations`/`parsed_output`=None）或不配对工具块触发严格校验 → `400 text is not set` → 那轮被吞、ack 丢弃 →「图片带文字没回复」。`run_collect` anthropic 路补上 sanitize（对齐 web）。③ vision 门控改用**这轮真模型**（resolve 加 `model_cfg`，不用静态 `settings.ai.vision`）；**去掉「带图强切 vision 模型」**——MiniMax-M3 实际支持图片，池里模型看得了就识、看不了当普通文件（不再硬切到「标 vision 实则不收图片块」的模型）。
- **保存上传附件传项目名当 id 直接崩**（`tools/files.py`）：`_as_int`/`_i` 解析失败返回原字符串而非 None → 非数字项目名流进整数主键查询 → asyncpg `DataError` 崩（`save_uploaded_file` 等）。改成失败返 None，由上层干净报错让模型用 `list_projects` 拿 id 重试。
- **语音 ffmpeg 找不到（进程 PATH 收窄）**（`agent/voice.py`）：裸 `"ffmpeg"` 在 setsid/systemd 起的进程里 PATH 找不到 → `create_subprocess_exec` `FileNotFoundError` → 转码失败、语音识别不了。复用 `media_transcode._ffmpeg_bin()`（PATH → `/usr/bin/ffmpeg` 等绝对路径兜底）。
- **网关把「嗯/好」等确认吞掉**（`agent/router.py`）：IM 网关原先用关键词把「嗯/好/谢谢」这类 ACK 短路回「嗯嗋～」或 drop，吃掉用户真实意图（如咕咕说「我去查」后用户回「好」被吞、搜索没接上）。**只去掉这一类 ACK 短路**——现在「嗯/好/谢谢」一律交主模型据上下文回应。**其余保留**：斜杠命令；咕咕**在忙（思考/搜索/生成/等确认）时**的进度追问（还在吗/查了吗/好了吗/进度，顺手补「查了吗/搜到了吗」进词表）与催促（急/快点）→ 回一句状态、不打断；在忙时取消（算了/停）→ 中断任务。
- **说要查却不查（只口头宣告不执行）**（`prompts/skills.md`）：「有没有 X 新闻 / 帮我查 Y」→ 咕咕回「我去查一下」就结束这轮、干等用户再问「查了吗」才动手。强化：**说了要查/要做就这一轮真发出工具调用**，别只宣告然后停。
- **要提醒却没真建定时任务（只口头答应 / 谎称已建）**（`prompts/skills.md`）：用户明说「中午提醒我修 bug」，咕咕回「好~12点提醒你」却没调 `create_scheduled_task`，甚至「目前没有定时任务」之后又谎称「我新建了」。根因：旧指针对**已明确**的提醒请求也走「先确认一句」流程，给了模型「口头应承当确认、不落地」的口子。改：**明确要提醒 / 定时的请求 → 这一轮立刻调 `create_scheduled_task` 建好、拿 success 再回话**（只有「是否要设定时」本身不明确才先问）；红线绑死到话术——「会提醒你 / 已设好提醒」在本轮工具没收到 `success` 前一个字不许说，谎称「我新建了」是最严重失败。线上验证：「中午12点提醒我修bug」→ 真建 `@once` 任务 + 据实回执。
- **一次性定时任务过期不自动清理**（`app/scheduled_tasks.py`）：正常触发的 `@once` 任务由 `execute_task` 即时删除，但**停用 / misfire 没触发 / 残留**的过期一次性任务无人回收，会一直僵在面板里（`execute_task` 对停用任务直接 early-return，走不到删除）。`reconcile`（每 ~30s）新增 GC：**过点的一次性任务自动清理**——正常触发的由 `execute_task` 即时删，没触发到 / 残留的过点约 **2 分钟**（120s 宽限，避开正在触发的那一下）后由 GC 扫掉，周期 cron 与未到点的不受影响。**定时面板的列表接口（`GET /scheduled-tasks`）也会读时顺手清**过期一次性任务——不只靠 worker GC，worker 滞后 / 没跑时面板也不显（不留）残留。
- **久置标签页切回来卡死约 1 秒**（`stores/live.js` + `stores/filesCache.js`）：标签页放后台久了 SSE 断开，切回前台重连时一次性 `bump` 全部 5 个资源 → filesCache / projects / calendar / sessions / clients 同时 refetch + 替换大数组 + 重渲染，挤在一两帧 → 卡主线程。改：重连补刷**错峰逐个 bump**（延后 300ms 起、每 250ms 一个），把这波刷新摊开、让出主线程（总量不变、不挤一帧）。（曾顺手给 filesCache 的 `rev.files` 加版本门控省刷新，但 `/files/version` GET 可能被缓存 → 拿旧版本号 → IM 存文件后项目卡片文件数不实时更新，已回退、保持无条件 refresh。）
- **`systemctl` 重启后端起不来、每次要手动 `pkill`**（`scripts/dev-restart.sh` + `deploy.md`）：根因是 8000 端口同时被 systemd 与手动 uvicorn**两个主人**抢，`systemctl restart` 停不掉非 systemd 的那个 → 绑不上端口死循环。立「一台机 8000 只一个主人」铁律：生产给 `gugu-backend.service` 加 `ExecStartPre=-/usr/bin/fuser -k -n tcp 8000` 自愈腾端口（`systemctl restart` 再不用手动 pkill）；dev 机 systemd 保持 disabled、用新增的 `scripts/dev-restart.sh`（免 sudo、自带腾端口）一条命令重启 web/worker/supervisor。
- **接入 IM 按钮漏微信**：咕咕给扫码绑定按钮时只发飞书 / QQ、漏了微信，现补齐微信。
- **拖到「已完成」没勾完待办**（`stores/projects.js`）：项目卡拖到已完成列时自动勾选所有阶段的全部待办——`moveProject` 进 done 分支原只推进 `currentStage` + `progress=100`、没勾 todo 也没把 stages 传后端。补：深拷贝 stages、未完成 todo 设 `done`+`autoCompleted`（快照原状态随 patch 存），与 `setStage` 同一约定，拖回进行中自动复原。
- **网页语音咕咕「听不到」（IM 正常）**（`core/chat_attach.py` + `agent/voice.py`）：两层卡点——① chat_attach 的 `native` 格式门控只放行 mp3/m4a/wav/ogg，**Chrome 录音是 webm**（`_recExt` fallback），不在白名单 → 媒体块根本不建、连 transcribe 都没调到（IM 语音在网关已转 mp3、是原生的，故畅通）。改：配了语音识别模型时音频/语音不再要求原生（`fmt_ok = native or (voice_ok and not is_video)`），交下游 ffmpeg 转。② 就算放行，Safari 的 `audio/mp4` 送到 mimo-v2.5-asr（只收 wav/mpeg/mp3）会 400 `Param Incorrect` → `voice.py` 转写前凡 mime 不在白名单的，用 **ffmpeg** 转 16k 单声道 wav 再送（输入走临时文件，mp4 的 moov 在尾部需可寻址）。现 Chrome/Safari 网页录音 + QQ/微信 amr 全覆盖。
- **邮件系统：配置「不保存」+ 发件人填名字崩**（`core/config.py` + `services/email.py`）：① `apply_override` 的「顶层字段」兜底循环排除集漏了 `smtp`、`voice` → 这两段先被各自处理块构造成对象、又被原始 dict 覆盖回 → `settings.smtp/voice` 变 dict、后台读出当空配置（看着像没保存）、发信用空配置发不出。补进排除集即根治。② 后台「发件人」常被填成显示名（如「咕咕」）而非邮箱，旧逻辑直接当地址塞进 From → 信封发件人 `<咕咕>` → smtplib `MAIL FROM` 按 ASCII 编码崩。`_resolve_from`：含 `@` 才当地址，否则当显示名、地址退回登录账号；中文主题 / 发件名走 `EmailMessage` 自动 RFC2047 编码。
- **网页语音发出后先显示成文件卡、刷新才变语音条**（`GuguChat.vue`）：`send()` 拼乐观用户气泡时 `files.map` 漏了附件的 `kind` / `duration`，而语音条靠 `f.kind==='voice'` 判定 → 补上即解。
- **语音 API Key 看着「没保存」**（`stores/config.js` + Admin/Agent）：key 实际存住了，但后端脱敏成 `****`、前端又清空显示 → 字段永远空、看着像没存。`config` store 记录后端是否已有 key（`secretSet.voiceApiKey`），面板据此显示「· 已配置 ✓」+ 动态占位。
- **后台页滚动闪动**（`layouts/AdminLayout.vue`）：`.admin-main` 既是 100vh 滚动容器又用了 `background-attachment: fixed`，渐变被钉在视口、滚动时每帧重绘整块导致闪动。去掉该属性（元素本身就是视口高的滚动容器，默认 `scroll` 已让背景相对自身固定，视觉一致且无重绘），所有后台页共用此布局。
- **录音条与按钮没对齐**（`GuguChat.vue`）：`.rec-bar` 没设高度、靠 padding 撑出约 22px，比 28px 按钮矮，底对齐时内容偏低。设成与按钮等高（28 / 放大态 32）、内容居中。

## [0.14.0] - 2026-06-29 · 感知系统（遥测/行为模块/解读先验）+ 记忆 2b（结构化 facts/事件总线/控制命令）

> 本版两根主线：① 给决策环最上游的「感知」装上**可观测 + 可 per-user 成长**的体系——A+B 感知遥测 + 误判捕获 + Admin 诊断面板 / 情境行为模块库 / per-user 解读先验 lens，**观测与学习全在异步反思里、零聊天延迟**；② 记忆补齐 **Phase 2b**——facts 升级为带置信/重要度/时间衰减的结构化 `facts.json`、反思增量化、事件总线、`/memory`·`/forget` 控制命令。外加 IM 跨 session 续接、会话一句话总结、在线/离线状态、一轮时区显示统一。

### 感知系统 P0–P2（新子系统，详见 `docs/agent/感知系统-架构升级.md`）

把「感知用户要什么」从隐式（埋在一次 LLM 调用里）变显式、可观测、可学，**全程不给聊天热路径加 LLM 跳**。

- **P0 · A+B 感知遥测 + 误判捕获**（`memory/reflection.py`）：反思多吐 `perception`（intent/ambiguity/emotion/emo_strength）打 `agent.perc` 日志 + 推 Redis capped list；正则捕获用户纠正（`misperc`）当客观误判信号。Admin「感知诊断」面板（`/admin/perception` + 前端深色页）按**活跃用户宏平均**聚合误判率/意图分布/by-model。
  - **面板阈值可调**：顶部阈值条（活跃门槛 / 标红误判率 / 歧义偏高线 / 最小样本，改完即时重切，带「复位默认」）；后端把 `rate_hi`/`min_n`/`ambig_hi` 提成 query 参数（默认即原常量），标红/标黄/高亮全随面板阈值联动。**只改「怎么看」这屏数据，不动系统行为阈值**（lens/decay 等仍留代码常量、按红线人调走部署）。
  - **误判捕获 v2：LLM 判 + 区分类型**：误判主信号从「正则关键词」改为**反思那次 LLM 顺带判** `correction:{is_correction, kind}`——正则注定漏召回（短随意的纠正如「错了，…」抓不到），且分不清「读错需求」和「查错数据」。`kind` ∈ `感知误读`（没读懂用户要什么）/ `数据或执行错`（读懂了但数据/操作做错）；正则降级为兜底（仅反思 extract 失败时用）。面板据此**拆出「感知误判率」（仅感知误读，本系统真正要优化的）与「纠错构成」**（感知误读 / 数据执行 / 未判），查错数据不再污染感知指标。
    - **判定原则钉死「谁错了」**：`is_correction=true` 的**唯一**条件是错的主体为「咕咕本人这次的回答/理解」。错的若是别人一律 false，明列四类反例——用户认自己错（「是我错了」「你是对的」）、第三方错（「他记错了」）、外部信息源错（「数据源/官网写错了」）、单纯聊「某事是错的」。修掉了「句里有『错』字就误判成咕咕被纠正」的假阳性（如用户认错反被算进感知误判率）。
- **P1 · 行为模块库**（`agent/behaviors.py` + `prompts/behaviors/`）：从 persona 抽出情境策略模块（DO+DON'T 同文件），由本句线索 + World Model **软点亮**、置于人格后最高优先、零前置 LLM。现有三个：`emotion-first`（接情绪·压住给方案/任务化，补 Being-with 缺口、压「闲聊也推进」nudge）、`stuck-first`（卡住给最小一步、别甩完整大纲）、`decision-explore`（纠结里摆权衡、问关键、别替 TA 拍板）。**最小裁决**：情绪在场优先接情绪、不与任务型模块叠加（stuck/decision 可共存）。
- **P2 · per-user 解读先验 lens**（`agent/memory/lens.py` + `.agent/lens.json`）：第 5 类记忆「怎么读懂这个用户」的偏置规则（如 `「还行」→ 多半不太行`）。事件驱动（吃反思 `lens_hint`、零热路径 LLM）；防过拟合双闸（模型自律 + 候选须复现 2 次、以触发语为键合并同义改写才提拔）；confidence 新规则 0.6 / 印证↑ / 半衰期 30 天衰减 / 低于 0.25 退休；`builder` 注入「解读镜片」偏置不独裁、按 effective 选话术档。

### 记忆系统：结构化 facts（2b）+ 增量化 + 时间衰减 + 事件总线 + 控制命令

- **反思跳过的修正：确认轮带动作也反思**（`memory/reflection.py` `schedule`）：原本「嗯/好的」这类纯应答词整轮跳过反思——但它们常用来**确认咕咕的方案**，若这轮咕咕**真用了工具**（如「要建项目吗？」→「嗯」→真建了），现在即便用户只说「嗯」也反思，记下这轮做了啥（daily/summary）。判据是「本轮有没有动作（工具）」而非消息长短：web 传 `used_tools` 列表、IM 用「工具轮次让消息变长」当代理；纯寒暄无动作仍跳过、不浪费调用。

- **facts 结构化（2b）**（`memory/store.py` `facts.json`）：facts 从 markdown 行升级为结构化条目，每条带 `kind`(observed=用户亲述/inferred=咕咕推断) / `conf`(置信) / `imp`(importance 1-5) / `ts`。反思吐 `facts_add`(对象 `{text,kind,importance}`)/`facts_remove`，`apply_facts_ops` 应用：命中相似条**印证**（升 conf、刷新 ts、亲述升级 observed），否则新增。**注入按 effective×importance 过滤排序**（importance 过滤）；**observed 不衰减、inferred 按半衰期（45 天）淡出**（复用 `decay.py`）——旧的推断类事实自然过期、不再当永真。旧 `facts.md` 首次读取自动迁移成 `facts.json`，零手动迁移。
- **反思增量化（2b · delta）**（`memory/reflection.py`）：反思只吐增删、**不再回显整份 facts**。根治了「facts 一多 → 回显超 `max_tokens` → 截断 → JSON 解析失败 → 静默返回 `{}`、老用户反思全废」的隐蔽坑；`max_tokens` 回落固定 900。
- **事件总线（2b）**（`agent/events/bus.py` + `types.py`）：轻量异步发布/订阅，事件用类（`MemoryUpdated`）不用字符串。反思 / `remember` / `/forget` 在 facts 变更后 `publish`，内置 listener 落 `agent.events` 审计日志；成就/分析等下游以后挂 listener 即可、不动发布方。
- **记忆控制命令（2b）**（`agent/commands.py`）：聊天里直接打 `/memory`（看咕咕记得你哪些事，按重要度排、标「推测」）、`/forget <内容>`（忘掉对得上的那条 fact）——确定性短路、零 LLM、不计精力、不触发反思。`/newchat` 未做（网页 UI 已有「新对话」）。
- **summary 时间衰减**（`agent/decay.py` + `store`）：summary 写时盖 `summary.ts`，注入时按半衰期（5 天）权重换话术档（新鲜直接给 / 半旧标「约 N 天前、可能已变」/ 过时标「多半过时、别据此提具体事」），过期状态不被当成近况。`decay.py` 为通用件，facts/lens confidence 衰减复用。

### 跨 session 续接修复（IM「没续上之前的聊天」）

IM 会话是 12h 滑动 TTL，过期会起新空会话 → 咕咕丢掉上一条上下文、续不上。三处一并修：

- **`read_conversation` 取最近而非最旧**（`tools/conversations.py`）：原 `order_by(created_at)` 升序 + limit 返回的是**最旧** N 条，「继续刚刚的话题」要的恰恰是最近聊的——改 DESC 取完再正序。
- **IM 新会话「续接桥」**（`runner._im_continuity_bridge`）：新会话开场注入「上一条对话 #id《标题》— 一句话总结」**指针**（A 档，引导咕咕用 `read_conversation` 翻）；用户这句带「继续 / 刚刚 / 上次 / 之前」等**续接词**时，直接把上一条尾部几轮塞进上下文（B 档，mimo 也能接，不靠模型自觉调工具）。超 48h 不注入（防翻陈年账）。按 user_id 查、跨平台续接、严格用户隔离；微信走同一套（`source` 统一）。
- **默认问候优先最近项目**（`greeting.py`）：上下文里「最近在推进的项目」提到最前、长期 facts 降级标成「背景，别当『最近在忙』」；提示词同步——治「记忆里聊过的旧项目被当成『最近在忙』」（如把 facts 里的旧插画项目当成在做的项目）。

### 新增：会话一句话总结（`conversation_sessions.summary`）

每个会话存一句「这段聊了啥」，供跨 session 查找 + 续接桥指针。后台 fire-and-forget 生成（`web._generate_summary`：新会话出一版、之后每 ~6 条刷新跟着话题走）、**不计精力**、失败不覆盖；`search_conversations` 列表/搜索带上、关键词也搜它。**绑 session 列、随会话删除自动清理**（50 上限淘汰 / 手动删 / 账号 CASCADE，无额外清理逻辑）。新增 `summary` 列 + 幂等迁移 `20260628000001`。

### GuguChat 在线 / 离线状态

未接入任何 IM（微信 / QQ / 飞书）→ 状态显示「**离线**」（原硬编码恒「在线」）。离线做成**克制的可点暗示**（灰点、文字弱化、hover 才微亮 + tooltip，不抢眼）；点击 → 展开大窗 + 摊开 IM 抽屉露出「扫码连接」+ 高亮 IM 区，引导接入。`open` 时即加载 bot 列表，小窗状态也准。

### 修复 / 其它

- **时区显示统一**：聊天气泡（`agent.py` 补 `"Z"` 后缀让前端按 UTC 解析）、后台各面板时间（系统日志/邀请码/反馈/定时任务 `strftime` → `fmt_local`）偏 8 小时修复——新增 `app/core/tz.py`（`LOCAL_TZ`/`local_now`/`local_day_start_utc`/`fmt_local`），quota/search/overview/greeting/scheduled_tasks/builder/admin 统一引用，消除各模块散落的硬编码 `timedelta(hours=8)`。
- **服务状态脱敏**：隐藏 PID / 主机名 / 网关所属用户名，定时任务列表只显示数量。

## [0.13.2] - 2026-06-28 · 微信接入 + 记忆四层 + 音视频·语音 + 精力修复 + 体验打磨

> 本版核心：新增**微信接入**（个人微信官方 iLink Bot，扫码自连，模式同飞书/QQ）；记忆补到**四层**（facts / daily / memory / **summary 当前状态快照**）；咕咕能**听 / 看音视频**（mimo 多模态 + IM 语音转码）、语音做成可播放**语音条 + 30 天存储**；修了一批 **Agent 可靠性**问题（联网不虚构 / 交叉验证、未来任务主动确认设定时、IM「确认用的嗯」被吞、用 QQ 聊却说没绑定）；**精力配额**修了「100% 仍拦不住」（封顶截断 + IM 漏判）与时区（UTC→CST）；外加拖拽实时让位、文件按状态分组、决策轨迹脱敏、DAU→WAU 等体验与后台打磨。

### 接入微信（个人微信 · 官方 iLink Bot）

咕咕可接入**个人微信**：走微信官方 iLink Bot API（`ilinkai.weixin.qq.com`）——扫码授权拿 `bot_token` → `getupdates` long-poll 收 + HTTP send 发，**非逆向、无封号风险**，模式同飞书/QQ 的 BYO 扫码自动连接。

- **网关 + 客户端**（新增 `adapters/wechat.py` / `adapters/wechat_client.py`）：long-poll 子进程拉消息入 `im:inbound`，`ILinkClient` 封装出码/轮询/收发；iLink 回复**必须带入站消息的 `context_token`**，入队 payload 透传、worker 回复时带回。
- **扫码连接**（新增 `api/v1/wechat_connect.py`）：`POST/GET /me/wechat/connect` 出码 + 轮询确认 → 自动 upsert `user_bots`（`bot_token` 存 `app_secret`、`base_url` 存 `app_id`）→ 通知 supervisor reload。`supervisor.py` 加 wechat 子进程拉起、`worker.py` 加微信发送分支，前端 `ProfileModal` 加「微信（个人微信）」扫码入口。
- **收到消息先即时反馈**：网关拉到消息先回一句「收到啦，让我看看哈~」再入队，免得 agent 慢处理时用户在微信干等没动静。
- MVP 限文本（图片/语音后补，需 iLink 媒体 AES + CDN）。⚠️ 待确认 iLink Bot（`bot_type=3`）开放门槛。

### 记忆新增 summary.md（当前状态快照「用户现在在做什么」）

记忆从三层补到**四层**：facts（稳定身份）/ daily（流水）/ memory（长期）之外，加 **`summary.md`** —— 一段「用户此刻在忙什么 / 近期重心 / 状态」的快照。

- **零额外开销产出**（`reflection.py` / `prompts/reflection.md`）：反思那次 LLM 调用的输出从 `{facts,daily}` 扩成 `{facts,daily,summary}`，summary 顺带产出。基于原快照**增量演进**——重心没变原样返回、变了才改；写回有「非空 + 内容变了」双重守卫，防把已有快照清空或瞎改。
- **注入最前**（`builder._memory_block`）：作为 `## TA 最近的状态` 注入系统提示**记忆块顶部**，咕咕开口前就知道用户当下处境；`greeting.py` 默认问候也优先参考它。
- **存储/清理**（`store.py` / `agent.py`）：`read_memory` 返回四层，`read_summary`/`write_summary` 读写 `.agent/summary.md`；清空记忆接口一并删除 summary.md。
- 实测：「在筹备公司年会、下周五交方案」→ summary 记「最近在筹备公司年会策划方案，下周五截止，忙得脚不沾地」，facts 只留稳定事实，三类正确分离。

### mimo 音 / 视频理解适配（含模型池路由修复）

让咕咕能真正「听 / 看」用户发的音视频（mimo 的 OpenAI 扩展块 `input_audio` / `video_url`）：

- **多模态附件链路**（`chat_attach.py` / `agent/core.py` / `runner.py` / `web.py`）：音视频附件 base64 随消息喂给 mimo；`build_user_content` openai 路加 `input_audio` / `video_url` 块（anthropic 路不支持、忽略）。mimo 默认思考模式会返回空正文，两套 API 均显式传 `thinking: disabled`。
- **IM 语音转码**（`media_transcode.py`）：QQ 语音是 SILK（`pilk` 解码）、其它 IM 多是 opus/amr → `ffmpeg` 转 mp3 再喂 mimo；缺 `ffmpeg`/`pilk` 优雅降级退文字提示。**部署需装 `ffmpeg`**（`deploy.md` 已补）+ `pilk`（`requirements.txt`）。
- **修：音视频被模型池静默打掉**（`runner.py`）：IM 经 `pick_model` 可能路由到非 mimo 模型（如 MiniMax-M3，走 anthropic 路），媒体块被 `build_user_content` 丢掉，咕咕只当成文件回「收到 mp3」。改为**带音视频的这轮强制切到 active mimo+openai 模型**，保证发得出去。
- **修：空附件早返回 tuple 元数太少**（`chat_attach.resolve_for_message`）：早返回原是 3-tuple、调用方已改 4-tuple 解包 → 无附件消息会崩。统一 4-tuple。

### 语音消息做成「语音条」+ 30 天独立存储 + 「让我听听」语气

QQ 语音 / 网页录音不再当文件卡，做成可播放的语音条：

- **语音条 UI**（`GuguChat.vue`）：`msg.files` 里 `kind==='voice'` 渲染成播放钮 + 装饰波形 + 时长；点击带 Bearer 拉 `download` 端点 blob 播放（`<audio src>` 不带 token）。
- **独立 30 天存储**（`chat_attach.py`）：语音走 `stage_voice()` → 独立 `.voice/` 目录、留存 30 天（普通附件仍 6h `.chat_staging/`）、带时长（`ffprobe` 探测）。过期点播放 → 提示「语音过期啦」。
- **「直接听内容回应」语气**（`resolve_for_message`）：语音分支提示词改成「这是对话不是文件，直接听内容并回应，别问要不要存」，去掉 `save_uploaded_file` 话术。
- **入口标记**：QQ 语音（silk/amr）/ 飞书语音（opus）转码成功＝语音 → `stage_voice`；网页录音上传带 `voice=true`；拖入的音频文件仍当文件。
- **飞书语音接入**（`feishu.py`）：原本 `audio` 类型语音被 `_ingest_media` 外直接 `return` 丢弃，现按「语音消息」处理——opus 经 `ffmpeg` 转 mp3、`stage_voice_sync` 暂存，与 QQ 汇合到同一条 mimo 听音链路（不用 pilk，opus 直转）。

### 红线：不虚构联网信息（交叉验证）+ 未来任务主动确认设定时

- **不虚构联网 / 实时信息**（`policy.md`）：联网查到什么说什么，**绝不在搜索结果之外脑补/外推/补全**（尤其赛程/比分/日期/价格）；关键或易错事实**交叉验证**，单一来源不轻信、来源冲突如实讲分歧。治咕咕给 F1 赛果时凭单一来源瞎编。
- **未来要到点执行的活 = 定时任务**（`skills.md`）：用户提「明天 / X 点 / 每天 帮我做 / 收集 / 发 某事」时，**先主动确认**「要设成定时任务、到点自动做吗」→ 认可才 `create_scheduled_task`；铁规则「没真建成那条定时任务，就别口头答应会自动做」。治「明早 8 点收集战报」被当口头应承、没真落定时任务。

### 咕咕行为：问候口吻 + 建项目当规划伙伴

- **默认问候据「上次互动」定口吻**（`agent/greeting.py`）：生成问候前查最近一条对话消息的时间，告诉模型「距上次说话多久」并加硬规则——几小时内 / 今天 / 昨天**绝不说「好久不见 / 最近怎么样」**、自然接上；确实隔了多天才用久别重逢语气；无记录给轻松招呼。修「刚聊过还说好久不见」的出戏。
- **建项目当规划伙伴，别套模板**（`prompts/skills.md`）：建项目时按项目真实流程拟贴合的阶段 + 每段关键待办（「公司建立」就是 注册资质 → 组团队 → 启动 这种），别一律默认「计划 / 执行 / 交付」；用户只给名字时主动提方案、请其确认/微调再落。
- **多天 / 多任务的事倾向做成项目**（`prompts/skills.md`）：旅游 / 办展 / 装修 / 搬家这类倾向做成项目（能装阶段 + 待办 + 文件）而非只记日历事件，做成后主动给规划（如旅游列打包 / 订票待办）；闲聊 / 决策探索 / 情绪场景仍克制，不硬塞。
- **保存 / 创建文档 ≠ 把文件发给用户**（`prompts/skills.md` + `send_file` 工具描述）：创建文档后用一句话告诉用户存到哪个目录（同一文件本轮连续编辑只在「刚创建」那次报一次位置）；**绝不主动 `send_file`**——它在飞书 / QQ 是真把文件推到对方聊天，只有用户明确要（「发给我 / 给我那个文件」）才发。

### 日历提醒：要提醒就建一次性定时任务（治「空口承诺提醒」）

日历事件本身不会主动提醒，咕咕却常按常识空口承诺「会提前 X 分钟通知」而不真设。`skills.md` 加规则：要提醒必须 `create_event` 后再 `create_scheduled_task` 建 `@once` 一次性提醒（事件时间减提前量、`channels` 默认 web），并加**铁规则「没真建成定时任务就别说会提醒」**。

### 修：用户正用 QQ 聊天，咕咕却说「QQ 没绑定、扫码连」

用户在 QQ 上跟咕咕说「QQ 通知我」，咕咕却回「QQ 还没绑定，扫一下连上」——它根本不知道**当前这段对话就来自 QQ**（QQ 显然已连）。根因：系统提示从不注入「当前来源平台 / 已连 IM 渠道」，而 `create_scheduled_task` 工具又叫咕咕「设 qq/feishu 渠道前先确认绑定」，咕咕无从确认只能瞎猜。

- **注入来源 + 渠道连接情况**（`builder._source_block` / `loaders.load_im_channels`）：系统提示加「## 当前对话来源 / 通知渠道」——本次对话来自 QQ/飞书/网页、各 IM 渠道是否已连（据 `imreach`）。**当前来源平台强制标记已连**（用户正用它说话＝必然可达），并明示「无需再绑、绝不让 TA 扫码」。
- **`runner.py` / `web.py`** 透传 `source`（`req.source`/`"web"`）+ `im_channels` 给 `builder.build`。
- **工具描述订正**（`scheduled_tasks.py`）：`create_scheduled_task` 的渠道说明从「先确认绑定」改为「看系统提示的渠道连接情况，已连直接用、未连才提示绑」。

### 修：IM 路由把「确认用的嗯」当闲聊吞掉

咕咕问「要删吗 / 要建项目吗」后，用户回「嗯」确认，却被 Intent Router 当成闲聊——忙时 `drop`、空闲回个「嗯嗯～」**都不进主模型**，确认永远丢失。根因是路由不知道「咕咕刚问了用户问题」。

- **「等回话」标志**（`runtime_state.py` / `worker.py` / `router.py`）：咕咕回复以**问句/确认收尾**（`reply_awaits_answer`：结尾带 `？` 或「要不要/好吗/确认一下」等）时，worker 在回复定稿后置 `agentawait:{platform}:{puid}`（Redis，20min TTL；陈述句回复则清）。
- **路由放行**：网关把 awaiting 传进 `decide(text, state, awaiting)`；awaiting 为真时，这轮的「嗯/好/算了」走 `agent`（是对提问的回答），不再 `drop`/秒回吞掉。咕咕下条陈述回复自动清标志，恢复正常闲聊短路。
- 顺带发现 `WAITING_CONFIRM` 状态定义了但从未被 set（删除确认走的是工具层 `confirm` 参数，不靠状态机），文档已订正。

### 修：精力 100% 仍拦不住对话（封顶截断到 0 + IM 漏判）

精力满了却还能继续聊，三处根因一并修：

- **封顶按比例缩被 `int()` 截断到 0**（`quota.py cap_usage`）：`remaining` 很小、单轮 token 很大时（如 limit=1），`int(tin * remaining/total)` 截成 0 → `AgentUsage` 永远记 0、用量永远填不满上限、硬拦的 `used >= limit` 永不触发。改为**精确填满**剩余额度（tin 优先、余量给 tout），不再按比例缩。
- **IM / 定时任务路径根本没硬拦**：耗尽硬拦原本只在网页 `web.stream`，IM/定时走的 `runner.run_collect` 漏了。抽出 `quota.is_exhausted`（CST 6h/周同口径），`runner` 存完用户消息即判定耗尽、直接回「咕咕累了，休息会儿再来～」不再生成。
- **web 与 IM 口径统一**（`web.py`）：网页原为 UTC 窗口内联判定，改走同一个 `quota.is_exhausted`，两路硬拦口径一致。

### 修：精力配额与 DAU 统计时区错误（UTC → CST）

- **精力 6h 窗口**（`agent/quota.py`）：`six_h_window_start` 原按 UTC 整点切割（北京 08/14/20/02 点重置），改为 CST 整点（00/06/12/18）；UTC → CST 算槽位，再转回 UTC naive 供 DB 比较，与 `AgentUsage.created_at` 口径一致。
- **DAU 改为「登录即算」+ CST 今日 0 点**（`admin_analytics.py` / `auth.py` / `models`）：原 DAU 按 `AgentUsage` 统计（须发消息才算），且 `today_start` 用 UTC 午夜。改为 `User.last_active_at`：前端每次加载调 `/auth/me`，每小时最多写一次，CST 今日 0 点起有记录即算活跃。新增 `last_active_at` 字段 + migration `20260627000002`。

### 待办/阶段拖拽升级为实时让位（去动画 + 克隆无底框）

待办与阶段拖拽从 HTML5 drag 升级为**指针驱动**：拖动时其他元素**实时同步让位**（不再等落下才重排）；待办拖动名字即可排序、并可**跨阶段**拖到别的阶段；去掉让位过渡动画（直接到位，杜绝中线判断引发的抖动）；阶段克隆预览**只显克隆体、不带底色框**，与待办一致。定时任务编辑卡的提醒内容占位也从「该喝水啦～」改为「收集昨天的科技新闻」。`ProjectCard.vue` / `ProjectModal.vue` / `Schedules/index.vue`。

### 项目待办：拖拽排序

项目卡待办弹窗 + 项目编辑卡阶段待办，每条左侧加拖拽手柄（六点 grip，平时半隐、悬停浮现），原生 HTML5 drag 重排 → 落库（`persistTodos` / `saveStages`）。手柄独立于输入框：点字照常编辑、拖手柄才排序；编辑卡内限**同阶段**重排。`ProjectCard.vue` / `ProjectModal.vue`。

### 文件库：项目文件按状态分组（已完成按完成日期归档）

文件库「项目文件」从「按 startDate 年/月归档所有项目」改为**先按项目状态分组**（待开始 / 进行中 / 已完成，看板顺序、空组隐藏）；纯前端（`Files/index.vue`）：
- 待开始 / 进行中 → 直接平铺该状态项目；
- 已完成 → 按**完成日期 `doneAt`** 归档为 年 / 月 / 项目（与项目面板一致）；
- 三态文件夹配状态色 + 图标（待开始灰·时钟 / 进行中蓝·播放 / 已完成绿·对勾）；
- 面包屑、全局搜索跳文件均按状态重建路径。

### 日历：已完成项目统一淡化

日历各处（月视图 chip / 跨天项目条 / 当天日程 / 近期节点 / 「+N 更多」弹层）的已完成项目统一加 `cal-done` 淡化（opacity 0.45、hover 回 0.7），退到背景、不抢眼；只淡化项目，用户活动事件不受影响。`Calendar/index.vue`。

### 深夜对话时间语境（0–4 点以日出为一天的分界）

凌晨 0–4 点时，`builder.py` 在注入的当前时刻后附加提示：「以日出为一天的分界：用户口中的『今天』指尚未结束的这个主观白天（日历昨天），『明天』指日出后的那天（日历今天）」，让咕咕正确理解深夜说「明天」的语义。

### 关闭气泡通知自动标记导航栏已读

通知同时推送导航栏和气泡时，关闭气泡（点 ✕ 或被新气泡顶替）即调 `uiStore.markRead(notifId)` 标记已读。`liveNotification` 补带 `id` 字段，气泡 item 存 `notifId`，`dismiss()` 取出后调 markRead。纯 bubble-only 通知（无后端 id）不受影响。

### 聊天内扫码绑定 IM：咕咕直接给按钮

- **问「怎么加 IM」→ 咕咕给可点的扫码按钮**（`prompts/skills.md` + `GuguChat.vue`）：用户问「怎么绑定飞书 / QQ / 把你接到 IM」时，咕咕在回复里输出动作链接当按钮（`[扫码绑定飞书](gugu://bind-im/feishu)` / `qqbot`），不再讲后台手动步骤。前端把 `gugu://` 链接渲染成胶囊按钮、拦截点击，**聊天上弹小窗显示二维码**，扫码成功自动绑定 + 刷新会话。复用现有 `feishu/qq connect` 的 start/poll，后端零改动；弹窗用全局 `.popup-menu`（右键菜单同款玻璃）。

### 前端发版门：新版本自动清过期客户端状态

- **客户端状态版本门**（`utils/clientVersionGate.js` + `main.js` / `admin.js` + `vite(.admin).config.js`）：构建版本号（`__APP_VERSION__` = git 短哈希，无 git 回退构建时间戳）变化 → 应用启动时（`createApp` 前）清掉 `KEEP` 之外的所有 localStorage + 整个 sessionStorage，再写新版本号。修「发版后旧 localStorage 残留、新代码走旧逻辑」。保留登录态（`user_token` / `admin_token`）与无害偏好（球钉住 / 音量）；主站 `/` 与后台 `/admin` 同源共享 localStorage，`KEEP` 同含两边 token、同版本号只第一个触发清理，不互相清登录。版本号跟 git 提交走（改了代码提交才 bump，同提交重复构建不白清）。
- 配套（运维侧，需在 1Panel/nginx 配）：`index.html` 发 `no-cache`、`/assets`（带哈希）长缓存，确保新 JS 真加载、版本门跑到最新那套。

### 登录页底部加备案号与署名

登录页底部绝对定位一行小字：「Created by Claude with love · 苏ICP备2026042185号」，备案号链接工信部查询页。

### 隐私：决策轨迹脱敏（数据最小化）

后台「决策轨迹」原本能看任意用户会话的完整对话原文 + 工具内容 + 文件——改为**脱敏保留**：只暴露决策结构、不暴露用户内容，脱敏全在后端做（数据不出后端）。

- **正文 / 结果 / 文件 / 标题脱敏**（`agent_admin.py`）：对话正文 → 只给字数「〔已隐藏 · N 字〕」；工具结果 → 「〔结果已隐藏〕」（留成 / 败）；文件名 → `***`（留扩展名）；会话标题 → 「会话 #id」，并**禁用按标题搜索**（防凭关键词试探内容）。
- **工具入参按值类型脱敏**：数字 / id / 布尔（`project_id`/`folder_id` 等便于排查落位）保留，字符串值一律打码 `***`。
- **`agent.traj` 日志同口径脱敏**（`tools/base.py`）：工具调用日志的字符串参数打码、id / 数字保留，不再把文件名 / 客户名写进 `gugu.log`。
- 前端去掉「搜标题」框、改按用户名筛选（`Admin/Agent/index.vue`）。
- 保留排查能力：仍能看每轮调了哪些工具、落到哪个 id、成 / 败、token、轮次。

### 后台分析：DAU 改 WAU，纳入 IM 活跃

活跃指标从「今日活跃（DAU）」改为「周活跃（WAU）」：过去 7 天「对话过（`AgentUsage`，网页 + IM 都记）∪ 登录过网页（`last_active_at`）」按 user_id 去重。修原 DAU 只看 `last_active_at`（仅带 token 的网页请求更新）、漏掉**纯用 IM 不登网页**用户的问题。`admin_analytics.py` / `Admin/Analytics/index.vue`。

### 后台 / 数据

- **记录用户 `last_active_at` + 后台活跃统计**（`models` / `auth` / `admin_analytics` + 迁移 `20260627000002`）：User 加 `last_active_at` 列（可空、索引），用户活动时按 1 小时节流更新；后台基于它统计活跃用户。

### 修：delete_project 工具 ImportError 导致 agent 删项目必失败

agent 工具层 `_delete_project` 还在 `from app.api.v1.projects import rehome_project_files_to_personal`，但该函数在「删项目改为连文件软删」时已被移除，导致任何 agent 删项目请求都以 ImportError 崩溃。改为与 API 端一致：先 `UPDATE files SET deleted_at=now()`（软删），再 `DELETE project`（文件夹由 FK CASCADE 级联删）。

### 其它修复

- **阶段拖拽重排没把待办带走**（`ProjectModal.vue` `commitStageDrag`）：拖拽落下时原本只重排了 `label` 数组、再赋回原位置的阶段，导致 `todos`/`key` 留在原地——表现为「只改了阶段名，待办没跟走」，且当前阶段也会错位。改成和拖拽预览 `displayStages` 一致：**整个阶段对象（label + todos + key）一起搬**；`key` 为稳定身份、`updateStages` 不重排 key，故当前阶段按 key 正确跟随、进度据新位置重算。
- **已完成项目取消前面阶段的待办没退出已完成**（`ProjectModal.vue` `saveTodos`）：完成判据 `isLastFull` 只看当前（=最后）阶段进度，取消**前面阶段**的待办时当前阶段仍满 → 项目赖在「已完成」。改成 `fullyComplete = 最后阶段 + **所有阶段全部待办都勾选**`：取消任意阶段的待办、不再真 100% → 退出已完成、退回进行中；同一判据也用于「进入已完成」，**禁止非满项目进入已完成**。
- **新用户首登弹历史广播、撞新手引导**（`notifications.py` `_visible`）：通知可见性原本只按「目标匹配」，新用户没补弹记录 → 首登必弹一条旧广播气泡、和新手引导欢迎气泡撞车。加「**只看注册之后产生的通知**」闸（`created_at >= user.created_at`，列表 / 上线补弹 / 标已读统一生效）：刚注册的用户不补看历史广播，注册后的新广播照常收；新手引导走独立 onboarding 通道、不受影响。
- **IM 前置路由把话题误当成催咕咕 + 空闲催促答非所问**（`agent/router.py`）：① 情绪/催词原本**子串匹配**，「**法拉利**怎么这么慢」「这电脑太慢」含「怎么这么慢/太慢」就被当成催咕咕而短路（QQ 上回「在的，你说～」、消息没进 agent）→ 改成**句首锚定**（句首、或「你/咕咕」前缀才判），带话题主语的不再误判。② 催促（emotion）原本空闲时也短路回「在的你说」→ 改成**只在咕咕真在忙（思考/搜索/生成/等确认）时才拦**、回状态化的「还在想/正在弄」安抚，**空闲催促交主 Agent 正常回应**；「在吗」这类在场查询不受影响。（router 在 IM 网关进程，改后需重启 `gugu-supervisor` 生效。）

## [0.13.1] - 2026-06-27 · 新手引导系统 + 精力配额硬拦 + 默认问候咕咕生成 + 逐字流式统一

> 本版核心：新增**独立新手引导子系统**（注册播种「活的示例项目」+ claim-once 欢迎/情境/回头看气泡，全静态文案、不依赖 agent）；精力（Token 配额）从「软降级」改为**耗尽硬拦 + 满额封顶/冻结**（精力条不越 100%、满额不污染周精力）；对话默认问候改为**咕咕轻量生成**（带记忆、不计精力、打字机入场）；「咕咕逐字说话」的系统侧文案统一走 `genstream.typed_stream` 流式；外加通知气泡文字/调性打磨、删项目连文件删与弹窗 / UI 细节。

### 精力系统：耗尽硬拦 + 满额冻结 + 逐字流式提示

精力（Token 配额）从「软降级」改为「硬拦」，新增满额冻结与全局逐字流式。详见 `docs/agent/精力系统架构.md`。

- **耗尽硬拦**（`web.py` / `profiles/base.py`）：6h / 周配额用尽后不再「软降级只挡重操作」，改为直接回一句「咕咕累了，休息会儿再来～」并 return，聊天 / 查询一律不放行；移除 `degraded` / `light_tool_names` / `READ_ONLY_TOOLS`。
- **封顶 + 满额冻结记账**（新增 `agent/quota.py` `cap_usage`）：记账前按 6h 剩余额度封顶本轮用量——单轮对话顶过线只记「填满到上限」的部分、超出（对话后半段）丢弃，**精力条最多 100% 不越线**；6h 已满则本轮不写 `AgentUsage`（冻结），直到窗口整点重置。被封顶 / 冻结的 token 既不计 6h 也不计周；web `_generate` 与 runner（IM / 定时任务）两处记账都接，非 web 路径满额也不污染周精力。
- **空回复兜底覆盖全模型**（`core.py`）：原空气泡兜底只 gate 在 `is_mimo`，非 mimo 模型空正文会裸露成空气泡；去掉该门，任何模型空正文都兜。
- **逐字流式统一**（新增 `genstream.typed_stream` 通用件）：系统侧成段文案（硬拦提示、空回复兜底、核实补做说明）原本一次性整段蹦出，统一改走 `typed_stream` 逐字推送，与正常回复同款动画（续看快照保持一次性、不重演）。

### 对话框默认问候改为咕咕生成（轻量直连 + 打字机动画，不计精力）

打开对话框时那句默认问候，从写死的固定文案改成**咕咕在进入全新对话时生成一句**——带点记忆、像熟人开口。详见 `docs/agent/proposals/对话默认问候-生成方案.md`。

- **后端轻量生成**（`agent/greeting.py` + `GET /agent/greeting`）：组装记忆上下文（长期 fact + 近 7 天有动静的项目 + 近 7 天 daily + 近期日历提醒）→ 轻量 LLM 直连（参照 `_generate_title`：非流式、anthropic/openai 双路、mimo 关思考、`max_tokens=180`），**不走 agent 循环**。提示词硬约束：不自我介绍、不报功能菜单、暖、2~3 句、表情极简、结尾把话交回用户。失败/空 → 返回 `''`。
- **不计入精力 / 配额**：该调用不经 `web.stream`/`runner` 那条记 `AgentUsage` 的路，token 不写 `AgentUsage`、不扣配额。
- **只在进入「全新对话」时生成**（`useGreeting.js` + `GuguChat.vue`）：`greeting` 只活在本次页面生命周期、不跨刷新缓存（去掉 sessionStorage）。生成不再在 `DefaultLayout` 无条件触发——刷新常会停在老会话（`SESSION_KEY` 仍在、`loadSession` 拉回历史），那时默认问候根本不显示、生成纯属空跑。改为 `GuguChat` 挂载时据 `SESSION_KEY` 判断：有可恢复会话 → 不生成；无（首次访问 / 关过标签页 / 清过会话）→ 才后台预取（fire-and-forget）。
- **打开对话框时打字机动画显示**（`GuguChat.vue`）：默认问候改为占位空消息，`watch(open)` 在任何打开路径触发 `animateGreeting()`——那一刻取最新问候逐字冒出（走 `streaming`/`renderMdStream`，与咕咕回复同源），每条只播一次。
- **问候纳入对话**（`GuguChat.vue` + `web.py` + `AgentRequest`/`ChatRequest` 加 `greeting` 字段）：用户回复问候时，把已显示的问候随首条消息发给后端。否则模型把用户对问候的回复当成「对话刚开始」又重新打招呼。落地分两步：① 问候入库为本会话首条 assistant 消息（供会话回看显示；只写一行 `ConversationMessage`、不碰 `AgentUsage` → 仍不计精力）；② **新会话首轮把问候作为「对话开场」注入 system prompt**——不能只靠那条前导 assistant 历史，因为 `sanitize_messages` 的「开头必须是 user」规则（Anthropic/MiniMax 不许前导 assistant）会把它剥掉，模型就看不到自己已打招呼。注入后模型「知道」开场白、顺着接，不再重复寒暄。
- **大窗「新对话」不放问候**（`GuguChat.vue` `newSession`）：问候只在打开小窗时出现；大窗点「新对话」是干净起手、空白开始。
- **兜底池**（`useGreeting.js`）：生成没好/失败 → 从 5 条静态兜底随机取一条，**兜底同样走打字机动画**；文案不自我介绍、不报菜单、风格贴近咕咕。

### 通知气泡文字统一 + 调性放宽到「个人成长」

- **通知气泡文字对齐 GuguChat 小窗正文**（全局变量）：所有通知气泡正文从 12px / 次要色改为与聊天一致的 13px / 主色 / 行高 1.5。抽出全局 CSS 变量 `--gugu-body-size` / `--gugu-body-line`（`variables.css`），`GuguChat` 与 `NotificationBubble` 共用——一处定义、改一处全局生效。
- **5s 自动消失收窄为仅教程气泡**（`NotificationBubble.vue`）：打完停留 5s 自动收**只作用于新手引导气泡**（`gugu` 标记）；IM / 后台广播等其它通知恢复「留到手动关或被新气泡顶掉」。
- **调性放宽**（`persona.md` + README / overview / mvp / design）：从「面向创作者（插画 / 动画 / 设计自由职业者）」放宽到「陪伴**个人成长**」——面向任何有目标要推进的人（工作 / 创作 / 学习 / 生活，创作者是重点群体之一）。
- **自我介绍不报功能菜单**（`persona.md`）：被问「介绍自己 / 你能做什么」时，别像念说明书那样罗列功能清单（读着像把提示词背一遍），用一两句像朋友那样说清是谁、把话交回用户；能力让人用着发现。

### 新手引导 Phase 3：回头看（完成第 5 个项目）

完成第 5 个项目时，咕咕回头看一眼：「还记得『〈引导项目名〉』吗？(停 1.5s) 那时候这里只有两个文件，现在已经越来越热闹啦。」`projectStore.moveProject` 里项目转「已完成」、已完成数 ≥5 → `fireLookback()`（claim-once 只一次；文案 `{project_name}` 后端用 `seeded_project_name` 回填）。至此新手引导 Phase 1/2/3 全部落地。

### 新手引导 Phase 2：情境气泡（7 个「第一次」钩子）

各界面第一次操作时，咕咕缓一拍（统一 1s）冒一句轻提示——claim-once 在后端，只弹一次、跨设备/重登有效。

- **7 个钩子**（`fireHint(key)` → `claim hint:<key>`）：进文件库 / 文件库打开音频(🎵😌) / 进日历 / 进定时任务页 / 切换·推进阶段（😊 熟悉一点了吗？）/ 手动新建第一个项目后（好啦～以后想到什么都可以建一个项目）/ 绑定 QQ·飞书成功。接入点：`Files`/`Calendar`/`Schedules`/`ProjectCard`+`ProjectModal`/`stores/projects.js`/`ProfileModal`。
- **气泡文案标记**：`schedules` 用 `[[p]]` 在「还没有定时任务」后停 1s；`file_lib` 用 `[[slow]]` 让「不过…」三个点逐个慢慢冒。
- **顺带修复**：新建项目的阶段默认值会兜底复制「最近一个项目」的阶段——**排除播种的教程项目**（`NewProjectModal` + `onboarding/useOnboarding` 暴露 `onboardingProjectId`），否则教程的 🌱🌿💬 会污染第一个真实项目的阶段模板。

### 新手引导 Phase 1：注册播种 + 欢迎/引导气泡 + 高亮（独立子系统 `backend/onboarding/`）

新用户首次进来不再是空房间——咕咕提前布置好一个「活的示例项目」并主动打招呼。独立子系统、**不依赖 agent**，文案全静态随机、不过 LLM。详见 `docs/agent/proposals/新手引导-实现方案.md`。

- **注册播种**（`onboarding/seed.py`，注册 hook 调，幂等、一账号一次）：建引导项目（名 3 选 1 无 emoji / 三阶段带 🌱🌿💬 / 各阶段待办 / `start_date`=登陆日、`deadline`=+3 天）+ 2 个 markdown 文件（欢迎信 + 「可以删掉我」，标题/引用块/落款排版）+ 个人空间根目录 1 个 mp3「小惊喜」（`onboarding/assets/`，缺则跳过）+ 日历活动「和咕咕的第一天」。
- **自有数据 + claim-once**（`onboarding/models.py` `OnboardingState` 表、`state.py`）：一用户一行 JSON 状态；welcome/guide/各情境/回头看 首次 claim 返回随机文案 + 标记，之后空——天然「只触发一次」、跨设备/重登有效。
- **欢迎/引导气泡 + 高亮**（`useOnboarding.js`，接进 `DefaultLayout`）：进应用 1s 弹欢迎、再 ~4.5s 弹引导并**跳项目面板高亮引导项目卡（5s 一次「呼吸」光晕）**。气泡走通知 toast，文字对齐 GuguChat 聊天正文（13px/主色），打完停留 5s 自动消失。
- **打字机标记**（`NotificationBubble.vue`）：文案支持 `[[p]]/[[p:1500]]`（停顿）、`[[slow]]…[[/slow]]`（逐字慢速冒出，如文件库「不过…」三个点）。
- **Demo 控制面板** `/dev/onboarding`：重置 / 重新播种 / 立刻预览各气泡，便于不重注册反复测。
- **老用户隔离 + demo 仅 dev**：`state.claim()` 加 seeded 闸——没走过新引导（注册时被播种）的老用户 claim 一律 None，欢迎/引导/情境/回头看气泡都不打扰；`/dev/onboarding` 用 `import.meta.env.DEV` 条件注册，prod build 经 tree-shake 完全剔除（代码保留供 dev 调试）。`scripts/smoke_onboarding.py` 端到端冒烟 20 项全过。
- 注意：`backend/onboarding/` 不在 dev `uvicorn --reload` 监视目录，改后需启动加 `--reload-dir onboarding` 或强制触发 reload。

### 项目 / 弹窗 / UI 细节

- **删项目改为连文件一并删除 + 有内容弹确认**（`projects.py` / `ProjectModal.vue`）：原先删项目把文件「归位个人空间」（跑进个人文件），改为文件软删、文件夹随 FK 级联删；前端在项目有文件 / 文件夹时弹浏览器确认，没有则直接删。
- **新建项目卡 / 定时任务卡标题输入框统一**（`NewProjectModal.vue` / `Schedules/index.vue`）：标题框从「透明、悬停才浮白」改为与其余字段框一致的 `0.72` 白底 + `0.1` 边框 + 同款 focus（保留大字号粗体）。
- **GuguChat 附件按钮与发送按钮垂直对齐**（`GuguChat.vue`）：附件按钮补固定高度（28 / 放大 32）与发送按钮等高，底对齐时中心也对齐。
- **项目卡悬停高光淡入淡出**（`ProjectCard.vue`）：悬停高光此前是瞬间出现——根因是高光用 `linear-gradient` 实现，而 `transition: background` 对 gradient 不生效（background-image 非可动画属性）。改为常驻微光放 `::before` 静态底层、悬停强高光放 `::after` 用 `opacity: 0→1` 淡入淡出（0.25s），移入移出都平滑。

---

## [0.13.0] - 2026-06-27 · MiMo接入、可靠性守卫体系、通知系统升级与全面体验打磨

> 本版核心：接入小米 MiMo 双格式模型；Agent 可靠性从「提示词软约束」升级为「代码多层硬守卫」；通知系统落库持久化 + 气泡流式打字机；SearXNG 替代 Tavily 承接通用搜索；对话状态指示动画化并全后台可配；外加文本预览稳定化、一批前端交互与 UI 细节打磨。

### MiMo（小米）模型接入 + 双 API 格式适配

- **后台新增 MiMo provider**（`Admin/Agent/index.vue`）：供应商下拉加「MiMo (小米)」（默认 `mimo-v2.5`，橙色圆点）；`mimo-v2.5` 同时支持看图 + 深度思考 + 1M 上下文，`mimo-v2.5-pro` 纯文本不看图。
- **API 格式显式可选**（`api_format` 字段）：MiMo 提供 OpenAI / Anthropic 两套兼容 API，预设里可选格式（留空=按 provider 自动判）；选 Anthropic 时前端自动切 base_url 后缀。后端抽出唯一判定口 `llm_select.use_anthropic_for(ai)`，聊天/记忆/IM 五处重复逻辑统一，杜绝「聊天走 anthropic、记忆还走 openai」的不一致。
- **空气泡根治**：mimo 推理模型偶尔整轮输出落进 `reasoning_content`、`content` 为空 → 空气泡。双层修复：① 传 `thinking:{type:disabled}` 从源头消除；② 仍空时追一轮要正文，再空给一句兜底，绝不留空气泡。走 Anthropic 格式可原生处理思考块 + `read_file` 看库内图，功能最全；去掉 `cache_control`（mimo 无 prompt caching）。
- **修复：MiMo 标题不更新**：标题调用未禁 mimo 的思考，`max_tokens=30` 被思考块吃光 → 标题空 → 回退首句截断。改传 `thinking:disabled`，从 `content` 挑真正的 text 块，`max_tokens` 提到 40。
- **修复：流式首条空气泡**（`genstream.py`）：`adapters/web` 先 `create_task` 后 `subscribe`，生成的头几个 token 在订阅建好前被 publish 掉丢失。新增 `open_subscription()` **先 attach 再启动生成**，订阅就绪后频道消息进缓冲不丢。

### Agent 可靠性：多层硬守卫体系

实战逮到「说了没做」「复制落错位置」「update 谎报成功」等多类执行幻觉，从代码层面硬化：

- **跨项目复制/移动落错位置**（`tools/files.py`）：未指定 folder 时默认继承源文件夹（属于原项目），实际落回原地。抽 `_target_loc` 统一定位：跨项目/空间又没指定 folder → 落目标根目录，不继承源文件夹。
- **update 类工具杜绝空转报成功**：`update_client`/`update_event`/`update_scheduled_task`/`update_todo` 没提供任何改动字段时改返回错误并提示该传哪些，不再空转谎报 success。
- **核实轮强制真查**（`core.py`）：自我核实加 `verify_queried` 跟踪——核实轮只嘴上说「没问题」却没真调查询工具时，注入 `_VERIFY_FORCE_PROMPT` 强制再追一轮真调 `read_file`/`list_*` 查证，防「凭印象说做完了」。`MAX_VERIFY` 3→5 封顶。
- **narration / 完成断言检测**（`core.py`）：检测模型用文字假装读/改文件却没真调工具，`_NARRATION_NUDGE` 强制纠偏。精度踩坑——口语高发词误触发 → 最终收窄到只收强 CRUD 动词（建/创建/保存/删/发/移/归档/重命名），实测 0/13 误触发、0/10 漏抓。
- **决策守卫**（`core.py` `_is_decision_dodge`）：用户消息含改动命令 + 回复含「不用改/已合理」+ 本轮零工具，三信号齐备时注入 `_DECISION_NUDGE` 逼执行或问清。实测 4 抓 6 放零误伤（求澄清/已动手/问句均不误判）。
- **`edit_file` 差异校验**（`files.py`）：原文 ≥200 字且改后 <50% 时结果加 `warning`，逼模型 `read_file` 读回核对（非阻塞）。
- **工具调用轨迹日志**（`tools/base.py`）：`registry.dispatch` 每次落一行 JSON（tool、args 摘要、ok、ms、user）到 `agent.traj`，三出口全覆盖，`grep '"t": "tool"'` 翻一眼即知。
- **工具注册契约 fail-fast**（`SkillRegistry.add`）：重名/空名/`input_schema` 非 object/handler 不可调用 → 启动期抛 `ToolContractError`，实测 55 工具全过、4 类违规全拦。
- **可靠性架构文档**：新增 `docs/agent/agent-reliability.md`（Execution Verifier 执行验证层：信 Tool 不信 Assistant）+ `docs/agent/agent-architecture.md`（可靠性执行链路 + 系统模块全景图）。

### Agent 人格与知识边界

- **记忆边界：根治「伪个性化幻觉」**：空记忆/新用户下咕咕会硬编「你之前聊过 X」。修复：`persona.md` + `policy.md` 加「不虚构共同历史」红线；`_memory_block` 空记忆时注入「暂无长期记忆——别假装记得任何共同经历」锚点。实测三风格全 0 脑补，活泼语气也没放大。
- **emoji 红线：输出层确定性兜底**：`persona` 明令不用阴阳/情绪表情，但活泼语气下照冒（token 级习惯，prompt 治不了）。`sanitize.strip_disallowed_emoji` 白名单制（27 个内容表情）之外的 emoji 连前导空格一起删；挂三出口（web 流式/IM/定时），实测违规全 0。
- **不确定就主动查证**：去掉 `skills.md` 的「省工具」框架——`web_search` 走自建搜索免费，该用就用；`persona.md` 加「不确定就去查证，别糊弄」，限定在新词/热梗/近期事件/易变事实，稳定常识仍直接答。实测「月薪喵是什么」→ 主动搜给真实含义，「Python 是什么」→ 直接答不多搜。
- **看图信自己的眼睛**：被问「这是谁」时咕咕会反射性 `web_search`「核实」，但网页搜文字帮不了认图（还白白多走一轮、token 涨 2 万+）。`persona.md` 加「看图类问题凭看到的直接答，只有要图本身给不了的外部信息才联网」。
- **对外口径：堵住工具名泄露**：新增工具后咕咕会抖出 `web_search`/`http_get` 等工具名和调用步骤。`policy.md` 补禁用名单 + 专门口径（只用能力说法答，不报名），实测 4 类套话全 0 泄露。
- **语气和善底线**：`persona.md` 新增「和善底线」——纠正方案不纠正人、归因到事实而非人、别让用户反过来照顾 AI 情绪、自然转弯不急刹车、把选择权交还用户。与「语气/长度」偏好设置衔接：简短≠生硬、正式≠冷淡，真诚与和善是底线、不在可调范围。

### 联网搜索分层：SearXNG（通用）+ Tavily（深度）

- **`web_search` → 自建 SearXNG**（`tools/search.py`）：通用搜索免费无配额，返回标题+链接+摘要；国内固定带 `sogou/quark/360search` 避开被墙引擎；后台可配地址/引擎 + 测试按钮（`Admin → Agent → 联网搜索`），SearXNG 测试会列出可达/超时引擎。
- **Tavily → `deep_research`**：原 `web_search`(Tavily) 改名，定位「读网页正文 + 总结/比较/研究」，保留每日次数配额（`SearchUsage`，SearXNG 不计）。路由准则：普通查找走 SearXNG，需读正文或给引用走 Tavily。目标：~80% 普通联网走免费 SearXNG。
- **prompt skills 系统**（新 `agent/skills/`）：带触发条件的「剧本」md，**按需加载**——builder 只注入索引（每个一行 name+描述），模型相关时调 `use_skill(name)` 拉正文，skill 数量可无限扩不撑上下文。
- **`http_get(url)` 工具**（`tools/web.py`）：prompt skills 的联网执行原语；含 SSRF 私网拦截（私网/环回/链路本地/元数据全拦）、不跟随重定向、响应截断 4000。**weather skill**：抓 `wttr.in/{城市}` 转人话。工具数 51→53。
- **`agent/skills/` → `agent/tools/` 改名**：原 skills 目录全是函数调用工具，改名对齐语义；新 `agent/skills/` 专放 prompt skill 剧本。

### 通知系统：持久化 + 流式气泡 + 已读追踪

- **通知落库 + 按用户已读**：新表 `notification_reads`；`site_notifications` 加 `bubble`/`persist`/`bubble_expire_at` 三列（Alembic `20260626000002`），通知一律落库，气泡落库才能离线补弹。
- **两渠道独立发布**：`bubble`（弹气泡）/ `persist`（进通知中心）可分别开关。后台发布页加**气泡时限**（永久/1天/3天/7天，默认 1 天）。
- **导航栏通知中心（持久态）**：`GET /notifications`（仅 persist=true）+ 标已读落库；前端 onMounted 拉全量 + 实时 SSE 追加，关浏览器重开仍在，未读数从后端来。
- **气泡上线补弹**：实时在线立即弹；离线者上线时补弹最近一条有效气泡（只一次，localStorage 记已弹 id，带 TTL 过期后不补）。
- **气泡流式打字机**（`NotificationBubble.vue`）：新通知**标题逐字冒出（30ms/字）→ 正文逐字流式（15ms/字）**，走 `MarkdownView` 渲染已打出子串；全局单计时器只让最新一条打字；标题圆点接收时脉冲，打完恢复。
- **通知支持无标题**：`title` 改可选（标题/内容不可同时为空），气泡/侧边栏/预览均按无标题渲染，气泡无标题时内容首行绕开 ✕ 占位。
- **气泡组件**（`NotificationBubble.vue`）：玻璃风（blur + 20px 圆角 + glass-shadow），固定 360px 与小窗/播放器严格同宽（border-box 三件对齐）；新通知把旧的顶上去（旧条 `nb-move` 上移 0.5s 后消失）；最新这条不自动超时，由用户关闭或被下一条顶替；开/合以咕咕球圆心为缩放原点。
- **气泡与侧边栏解耦**：气泡存独立快照，关闭气泡不影响侧边栏通知列表；修复点气泡 ✕ 连带关掉侧边栏弹窗的 bug（`closeAll` 加 `.nb-stack` 守卫）。
- **独立 `MarkdownView` 组件**（`utils/markdown.js`）：轻量独立 `marked` 实例（GFM + 软换行 + 链接新标签），与 GuguChat 的全局配置互不影响；通知气泡/侧边栏/聊天统一同款 md 样式。
- **气泡动态锚点**（`uiStore.chatNotifyAnchor`）：小窗/播放器展开时实时写入距视口底部距离，气泡始终浮在其正上方，`transition: bottom 0.42s` 平滑避让。
- **后台通知发布页**（`Admin/Notifications`）：填标题（可选）+ 内容（支持 Markdown），预览 1:1 复刻真实气泡，一键发送给所有在线用户 + 历史列表/删除。
- **广播后端**（`notifications_admin.py`）：写库 + 发布到 Redis `events:__broadcast__`；`events.stream()` 同时订阅用户个人频道与广播频道。

### 对话状态指示：全可配 + 动画化

- **状态命名后台可配**（`Admin/Agent/index.vue` 新标签页）：可改全部状态显示名——特殊状态（思考中/整理中/复查前缀）+ 每个工具（~55 个，带筛选框）；留空回退默认，保存即热生效（后台 `StateLabelSettings` + `config.override.json`）。
- **一态多名随机显示**：任一命名值用 `|` 分隔填多个，每次随机取一条；工具名由后端 `_pick_label` 每次发事件时抽，思考态由前端每次进入思考时抽。
- **单一数据源**：工具名/复查前缀/整理中由**后端**在 `tool_call` 事件里解析好下发，前端直接显示，撤掉前端拼「复查 ·」前缀；思考态经 `GET /agent/ui-labels` 取。
- **打字机入场 + 排队切换**（`GuguChat.vue`）：状态文字逐字冒出，配轻微「冒泡」入场动画；SSE 状态事件**入队逐个播放**，每条打完字 + 最短驻留才切下一条，不再一闪而过。真回复 token 一到即打断队列让位正文。
- **思考默认回三个点**：`core.py` `_thinking` 默认空 → 显示三个点动画；后台填了文字才显示带 spinner 的文字气泡。
- **自检轮气泡治理**：复查轮 `tool_done` 原来把 `thinking` 重置为真（=3 个点），但复查正文被缓冲丢弃，导致点点残留到 `done`。改为：复查工具打 `verify` 标记，`tool_done` 时 `thinking = !evt.verify`；复查状态显示「复查 · X」与主回复区分，既消除残留点点又可观测。

### 文本预览稳定化 + 浮动窗口增强

- **文本文件走浮动窗口预览**：`preview.js` 把 `isTextExt`（MD/TXT/代码等）路由到浮动窗口；`FloatPreviewWindow` 新增文本分支（下载 blob → `TextViewer` 渲染），默认 720×520，支持拖拽/最大化/多开；MD 有 markdown 渲染，代码文件有高亮。
- **稳定即时刷新**（`GuguChat.vue`）：文件工具 `tool_done` 即 `liveStore.bump('files')`，确定性触发预览重载，不靠会丢的 events SSE 兜底；推广到 projects/calendar。
- **TextViewer 滚动位置存 localStorage**：按 `fileKey` 存，跨组件重建/整页刷新都保留；新内容更短时浏览器自动夹到底。
- **下载 URL cache-bust**：刷新时带 `?_t=`，避免浏览器返回缓存旧内容。
- **文本预览可选中复制**（`TextViewer.vue`）：覆盖预览弹窗的 `user-select:none`，正文可选/复制，行号仍不可选。
- **浮动窗口：内容刷新不重置位置**（`FloatPreviewWindow.vue`）：`liveStore.rev.files` 触发的重载传 `refresh=true`，`load()` 在 `refresh && ready` 时跳过 `fitWindow()`，窗口位置/尺寸原地保留，仅 `blobUrl` 更新。
- **SSE 断线重连补偿**（`live.js`）：重连成功后 bump 所有 rev，补上断线期间漏掉的资源变更，不用手动刷页面。
- **工具集漂移修复**：`_PROJECT_TOOLS`/`_FILE_TOOLS` 与后端 `RESOURCE_BY_TOOL` 不同步导致连回合末兜底都漏刷，已对齐并加注释防再漂移。

### 前端交互与 UI 打磨

- **GuguChat 展开大窗跳底**：`enterExpanded()` 加 ResizeObserver 在 0.42s 过渡期间持续跟底，对齐 `exitExpanded()` 行为；修复原来只在 nextTick 后设一次 scrollTop 随即失效的问题。
- **日历多选：单日悬停不切侧边栏**（`Calendar/index.vue`）：`activeRange` 在 anchor=hoverRangeEnd 时返回 `null`，只有真正跨天拖选后才切「添加项目」模式。
- **定时任务时间输入改文本框**（`Schedules/index.vue`）：不弹系统选择器；宽度与 DatePicker 等宽，文字居中；`title-input`/input/textarea/select/`repeat-tab` 圆角统一 `var(--radius-sm)`，去除 `corner-shape: squircle`。
- **项目卡悬停亮色高光**（`ProjectCard.vue`）：`::after` 伪元素顶部白色渐变 + inset 描边，hover 时明显增亮（`rgba(255,255,255,0.55)`），transition 过渡顺滑。
- **看板「新建项目」卡悬停亮色**（`KanbanColumn.vue`）：hover 背景从暗（`0.05`）修正为 `rgba(255,255,255,0.3)`，与项目卡风格对齐。
- **ProjectModal 删除阶段按钮位置修复**：`.node-row` 加 `padding-right: 8px`，防止「×」按钮落在阶段分割线上。
- **项目编辑卡阶段区版面记忆**（`pmStagesExpanded`）：展开（50/50 版面）状态持久化到用户偏好，重开保留上次版面。
- **GuguChat 小窗/播放器/气泡严格同宽**（360px border-box）；音乐播放器随聊天展开缩回咕咕球；FAB 只跳图标、圆圈完全静止。
- **新建项目状态球**：顶部胶囊改为 14px 圆形状态球，点击循环切换三态，悬浮缩放 1.2×；修复与名称输入框重叠。
- **DatePicker 样式统一**：边框色/背景/内边距与其他表单对齐，打开状态加紫色 focus 环。
- **定时任务试运行 Toast**：「试运行」结果从浏览器 `alert()` 改为页面内 Toast 提示。
- **颜色格方形化**：新建项目颜色格从圆形改为 6px 圆角方块；分割线宽度统一（纵向改用渐变色）。
- **数据分析趋势图增强**（`Admin/Analytics`）：折线改为 canvas 渐变填充；hover 显示跨系列 tooltip；自定义 crosshairPlugin 白色竖线指示当前日期。

### 项目与工作流增强

- **全局搜索准确跳转**：对话搜索滚到并高亮命中消息（`data-db-id` + `_flashChatMessage`）；日程搜索切换到对应月份并高亮目标条目；两处均有 1.8s 渐隐紫色高亮动画。后端消息列表每条加 `id` 字段，搜索命中时附带 `message_id`。
- **全局搜索拼音/罗马音匹配**（`utils/romaji.py`）：纯 ASCII query 自动走罗马音分支（pypinyin + pykakasi），搜 `riqi` 命中「日期」，搜 `yorushika` 命中「ヨルシカ」。
- **全局搜索点项目 → 高亮项目卡**：照 file/event 跳转的 `pendingXxx` 模式，点项目跳到项目面板、对应卡片滚到中央 + 紫色高亮环闪一下，不再弹编辑窗。
- **待办全完成自动进下一阶段**（`ProjectCard.vue`）：勾完当前阶段最后一个待办 → 自动推进下一阶段，与 `ProjectModal` 已有逻辑对齐；空阶段/最后阶段不动，取消勾选不推进。
- **项目卡：点击阶段名快速操作待办**：阶段名变可点击触发器（hover 浅底 + 小箭头，有待办时附完成计数），弹出当前阶段待办弹层（Teleport 到 body，玻璃面板风），支持勾选/编辑/删除/添加，点外部或 Esc 关闭。
- **mode2 文件卡拖影尺寸修复**（`usePhysicsDrag.js`）：stages-expanded 下文件卡 `aspect-ratio` 压扁，拖影克隆体挂 body 后丢上下文 → 尺寸回落更大。给物理拖拽加 `cloneClass` 选项，mode2 时给克隆体打标记类补回版式，拖影与面板卡严丝合缝。
- **修复：多工具对话后追问报「咕咕开小差了」**（孤儿 tool_result）：历史截断时丢掉打头的 `assistant(tool_use)` 把紧跟的 `tool_result` 变孤儿 → MiniMax 400 → 「咕咕开小差了」。`sanitize_messages` 改为按位置标记合法相邻对，丢前导 assistant 时同步剥掉遗留孤儿 tool_result。

### 其他

- **前端代码复用重构**：提取 `useSorting`/`useUploadQueue`/`useBoxSelection` 三个 composable，消除 Files 和 ProjectModal 间约 180 行重复代码；`DatePicker`/`DateSpanPicker` 统一在 `main.js` 全局注册。
- **AI 回复文件编号外漏修复**：文件列表去掉 `[id=xxx]` 前缀，工具按文件名定位足够，编号只在同名歧义时才需要；Admin Agent 行为开关改为点击即时保存，不再需要额外点「保存」。
- **缩略图减负**：`Image.draft()` 大图快速降采样解码 + `Semaphore(核数-1)` 并发闸，2 核机上传后不再占满双核卡请求。
- **开发服务器稳定性**：uvicorn `--reload` 限定监听 `app/` + `agent/` 两目录，不再 watch 整个 backend（含 .venv），pip install 不触发大量连锁重启。
- **后台管理员用户名走 env**（`ADMIN_USERNAME`，默认 `admin`），与 `ADMIN_PASSWORD` 同款。改 `.env` 后重启即生效。


---


## [0.12.0] - 2026-06-25 · 并发扩量、定时任务、IM 强化与体验打磨

> 本版核心：worker 从串行并发化、配多 key 分流扩到 50+ 人；落地用户定时任务 + 提醒工作流；
> IM 交互（斜杠命令 / 取消打断 / 多模态）与网页聊天体验大幅强化；外加一大批文件系统、看板、
> Admin、防幻觉与运维打磨。下面按主题归并（开发期约 50 个迭代小节）。

### 并发扩量与性能（worker 串行 → 50+ 人）

- **worker 串行 → 有界并发**：`run_once` 的 `for await` 改 `asyncio.create_task` 并发派发 + 全局 `Semaphore`；`user_gate(puid)` 进程内锁同用户串行保序、不同用户并发（单机即终态）；优雅 drain（SIGTERM 等在跑的跑完再退）；`msg_id` SETNX 幂等去重（修 `claim_stale` 重投）。实测 ~6×（串行 ~21 → 并发 ~190 条/分，带工具）
- **多 key 分流（pick_model 模型解析层）**：`agent/llm_select.py` 统一「选哪个模型」决策点；`pool` 策略把请求散到多个 key（`random`/`round_robin`/`least_loaded` 最少在途），**总并发 ≈ key 数 × 16**；实测 2 key 把 sem=24 从 0/24 救成 24/24，不等速 key 下「最少在途」吞吐 +37%
- **⑦ 慢尾兜底**：`core._stream_round` 对 429/超时/网络/5xx 在出 token 前退避重试（1/2/4s），sem=20 带工具从 0/12 → 12/12
- **配额耗尽能力降级**：不再一刀切拦死，降到只读工具集（12/47）+ 婉拒重操作，查询/对话照常（`profile.light_tool_names`）
- **连接池 + SSE**：SSE 鉴权改 `get_current_user_id`（不查 DB），长连接不再占连接池；池调优 `pool_size=15`/`max_overflow=25`/`timeout=10`/`recycle=1800`——修「试运行/重启后整站卡死」
- **地基加固**：稳定 consumer 名 `{host}`（重启复用、不再积累）+ 启动清死 consumer；`MAX_ROUNDS → 6`；`worker_concurrency` 后台可热配（30s 热读）
- 压测详见 [`docs/ops/并发压测结果.md`](docs/ops/并发压测结果.md)（单条 17.9s→4.3s、串行 vs 并发、升压拐点、1000 用户容量模型）

### 定时任务 + 提醒工作流

- **用户自定义定时任务**：`scheduled_tasks` 表（DB 驱动），worker 单实例每 ~30s reconcile 到 APScheduler（增删改开关即时生效）；`/schedules` 页 CRUD + 试运行 + 排程选择器
- **提醒工作流重构**：结果**不进对话**——`execute_task` 用 `run_ephemeral` 跑 agent（不建 session/不写消息/不推 sessions 事件），改投递到侧边栏铃铛通知(SSE) + IM 主动 DM；移除 `reminder` 动作类型，统一走 agent；上下文注入消歧（payload 里「我」= 用户）
- **多平台精确投递**：web 通知 / 飞书 / QQ **分别勾选**、各自独立；`imreach:{uid}:{platform}` 按平台存址互不覆盖；飞书连接时存 `open_id` → 免先聊天即可投递；解绑清址 + 投递前校验活绑定，防误发旧账号
- **对话历史压缩（新）**：超长会话把旧消息**滚动**总结成摘要，注入 system prompt 省 token（不当消息发给 LLM）；后台「对话历史压缩」开关（`conv_compress_enabled`，默认开，可关）
- 重复模式改场景选择器（每日/工作日/周末/自定义）；单次任务执行后自动删除；试运行同步返回各渠道结果（已发送/无地址/失败）；频道选项按 IM 绑定动态显示

### IM 交互强化

- **斜杠强制命令** `/stop`·`/status`·`/help`：网关层确定性触发，绕过关键词分类，比自然语言取消稳；非命令（路径/未知）不吞、照常走对话
- **自然语言取消·流式途中可打断**：core 工具循环原只在轮顶查取消，单轮长回答打不断——改为流式输出每 24 token 协作查、命中即 `close stream` 断上游，真正掐断生成
- **轻量 Intent Router + State Manager（Phase 1.7）**：任务进行中的「还在吗/算了/嗯」网关据 Redis 状态短路、不进主模型；状态机走 Redis（worker 写、网关读，带 TTL 防卡死）
- **多模态看图增强**：大图自动压缩、HEIC/HEIF（`pillow-heif`）、`read_file` 看文件库内图（vision + Anthropic）
- **IM 出口兜底**（`agent/outbound.py`）：发用户前确定性清洗 tool_id / 拦系统提示词泄露；空回复兜底（绝不发空）

### 咕咕聊天（网页）体验

- **多会话流式隔离 + 切换实时续看**：流绑定归属会话（修「回复串到别的会话」），切走 abort、切回 `resumeStream` 补快照再续；`genstream` 后台解耦，刷新/切换不丢回复
- **消息图片缩略图 / 拖入上传 / 滚动跟随**：气泡缩略图（复用 `useThumbCache`，刷新后按 `attach_id` 取暂存图）；大小窗整窗拖入多文件；大窗流式跟随脱手修复、发消息即时跳底
- **侧栏 IM 接入抽屉**：飞书/QQ 两个可展开抽屉，未接入显示「扫码连接」，接入后变会话抽屉

### 文件系统与项目

- **文件工具集合操作**：`move_items`（文件 + 文件夹**递归整搬**，后端展开）取代单文件 move；`rename_file`/`edit_file` 批量；逐项如实回报，呼应防幻觉
- **存储↔DB 对账与修复工具**（Admin·数据库）：以物理存储为准核对，幽灵（DB 有文件没）/ 孤儿（文件在 DB 无记录）明细 + 导入/删除修复
- **项目删除遗留孤儿修复**：删项目前 `rehome_project_files_to_personal`，文件干净归个人而非变孤儿泄漏进个人视图
- **OSS 预签名直传**：`storage.backend=='oss'` 自动走浏览器直传（presign/confirm 两端点），`local` 仍走代理，省服务器中转带宽
- **项目进度口径统一**为「所有阶段待办已完成/总数」（看板/总览/编辑卡/日历/胶囊一致），阶段条各阶段独立涨
- 文件夹删除改软删进回收站；项目卡拖放上传 + 文件数实时徽章；编辑卡 Shift/Ctrl 多选快捷键；已完成列「最近完成」置顶

### 界面打磨

- **卡片拖拽物理效果**（`usePhysicsDrag`）：弹簧跟手、FLIP 占位收合、落点让位/换列双克隆飞行/吸入文件夹，落点滚动到位；接入看板/文件库/编辑卡
- **看板进度条瀑布动画**（per-stage 填充 + 全局 ease-out 错峰）+ 滚动条 `scrollbar-gutter: stable`
- **通知面板** Markdown 渲染 + 高度自适应不溢出（按视口动态算、铃铛靠下时上移）
- 弹窗样式统一（排序改走 `ContextMenu` 修毛玻璃失效、清全局样式泄漏）；项目卡名称悬停浮出编辑框
- 顶栏/定时任务按钮 Phosphor 图标；`AdminSelect` 自定义下拉（自适应宽度）；站内全局搜索（顶栏跨项目/文件/文件夹/日程/客户/对话 6 类）
- 隐私政策独立页 `/privacy`（无需登录）+ 注册页内测提示勾选
- PDF 预览修 iframe 滚动/开关时整页闪烁（移 OOPIF 无效 `backdrop-filter` + `will-change` 稳定 GPU 层）

### Agent 提示词与防幻觉

- **提示词分层**：persona（角色）/ skills（执行规则·真实性铁律·confirm）/ policy（内容红线 + 对外口径「以伙伴示人」）/ default（数据模板），后台分别可编辑
- **防幻觉增强**：概览每轮注入各空间文件真值；数量只数本轮 success；被质疑数量/结果**必重查**、禁止甩锅编造；时间一律以 `{now}` 为准
- **咕咕中文化**：注入上下文时项目状态英文枚举 → 中文（待开始/进行中/已完成）、文件位置用项目名不用编号；policy 加规则——内部 id/编号绝不对用户说、字段状态一律中文、不夹生英文
- 改文件内容前先 `read_file` 拿最新（防覆盖用户外部改动）

### Admin / 后台

- 服务状态页**队列水位监控**（`im:inbound` length / 消费组 lag / pending，超阈值标黄）
- **用户反馈功能**（提交入口 + Admin 分页列表 + SMTP 邮件通知）+ 反馈页深色 glass 重写
- **SMTP 邮件系统**配置卡片（SSL/STARTTLS 切换 + 测试发送）
- Admin 导航图标全换 Phosphor

### 运维 / 文档

- **systemd 托管 worker / supervisor**（`Restart=always`，supervisor `KillMode=control-group`）；`make install` 一次装全 3 个——修「漏重启 worker → 进程死了不自动拉起、消息无限排队」的生产隐患
- **文档收口**：`开发链路-roadmap.md` → `并发优化ROADMAP.md`（单一权威，P0–P4 + ①–⑨ + 压测），新增 `并发压测结果.md`，删旧 `并发与性能优化.md`；`agent.md` 重整为纯架构参考（1059→418）、`agent-决策环.md` 同步并发现状

### 修复

- **配置 override 漏 `agent` 段合并**（存量 bug）：`apply_override` 没有 agent 合并块 → 整个 agent 行为配置 override 失效（对话压缩/worker_concurrency/memory_enabled 保存后读默认值），已补
- **对话压缩致命 bug**：摘要原以 `role="summary"` 当消息发给 LLM（API 只认 user/assistant 会报错）→ 改注入 system prompt；messages 端点过滤摘要气泡
- **`read_file` 读 PDF/Office 报「找不到文件」误导**：服务器没装 `pdftotext`/`libreoffice` 时 `FileNotFoundError`（命令不存在）被误读成「用户文件丢了」→ 改报命令未装、文件完好、勿建议删除
- 一批：文件夹文件数漏排回收站、项目卡计数漏算文件夹内文件、换头像不实时（URL 挂 mtime 版本号）、Admin 工具分布接口 500（jsonb 标量）、顶栏白色伪影带、缩略图缺文件 500→404、`move_file` 回报落点补项目信息、IM 空回复发 QQ 被拒、项目卡双层圆角、已完成卡进度条下移、`ProjectCard`/`ProjectModal` TDZ

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