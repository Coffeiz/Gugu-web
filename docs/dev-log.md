# PM Studio · 早期开发记录

> 更新：2026-06-23
> 状态：早期阶段记录，当前进度见 `docs/overview.md`

---

## 2026-06-23 · QQ 接入：从「以为是合作墙」到扫码自动连接（根因拆解）🦐

**结论先行**：QQ 实现了「手机扫码 → QQ App 内选 bot 授权 → 咕咕自动填好 AppSecret」，体验等同 QwenPaw/OpenClaw。**实测整套 q.qq.com 接口无鉴权、无需任何合作方资质**——一度误判为「腾讯官方合作墙」，被用户的实测和扒源码推翻。这条记录的价值在于**纠错过程**：别想当然把「看起来很官方的能力」判成够不着。

### 背景诉求

用户要的不是"填 AppID/Secret"，而是 QwenPaw 那种「扫码即连、自动填 key」。先做了两版都不对：
1. **共享 bot + 用户验证码绑定** —— 用户要的是每人自带 bot（BYO），不是一个共享 bot。
2. **BYO + 二维码指向 `q.qq.com` 网页** —— 用户指出 QwenPaw 扫码进的是 **QQ App 内授权页**，不是网页。

### 几次误判（关键教训）

| 当时判断 | 实际 | 错在哪 |
|---|---|---|
| 「扫码即创是飞书 openclaw CLI 的非公开接口，QQ 没有」 | QQ 有公开的 bind_task 流程 | 没去查 QQ 侧，拿飞书经验套 |
| 「`source=QwenPaw` 是注册过的接入方白名单，独立项目用不了」 | source 只是标签，`source=Gugu` 照样跳转 | 没让用户实测就下结论 |
| 「扫码进 QQ App 选 bot 是腾讯给合作方的原生深链，复刻不了」 | 就是个带 `task_id` 的普通网页(QQ webview 打开)，task 由公开接口创建 | 把"看起来原生/官方"等同于"够不着" |

### 拆解真相的两步

1. **用户给了真实 QR 链接**：`connect.html?task_id=<uuid>&_wv=2&source=QwenPaw` —— 暴露了 `task_id` 是核心，`_wv=2` 是 QQ webview 标志，`source` 是来源标签。
2. **用户实测 `source=Gugu` 能正常跳转** → source 不是墙；剩下唯一问题是"怎么创建 task_id"。
3. **扒 QwenPaw 源码**（开源 `qrcode_auth_handler.py`）找到全套：
   - `POST q.qq.com/lite/create_bind_task {"key": <base64随机32字节>}` → `task_id`
   - 轮询 `POST q.qq.com/lite/poll_bind_result {"task_id"}` → `status==2` 时返回 `bot_appid`(明文) + `bot_encrypt_secret`
   - secret 是 **AES-256-GCM**（raw = iv(12) + 密文 + tag），用第 1 步的 key 解密
   - **安全模型**：接口无鉴权，但 secret 用调用方本地生成的 key 加密回传，只有创建者能解 → 所以公开也安全
4. **本地实测 `create_bind_task`**：我们自己的后端直接 POST 就拿到了合法 `task_id`，坐实"无鉴权可复刻"。

### 实现（咕咕侧）

- `app/api/v1/qq_connect.py`：`POST /me/qq/connect`(建 task，aes_key 只存 Redis 服务端) + `GET /me/qq/connect/{task_id}`(轮询→AES 解密→写 `user_bots`)
- 前端 ProfileModal：QQ 主操作「扫码连接」(自动) + 「手动填」兜底
- QQ 走 **BYO 模型**：`user_bots` 表存每用户凭据；supervisor 从 DB 读、按 bot 起独立网关（凭据走 env 注入）；worker 用 payload 的 `owner_user_id` 直接认人（bot 即归属，无需绑定）

### 收尾的坑：发消息无回应

