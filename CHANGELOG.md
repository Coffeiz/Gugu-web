# 更新日志 · Changelog

本项目所有显著的更新都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### MiMo（小米）模型接入 + 双 API 适配 + 空回复治理

- **后台新增 MiMo provider**（`Admin/Agent/index.vue`）：供应商下拉加「MiMo (小米)」（默认 `mimo-v2.5`、base_url `token-plan-cn.xiaomimimo.com/v1`、橙色圆点）。`mimo-v2.5` 才同时支持「看图 + 深度思考 + 1M 上下文」；`mimo-v2.5-pro` 纯文本不看图，选型注意。
- **API 格式可选**（`api_format` 字段，`AISettings`/`AIPresetItem` + admin 选择器）：MiMo 同时提供 OpenAI / Anthropic 两套兼容 API，预设里可显式选格式（留空=按 provider/base_url 自动判）；选 Anthropic 时前端自动把 base_url 后缀 `/v1` ↔ `/anthropic` 互切。后端抽出**唯一判定口 `llm_select.use_anthropic_for(ai)`**（优先显式 `api_format`），聊天 / 记忆 / IM **5 处**重复逻辑统一改用它，杜绝「聊天走 anthropic、记忆还走 openai」的不一致。
- **鉴权**：MiMo 两套 API 都收 `api-key` 头与 `Authorization: Bearer`。`llm_select.openai_default_headers` / `anthropic_default_headers` 给 mimo 补 `api-key` 头（多发一个无害），三处 SDK 客户端 + admin 连通性测试/多模态检测同款。
- **空气泡根治**：mimo 是推理模型（返回 `reasoning_content` + `content` 双字段），思考开时偶尔整轮输出全进 `reasoning_content`、`content` 为空 → 空气泡。两层修复：① **OpenAI 路给 mimo 传 `thinking:{type:disabled}`**（`extra_body`，官方两套 API 都支持此参；思考关时正文不再空，从源头消除）；② 仍空（思考开）时**追一轮要正文、再空给一句得体兜底**，绝不留空气泡。
- **Anthropic 路对 mimo 特化**（`core._run_anthropic`）：去掉 `cache_control`（mimo 无 prompt caching）；thinking 取值用文档确认的 `disabled`（想开则不传、用其默认，不瞎猜 enable 值）。实测 mimo anthropic 端点（`/anthropic/v1/messages`）：鉴权 / `thinking:disabled` / **图片块（看图）** 全通，`cache_control` 也不报错。**走 Anthropic 格式可原生处理思考块（免疫空气泡）+ `read_file` 看库内图**，功能最全。

### Agent 看图：信自己的眼睛，别反射性联网搜

- **背景**：模型接了 vision 后，问「这是谁 / 这画的啥角色」时咕咕会按「不确定就查证」的人格反射性 `web_search` 去「核实」——但 web 搜是文字的，反向认图根本帮不上，只让用户干等（实测一次图请求白白多走一轮 `web_search`、输入涨到 2 万+ token）。
- **修复**（`persona.md`）：「不确定就查证」段后加「看图时信你自己的眼睛」——看图类问题**凭看到的直接答**（认得就说、拿不准就照实说像谁），只有要图本身给不了的**外部信息**（出处设定 / 哪买 / 最新消息）且确实不知道时才联网。区别于「外部事实可查证」：图里画了啥，眼睛已经看到了，不必再搜。

### 流式首条空气泡：pub/sub 订阅竞态修复

- **现象**：切换主模型（尤其首 token 更快的模型）后，每个会话**第一条**回复偶发空气泡——回复其实已生成并落库（快照/DB 有全文），只是当场没显示。
- **根因**（`adapters/web.stream()`）：先 `create_task` 起后台生成、后 `subscribe` 频道；Redis pub/sub 发完即弃，生成的头几个 token（短回复时是全部）在订阅建好前被 publish 掉、丢失。
- **修复**（`genstream.py` + `adapters/web.py`）：新增 `open_subscription()`，**先 attach 订阅、再启动生成**——订阅就绪后频道消息进连接缓冲不丢。`subscribe(session_id, pubsub=)` 兼容传入已订阅的 pubsub；`resume()`（刷新续看，本就先回放快照再订阅）逻辑不变。

### 前端体验打磨

