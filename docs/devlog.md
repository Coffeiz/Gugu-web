# PM Studio · 早期开发记录

> 更新：2026-06-28
> 状态：早期阶段记录，当前进度见 `docs/overview.md`

---

## 2026-06-28 · 感知系统 P0–P2 落地 + 记忆增量化/时间衰减 + 一个静默吃掉全部老用户反思的坑

围绕「把决策环最上游的『感知』做成显式、可观测、可 per-user 成长」连做了一串，全程守住**聊天热路径只有一次 LLM**（观测和学习都塞进异步反思）。

**① 感知诊断面板「没数据」——两个叠在一起的坑。** 发了好几轮对话面板还是空。逐层排除（阈值→Redis 空→反思没跑→对话崩）后挖出两层：(a) 另一 agent 的「会话总结」给 `conversation_sessions` 加了 `summary` 列但没跑迁移 → 对话直接崩 → 反思根本没机会跑（`create_all` 只建缺表不补列，必须 alembic）；(b) **真正的静默杀手**：`complete_json` 的 `max_tokens=500` 太小。反思要回显**整份 facts**（老用户攒了 900+ 字）+ daily/summary/perception，输出超 500 被截断 → JSON 解析失败 → 返回 `{}` → 什么都不写。**对空 facts 的新用户正常、对有积累的老用户全废**，所以特别难发现。先治标（max_tokens 跟量走、上限放到模型最大），再立刻意识到这是 2b 该根治的。

**② 反思增量化（2b · delta）——根治上面的脆弱性。** 让反思**只吐这轮的增删** `facts_add`/`facts_remove`、不再回显整份 facts；`store.apply_facts_delta` 应用（删按内容匹配：照抄原文 exact 优先、子串≥4 字兜底防泛词误删；增去重追加）。输出体量**不再随 facts 增长**，截断坑从源头消失，`max_tokens` 回落固定 900。旧 prompt（回显整份）兼容回退。线上真模型验证：6 条种子 facts，对话推翻 1 条 + 新增 2 条 → 精确删 1 增 2、其余 5 条一字不动。

**③ summary 时间衰减。** summary 没 TTL，会一直当「最近状态」用——其实几天就该打折。写时盖 `summary.ts`，注入时按半衰期（5 天）权重换话术档（新鲜直接给 / 半旧「约 N 天前、可能已变」/ 过时「多半过时、别据此提具体事」）。抽出通用件 `agent/decay.py`，给后面 lens 的 confidence 衰减复用。

**④ per-user 解读先验 lens v1（P2，最关键的自学习层）。** 第 5 类记忆：「怎么读懂这个用户」的偏置规则（如 `「还行」→ 多半不太行`），存 `.agent/lens.json`。设计死守几条：**事件驱动**（反思多吐一个 `lens_hint` 字段当燃料、零额外热路径 LLM）；**防过拟合双闸**（模型自律 + 候选须**复现**才提拔成规则——一次性误会不立刻学成偏见）；confidence 会动（新规则 0.6 / 印证↑ / 半衰期 30 天衰减 / 低于 0.25 退休）；注入「解读镜片」**偏置不独裁**。

**⑤ lens 复现匹配的真正难点：跨改写认出同一条规则。** 模型两次表述同一规则，用词差很多（「说…通常…多问一句」vs「讲…其实多半…追问」），整句字符 bigram Jaccard 只 0.16，认不出是同一条。词面相似度做不到语义等价。解法：让模型按**规范格式** `「触发语」→ 含义/应对` 输出，匹配**以触发语为键**（「没事」的两次不同表述能收敛、「没事」vs「随便」不会误并）。这是 lens 能可靠复现去重的关键设计。真模型验证：纠正对话「我说还行其实不太行」→ 模型吐出 `「还行」→ 多半是不太行，别照字面接`，格式完全贴合。

**一句话总结:** ②③④ 都靠同一条原则——**别把「会变/会错」的东西当永真**：facts 增量改不整份重写、summary 会过时要打折、lens 从「错」里学且要复现验证才信。而①再次印证：**静默失败最坑**（截断→`{}`→无写入，无报错），排查记忆链路时要直接验「反思到底写没写盘」而不是猜。

## 2026-06-27 · 生产部署连环坑：被冲的状态文件、create_all/alembic 不同步、废弃 NOT NULL 列

本地改完一批（默认问候、精力硬拦等）push 到 main、devserver `git reset --hard` 对齐后，往**生产**（`www.gugugu.site`，阿里云 1Panel + systemd，和 192.168.110.51 那台 dev 是两台机）推这版，结果踩了一长串坑——几乎每一步都暴露一个「dev 想当然、prod 不成立」的假设，逐个记下来（都已沉进 `deploy.md`）。

**① `make stop` 说「未运行」但服务在跑。** 生产 backend 是 systemd `gugu-backend.service` 托管的，而 `make start/stop` 管的是 Makefile 另起的手动 uvicorn——两套进程。在生产用 `make` 控制后端只会迷惑 +抢端口，**一律 `systemctl`**。

**② 服务 `status=203/EXEC` 起不来。** 203 = systemd 执行不了 ExecStart 里的 `.venv/bin/...` → **venv 被这次部署冲没了**（`reset --hard`/`clean`/重新解压都可能干掉 gitignore 的 `.venv`）。重建 venv + 装依赖才起得来。

**③ `password authentication failed for user "pm"`。** 部署把 `.env`/`config.override.json` 也冲了，DB 密码退回占位值（用户原话「忘了重建 env 了」）。教训:**任何代码刷新后，启动/迁移前先确认 `.venv` + `.env` + `config.override.json` 三样都在、DB 密码对**。

**④ `alembic upgrade head` 从 base 重放、第一条就炸 `DuplicateColumnError: column "description" already exists`。** 这是核心认知坑:**生产库的表结构一直是后端启动 `create_all` 按模型直接建的，`alembic_version` 表从来是空的**——alembic 以为啥都没迁，从头重放，撞上 `create_all` 早建好的列（非幂等的老 `add_description` 一撞即死）。dev 一直假设「迁移是 schema 的唯一真相」，prod 上根本不是。恢复:`alembic stamp head` 让它停止重放（只写版本号、不动表），再把本次新迁移真正该加的「新列/新表」手动补上（新迁移多写成 `IF NOT EXISTS`，直接在库上跑零风险）。

**⑤ 自食其果:「旧库和新工具系统不兼容」。** stamp head 之后，建项目报 `null value in column "notes" violates not-null constraint`。根因正是**我前一步嘴上说「删废弃列的迁移非必需、先别跑」——错的**。新代码把 `notes` 字段从模型删了、INSERT 不再带它，但旧库那列还是 `NOT NULL` 且**没有 DB 默认值**（默认本是 ORM 在 Python 侧给的，删字段后没人给）→ 每次 INSERT 都插 NULL → 违约、建项目全崩。**废弃的 NOT-NULL 无默认列必须删**，不删就挡死所有写入。删掉 `projects.notes` + `scheduled_tasks.action_type` 后恢复。

**⑥ 怎么一次性查清所有差别（而不是逐个撞）。** 用 `alembic revision --autogenerate` 当**只读差异扫描器**:它把当前模型 vs 实际库的所有出入生成成一个文件（不改库），`upgrade()` 里 `op.add_column`/`drop_column`/`alter_column` 一目了然。读完即删（它是 head 之上的游离迁移，留着会被后续 upgrade 整份应用）。这次跑出来 `upgrade()` 是空的 `pass` → **确认生产库已和新模型 100% 一致**，连环坑收尾。注意它有假阳性（server_default、索引命名等），当对照清单用、别整份 apply。

**附带两记:** 部署后所有数据页 `summary 401` —— 重建 env 时 `SECRET_KEY` 变了、旧登录 token 全失效，**重新登录即恢复**（根治:SECRET_KEY 跨部署保持同一值）。还有 1.6G 小机上 `make install` 把 unit 重置回 `--workers 2`（≈660M）贴着 OOM 线，得重新 `sed` 降单 worker。