连上后发消息咕咕不回 —— 不是代码问题，是 **supervisor 和 worker 没在跑**（只起了 web 后端）。这俩是独立进程必须单独常驻。起来后日志立刻通：
```
[qq:3] 收到 BBFF2AB9...: 'hello'
[worker] qqbot 回复 → 'hey～今天有什么要推进的…'
```
> `ps | grep worker` 会被内核线程 `kworker` 误匹配，排查时差点看走眼。

### 反思

- **别替用户判"够不着"**：一个 `curl` 就能验证的事（create_bind_task 无鉴权），比三轮"我觉得是合作墙"有用得多。
- **开源参照物先扒源码**：QwenPaw 开源，机制全在 `qrcode_auth_handler.py`，早看早做完。
- 详细机制见 `qq-scan-connect` 记忆 + `docs/agent-im接入架构.md` §3.2。

---

## 2026-06-23 · 里程碑：咕咕首个 IM 平台（飞书）端到端打通 🎉

**第一次让咕咕住进 IM**——飞书私聊里发消息，咕咕带完整人格/记忆/工具回复，全程经队列+独立 worker，平台无关骨架可复用到 QQ/微信。架构与决策见 `docs/agent-im接入架构.md`、`docs/agent.md` Phase 4。

### 端到端链路

```
飞书私聊消息
  → 网关 adapters/feishu.py（lark-oapi WebSocket 长连，收 im.message.receive_v1）
  → produce_sync 入队 Redis Streams（im:inbound）
  → worker.py 独立进程 consume
  → run_collect(AgentRequest)：复用 loaders/builder/core/sanitize，攒完整回复（人格+记忆+41工具）
  → feishu.send_text（lark.Client im.v1.message.create）发回飞书
```

实测：私聊发"你是谁"→ 咕咕回"我是咕咕，你的创作搭子…"（带人格），送达飞书。两条连发都正确处理。

### 为什么这样搭（关键决策）

- **不用 OpenClaw**：飞书/QQ/微信都走官方直连。飞书用官方 `lark-oapi`，WebSocket 长连**不需要公网 URL/webhook**，最省事。
- **bot 创建 vs 用户绑定分开**：一个 bot（owner 一次性建，凭据走 `.env` 的 `FEISHU__APP_ID/SECRET`，**不做后台 UI**），所有用户私聊它各开小窗；用户身份靠后续 OAuth 扫码绑定区分（当前临时全映射 root123）。
- **队列+独立 worker（不内联）**：收消息↔跑大模型解耦，为高流量留缝；worker 独立进程，避免多 uvicorn worker 重复消费长连接。
- **同步 produce**：lark `ws.Client.start()` 是同步阻塞 loop、事件 handler 同步，故网关用 `redis.produce_sync`（独立同步客户端），worker 侧仍用异步 consume。

### 踩的坑

- **worker 阻塞读超时**：`XREADGROUP block=5000ms` 时 redis 客户端默认读超时更短 → 反复 `TimeoutError: Timeout reading from`。修：`get_redis` 设 `socket_timeout=None`（阻塞读不能有读超时）。
- **过度撤回**：误把后端飞书网关/配置一起 git checkout 撤了（本意只删前端 Admin 飞书卡片）→ 从 context 重建后端。教训：撤回前分清"前端 UI"与"后端能力"，shared 文件别一把 checkout。

### 现状与下一步

- 跑起来 = 两个独立后台进程：`python -m agent.adapters.feishu`（网关）+ `python -m worker`（worker）。
- 已落地骨架：`app/core/redis.py`（Streams + produce_sync）、`agent/runner.py`（非流式）、`worker.py`、`agent/adapters/feishu.py`（收+发）。
- **下一步**：OAuth 2.0 用户扫码绑定（方案 A 轻绑定）——绑定表 `(platform,open_id)↔user_id` + 后端授权URL/回调 + 设置页二维码 + 网关 open_id 解析，替换临时的 root123 映射，实现"每人各聊各的"。

---

## 2026-06-23 · Agent：记忆深化 + prompt 缓存 + IM 接入架构

接上一日，把记忆系统从"能记"做到"记得干净、注入便宜、写得克制"，并定下 IM 接入方案。详见 `docs/agent.md`、`docs/agent-im接入架构.md`。