- **日历多选：单日悬停不提前切侧边栏**（`Calendar/index.vue`）：`activeRange` computed 在 anchor 与 hoverRangeEnd 同天时返回 `null`，侧边栏仅在真正跨天拖选后才切换为「添加项目」模式，防止点击单天意外触发。
- **定时任务时间输入改为文本框**（`Schedules/index.vue`）：`<input type="time">` 改为 `<input type="text">`，不弹系统选择器；宽度与 `DatePicker` 等宽（移除 `width: 120px` 限制），文字居中对齐；`title-input`、表单 input/textarea/select、`repeat-tab` 圆角统一为 `var(--radius-sm)`，同步去除 `corner-shape: squircle`（避免与 DatePicker 视觉不一致）。
- **项目卡悬停亮色高光**（`ProjectCard.vue`）：卡片 `::after` 伪元素加顶部白色渐变 + inset 描边，hover 时高光明显增亮（`rgba(255,255,255,0.55)` 渐变区），静止时保持低调（`0.12`），transition 过渡顺滑。
- **看板「新建项目」卡悬停亮色**（`KanbanColumn.vue`）：hover 背景从 `rgba(255,255,255,0.05)`（比默认更暗）修正为 `rgba(255,255,255,0.3)`（明显更亮），无 inset 顶部光，与项目卡风格对齐。
- **ProjectModal 删除阶段按钮位置修复**（`ProjectModal.vue`）：`.node-row` 加 `padding-right: 8px`，防止「×」按钮落在阶段分割线上。
- **浮动预览窗口：内容刷新不重置位置**（`FloatPreviewWindow.vue`）：`liveStore.rev.files` 触发的内容重载改传 `refresh=true`，`load()` 在 `refresh && ready` 时跳过 `fitWindow()`，窗口位置/尺寸原地保留，仅 `blobUrl` 更新为最新内容。
- **项目编辑卡阶段区展开版面记忆**（`pmStagesExpanded` 偏好）：阶段区展开（50/50 版面）状态持久化到用户偏好——`UserPreferences` 加 `pmStagesExpanded` 字段（`schemas` + `preferences` API），前端 `preferences` store 加 `savePmStagesExpanded`，重开保留上次版面。

### Agent 记忆边界：根治"伪个性化幻觉"（编造与用户的共同历史）

- **背景**：空记忆 / 新用户下，咕咕会硬编「你之前聊过 X / 我记得你喜欢 Y」（用户根本没提过）。这类幻觉 `web_search` 救不了——「你我之间发生过什么」网上查不到，唯一真相源是注入的记忆区；且「活泼」语气会放大（亲昵语域爱 call-back 共同记忆）。
- **A · prompt 双层红线**：`persona.md`「关于记忆」加「记忆区是你对用户了解的唯一真相源，没写的就是不知道，绝不说『你之前聊过 / 喜欢 X』」+ 区分两类不确定（外部事实可查证 / 你俩之间的事查不到→没记忆就别断言）；`policy.md` 加红线「不虚构与用户的共同历史」。
- **C · 空记忆显式声明**：`builder._memory_block` 记忆全空时不再返回空串，改注入「暂无任何长期记忆——别假装记得任何共同经历或偏好」，给「我不知道」一个锚点，掐掉无锚点脑补。
- **实测**（`scripts/smoke_memory_boundary.py`，全零 UUID 空记忆 + 诱发 prompt，三风格 × 真实 LLM）：**natural/formal/lively 全 0 脑补**，活泼也没放大；咕咕改为老实承认「头一回聊、一无所知」并引导用户自我介绍，甚至主动声明「不瞎猜一个听着像对的答案糊弄你」。

### Agent emoji 红线：prompt 压不住 → 输出层确定性兜底

- **背景**：persona 明令「坚决不用 😅😶✨ 等阴阳 / 情绪表情」，但「活泼」语气下照冒（emoji 是该语域的高概率 token）。先试 prompt 三层声明（lively 文案 + 风格块底线声明 + persona「语气不豁免」）——**实测全无效**，lively 依旧条条带 😅。**结论**：emoji 是 token 级低层习惯、非高层语义行为，prompt 治不了，必须输出层兜底。
- **修复**：`sanitize.strip_disallowed_emoji`——白名单（27 个内容类别表情 ✅💡📝📂📅💬…）之外的 emoji 连前导空格一起删（白名单制比黑名单稳，新表情漏不掉）。挂**三出口**：web `emit_clean`（流式当场拦）、`run_collect`（IM，接 `sanitize_outbound` 后）、`run_ephemeral`（定时）；`_collect` 保持纯净（对照测试要拿原始输出）。
- **实测**：strip 后三风格 emoji 违规全 0；白名单实战抓到 🤷🌱😂✨ 等未预料表情。