**一句话总结:** 这串坑的共同根:**生产环境的真实状态和 dev 的脑内模型不一致**——prod 的 schema 是 `create_all` 攒的不是 alembic 迁的、状态文件会被部署冲掉、删字段的迁移不跑就留下挡路的 NOT NULL 列。排查的通用解法也统一:**别逐个撞，用工具拿全量真相**（`alembic autogenerate` 看 schema 差异、`pg_stat_activity`/配置确认连的哪个库、`journalctl`+`logs/gugu.log` 分清 systemd 视角和 Python 真错）。全部订正/补进了 `deploy.md` §5.1 / §6 / §6.2 + 常见问题表。

## 2026-06-27 · 对话默认问候改成生成 + 一个「前导 assistant 被剥」的隐蔽坑

把 GuguChat 打开时那条写死的默认问候改成**咕咕自己生成**（带点记忆、像熟人开口），方案沉在 `docs/对话默认问候-生成方案.md`。几轮迭代把节奏定型：**进入全新对话时**后台轻量直连生成一句（不走 agent 循环、不计精力），内存 ref 不跨刷新缓存；打开对话框时走**打字机动画**逐字冒（生成版 / 兜底都走）；生成没好就从静态兜底池随机取一条。中途纠了个浪费：本来「每次刷新都生成」，但刷新常停在老会话（`SESSION_KEY` 还在、问候根本不显示）→ 改成由 `GuguChat` 据 `SESSION_KEY` 判断，只在真·全新对话才生成。

**真正值得记的是「问候纳入对话」逮到的坑。** 用户回复问候后，咕咕却**当成对话刚开始又重新寒暄**。第一反应是「问候没发给后端」，但其实它发了、也入库为新会话首条 `assistant`（`created_at` 早于用户消息）了。真正的根因藏在 `agent/sanitize.py`：发给 Anthropic/MiniMax 的消息序列**首条必须是 user**，`sanitize_messages` 第 4 步据此 `while norm[0].role != "user": pop(0)`——把那条**前导 assistant 问候每轮都剥掉**，模型永远收不到。所以「把非用户发出的话塞成历史前导 assistant」这条路根本走不通。改法：新会话首轮把问候**注入 system prompt**（"你已经说过：「…」，别重复"），保持序列 user 开头；DB 那条 assistant 仍留着只供会话回看显示。教训沉成通用约束写进了 `docs/agent.md`「五、消息序列约束」：**想让模型看到非用户输入的上下文，走 system prompt，别靠前导 assistant 历史**；排查「模型无视某条历史」先看它 sanitize 后还在不在。又一次印证——**先怀疑数据没到，往往其实是到了又被某层清洗悄悄丢了**（和之前 best-effort SSE 丢事件同型）。

---

## 2026-06-27 · 状态命名 + 动画化、实时刷新系统性补课、又一轮真实性守卫

接着可靠性那波，今天是一串「用户在用中发现 → 当场修」的迭代，几条线索其实指向同一些底层模式。

**状态命名 + 动画化。** 先把对话里所有「状态气泡」做成后台可配（特殊状态 + ~55 个工具，留空回退默认），又加了「一个状态多个名字、随机显示」。设计上定了**单一数据源**：工具名/复查前缀/整理中由后端在 `tool_call` 事件里解析好再下发（前端不再拼「复查·」前缀），只有「思考中」是无 SSE 事件的纯前端态，单开 `GET /agent/ui-labels` 取。随机点也分两边：后端 `_pick_label` 每次发事件抽、前端 `watch(thinking)` 每次进思考态抽。中途用户要「所有状态都用 SSE 动画方式出现、切换太快要排队」——做了个**状态动画队列**：SSE 事件入队、逐个打字机入场，每条放完才切下一条，真回复 token 一到就打断让位。思考默认最后定回三个点。

**实时刷新的系统性补课。** 用户两次反馈「咕咕改完 md 预览不刷新」「重构项目后项目卡不动」。挖下去是同一个根：**视图刷新只依赖 best-effort 的 events SSE**（Redis pub/sub 发完即弃，dev `--reload` 重启 / 订阅竞态就丢事件——和之前首条空气泡同类）。而对话结束的兜底 `refreshAfterTools` 又有两处洞：① 文件分支只刷文件管理器、没 bump 预览要的 `rev.files`；② **前端工具集和后端 `RESOURCE_BY_TOOL` 早就漂移了**——`_PROJECT_TOOLS` 漏了 `set_stages`/`update_todo`（重构正用这俩！），`_FILE_TOOLS` 把 `move_items` 错写成根本不存在的 `move_file`、还缺 `copy_file`。修法统一成**确定性刷新**：工具一 `tool_done`（改完那刻）就走**已连好的对话流** bump 对应资源，不等回合末、不靠会丢的 SSE；并把工具集对齐后端权威映射、加注释防再漂。教训：**best-effort 的实时通道必须配一条确定性兜底**，而且两份「该刷哪些」的清单分散在前后端 → 迟早漂移，至少要互相注明出处。顺带预览还做了滚动位置存 localStorage（刷新会销毁重建组件，内存变量留不住）+ 下载 URL cache-bust（否则「刷新了但浏览器给缓存」表现成没刷）。

**又一轮真实性守卫——这次靠轨迹日志逮到。** 用户：「咕咕说复制进项目了，其实在原地复制了一份。」翻 `agent.traj`（上一波加的 P1 轨迹）当场还原：`copy_file` target 传得对，是工具 bug——跨项目复制时 `folder_id` 默认继承了源文件夹（属于原项目）→ 落回原地，却照样 `ok`，模型据此谎报。抽 `_target_loc` 统一目标定位（跨项目不继承源文件夹）。然后**举一反三扫了所有工具**，逮到一批同类「空转报成功」：`update_client/event/scheduled_task/todo` 没给任何改动字段也 commit + 报 success → 全改成「没实际改动就报错」。沉淀出一条工具自律：**没产生实际效果（no-op / 解析失败退化 / 目标解析不出）一律报错，绝不 return success**，否则就是给上层喂谎报素材。MAX_VERIFY 也按用户要求 3→5。这波再次印证上次的体会——**先有可观测（轨迹），这种「谎报」才从「猜」变「翻一眼就定位」**。

**杂项 + 起步。** mimo 标题不更新（思考吃光 30 token 取不到标题，禁 thinking + 挑 text 块修了）；mode2 文件卡拖影比面板卡大（克隆体挂 body 丢了 `.modal.stages-expanded` 上下文，给克隆打标记类补回版式）。最后和用户讨论了**新手引导**方案并落成 `docs/新手引导-实现方案.md`（注册播种 + 延迟欢迎气泡 + claim-once 情境引导 + 回头看 + demo 控制面板，全静态文案随机、后端持久化），待开工。

---

## 2026-06-26 · Agent 可靠性大改：从「工具没正确调用」一路挖到守卫体系

起因是用户一句「咕咕不管 M3 还是 mimo 都有很严重的工具没正确调用的问题」。两个模型都中 → 八成是**共享逻辑回归**，不是某个 provider 特有。让我别急着改、先把整条思维链查清楚。

**取证式诊断**。先看 `AgentUsage`：最近一片请求 **`tools=None`**——模型根本没调任何工具。但隔离探测发现**模型本身正常**：给真实 system prompt + 54 个工具，问「列出我所有项目」，M3 干净利落地发 `tool_use: list_projects`。那为什么生产里不调？翻到出问题的会话（session 190，一段「改文件」灾难）才看清：咕咕在**用嘴假装**——「让我读一下文件…读到了，文件里是带数字的列表…改好了」，全程一个工具没调，用户都看穿了「你根本没读文件」。再把这段被污染的历史 replay 给同一个 M3，它**继续叙述假装、还编造文件内容**。**根因实锤**：模型某轮没真调工具、改用文字假装，这段叙述进了历史后**自我强化**——它看到自己「过去都是用嘴读写」，就跟着堕落。与模型无关，是上下文条件反射。

