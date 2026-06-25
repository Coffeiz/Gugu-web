# PM Studio · 早期开发记录

> 更新：2026-06-25
> 状态：早期阶段记录，当前进度见 `docs/overview.md`

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

### 冒烟测试（无 API 成本）

在接缝处打桩（`_stream_round`/OpenAI client/`registry.dispatch`），用脚本化假回复驱动 **core.py 真实循环**，4 场景 15 断言全绿：A 建项目→自检发现不全→补做→二次核实通过（注入 2 次）；B 纯查询不触发；C 反复改→封顶 3 轮不报错；D OpenAI 路同构。证实了"通过即停 / 补做再触发 / 只读不触发 / 有上限"四条核心行为。

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