### 通知系统：持久化 + 已读追踪 + 气泡上线补弹/时限（气泡与通知中心分渠道）

- **通知落库 + 按用户已读**：新表 `notification_reads`（user × notification × read_at，无记录=未读）；`site_notifications` 加 `bubble`/`persist`/`bubble_expire_at` 三列（Alembic `20260626000002`）。通知本体一律落库（气泡也要落库才能上线补弹）。
- **两渠道独立发布**：`bubble`（弹气泡）/ `persist`（进通知中心）可分别开关——气泡+中心 / 仅气泡 / 仅中心。
- **导航栏通知中心 = 持久态**：`GET /notifications`（仅 `persist=true`）+ `POST /notifications/read`（标已读落库）；前端 `onMounted` 拉全量（含离线漏掉的）+ 实时 SSE 追加，关浏览器重开还在、未读数从后端来。
- **气泡 = 实时弹 + 上线补弹**：实时在线立即弹；离线者上线时 `GET /notifications/bubble` 补弹**最近一条**有效气泡，**只一次**（前端 `localStorage` 记已弹 id），**带发布时限**（`bubble_ttl_hours`，过期后再登录不补弹）。气泡与通知中心数据源彻底分开（气泡听 `liveNotification`，中心读持久列表）。
- **后台发布页**（`Admin/Notifications`）：发布渠道选择 + **气泡时限**（永久/1天/3天/7天，默认 1 天）；广播带 `nid` 供前端去重/标已读。
- 后端已上线（迁移已在共享库执行）；前端已 build、随版本末部署。


### Agent 搜索分层：自建 SearXNG（通用、免费）+ Tavily（深度）

- **`web_search` → 自建 SearXNG**（`tools/search.py`）：通用网页搜索，免费、无配额、快，返回标题+链接+摘要，适合找官网/文档/GitHub/事实/新闻标题。`settings.search.searxng_url` + `searxng_engines` 配置；国内服务器只有 `sogou/quark/360search` 可达，固定带 engines 避开会超时的 google/bing。
- **Tavily → `deep_research`**：原 `web_search`(Tavily) 改名 `deep_research`，定位「读网页正文 + 总结 / 比较 / 研究 / 给引用」，保留每日次数配额（`SearchUsage`，SearXNG 不计）。`runtime_state` 给 `deep_research`/`http_get` 补「搜索中」状态。
- **路由按任务分**（`prompts/skills.md`）：专有技能 → 已知 URL `http_get` → 普通查找 `web_search`(SearXNG) → 读+总结 `deep_research`(Tavily，直接上别绕) → SearXNG 失败由模型兜底转 `deep_research`。**目标：~80% 普通联网走免费 SearXNG，不再烧 Tavily 配额。**
- **删除 `news` skill**：RSS 易失效，新闻查询归入 `web_search`（通用引擎 sogou/quark/360 本就覆盖新闻）。
- **`web_search` 去掉 `category` 参数**：实测国内服务器上 news/it/science 等类别引擎（google/bing news、reuters 等）全被墙，传 `category` 只会挂一堆死引擎、拖慢甚至超时；通用引擎已覆盖新闻，去掉后更快更干净。
- **后台可配 + 测试按钮**（Admin → Agent → 联网搜索）：SearXNG 地址 / 引擎 / Tavily Key 都在面板配（`config.override.json` 热生效），各带「测试」按钮（`POST /admin/config/test-search`）——SearXNG 测试免费且会列出可达/超时引擎，Tavily 测试验证 key 有效。403 等错误给「未开启 JSON 输出」等清晰提示。
- 部署见 `docs/deploy.md`「可选：SearXNG 自建搜索」（Docker，开 `formats: json` + `limiter: false`，内存紧的机器用 `--memory` 上限隔离）。冒烟 `scripts/smoke_skills.py` 覆盖两工具。

### Agent 对外口径：堵住新工具名泄露（`policy.md`）