**拉 OpenClaw 仓库取经**（用户找了另一个 agent 逐层读 + ChatGPT 的见解）。结论很统一：OpenClaw 的可靠性**不是靠更聪明的 prompt**，是四件工程事——① 把 agent 拆成**可观测 pipeline**；② 每个反复出现的坑加一个**确定性守卫**（不是再写 prompt）；③ 工具系统**确定性 + 强类型契约**；④ 诚实承认**强模型是底座**（cloud 模型/32B+ 才可靠，没银弹让弱模型可靠调工具）。核心理念一句话：**Runtime 信 Tool、不信 Assistant**——Assistant 说「保存好了」但没看到工具事件，就该认为它在胡说。但要拨正一个误读：「模型要不要发出 tool_use」这步**没有 hook 能强制**，能硬的只是「检测到失败→重试」，OpenClaw 这步也是靠 prompt + 强模型，和我们一样。

**修法：prompt 红线 + 代码守卫（坑→守卫，别坑→prompt）**。
- prompt 层：`skills.md` 加反叙述铁律（绝不用文字假装操作）、`policy.md` 澄清「不报工具名≠不调工具」、`persona.md` 加「看图信眼睛别反射性联网」。
- 代码层（`core.py` 两路同构）：**narration 兜底**（`_looks_like_narration` 抓「让我读…读到了…改好了/已创建」+ 零工具 → `_NARRATION_NUDGE` 逼真调）；**决策守卫**（`_is_decision_dodge` 抓「用户明确命令改 + 回复『不用改/已合理』驳回 + 零工具」→ `_DECISION_NUDGE` 逼执行或问清）；mimo 空回复兜底（`empty_retry`）。
- 顺手做了可观测（P1 `agent.traj` 工具调用轨迹）和工程加固（P4 `SkillRegistry.add` 注册期契约 fail-fast，重名/坏 schema 启动就炸）。

**关键洞察被实测反复验证：提示词软、守卫硬。** M3 提示词就够——被污染历史下也能「认错 + 真调工具」。但 **mimo 提示词救不动**：同样场景它嘴上认错、接着编造文件内容，零工具；只有 narration 守卫抓到→注入 nudge 逼一轮，mimo 才乖乖调 `read_file`。**mimo 的可靠性全靠代码守卫兜，M3 靠提示词。** 这正反两面把「模型是底座」钉死了。

**踩坑：正则是高精度低召回，全链路实测才逮得到逃逸。** 单元测试我把检测正则调到「该抓的抓、疑问/邀约不误伤」（如「都保存了吗？」「要不要帮你建一个？」一律放过）。但在 devserver 上跑**真实 LLMRunner 循环 + live mimo + 强污染历史**做全链路检测，~24 轮里逮到 **1 次逃逸**：mimo 说「我再确认一下。确认了，已经是每行一个的格式了」——真假装，但措辞我没覆盖。补了 ③ 组（`确认了`/`已经是X格式了`）。**这种逃逸单元测试测不出，必须全链路跑真实模型才暴露。**

**反过来又踩了误触发的坑——而且是用户先发现的。** 上线后用户说「咕咕输出完会再出现一次气泡然后收回，是在复查吗？」。查下来：一半是 intended（做了增删改后的静默自检，确认文字缓冲后丢弃，本来就这表现）；但另一半是 bug——我把完成断言泛化得太宽，「记 / 整理 / 安排 / 确认」这些**既能是工具动作、也是普通对话高发词**也被当成了假装。咕咕正常回句「已经记下了 / 已经安排好了 / 确认过这方向可行」（根本不需要工具）就误触发守卫、逼它重来一轮 → 前端就是那个「气泡又收回」。`确认了` 那个补丁更是直接命中「确认过这方向可行」。**最终把完成断言收窄到只收强 CRUD 动词**（建/创建/保存/删/发/移/归档/重命名），口语词全剔除，实测 0/13 误触发、0/10 漏抓。两个坑合起来一个教训：**narration 这类启发式检测，单元测试的「零误伤」只在我想到的样本上成立——低召回（逃逸）和误触发（口语词）都只有在真实流量里才暴露，得靠全链路实测 + 用户反馈兜。**

**live 验证**。devserver 网页后端跑 `uvicorn --reload`，代码同步进来自动重载；真实循环 ×N 跑下来，**run3 亲眼看到守卫自动接管**（mimo 第一轮假装→循环代码自己 `_new_round` 注入 nudge→转去真调 `read_file`），全链路 ~93% 最终真调工具。IM（飞书/QQ）的 systemd 服务没 --reload，得 `sudo systemctl restart gugu-worker gugu-supervisor` 才让 mimo-on-IM 拿到代码守卫（提示词在 IM 也热读，故 M3-on-IM 已好）。

**体会**：① **能确定性化的别交给模型**——但「决定要不要调工具」这步确定性化不了，守卫只能「检测失败→重试」，这是天花板。② **先可观测再优化**——今天「调没调工具」猜了好几轮，有了 `agent.traj` 轨迹就是翻一眼。③ **弱模型靠工程补、强模型省一半事**——守卫把 mimo 从「经常假装」拉到 ~93%，但补不平残余不确定性，重工具任务 M3 仍更稳。沉淀成三份文档：`agent-architecture.md`（三张图）、`agent-reliability.md`（可靠性工程 + P0–P4 Roadmap）、本文。

---

## 2026-06-26 · Agent 大改：Tools/Skills 分层 + 自建搜索 + 口径/记忆排查

这天主要在 agent 后端，几条线串起来。

**先把 `skills/` 改名 `tools/`**：原来的 `agent/skills/` 全是函数调用工具，名实不符。改名后把 `skills/` 这个词腾出来给真正的「prompt skills」——带触发条件的剧本 md，渐进式按需加载：system prompt 只注入索引（一行 name + 何时用），模型相关时调 `use_skill` 把正文拉进来再照做，skill 数量可无限扩不撑上下文。配套加了 `http_get`（窄口联网取数，**带 SSRF 私网拦截**——后端在内网，旁边就是 Redis/DB，裸 http_get 等于给模型开了打内网的口子，必须拦私网段 + 不跟随重定向）。第一个 skill 是天气（wttr.in）。

**weather 之后想做 news，踩了"要不要浏览器"**：原版 news skill 用 `browser_use`（我们没有），且新闻首页 JS 重、`http_get` 抓的截断 HTML 全是导航栏。结论：要么建真浏览器（重），要么换 RSS（http_get 抓干净的 XML）。选了 RSS，后来发现人民网 RSS 也不稳，索性**删掉 news skill**，新闻归入通用搜索。

**搜索分层：自建 SearXNG（免费）+ Tavily（深度）**。目标是把 ~80% 普通联网（找官网/文档/事实/新闻）从烧配额的 Tavily 挪到免费的自建搜索。`web_search` 接 SearXNG、Tavily 改名 `deep_research`，路由按任务分写进 `skills.md`。部署 SearXNG 踩了一串：① devserver 拉不动 Docker Hub（i/o timeout，走 daocloud 镜像源）；② 内存只剩 600M，用 `--memory` 死锁容器防 OOM 拖垮后端；③ **国内只有 sogou/quark/360search 可达**，google/bing/ddg 全超时——工具固定带这三个引擎。后来用户在 1Panel 自己部署到 110.50，403 是因为 SearXNG 默认不开 json 输出（`search.formats` 要加 json，且这段是 `search:` 顶层、别误塞进 `server:`）。还发现 `category: news` 在国内毫无用（news 类别引擎全被墙），去掉了。后台 Admin 加了 SearXNG/Tavily 配置 + 测试按钮。

**修了个真实线上 bug：「咕咕开小差了」**。多工具对话后追问会 400。复现是：工具轮被持久化进 content_json，追问时历史按 token 窗口截断，`sanitize_messages` 用"全局 id 是否存在"判断 tool 配对——"开头必须是 user"会丢掉打头的 `assistant(tool_use)`、把紧跟的 `tool_result` 变孤儿，MiniMax 直接报 `tool result's tool id not found`。改成**按位置标记合法对**（只认相邻的 tool_use→tool_result），并补了回归冒烟。