### 1. 记忆 facts 调和重写（治矛盾/膨胀）

反思从"只输出新增、追加去重"改为"输出调和后的**完整事实**、覆盖写回"：保留仍成立、修正矛盾、合并重复、删过时，强约束"别无故删/别清空"，加防误删兜底（原有事实但模型返回空则不覆盖）。实测把"只去过杭州 vs 去过CP"这类矛盾、推测、评判噪音重写消除。`remember` 工具仍走追加。

### 2. 记忆三层压缩（daily → memory，无 weekly）

- 砍掉原设计的 weekly 中间层，压缩定为 **daily → memory.md** 两段（咕咕只需"近期/长期"两档）
- `memory/_llm.py`：抽出反思/压缩共用的 LLM 调用（provider 路由 + JSON 解析）
- `memory/compress.py` + `prompts/compress.md`：daily **按累积条数**压缩——保留最近 30、攒到 40 触发、最老 10 条 LLM 摘要沉淀进 memory.md、硬上限 60；约每 10 轮压一次
- `store.py` 加 memory.md 读写、`read_memory` 返回 facts/memory/daily；`builder.py` 注入「长期记忆」段
- **三层定稿**：facts（永久档案）/ memory（永久沉淀，越压越精）/ daily（最近 30–40，老的流进 memory）

### 3. 反思写侧省钱：琐碎对话门槛

`reflection.schedule()` 加 `_worth_reflecting()`：用户消息整条命中纯应答/寒暄词黑名单（嗯/好的/谢谢/哈哈/👍…）则跳过反思。精确匹配、保守，长句或短的有意义内容（"南京"/"我是插画师"）照常反思。省写侧约 20–40% 无效调用。

### 4. prompt 缓存（读侧近乎免费）

- `core.py` Anthropic/MiniMax 路：system（人格+记忆+上下文）打 `cache_control` 缓存断点，缓存 tools+system，多轮工具循环只重算新消息，命中读取便宜 ~90%；`_usage` 加 `cache_read` 观测
- **实测 MiniMax M3**：第 2 次调用 `cache_read=1487 / input=1`，确认命中
- OpenAI 兼容路为自动前缀缓存，结构已 system 在前，无需改

### 5. 成本策略定论（1M 上下文 + 缓存背景下）

- **读/注入侧**（记忆/工具/人格）：1M 上下文 + 缓存命中 → 几乎免费，**记忆注入不必 trim**；`context_tokens` 保持 25600（历史 token 每轮重算、缓存不了，不必追 1M）
- **写/反思侧**：缓存帮不到，靠琐碎门槛省
- facts/memory/daily 容量与压缩参数维持现状，不再细调

### 6. 提示词文件化收口

反思（reflection.md）、压缩（compress.md）均为 md 文件，热读 + 兜底 + Admin 在线编辑（`agent_admin.py` `SPECIAL_PROMPTS=["persona","reflection","compress"]`，前端「系统提示词」tab 显「人格/记忆反思/记忆压缩」）。标题生成 prompt 经评估保持内联（用户决定不抽）。

### 7. IM 多平台接入架构（设计，未开工）

新增 `docs/agent-im接入架构.md`：飞书 / QQ / 微信**官方直连、不用 OpenClaw**（lark-oapi / botpy / iLink）；从一开始按「收消息 ↔ 跑大模型」解耦的**队列 + worker 架构**建，为高流量留缝（AgentRequest/Response + dispatch 间接层）。现状：Redis 配了没用、无队列/worker、`--workers 1`；落地从 Redis+Streams 起步、6 步逐缝验证。agent.md Phase 4 已对齐、删 OpenClaw/webhook 旧话；小模型相关项统一标「最后做·暂无条件」。

---

## 2026-06-22 · Agent：Skill 一等公民 + 记忆 Phase 2a + 联网搜索

详细架构见 `docs/agent.md`。本次四块工作：

### 1. Skill 一等公民重构