- **背景**：新加搜索/技能工具后，咕咕被问「这是怎么搜到的」会抖出 `use_skill → http_get → wttr.in` 三步流程、被问「http_get 是什么」会复述工具名——`policy.md` 原有「不暴露工具」规矩没压住，因禁用名单还是老工具（`list_trash` 等）、且没专门管「问机制」的场景。
- **修复**（提示词层，热生效）：① 禁用工具名补全 `web_search`/`deep_research`/`http_get`/`use_skill` + 「技能/剧本/调用/接口」说法；② 新增「被问『怎么做到的 / 这是什么工具 / 怎么搜到的』」专门口径，只用能力说法答、不报名、不讲分几步、不主动报数据源（带 ❌/✅ 对照例）；③ 再补「用户直接把工具名甩脸上问时也别复述、别承认」。
- **实测**（`run_ephemeral` 真实 LLM）：4 类套话（含两种直接报工具名）全部 0 泄露。

### Agent：不确定就主动查证，别糊弄（去工具成本焦虑）

- **背景**：被问没听过的新词/热梗（如"月薪喵"），咕咕要么"没听过、你从哪看的"踢皮球、要么凭字面编个听着像对的答案——两种失败同一个根：没有"答之前先确认自己是不是真知道"的自觉。`skills.md` 的"省着用工具、成本意识"还压着它不敢主动搜。
- **修复**（提示词层，热生效）：① `skills.md` 去掉"省工具"框架——"工具该用就用，别为省调用而不帮用户"，`web_search` 走自建搜索免费、放开用，只有 Tavily 计费才省着点；保留真效率（别重复查、别反复确认结果）。② `persona.md` 加「不确定就去查证，别糊弄」——立足"给对的答案才是真帮用户"，同堵"编答案"与"踢皮球"，限定在新词/热梗/近期事件/易变事实，稳定常识仍直接答（不逢问必搜）。**没写机械 if-then 规则进 skills**，由性格驱动。
- **实测**：「月薪喵是什么」→ 主动搜、给出真实含义（博主养的布偶猫表情包），不再脑补；「Python 是什么」→ 直接答、不多搜。

### Agent：不虚构与用户的共同历史（伪个性化）

- 与「不确定就查证」是**两类**不确定：外部世界的事拿不准能上网查，但**你俩之间发生过什么查不到、网上也没有，没记忆就是没有，别编**。
- `persona.md` / `policy.md` 加规矩：记忆区没写的，绝不说「你之前提过 / 我记得你说过 / 你喜欢 X」；想显得懂他却没素材时宁可问、别脑补一段没发生的经历；被反问「我什么时候说过」时老实认。
- `builder._memory_block` 改为**空记忆时也注入一句明确声明**（"暂无长期记忆，别假装记得共同经历，需要就直接问"）——给"我不知道"一个锚点，防模型在空白处脑补。

### Agent：Tools/Skills 分层 + prompt skills 系统（weather / news）

- **`agent/skills/` → `agent/tools/` 改名**：原 `skills/` 全是函数调用工具，名实不符；整目录改名 `tools/`，修全部 `agent.skills`→`agent.tools` import（15 py + core/profiles/smoke）。`prompts/skills.md`（工具准则）暂留，后续改名 `tools.md`。
- **prompt skills 系统**（新 `agent/skills/`）：带触发条件的「剧本」md（frontmatter `name`/`description`/`emoji` + 正文），**渐进式按需加载**——builder 只注入「## 可用技能」索引（每个一行 name + 何时用），模型相关时调 `use_skill(name)`（`tools/meta.py`）拉正文再照做，skill 数量可无限扩不撑上下文。加载器 `skills/__init__.py` 不缓存、改 md 免重启。
- **`http_get(url)` 工具**（`tools/web.py`）：prompt skills 的联网执行原语——**SSRF 私网拦截**（私网/环回/链路本地/元数据全拦）、不跟随重定向、响应截断 4000；builder 提示「正文里 `curl <URL>` 即用 http_get 抓」。
- **weather skill**：`http_get` 抓 `wttr.in/{城市}?format=3|?0`，转人话。
- **news skill**：原版要 `browser_use`（我们没有，且 http_get 抓 HTML 首页无效）→ 改 **RSS 路线**，`http_get` 抓人民网 `people.com.cn/rss/{politics|finance|society|world|scitech|sports|ent}.xml`（七类实测 200、干净 CDATA 标题），**无需浏览器**。
- **Profile 字段**：`BaseProfile.skills`→`tools`（工具集），新增 `skills`（启用的 prompt skill slug）；`default` 启用 `weather`/`news` + `web`/`meta`。工具数 51→**53**。
- **工具使用准则（`skills.md`）成本梯队**：要外部信息按「有对口技能 → `use_skill`+`http_get`；知道 URL → 直接 `http_get`；开放式找不到来源 → 才用 `web_search`/Tavily」由便宜到贵选，**显著减少 Tavily 调用**。
- 冒烟：`scripts/smoke_skills.py`（28 项，含 SSRF、实抓 wttr.in/RSS）。