**两轮提示词收口径**。① 语气：从 GPT 的人际/情绪心理学视角看，咕咕自我更正时说"确实不该 / 没过脑子 / 完事"会让用户不适——给 persona 加了「和善底线」（纠正方案不纠正人、归因到用途而非人、别让用户照顾 AI 情绪、把选择权交还用户），并和用户新加的「语气/长度」设置衔接（short/formal 加兜底，和善是不可调的底线）；顺带把 emoji 从"6 个黑名单"换成"极简 + 只标内容类别"，并按用户意见**去掉了 emoji 风格的用户选项**（rich 档正好违背极简）。② 工具名泄露：加了搜索工具后，咕咕被问"这是怎么搜到的"会抖出 `use_skill→http_get→wttr.in` 三步、被问"http_get 是什么"会复述工具名——`policy.md` 原有规矩没压住（黑名单还是老工具、没专门管"问机制"）。补全新工具名 + 加"被问怎么做到的"专门口径 + "用户直接甩工具名也别复述"，`run_ephemeral` 实测 4 类套话 0 泄露。

**收尾几件小事**：按用户意见隐藏总览面板（默认进项目、注释路由让它不进 bundle、代码留着以后做团队功能）；排查"记忆只到 25 号"——查下来 devserver 的 daily.md 顶部就是 26 号、反思正常，原来是用户在 Mac 本地后端看的，那是另一套独立的本地存储，不是 bug。

**最后一个有意思的：让咕咕"不确定就主动查"。** 用户发现问"月薪喵是什么"（一个新出圈的猫表情包梗），咕咕"没听过、你从哪看的"踢皮球。第一反应是给 skills 加条"遇到不懂就 web_search"，但用户叫停了——说别把"帮用户"降成 if-else 规则，真正该去掉的是 skills 里"省工具用"的成本焦虑（它压着咕咕不敢主动搜）。去掉框架后实测更糟：咕咕这回不踢皮球了，但**凭字面编了个"工资自嘲梗"**（错的）。于是看清这俩失败（踢皮球 / 编答案）是同一个根——没有"答之前先确认自己是不是真知道"的自觉，这是性格不是工具规则。最终给 persona 加「不确定就去查证、别糊弄」（立足"给对的答案才是真帮用户"，限定在新词/热梗/易变事实，稳定常识仍直接答）。实测"月薪喵"→ 真去搜、给出真实含义（博主的布偶猫），"Python 是什么"→ 直接答不多搜。**这次的体会：「主动帮用户」是性格层的事，往 skills 塞规则只会按下葫芦浮起瓢（不踢皮球了就改成编）。**

---

## 2026-06-26 · 通知气泡改版 + GuguChat 加宽 + 预览闪烁修复

围绕「悬浮球生态」（咕咕球 / 聊天小窗 / 音乐播放器 / 通知气泡）做了一轮统一。

**通知气泡彻底对齐咕咕生态**：原本是右下角独立风格的 toast（自己一套圆角/阴影、4 条堆叠、5 秒进度条自动消失、可选配色）。改成：
- 视觉与小窗 / 播放器同款玻璃面板（`blur(28px)` + 20 圆角 + `glass-shadow-lg` + 内高光 `::after`），宽 360px 三者右对齐成一列。
- 行为改为**新通知把旧的顶上去**：`column-reverse` 下新条插到底部（贴近球），旧条 `nb-move` 上移、停留 1 秒后自动消失（每条进可见栈时排一个 1s 计时器，被下一条顶上去就触发）。最新这条不自动超时。
- **去掉进度条**，最新这条只能点关闭按钮关、或被下一条顶替——通知是 admin 广播的重要信息，不该自己悄悄消失；旧条则在被顶替 1 秒后退场，避免堆积。
- 开 / 合**以咕咕球圆心为缩放原点**，逻辑直接抄音乐播放器：贴球时 `calc(100% - 25px) calc(100% + (anchor-53)px)` 指向 FAB 圆心，被小窗 / 播放器顶高时退化为 `50% 50%` 自身中心。原点由 `uiStore.chatNotifyOrigin` 实时算好传过去。

**通知支持完整 Markdown**：新建 `utils/markdown.js`，一个**独立的 `marked` 实例**。不能直接复用 GuguChat 的 `renderMd`——那套是 `marked.use()` 改全局配置、还挂了 hljs 代码高亮和复制按钮，是聊天专用。隔离实例只要 GFM + 软换行 + 链接新标签打开，两边互不污染。气泡和 admin 预览各写了一套紧凑 `:deep()` md 排版（标题/列表/代码/引用/表格…）。admin 发布页顺手去掉了配色选项，`content` 后端是 `Text` 不限长。

**GuguChat 小窗 + 播放器加宽**：`SMALL_W` 316→360，播放器 316→332（外宽含 padding 正好 360，和小窗对齐）。

**播放器随聊天放大缩回球**：聊天展开（放大）时，播放器原本会浮在展开窗右下角（z 比窗口高），很碍眼。给 `v-if` 加 `&& !expanded`，它就走 `mini-player` 离场动画缩回 FAB——而 `transform-origin` 早就指向球心，天然就是「缩进球里」。退出放大再弹回。

**项目卡文件预览滚动闪烁**：用户反馈滚文件网格偶发闪屏，怀疑是抽屉预览代码冲突。查下来不是——`FilePreviewModal` 关闭时 `v-if` 不在 DOM。真因是每个文件卡 `.fc-thumb-area` 常驻 `will-change: transform`，几十上百个卡片把合成器层预算撑爆，叠加 `.modal-right` 的 `backdrop-filter` 滚动时偶发重合成闪烁。去掉常驻 `will-change`（保留 `translateZ(0)` 维持遮罩层），滚动容器 `.file-content` 再加 `isolation: isolate` 隔离重绘。`will-change` 常驻在大量元素上本就是反模式。

---

## 2026-06-26 · 一批体验打磨：FAB/气泡/颜色/日历联动/预览实时刷新

本次迭代无新功能模块，全是从真实使用中暴露的交互细节：

**咕咕 FAB 只跳图标**：原来 `ai-fab--typing` 加在 `<button>` 上，整个圆圈都在跳，视觉廉价。改到内层 `<svg>` 后圆形底座静止，只有图标轻微弹跳（translateY 0→-2px→0，0.2s），更克制。

**空气泡问题**：agent 有时只输出空白 token，气泡就出来了但没内容。两层修复：① 渲染条件加 `.trim()` 判断；② stream 结束后 `finally` 里检查 `text?.trim()`，空的就从 `messages` 里 `splice` 掉。

**agent 建项目不撞颜色**：之前随机选颜色会选到已有卡的颜色，视觉上撞色。新增 `_pick_unused_color`——先查当前用户所有项目已用色集合，从预设里过滤出未用的再随机；全用完了才退化为全随机。

**新建项目弹窗两行变紧凑**：客户+日期并一行，看板状态+颜色并一行，用 `grid 1fr 1fr`，状态按钮字号和间距缩小，颜色 chip 缩到 20px 并 `flex-wrap: nowrap`，单行不溢出。

**DateSpanPicker 省年**：`fmt()` 判断是否当年，是则只输出「月/日」，不是才输出「年/月/日」。影响所有用到 `DateSpanPicker` 的地方，包括项目卡、新建弹窗。

**全局注册 DatePicker/DateSpanPicker**：这两个组件被 Calendar、ProjectModal、CalendarPanel 等多处 import，提到 `main.js` `app.component()` 全局注册，各处无需单独 import。

**定时任务自定义日期单选**：原来用 `DateSpanPicker` 选区间（对应 `@once:...:end=...`），改为 `DatePicker` 单日，cron 格式简化为 `@once:YYYY-MM-DDTHH:mm`，parseCron 同步移除 endDate 解析。

**文档预览实时刷新**：发现 agent 编辑文件后，`FilePreviewModal` 和 `FloatPreviewWindow` 的 blob URL 不会更新（它们只在 `file` prop 变化时重加载）。解法：watch `liveStore.rev.files`，文件改动 SSE 到来时对 `isText` 类型文件重新 fetch。图片/视频/PDF 跳过，因为 agent 不会就地修改这些格式。

**日历多选→添加项目**：拖选多日后侧栏"添加活动"按钮变为"添加项目"（渐变紫，与顶栏同款），点击走已有的 `uiStore.newProjectRange + openNewProject` 通路，弹窗自动填入所选日期范围。`ctxAddProject` 加 fallback：无 `cellCtx.range` 时用 `activeRange.value`（侧栏点击场景）。

---