原 `DefaultProfile.tool_names` 手抄全部工具名，与各 skill 的 `Tool` 声明双重维护（加工具改两处、漏一处静默失效）。改为：`SkillRegistry` 增 `_skills`（skill→有序工具名）+ `add_skill()`/`tools_of()`；`BaseProfile.skills`（skill 名列表）+ `tool_names` 派生属性。`DefaultProfile.skills` 一行替代扁平清单。工具集与重构前集合相等（验证通过），行为零变化。

### 2. 记忆系统 Phase 2a（精简闭环）

- `memory/store.py`：读写 `.agent/{facts,daily}.md`，经 `StorageBackend`（本地/OSS），单库无 DB 同步问题；`merge_facts` 内容去重、`append_daily` 滚动 30 条
- `memory/reflection.py`：对话后单次非流式 LLM 提炼 `{facts,daily}`，`schedule()` fire-and-forget（持后台任务引用防 GC），失败不影响对话
- `skills/memory.py`：`remember` 工具（主动记忆）
- builder 记忆 section 仅非空时注入；loaders.load_memory 改 async；web.py memory_enabled 时注入 + 反思
- **简化偏差**：facts.md 而非 facts.json、两层而非三层、无 compressor/events/identity（昵称用 `User.display_name`）
- **实测**：真实对话已能写入 facts；首版提炼偏噪音（记了推测/世界常识/矛盾/评判），据此收紧反思提示词（见 4）

### 3. 联网搜索（Tavily）+ 搜索配额

- `skills/search.py`：`web_search` 工具（第 41 个），调 Tavily Search API
- 配置：`config.py` 加 `SearchSettings.tavily_api_key`，走通用 `/admin/config`（GET 打码、PATCH 存 override）；前端 Agent 配置页「联网搜索」卡片输 key + config store 加 `search` 段 + `tavily_api_key` 进 `PASSWORD_FIELDS`
- **搜索配额**：`QuotaSettings.default_search_limit_daily` + 新建 `search_usage` 表（create_all 自动建，无手写 migration）；`web_search` 执行前数当天次数、超则拒（仅拦搜索、不拦对话），成功才记一行。前端配额管理页加「每日搜索次数上限」。先只做全局、暂无 per-user 覆盖
- 边界：`used >= limit` 拦截，30 上限 → 当天放行 0–29、第 30 次后拦

### 4. 反思提示词文件化 + 收紧

- 原 `_SYS` 内联常量 → `prompts/reflection.md`，`reflection.py` 每次现读（热生效）+ 兜底；接进 Admin（`agent_admin.py` 的 `SPECIAL_PROMPTS=["persona","reflection"]`），前端「系统提示词」tab 显示「记忆反思」+ 谨慎提示
- 收紧规则（治首版噪音）：只记用户本人、不记推测、不记世界常识/一时状态、不评判、宁少勿多 1–3 条

### 注记

- web.py 持久化段：工具中间消息（tool_use/tool_result）以 `content_json`（JSONB）逐条落库；`core.py` 用 `model_dump()` 序列化 SDK 对象保证 JSON 安全
- 后端 uvicorn 未开 `--reload`，改 Admin 端点/模型需 `make restart` 才生效

---

## 2026-06-21 · 缩略图根因排查：Pillow 未安装导致全量加载原图

### 背景

用户反馈总览页和文件库滚动卡顿、图片加载慢、渐进式效果失效。为此陆续做了大量前端优化（`shallowRef` 批量更新、`preDecodeBlobs`、`will-change`、`backdrop-filter` 移除、IntersectionObserver 懒加载等），体验有所改善但根本问题未解决。

### 根因

**`Pillow` 未写入 `requirements.txt`，venv 中从未安装。**

后端 `/files/{id}/thumb` 端点调用 `_generate_thumbs_sync()` 生成 WebP 缩略图，但所有调用都在 `except Exception: pass` 中静默失败。最终降级路径返回**原始大图**（几百KB～几MB JPEG/PNG）。