### Agent：修复多工具对话后追问报「咕咕开小差了」（孤儿 tool_result）

- **根因**（真实会话复现）：天气/改项目等多工具轮被持久化进 `content_json`，追问时历史按 token 窗口截断，`sanitize_messages` 用**全局 id 匹配**判断 tool 配对——「开头必须是 user」会丢掉打头的 `assistant(tool_use)` 把紧跟的 `tool_result` 变孤儿，删空消息/合并同角色又打乱相邻性 → MiniMax `400 invalid params, tool result's tool id not found` → 重试 5 次失败 → 「咕咕开小差了」。
- **修复**（`agent/sanitize.py`）：`sanitize_messages` 改为**按位置标记合法对**——只认「`assistant(tool_use X)` 紧接 `user(tool_result X)`」的相邻配对，其余 tool 块全剥；丢前导 assistant 时同步剥掉新表头遗留的孤儿 tool_result。不再被「id 跨位置复用」蒙混。
- 冒烟：`scripts/smoke_sanitize.py`（8 项，含顺序错位领头 result 等边界）。

### Agent 语气：和善底线 + 与「语气/长度」设置衔接

- **persona.md 新增「和善底线」**（摩擦时刻——纠正/不认同/拒绝/自我更正——最易显冷）：**纠正方案不纠正人、调整方向不调整关系**；归因到用途/事实而非人（保护积极面子）、别让用户反过来照顾 AI 情绪（不堆叠「我错了/我收回/没过脑子」）、自然转弯不急刹车（少用「收回/取消」）、把选择权和结束权交还用户（不替他「完事」）。
- **与用户「语气/长度」设置（`style_prefs`）衔接**：`builder._style_block` 给 `short`/`formal` 文案加兜底（简短≠生硬、正式≠冷淡），标题改为「用户设置优先于语气松紧/长度/emoji，**但真诚与和善是底线、不在可调范围**」——两功能各管各、不打架。

### 全局搜索增强：准确跳转 + 拼音/罗马音匹配

- **搜索跳到准确位置**：对话搜索命中消息正文时，跳转后自动滚到并高亮该条消息（`data-db-id` + `_flashChatMessage`）；日程搜索命中后切换到对应月份并高亮目标日程条目（`data-event-id` + `_flashCalendarEvent`）；两处均有 1.8 秒渐隐紫色背景闪光动画
- **后端补充消息 ID 字段**：`GET /api/v1/agent/sessions/{id}/messages` 每条消息加 `id` 字段；搜索接口消息正文命中时附带 `message_id`，前端凭此定位具体消息
- **拼音 / 日语罗马音搜索**（`backend/app/utils/romaji.py`）：新增 `pypinyin` + `pykakasi` 双引擎罗马音转换工具，`to_romaji()` 先用 pypinyin 把汉字转拼音、再用 pykakasi 把假名转 Hepburn 罗马音，`romaji_match()` 做去空格子串匹配；搜索 `riqi` 可命中「日期」，搜索 `yorushika` 可命中「ヨルシカ」
- **搜索后端 ASCII 查询自动走罗马音分支**（`search.py`）：检测到纯 ASCII 字母 query 时，在 SQL ILIKE 结果不足 PER_TYPE 的情况下再扫描最近 200 条记录、用 `romaji_match` 过滤补充，所有类型（项目 / 文件 / 文件夹 / 日程 / 客户 / 对话）均覆盖；合并去重后取前 6 条

### 开发服务器稳定性修复

- **uvicorn `--reload` 限定监听目录**：改为 `--reload-dir app --reload-dir agent`，不再 watch 整个 `backend/`（含 `.venv/`），安装 pip 包不再触发大量连锁重启导致请求 500

### 项目卡：点击阶段名快速操作当前阶段待办

- **阶段名变可点击触发器**（`ProjectCard.vue`）：项目卡右侧的当前阶段名变为可点击（hover 浅底 + 小箭头，有待办时附 `已完成/总数` 计数），点击在其下方（放不下转上方）弹出**当前阶段待办弹层**，Teleport 到 body、玻璃面板风
- **弹层内直接操作待办**：勾选 / 取消、编辑文字、删除、＋ 添加，持久化走 `projectStore.updateStages`；无待办时显示「还没有待办」+ 添加入口；点击外部 / `Esc` / 页面滚动关闭
- 触发器 `@click.stop`、弹层 Teleport 到 body，不会误触打开项目编辑卡