## 2026-06-25 · 已完成列折叠的月份改 v-if：别让攒了几百个的项目卡全量挂载

`DoneColumn.vue`（项目看板「已完成」列）按年→月折叠，但折叠用的是 `v-show`——**只切 `display:none`，里面的 `ProjectCard` 照样全部挂载**。已完成项目随时间累积到几百个时，初次渲染要 mount 几百个 526 行、十几个 computed 的大卡片（虽不发网络请求，但实例化 + DOM + 响应式开销都在），明显拖慢。

改法：折叠容器的三处 `v-show` → `v-if`（年 body、月 cards、未设置日期 body）。默认 `onMounted` 只开当前年+当前月，于是**初次只渲染「最近完成」置顶 3 个 + 当前月那几张**，展开某月才按需挂载、折叠回去即卸载。`npx vite build` 通过。

> `v-show` 适合频繁切换、想保留状态的场景；这里卡片纯由 props 驱动、且大多数长期折叠，`v-if` 的按需挂载/卸载更划算。

---

## 2026-06-25 · 批量上传/缩略图并发限流：共享 pLimit，别把连接和带宽打满

低配生产（2C/2G + 有限带宽）批量拖几十个文件时，尾部请求 503/超时。根因是浏览器单域名 HTTP/1.1 约 6 连接，而前端**一次性把所有上传请求全发出去**（`ProjectModal.uploadFiles` 的 `Promise.allSettled(tasks.map(...))` 无上限），上传完成又同时触发同样多的 `/thumb` 请求，两者叠加瞬间打满。

**做法**：抽一个共享并发限流器 `@/utils/concurrency.js` `pLimit(n)`（任务排队、按阈值放行、完成即补位），上传与缩略图加载**共用同一实现**，阈值集中两个常量：`UPLOAD_CONCURRENCY=3` / `THUMB_CONCURRENCY=6`，带宽紧只调一处。

三处限流现状：① 上传 = `ProjectModal` 套 `pLimit(3)`（新增；`UploadModal`/`ProjectCard` 本就 `for` 串行）；② 缩略图加载 = `useThumbCache` 改用共享 `pLimit(6)`（替换原 `_acquire/_release`）；③ 缩略图生成（后端）= `_THUMB_SEM=Semaphore(cpu-1)`（早有，2C=1）。

注意：仅**单客户端内**限流，多用户并发仍可能叠加——真要全局限得后端中间件信号量，当前量级不必要。`npx vite build` 通过。详见 `performance.md` 十三节。

---

## 2026-06-26 · 给咕咕加「定时任务」技能：功能完整 + 尽量少调用

先清理 reminder 遗留（`action_type` 整列删，含 DB 迁移），再加 `skills/scheduled_tasks.py`
（list/create/update/delete 四件套，进 DefaultProfile）。两条硬约束贯穿设计：

**功能完整**：CRUD 齐；create 一次带齐 name+instruction+cron+channels；update 含改名/改时间/改渠道/启停；
delete 走两步 confirm；cron 支持 crontab 与 `@once:<ISO>`，复用 API 层 `_validate_cron`/`_norm_channels`。

**尽量少调用**：① create 一口气建好，cron 由模型从自然语言直接生成、不绕中间「解析时间」工具；
② update/delete **按任务名定位**（`task="每天进度"`），不必先 list 再操作（仿项目 `_resolve_project`）；
③ list 一次返回全部。④ **故意不进 `RESOURCE_BY_TOOL`**——定时任务是单行写入、风险低，进去会每次触发
自我核实那一轮，反而多调用，与「少调用」冲突，所以不放（代价：建完 /schedules 页不自动刷新，可接受）。

附带：`_humanize_cron` 把 `0 9 * * *`→「每天 09:00」，skills.md 要求**对用户只说人话时间、绝不甩 cron 串**；
设 feishu/qq 渠道前确认绑定。冒烟：建/按名改/按名删(两步)/非法cron拦截/cron人话化 全过，工具数 47→51。

---

## 2026-06-25 · 日历项目长条永远填不满 100%：一个 off-by-one

日历里 100% 完成的项目长条只填到 ~90%。`barSegFill`（`Calendar/index.vue`）把完成度 %
映射到项目日期跨度上填充，但两处天数口径不一致：

- `total = daysBetween(start, end)`（**不含端点**，6/1~6/10 = 9）
- `segEndOff = daysBetween(start, segEnd) + 1`（**含端点**，= 10）

→ `progressDays` 最大只到 `total`(9)，而末段 `segEndOff = total+1`(10)，`9 >= 100% 段尾` 永不成立
→ 末段走比例 `9/10 = 90%`。其实整条进度都被低估（50% 显示成 45%）。修复：`total` 也 `+ 1` 与
`segEndOff` 对齐。验证：100% 单段 90→100、跨周末段 75→100、50% 45→50。

> 这类"时间区间 / 索引"的 ±1 最容易藏在"含不含端点"上——map 进度到天数时，progressDays 的
> 标尺（total）必须和判定点（segEndOff）用同一种端点口径。

---

## 2026-06-25 · 回收站一键清空 + 堵住咕咕泄露内部术语

两个从真实使用里暴露的问题：

**1. 回收站只能 50 个 50 个删，没法一键清空。** 根因：`list_trash` 写死最近 50 条且不翻页（116 个只看得到 50，删完再冒下 50），`permanent_delete` 又只收单个 `file_id` → 删 N 个要调 N 次，撞 `MAX_ROUNDS` 上限就卡住。后端其实早有一键清空（`DELETE /trash`，网页"清空"按钮用的），只是 **agent 没有对应工具**。修复：`permanent_delete` 加 **`all=true`**（复用清空逻辑、一次全删、走同样两步 confirm、按数量提示）；`list_trash` 列满 50 时附"还有更多、清空用 all=true"提示；skills.md 加硬规则"清空回收站一次 all=true，绝不逐个删"。

**2. 咕咕把内部机制词泄露给用户。** 实际聊天里冒出了 `confirm=true` / `list_trash` / `system 注入的 116` / 空数组 `[]` / "调用 N 个"。policy.md 本有"不外露工具名/JSON"，但太笼统没对号入座。修复：把这次漏的**每个原词**作为反面清单钉进 policy.md，并给正反改写（❌「发了 50 个调用全失败、list_trash 返回 []、system 注入的 116 对不上」→ ✅「回收站清空啦，现在是空的 ✅」）。`builder.build()` 每次请求重读 .md，下条消息即生效、不用重启。

> 注：那次"文件不在回收站"是用户自己在网页删了，不是咕咕乱删 ID——排除了行为问题。

---

## 2026-06-25 · "咕咕开小差了"真凶：历史窗口截断留下孤儿 tool_result

用户反复"开小差"，排查绕了一大圈（先怀疑本地 DB 连接池、Redis、LLM key——全是好的），
最后从共享 DB 的 SystemLog + devserver 的 `gugu-web-dev.log` 揪出真凶。

### 排查链（记一笔，少走弯路）

1. 前端文案区分来源：`咕咕开小差了 😵‍💫` = 后端发的 **error 事件**（core.py LLM 失败的 detail）；
   `网络不太好 📡` 才是前端纯网络兜底。看到"开小差"就说明后端在报错，不是连不上。
2. 本地 gugu.log 不增长 → 用户其实打的是 **devserver**（和本地共用 192.168.110.50 的 DB/Redis，
   日志混在一起；traceback 路径 `/home/coffeiz/...python3.12` = Linux 才认出来）。
3. devserver 还有个坑：手动 `--reload` uvicorn 占着 8000，systemd `gugu-backend` 绑不上 →
   崩溃重启 **6031 次**（`Address already in use`）。这是噪声，不是"开小差"的因。
4. 真错在 `gugu-web-dev.log`：`BadRequestError 400 invalid params, tool result's...` 与
   `IndexError`（print 截断在 120 字符看不全）。

### 根因