前端把这张大图当成 `tiny`（预期 20px WebP）缓存到 blob Map，渲染时浏览器需要解码全尺寸图片：
- `tiny` 不是 20px 小图，blur 占位失去意义
- `card` 返回原图，文件库加载几十张 MB 级图片
- 浏览器 HTTP Cache 缓存了这些大图响应（`max-age=86400`），强刷页面也不请求后端，旧 blob 持续命中

### 排查过程

1. 发现 blob cache 里存在 JPEG/PNG 类型，怀疑降级逻辑触发
2. 在后端端点加日志，发现浏览器根本没有发 thumb 请求到服务器（HTTP Cache 直接命中）
3. 清除 site data 后，强刷仍无 thumb 请求 → uvicorn 日志无任何 `/thumb` 条目
4. 直接在 venv 中测试 `from PIL import Image` → `ModuleNotFoundError`
5. 确认 Pillow 从未安装，`requirements.txt` 缺失该依赖

### 修复内容

| 位置 | 改动 |
|------|------|
| `requirements.txt` | 新增 `Pillow>=10.0.0` |
| `_generate_thumbs_sync` | 修复 RGBA/透明通道处理（PNG 保留 RGBA，其余转 RGB） |
| `get_thumb` 端点 | 降级改为输出缩小 JPEG，最后兜底才返回原图；移除静默 `except: pass`，改为打印 traceback |
| `useThumbCache.js` | fetch 加 `cache: 'no-cache'`，强制跳过浏览器 HTTP Cache，确保拿到最新 WebP |

### 反思

之前所有前端优化（`shallowRef`、`preDecodeBlobs`、懒加载、`backdrop-filter`）都是在治标，真正的性能瓶颈是后端返回了全尺寸原图。正确的 WebP 生效后（tiny 几百字节，card 几 KB），滚动卡顿和加载慢的问题基本消失，前端优化才能真正发挥作用。

**教训：依赖静默失败 + 降级兜底会掩盖真实问题，重要依赖必须写入 requirements.txt 并在 CI/部署时验证。**

---

## 核心愿景

通用项目管理 Web，通过自然语言管理进度、文件、排期，支持自然语言交互。适用于插画约稿、动画制作、工程项目等任何需要进度追踪的场景。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 + Vite + Pinia + Vue Router |
| UI 库 | Arco Design Vue |
| 后端 | FastAPI + PostgreSQL |
| 模型 | Qwen + LangChain（待接入） |

---

## 已完成功能（早期阶段）

### 布局 & 全局
- DefaultLayout：顶栏（glassmorphism，`position: absolute; z-index: 10`）+ 侧边栏 + 内容区
- 顶栏内容：页面标题、日期、搜索框、"导入文件"、"新建项目"按钮
- 侧边栏底部用户卡片（头像 + 姓名，无职业）+ 设置弹窗
- 自然语言悬浮球（`z-index: 1000`）+ 聊天弹窗（`z-index: 999`），点击外部自动收起
- 导航：总览 / 项目 / 日历 / 文件库 / 客户 / 通知
- 滚动条始终占位（`overflow-y: scroll; scrollbar-gutter: stable`）防止切页抖动

### 总览页（Dashboard）
- 项目列表（ProjectList）：状态徽章（待开始 / 进行中 / 已完成）、当前阶段、截稿倒计时
- 最近文件（FilePanel）：分 tab 展示 + 拖拽上传区
- 玻璃拟态卡片，hover 非线性上浮动画 `cubic-bezier(0.34, 1.2, 0.64, 1)`

### 项目页（Projects）
- 三列看板：待开始 / 进行中 / 已完成
- HTML5 拖拽换列（`@dragstart / @dragover / @drop`）
- ProjectCard：显示项目自定义当前阶段、阶段进度点、截稿倒计时、进度条
- ProjectModal（全屏）：阶段编辑器、项目重命名、看板状态选择、进度滑块、截稿日、客户
- NewProjectModal（全局挂载于 DefaultLayout）：表单 + 8色渐变预设 + 实时预览

### 数据层（Mock）
- `useProjectStore`（Pinia）：`kanbanColumns`、项目字段、Actions
- `useUiStore`：`openNewProject`、`notifCount`