### 站内通知系统（管理员广播 + 用户端气泡）

- **通知气泡组件**（`NotificationBubble.vue`）：与小窗/播放器同款玻璃风（`backdrop-filter: blur(28px)` + 20px 圆角 + `var(--glass-shadow-lg)` + 内高光 `::after`），**固定 360px 与小窗/播放器严格同宽**（三者均按 border-box 360 对齐）；**纵向布局**——关闭 ✕ 绝对定位右上角、标题行（圆点 + 标题）、内容占满整宽且左右 padding 对称；**关闭按钮与音乐播放器 / GuguChat 一致**（26px 圆角方块、透明底、`PhX`、hover 变红）；**新通知把旧的顶上去**——新条插到底部（贴近球），旧条 `nb-move` 上移、停留 **0.5 秒**后自动消失；最新这条**不自动超时**（无进度条），由用户点关闭按钮关掉或被下一条顶替；开/合以**咕咕球圆心为缩放原点**（`scale(0.05)` + 弹性曲线，与音乐播放器一致，原点 `uiStore.chatNotifyOrigin`：贴球时取球心、被小窗/播放器顶高时取自身中心）；去掉配色选项，圆点统一咕咕主题渐变；内容支持**完整 Markdown**
- **通知支持「无标题、仅内容」**：后端 `BroadcastRequest.title` 改为可选 + 校验「标题/内容不可同时为空」；气泡 / 侧边栏 / admin 预览均按无标题渲染（不显示标题行、内容作正文）；气泡无标题时内容首行用浮动占位绕开右上角 ✕
- **气泡与侧边栏通知中心彻底解耦**：① 气泡存的是 uiStore 通知的**独立快照**（`{id,title,content}`）而非同一对象引用，关闭气泡只动本组件 `visible`，不影响侧边栏数据；② 修复点击气泡关闭 ✕ 会**连带关掉侧边栏通知下拉弹窗**的 bug——`AppSidebar` 的 `document` 外部点击监听 `closeAll` 加守卫 `e.target.closest('.nb-stack')`，落在气泡内的点击视为气泡自身交互，不触发侧边栏弹层关闭
- **独立 Markdown 渲染器 + 通用展示组件**：`utils/markdown.js` 是通知/轻量场景专用的隔离 `marked` 实例（GFM + 软换行 + 链接新标签打开 `rel=noopener`），与 GuguChat 那套带 hljs 高亮 / 复制按钮的全局 `marked` 配置互不影响；`components/common/MarkdownView.vue` 为全站通用的 md 展示组件（`:text` 走轻量渲染、`:html` 接预渲染产物，字号用 `em` 相对父容器），**GuguChat 聊天 / 通知气泡 / 侧边栏通知中心统一同款 md 输出样式**，各处删除原本重复的 `:deep()` 样式块
- **气泡动态锚点**（`uiStore.chatNotifyAnchor`）：GuguChat 小窗/播放器展开时实时写入距视口底部距离，气泡始终浮在其正上方，`transition: bottom 0.42s` 平滑避让
- **后台通知发布页**（`Admin/Notifications/index.vue`）：填写标题（**可选**）+ 内容（**支持 Markdown**，已移除配色选项），预览 **1:1 复刻真实气泡**（纵向布局、✕ 右上角、无进度条、无标题时仅内容），一键发送给所有在线用户；记录历史列表，可单条删除
- **广播后端**（`notifications_admin.py`）：`POST /api/v1/admin/notifications/broadcast` 写入 `site_notifications` 表 + 发布到 Redis `events:__broadcast__` 频道；`GET/DELETE .../history` 管理记录；`events.stream()` 同时订阅用户个人频道与广播频道，全量覆盖在线用户
- **侧边栏通知中心 Markdown**（`AppSidebar.vue`）：改用通用 `MarkdownView` 组件渲染 `n.content`，与气泡 / 聊天同款 md 输出（`em`/`del`/`a`/`blockquote`/`pre`/代码块/`hr`/标题层级等全覆盖），移除组件内原本重复的一大段 `:deep()` 样式

### UI 细节与交互打磨