`tokens.select_history` 按 token 预算"整条进出"裁历史，但**不守 tool_use/tool_result 配对**：
窗口可能从一个带 `tool_result` 的 user 消息开头，而它对应的 `assistant tool_use` 正好被裁在窗外
→ **孤儿 tool_result** → MiniMax（anthropic 兼容端点，比官方严）报
`invalid params, tool result's tool id(xxx) not found (2013)`。有时它返回畸形流让 SDK 抛 `IndexError`，
是同一病根的另一种表现。会话越长越容易踩（一个 136 条的会话是重灾区）。web.py 又把历史**原样**塞给 LLM，没有任何合法性清洗。

### 修复

`sanitize.sanitize_messages()`（`agent/sanitize.py`），在 web.py 发送前清洗：删孤儿
tool_use/tool_result、删空消息/空 text 块、保证首条 user、合并连续同角色。**验证**：直接打 MiniMax，
构造孤儿场景原样发 → 400（还原了那条确切报错），清洗后 → 200。

> 经验：MiniMax 其实**容忍**连续同角色（实测 200），真正致命的是孤儿 tool_result。
> 但合并同角色无害、留作健壮性。print 调试信息别截断太狠（`str(e)[:120]` 把关键的 tool id 切没了）。

---

## 2026-06-25 · 下线项目「备注」功能：贯穿全栈的字段删除

项目备注（`Project.notes`）整体下线，从数据层到 UI 一条龙删干净：

- **后端**：模型 `Project.notes` 列、schema（ProjectCreate/Update/Response）、API（`projects.py` 的 `_to_resp`/`create_project`）、全局搜索（`search.py` 不再按 notes 匹配）。
- **agent 工具（数据集）**：`skills/projects.py` 里 `create_project`/`update_project` 的 `notes` 入参、`get_project`/`list`/序列化的 `notes` 字段、以及工具描述里的"备注"字样全部移除——模型从此既不会写也不会读项目备注。
- **前端**：`stores/projects.js` 默认对象、`NewProjectModal`/`ProjectModal` 的备注 textarea + 自动保存 watcher + CSS、`Privacy.vue` 文案。
- **迁移**：`20260625000001_drop_project_notes.py`，`DROP COLUMN IF EXISTS`（幂等）。

两个注意点：① 只删**项目**的 notes，**客户**（`Client.notes`）和**邀请码**（`InviteCode.note`）的备注保留。② 模型改完应用即可正常工作（DB 那列还在、ORM 不映射、新建走 DB 默认值），**跑迁移才真正删列且不可逆**——本地/devserver/prod 各自决定何时 `alembic upgrade head`。改了 `skills/projects.py`（大脑），IM worker 需重启才生效。

---

## 2026-06-25 · 给 agent 加"自我核实"闭环：防"嘴上说建好了、实际没建全"

模型偶尔会建项目/任务时漏建几个阶段或待办，却回一句"都建好啦 ✅"。靠 prompt 提醒("做完检查一下")不稳——它经常跳过。于是改成**代码强制**的核实闭环（`core.py`）。

### 机制：`did_mutate` 开关 + 注入式自检轮

- 本轮只要调过增删改工具（复用实时刷新用的 `RESOURCE_BY_TOOL` 全集，32 个）→ 置 `did_mutate`。
- 模型说"完成"（不再调工具）时，若 `did_mutate` 且核实未满 `MAX_VERIFY=3` → **注入一条「系统自检」user 消息**，强制它用查询工具（`get_project`/`list_files`…）查证真生效/完整，**不全就当场补做**。
- **关键：是闭环不是定额**。自检轮里如果只查没改 → `did_mutate` 保持 False → 收尾结束（**通过即停**）；如果补做了（又调增删改）→ `did_mutate` 重新置位 → 再来一轮自检。直到"只查不改"或封顶 3 轮。
- **只读任务零开销**：没动过数据就不触发。Anthropic / OpenAI 两路同构，轮预算 `MAX_ROUNDS + MAX_VERIFY*2`，核实轮不挤占任务的 6 轮。

### 两个坑

- skills.md 原有一条"工具成功返回=完成，别反复 get/read 确认"（省 token）。它和强制自检**直接打架**——加了例外条款：收到「系统自检」必须照做。
- 自检 prompt 要写明"**核实无误就简短确认一句、别把流程念一遍**"，否则模型会在核实轮啰嗦复述，徒增 token。

### 代价（写给低配生产）

每个含增删改的任务**至少多 1 轮 LLM 调用**（自检轮），2C/2G + MiniMax 上成本和响应时间都会涨。换"不漏建"的确定性，值；嫌重可把 `_mutset` 收窄到只盖 create_*，或调小 `MAX_VERIFY`。

### 静默自检（补丁）：别"二次检查重复说一遍差不多的话"

上线后发现 UX 回归：前端所有 token 都拼进**同一个气泡**（`aiIdx` 跨轮不重置），自检轮的确认（"已核实，项目X的3阶段都在 ✅"）直接拼到首条"建好了…"后面，几乎重复。web.py 原有的去重只做**精确前缀匹配**，自检是**改写/换词**，前缀对不上 → 漏过。

改在 **core.py 源头**（web/IM 统一受益）：引入 `verify_mode`（进入核实阶段就持续到收尾，含其 `get_*` 查证轮）+ `verify_fixed`。核实阶段模型文字**先缓冲不实时发**——干净通过整段丢弃；只有补做时在补做那轮发一次"发现漏了X"说明。坑：自检几乎总要先调 `get_project` 查证，确认落在**下一轮**，所以 `verify_mode` 必须**跨轮持续**（最初按单轮标志写错了，冒烟测试抓出来）。

### 冒烟测试（无 API 成本）

在接缝处打桩（`_stream_round`/OpenAI client/`registry.dispatch`），用脚本化假回复驱动 **core.py 真实循环**，`backend/scripts/smoke_self_verify.py`，5 场景 23 断言全绿：① 干净通过→确认被抑制（核心诉求，断言"已核实"不在流出文本里）；② 发现漏→只发一次"发现漏了X"、中间/末尾确认静默；③ 纯查询不触发；④ 反复补做封顶 3 轮不报错；⑤ OpenAI 路同构。

---

## 2026-06-25 · 生产整机卡死：以为是自己传的代码，真凶是 pgAdmin + 2G OOM

第一次把咕咕部署到自己的生产服务器（阿里云 2C/2G + 1Panel），传了几个文件后**整机卡死、网页打不开**。第一反应是「我刚传的代码把后端搞崩了」——结果完全不是。

### 排查：先看「谁在烧 CPU」，而不是猜

```bash
ps aux --sort=-%cpu | head        # CPU 谁占满
free -h                            # 内存
journalctl -u gugu-backend -n 40   # 有没有崩/被杀
```

`ps` 一看，烧 100% CPU 的是 **pgAdmin**（`gunicorn ... run_pgadmin:app`），咕咕的 worker/web 才占 1%、好好的。pgAdmin 是 1Panel 应用商店装的、跑在 Docker 里，**崩溃重启循环**——PID 一直变（`kill` 掉立刻换个新的），连它的启动探活代码 `import config; print(...)` 都在 100% CPU 上转。它还绑在公网 80 端口，很可能在被扫描爆破。

`journalctl` 又发现咕咕 **backend 被 `code=killed status=9/KILL` 杀过几次**——`status=9` = SIGKILL，是**系统 OOM killer** 干的：pgAdmin + Postgres + Redis + 咕咕挤在 2G（实际可用 1.6G）里把内存吃爆，内核挑了 backend 杀。

### 根因链

pgAdmin 崩溃重启循环 → 烧满 CPU + 吃内存 → 整机卡 + 内存到顶时 OOM 杀掉咕咕 backend。**和我传文件没半点关系。**

### 处理

1. **停掉 pgAdmin**（Docker 容器，`docker stop` / 1Panel 停用；这台机根本不需要它，看库用本地客户端远程连）→ CPU 立刻回正常。
2. **加 4G swap** → 防内存峰值再触发 OOM。
3. worker 并发度调小、不用的 IM bot 停用 → 降咕咕自身占用。

### 教训

- **整机卡死先 `ps aux --sort=-%cpu | head` 看是谁，别先怀疑自己刚改的东西**——这次真凶是个完全无关的第三方应用。
- **`status=9/KILL` 八成是 OOM**，不是代码 bug。2G 小机必配 swap。
- **生产机别堆非必要的重应用**（pgAdmin、各种面板插件）——它们和你的服务抢同一份 CPU/内存，一个崩溃循环就能拖垮全机。
- 调优细节见 `deploy.md` §3.8「低配服务器调优」。