---

## 待开发（早期规划）

| 优先级 | 功能 |
|---|---|
| 高 | 日历页完整实现 |
| 高 | 文件库页完整实现 |
| 高 | 数据库模型 + Alembic 迁移 |
| 高 | 后端 CRUD API（项目 / 文件） |
| 中 | 替换 Mock 数据为真实 API |
| 中 | 自然语言管理集成（Qwen + LangChain） |
| 低 | 客户管理页 |
| 低 | 通知系统 |

---

## 2026-06-22 · 阶段自动完成 + 状态联动 Bug 群

### 背景

实现「最后阶段进度满时自动标记已完成、拖回时还原阶段与待办」功能后，连续出现四个相互关联的 bug。

### 根因逐一拆解

**Bug 1 · `_stageBeforeDone` 记录了错误的阶段**

`setStage` 在调用 `moveProject('done')` 之前已执行 `p.currentStage = stageKey`（最后阶段），导致 `moveProject` 里 `p._stageBeforeDone = p.currentStage` 拿到的是最后阶段 key，而非操作前的原始阶段。

修法：在修改 `currentStage` 之前先记下 `originalStageKey`，直接写入 `p._stageBeforeDone`；`moveProject` 改为「已设则不覆盖」。

**Bug 2 · 从已完成拖回时 todo 未还原**

`moveProject`（看板拖拽触发）只还原了 `currentStage` 和 `progress`，完全缺少 todo 还原逻辑。`setStage` 的退回路径有正确的 `autoCompleted` 还原遍历，但 `moveProject` 未复用，导致拖回后所有阶段 todo 依然处于全勾状态。

修法：在 `moveProject` 的 `done → active` 分支里加同样的还原遍历，并将还原后的 `stages` 一并 patch 到后端。

**Bug 3 · 编辑卡状态胶囊不实时更新**

Modal 内 `localStatus` 是本地 `ref`，只在 `watch(() => props.project?.id, ...)` 触发（即打开不同项目）时初始化一次。`moveProject` 修改了 store 的 `p.status`，但 `localStatus` 对此无感，胶囊卡在旧状态。

修法：新增 `watch(() => props.project?.status, ...)` 单独跟踪 status 变化，实时同步 `localStatus`。

**Bug 4 · 胶囊更新有明显延迟**

`setStage` 的执行链：`await _patchProject`（网络）→ `await moveProject`（网络）→ 才设 `p.status = 'done'`。胶囊需等两次网络回包才变色。

修法：把 `p.status = 'done'`、`p.doneAt`、`p._stageBeforeDone` 全部移到第一个 `await` 之前做乐观更新，并合并为一次 `_patchProject` 调用，Vue 在下一 tick 立即重渲。

### 教训

- **「提前修改共享状态再传给子函数」会破坏子函数的快照逻辑**：调用者改了 `p.currentStage`，被调用者再读它时拿到的是已被污染的值。今后凡是要在调用链中「传递修改前状态」，必须在第一次修改前就显式保存。
- **乐观更新要在第一个 `await` 之前完成**：只要有一行同步赋值在 `await` 之后，用户就会感受到延迟。

---

## 设计规范（早期版本）

- **色系**：紫蓝渐变主色 `#8b8fbe → #c4afc8`，成功绿 `#5a9e88`，警告橙 `#b07858`
- **玻璃拟态**：`backdrop-filter: blur(20px)`，`rgba(255,255,255,0.26~0.48)` 背景，白色内描边
- **圆角**：`--radius-sm: 10px`，`--radius-md: 14px`，`--radius-lg: 18px`
- **动画**：hover 弹性 `cubic-bezier(0.34,1.2,0.64,1)`，遮罩/阴影 `cubic-bezier(0.4,0,0.2,1)`，Modal 入场 `cubic-bezier(0.34,1.3,0.64,1)`
- **Z-index 层级**：内容(default) → 渐变遮罩(5) → 顶栏(10) → Modal(200~300) → 对话球(1000) / 聊天(999)