- **GuguChat 小窗 / 音乐播放器加宽 + 三者严格同宽**：小窗 `SMALL_W` 316→360px；播放器改 `box-sizing: border-box; width: 360px`（修掉原先 content-box 332 实际外宽 362 比小窗宽 2px 的问题）；通知气泡同为 border-box 360，三者右对齐成一列
- **音乐播放器随聊天放大缩回咕咕球**：聊天展开（放大）时播放器 `v-if` 加 `&& !expanded`，走 `mini-player` 离场动画缩回 FAB 圆心（`transform-origin` 已指向球心），退出放大再从球弹回；播放状态仍由 FAB 旋转 / 律动指示
- **项目卡文件预览滚动闪烁修复**（`ProjectModal.vue`）：移除文件卡 `.fc-thumb-area` 常驻的 `will-change: transform`（大量卡片常驻 will-change 撑爆合成器层预算，叠加 `.modal-right` 的 `backdrop-filter: blur(28px)` 滚动时偶发闪屏），保留 `translateZ(0)` 维持遮罩层；滚动容器 `.file-content` 加 `isolation: isolate` 隔离重绘
- **新建项目状态球**：顶部状态「胶囊」改为 14px 圆形状态球，点击循环切换三态（待开始/进行中/已完成），悬浮缩放 1.2×；修复名称输入框 `margin: -11px` 导致与状态球重叠的问题
- **颜色格方形化**：新建项目颜色选择格从圆形改为 6px 圆角方块，视觉更整齐
- **分割线宽度统一**：纵向 `.section-row::after` 改用渐变色，与横向分割线视觉线宽一致
- **数据分析趋势图增强**（`Admin/Analytics/index.vue`）：折线改为 canvas 渐变填充（顶端到透明）；鼠标悬浮显示跨所有数据系列的 `index` 模式 tooltip；新增自定义 `crosshairPlugin`，白色竖线（35% 不透明）指示当前日期位置
- **GuguChat 输入框底部裁切修复**：输入框加 `line-height: 1.5; padding: 2px 0`，g/p/y 等下沉字符不再被截断
- **文档预览滚动闪烁修复**（`TextViewer.vue`）：移除 `.tv-wrap` 上的 `transform: translateZ(0)`（与 `position: sticky` 行号列产生合成层竞争导致闪烁），改为在滚动容器加 `will-change: scroll-position`
- **DatePicker 样式统一**（`DatePicker.vue`）：边框色/背景/内边距与其他表单输入框对齐；打开状态加紫色描边 focus 环；日期数字保持居中显示
- **定时任务试运行 Toast**（`Schedules/index.vue`）：「试运行」结果从浏览器 `alert()` 改为页面内 Toast 提示，风格与其他页面一致

### 体验打磨与交互增强

- **咕咕 FAB 只跳图标，不跳整个圆圈**：`ai-fab--typing` 动画 class 从 `<button>` 移到内层 `<svg>`，跳动幅度从 4 px 收窄到 2 px，圆形底座完全静止。
- **修复空气泡**：AI 流式输出结束后若文本全为空白符，消息气泡不渲染（`msg.text?.trim()`），并在 `finally` 里清除该消息记录。
- **agent 创建项目自动选未用颜色**：`projects.py` 增加 `_pick_unused_color`，先从数据库查已使用颜色集合，优先随机选未使用的，全满时再随机选。
- **新建项目弹窗布局紧凑化**：客户 + 项目周期合并为同一行，看板列 + 颜色格合并为同一行，用 `grid 1fr 1fr` 双列排布；标签精简（"客户 / 委托方"→"客户"），日期选择器 placeholder 缩短。
- **DateSpanPicker 日期显示省略当年年份**：`fmt()` 函数当年日期只显示「月/日」，跨年才补「年/月/日」，减少视觉噪声。
- **定时任务「新建任务」按钮去掉悬浮位移动画**：移除 `.btn-primary:hover` 的 `transform: translateY(-2px)`，保留阴影加深和透明度变化。
- **定时任务自定义日期改为单日选择**：原来的 `DateSpanPicker`（范围）替换为 `DatePicker`（单日），cron 格式 `@once:YYYY-MM-DDTHH:mm`，去掉 `:end=` 后缀逻辑；`DatePicker` 与 `DateSpanPicker` 统一在 `main.js` 全局注册，无需各处单独 import。
- **文档预览实时刷新**：`FilePreviewModal` 和 `FloatPreviewWindow` 监听 `liveStore.rev.files`，agent 编辑文本/Markdown/代码文件后预览窗自动重新 fetch 渲染最新内容（图片/视频/PDF 不自动刷，避免无效重加载）。
- **已完成列数量角标统一风格**：`DoneColumn` 的 `.col-count` 改为与 `KanbanColumn` 相同样式（白色加粗数字 + 半透明紫色背景），视觉上三列一致。
- **日历多选日期后侧栏按钮变为「添加项目」**：框选多日时，侧栏「添加活动」替换为渐变紫色「添加项目」按钮（与顶栏新建项目同款风格），点击打开新建项目弹窗并自动填入所选日期范围。