---

## 2026-06-25 · 并发化扩量踩的三个连接/配置坑

把 worker 从串行改并发、上多 key 分流那几天，真正卡住我的不是并发逻辑本身，而是三个「看着不相关、根因藏得深」的连接/配置坑。

### 坑一：SSE 长连接把 DB 连接池吃光 → 整站卡死

现象：前后端一重启、或多开几个标签页，**所有 API 一起挂**（30s 超时），不只是聊天。

根因：`/live/stream`（实时刷新 SSE）走 `Depends(get_current_user)`，而它 `Depends(get_db)`——于是 **DB session 在 SSE 整条长连接的生命周期里一直不释放**。每条 SSE = 占一个池连接。默认池 `pool_size=5 + overflow=10 = 15`，浏览器重连几次就打满，之后所有请求 `QueuePool limit ... timeout`。

修：SSE 不需要查 DB，只要鉴权。新增 `get_current_user_id`（只解 JWT、不碰 DB），SSE 端点改用它；连接池也调大到 15+25。

> **教训**：长连接 / 流式端点**绝不要挂 `Depends(get_db)`**——普通请求几十毫秒就还连接，SSE 能挂几小时。要鉴权就只解 token，别顺手拿 db。

### 坑二：uvicorn --reload 被 SSE 卡死，改一次代码要强杀

改完后端 `--reload` 卡在 `Waiting for connections to close`——SSE 长连接不主动断，reload 永远等不到「连接关完」，后端一直不可用，只能 `pkill -9` 重起。快速迭代时尤其要命。

解：`uvicorn ... --reload --timeout-graceful-shutdown 1`——1 秒强制断连，reload 秒级完成。（和坑一同源：SSE 长连接既占池、又卡 reload。）

### 坑三：config override 漏了一个段，整组开关静默失效

后台把「对话历史压缩」开关关掉、保存、刷新——**又自己打开了**。

根因：`apply_override` 给 `db/redis/storage/ai/quota/search/ai_presets` 都写了合并块，**唯独漏了 `agent`**，`top_fields` 还把 `agent` 排除在外。结果 `agent` 段（对话压缩、`worker_concurrency`、`memory_enabled`…）的 override **写进了 `config.override.json`，但 `apply_override` 根本不读** → `settings.agent.*` 永远是 schema 默认值。最坑的是**不报错**：保存成功、文件里也确实有 `false`，就是读回来是 `true`。

修：补上 `if "agent" in override: ...` 合并块。一并修好了之前也悄悄失效的 `worker_concurrency` / `memory_enabled`。

> **教训**：加一个新配置段，**必须同步在 `apply_override` 加合并块**，否则静默失效——没有任何报错指向你，只能靠「保存的值读不回来」反推。排查时记住：**「写盘成功」和「读回正确」是两回事**，要分别验。

---

## 2026-06-23 · 聊天文件收发：三个藏得很深的坑

做「用户给咕咕发文件 / 咕咕发文件回去」（网页 + 飞书），踩了三个根因都不在表面的坑：

**1. 飞书发文件「没收到」→ 暂存撞 asyncio loop。**
飞书收文件后要把字节暂存（`stage_sync`，给 IM 网关用的同步版）。咕咕一直说「暂存失败/没收到」。日志挖出来是 `RuntimeError: Cannot run the event loop while another loop is running`——lark SDK 的 handler **本身就跑在一个运行中的 asyncio loop** 里，我却在当前线程 `new_event_loop().run_until_complete()`，直接撞车。
修法：把 async 的 `storage.put` 丢到**独立线程**用 `asyncio.run` 跑（新线程没有运行中的 loop），元数据用**同步 redis** 客户端（避开 async 客户端的跨 loop 复用问题）。教训：**别假设自己不在 loop 里**——第三方 SDK 的回调经常已经在 loop 中。

**2. 实时同步时咕咕回复显示「空气泡」→ markdown 缓存渲染漏了 html。**
之前为性能把 AI 气泡改成「持久化消息读 `msg.html`（预渲染），只有流式才实时 `renderMd`」。但 IM 实时 `appended` 进来的助手消息只塞了 `text` 没塞 `html` → 非流式分支读到 undefined → 空气泡。修：append 时就 `renderMd` 设 `html`、带上 `files` 卡片，AI 空文本不渲染气泡。教训：**加缓存字段后，所有写入口都得补上**，否则某条路径的数据就是「半成品」。

**3. `agent_usage.tools_used` 缺列 → 所有生成全崩。**
并行改动给模型加了 `tools_used` 字段但没建迁移，生产库没这列 → 每次存用量 `UndefinedColumnError` → `run_collect` 整个 except 掉 → 看起来像「咕咕全坏了」。手动 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 救活（迁移文件待补）。教训：**模型字段改动必须配迁移**，缺一列能让整条链路静默崩。

资源下载/上传的平台 API 用法参考了 QwenPaw（飞书 `im.v1.message_resource.get` 下载、`im.v1.image/file.create` 上传）。QQ 的发文件还没做。

---

## 2026-06-23 · 漏重启 worker：实时不生效 + QQ 会话没标 source（同一个根因）

实时刷新和 IM 标题都做完、也单测过了，用户却反馈「IM 消息依旧不实时、新建 session 不刷新、QQ 会话没标记成 qq」。两个 bug，同一个根因。

### 大脑跑在 worker，我一直只重启 supervisor

排查时按 source 这条线查：QQ 会话 `source` 没设成 `qqbot` → 说明 `req.source` 没传到 `run_collect`。但翻 `worker.py` 的 `handle()`，`AgentRequest(..., source=platform)` 明明是对的，`qq.py` 入队也带了 `platform:"qqbot"`。代码没问题，那就是**跑的进程是旧的**。

`ps` 一看：worker 进程 pid 还停在 **12:49** 启动的那个，而我这下午改的实时代码、source 传递全在之后。**关键认知盲点**：咕咕的大脑（`run_collect` + 工具 dispatch）跑在**独立的 `worker` 进程**里——

```
网关(qq/feishu) 收消息 → 入队 ──→ worker 消费 → run_collect(大脑) → 发回 + publish事件
   ↑ supervisor 管这些                  ↑ 这个进程我从没重启过
```

我每次「重启 IM 栈」都只杀了 supervisor + 网关，**网关只负责收消息入队**，真正跑大脑、发实时事件、写 source 的 worker 一直是旧代码。栽在同一个地方好几次都没意识到 worker 是第三个独立进程。

### 修 + 验证

重启 worker 后：新建 QQ 会话 `source='qqbot'` ✓；用 curl 模拟浏览器订阅 `/live/stream`，独立进程 `events.publish` 的事件跨进程送达 ✓。两个 bug 一起好。

### 教训

- **改 `agent/` 大脑代码必须重启 worker**，光重启 supervisor 没用；`make restart` 只管 web。已写进 `deploy.md` 2.7。
- 调试顺序对了：先盯一个**具体的可证伪现象**（source 没写对），顺着它确认「代码对 → 那就是进程旧」，比对着「实时为什么不工作」空想快得多。
- 进程模型要在脑子里清晰：web(uvicorn) / supervisor(+网关子进程) / worker 是**三个**独立常驻进程，各管一段，别当成一坨。

---

## 2026-06-23 · 实时刷新：Redis pub/sub → SSE（顺带想清楚了站内 IM 的地基）

用户反馈「IM 发的消息、咕咕创建整理项目/活动/文件 都不会实时更新」。拆开是两个层面的洞。

### 根因：IM 的改动根本没有通道到网页

web 聊天本来有 `refreshAfterTools`——流结束后按用过的工具刷对应 store。但它**只对 web 生效**：IM（飞书/QQ）走的是另一条路（worker → `run_collect`），网页这边毫不知情。而且翻代码发现 Calendar 视图 `import` 了 `calendarSignal` 却**根本没 watch 它**，等于 web 改了日历视图也不刷——一个潜伏的 bug。

光靠「web 流里的 `tool_done` 事件」补不了 IM——**IM 没有 web 流**。要让 IM 的改动到网页，必须有**推送通道**。

### 方案：挂在 dispatch 这个唯一咽喉上

关键发现：`registry.dispatch` 是 **web agent 和 IM worker 共用的唯一工具执行入口**。在这一个点上 publish「资源变了」，两条路就都覆盖了。Redis 已经在用（IM 队列 + 心跳），pub/sub 顺手：

```
工具成功 → events.publish(user_id, 资源)  →  Redis PUBLISH events:{user_id}
                                          →  SSE /live/stream（前端 fetch streaming 订阅）
                                          →  bump rev[资源] → store/视图 watch 重新拉
```
按 `events:{user_id}` 隔离频道，**没有跨用户扇出**——这是流量会不会炸的分水岭。

### 从「刷列表」到「消息级追加」——想清楚了 native IM 的地基

第一版只发 `{resources:['sessions']}`，前端刷会话列表。用户问「为什么消息不会追加」「以后做站内 IM 是不是还得做」「流量会不会太大」——三连问其实把方向问明白了：

- **追加是任何 IM 的核心，不是附加项**。粗粒度「刷列表」是桥接场景的取巧；站内 IM 必须做到消息级推送。
- **现在搭的 pub/sub → SSE 就是它的地基**，不浪费。于是直接做成 IM-ready：事件带 `session_id + appended`（这一来一回），前端判断是当前会话就把气泡追加进去。
- **流量反而更省**：粗粒度是「改一条 → 整列表 refetch」，消息级是「只发那一条增量」。加上按收件人定向、空闲只 keepalive，流量下限就是「消息本身」，省不掉也不该省。

### 留的尾巴（记清楚）

web 自身聊天（`web.py` 流式）暂未 publish → 同账号多网页标签不互相同步。做站内 IM 时让 web 也 publish 即可，链路现成。已读/送达/在线状态/顺序去重是 IM 进阶项，地基已就位。

详见 `docs/agent.md`「实时刷新」一节、`CHANGELOG.md`。

---

## 2026-06-23 · 咕咕读历史对话 + 隐藏导航悬停 URL

两件小事，但第二件踩了「需求别想当然」的教训。

### 咕咕能翻以前的对话了

此前咕咕只能看**当前 session 的上下文**和**提炼出的记忆**，翻不了以前那次具体聊了啥。加 `conversations` skill 两个工具：`search_conversations(keyword?)`（搜消息正文+标题、按 session 聚合带片段；不传则列最近）、`read_conversation(session_id)`（读完整原文）。**严格按 `user_id` 隔离**，读他人 session 返回"不属于你"（实测验证）。和记忆系统互补——**记忆是提炼结论，这是原始原文**，要细节时才翻。

### 「隐藏导航栏 URL」——先理解错成隐藏地址栏

用户说"隐藏导航栏的 url"，我**第一反应是隐藏地址栏路径**，于是把两个 router 都换成 `createMemoryHistory`（路由进内存、地址栏永远停在根）。用户回："我不是说这些"——还反问我**这网站到底该不该隐藏地址栏**。

我给了真实意见：**不该**。URL 路径不是机密，数据靠 token/角色守，藏路径属于"安全靠隐蔽"几乎没用；却实打实丢了**刷新留在原页、深链、前进后退**。于是全回退。

用户真正要的是**消除侧栏链接悬停时浏览器状态栏的 URL 预览**。根因：`<router-link>` 渲染成 `<a href>`，悬停就露目标地址。改法：侧栏项换成 `<div>` + 编程式 `router.push`，**没有 `href` 就没有悬停预览**；自己用 `route.path` 算 active 高亮、补 `tabindex`/`role=link`/回车跳转保住可访问性。主站 `NavItem.vue` + 后台 `AdminLayout.vue` 都改。

**教训**：含糊需求（"隐藏 url"）至少有三种解（藏地址栏 / 藏悬停预览 / 改 hash），我挑了最重的那种还动了架构。该先一句话确认再动手，而不是猜一个就改一片。

详见 `CHANGELOG.md`。

---

## 2026-06-23 · IM 统一 BYO + 服务面板 + 发文件 + 健壮性一波（接 QQ 之后）

QQ 跑通后这一大批：把飞书也并到 BYO、加运维面板、让咕咕能发文件、补一堆健壮性。记几个有价值的点。

### 飞书也是「扫码即创」——又一次推翻「合作墙」

继 QQ 之后，飞书同样被我先误判为"需要官方接入资质"。扒 QwenPaw 源码 + 实测发现飞书有公开的 **OAuth 2.0 设备授权流（RFC 8628）**：`POST accounts.feishu.cn/oauth/v1/app/registration`（init→begin→poll），手机飞书扫码授权后**自动创建 PersonalAgent 应用**、poll 直接返回 `client_id/secret`。**无鉴权、无资质**。

于是把飞书从「Admin 共享 bot + OAuth 用户绑定」**整个换成 BYO**（每用户扫码建自己的 app），和 QQ 统一：
- supervisor 飞书+QQ 都从 `user_bots` 表读、env 注入凭据；worker 都用 `owner_user_id` 认人（bot 即归属，省掉 `PlatformBinding`）。
- 删掉一整套旧代码：`feishu_bind.py`(OAuth)、`feishu_event.py`(webhook)、`PlatformBinding` 模型、Admin 频道面板、`FeishuSettings`/`active_im_bots`。
- 坑：device flow **轮询等待时按 RFC 8628 返回 HTTP 400 + `{"error":"authorization_pending"}`** —— poll 不能 `raise_for_status`，否则一直当失败。
- **教训重复**：又是"看起来很官方就以为够不着"。一个 `curl` 比三轮猜测有用。两次都栽在这。

### 工具异常会冲垮整轮对话（健壮性大坑）

用户报"咕咕生成一个字就出问题了"。查到 `registry.dispatch` 对工具 handler **没有 try/except**——任何工具抛异常都会穿透 core → web.py 的 `except` → 整轮报「咕咕出了点问题」。一个工具崩 = 整个对话崩。

修：dispatch 包 try/except，把 `{"error":"工具 X 执行出错…"}` 当**结果**返给 LLM（并打日志）。LLM 按 persona 铁律如实说没做成、不假装成功，**对话继续**。顺带把错误文案友好化+分类（网络→「网络不太好」、其他→「开小差」）。

### 发文件：工具 → 前端 UI 的旁路

咕咕要能在窗口发可下载文件。普通工具结果只回给 LLM，没法推 UI。于是开一条旁路：工具结果带 `_artifact` → dispatch 返回 `(文本, artifact)` → core 在 tool_done 后多推 `{type:'file'}` → web 透传给前端渲下载卡片。**任何工具想推 UI 元素都能走这条**。持久化到 `conversation_messages.files`（新列+迁移），刷新后还在。

### 服务面板：kill + systemd 自愈

Admin 加「服务状态」页：worker/supervisor 每 5s 写 Redis 心跳，面板看状态 + 一键重启。重启用 **kill pid + 靠 systemd `Restart=always` 复活**（同用户无需 sudo；杀前核对 `/proc/cmdline` 防误杀）。dev 没 systemd 不自愈 → 加了"后端自己 Popen 拉起"兜底，`systemctl is-enabled` 判断走哪条。

### 并行 agent 协作的坑

这阶段有另一个 agent 同时在改前端。踩到：① 它插了个排序选择器到 `v-if/v-else` 中间 → 整个 build 挂（`v-else` 不相邻）；② 它给 `ConversationSession` 加了 `source` 列**但没迁移**，本地我 ALTER 过不报错、**服务器全新 DB 会缺列崩**。
- **教训**：模型加列必须配迁移（`create_all` 只建表不加列）；提交时只 `git add` 自己动过的文件，别把别人半成品一起提了。

### 收尾

- 网页生成中发消息会**排队**，生成完接力发（和 IM 的 Redis 队列行为一致）。
- `create_project` 未填日期默认 start=今天、deadline=一周后。
- IM 对话**补上会话历史**（之前 `run_collect` 没读历史 → "聊着聊着变新会话"）。

详见 `docs/agent.md`、`docs/agent-im接入架构.md`、`CHANGELOG.md`。

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