### 文本文件改用浮动窗口预览

- **MD / TXT 等文本类型走浮动窗口**：`preview.js` 的 `open()` 把 `isTextExt` 也路由到浮动窗口路径；`FloatPreviewWindow` 新增文本分支（下载 blob → 交给 `TextViewer` 渲染），默认窗口 720×520，支持拖拽、最大化、多开，MD 有 markdown 渲染、代码文件有高亮。
- **修复滚动闪烁**：`TextViewer` 的 `.tv-wrap` 加 `transform: translateZ(0)` 提升到独立合成层；行号列 `position: sticky` 在 `will-change: transform` 滚动容器里有 Chromium 已知 bug（向上滚时 sticky 元素重绘闪烁），将 `will-change` 移到外层 `tv-wrap` 后消除。

### AI 回复质量 · 修复文件编号外漏

- **系统提示词去掉 `[id=xxx]` 前缀**：文件列表从 `[id=899] 文件名.ext（位置）` 改为 `文件名.ext（位置）`；工具调用本就支持按文件名定位（`_resolve_file` 优先名字查找），编号仅在同名歧义时才需要，日常完全用不到。
- **Admin Agent 行为 toggle 改为即时保存**：「记忆系统」和「对话历史压缩」开关点击后自动调 `saveBehavior()`，不再需要额外点「保存」按钮，避免用户误以为切换即生效而实际未持久化。

### 前端代码复用重构（共用 composable）

- **提取 `useSorting`**：排序状态（`sortKey/Dir`）、菜单（`sortMenuOpen/Pos`）与 `SORT_OPTIONS` 常量从 `Files/index.vue` 和 `ProjectModal.vue` 合并为单一 composable；两处通过解构别名调用，模板无改动。
- **提取 `useUploadQueue`**：幽灵上传卡的创建（`createGhost`）、进度（`updateGhostProgress`）、移除（`removeGhost`）、失败（`failGhost`）统一管理，父组件只需传各自的业务参数调 `uploadWithProgress`，不再各自维护 `uploadingItems` 和 `_uploadUid`。
- **提取 `useBoxSelection`**：框选拖拽全逻辑（矩形计算、DOM 碰撞检测、预览高亮、`cancelDrag`）提取为通用 composable；通过 `fileAttr`/`folderAttr`/`parseFolderId`/`onBoxSelect` 选项适配两处差异（Files 折叠键值 vs ProjectModal 数字 ID、Shift 追加 vs 替换），两侧约 180 行重复代码删除。

### 缩略图生成 · 低配机器减负（draft 降采样 + 并发闸）

> 2 核小机上传图片后网页「卡一下」——缩略图生成（解码/缩放/编码）虽已丢线程池，但多个并发跑仍占满双核、拖累其它请求。

- **`Image.draft()` 大图快速降采样解码**：JPEG 解码时直接按目标尺寸解出 1/2~1/8 分辨率，省掉解全分辨率的大头开销（非 JPEG 无效、安全）。手机大照片生成缩略图的 CPU 大幅下降。
- **并发闸 `_THUMB_SEM = Semaphore(核数-1)`**：缩略图生成最多 `(核数-1)` 个并行（2 核→1），始终留一个核给事件循环和其它请求——上传后「后台预生成 + 前端按需生成」两边不再争满双核。

### 后台管理员 · 用户名也走 env

- 管理员用户名从写死 `"admin"` 改为读 `settings.admin_username`（env `ADMIN_USERNAME`，默认 `admin`），与 `ADMIN_PASSWORD` 同款。改 `.env` 后重启后端，用新账号登录。

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
- 压测详见 [`docs/并发压测结果.md`](docs/并发压测结果.md)（单条 17.9s→4.3s、串行 vs 并发、升压拐点、1000 用户容量模型）

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