# 咕咕 · IM 多平台接入架构

> **状态**：🟢 飞书 + QQ + 微信三平台均已上线（飞书/QQ BYO 扫码自连，微信 iLink 长轮询）｜文本/图片/语音三平台打通｜队列+worker+supervisor 三进程已部署，supervisor 带秒崩退避
> **分类**：技术架构 / Agent 平台接入
> **创建**：2026-06-23 ｜ **更新**：2026-07-02
> **目标**：把咕咕接入飞书 / QQ / 微信三个 IM 平台，**不依赖 OpenClaw**，且架构**未来可平滑扩到高流量**。
>
> 运行时一轮对话内部决策环（含 IM 前置路由 / 状态机 / 自然语言取消）见 [`agent-决策环.md`](agent-决策环.md)。

> ⚠️ 文中各平台 API 细节来自仓库/SDK 调研（WebFetch），**动手前需对着官方真 README 再核一遍**。

---

## 1. 目标与原则

- 咕咕（独立 FastAPI 后端）作为"大脑"，接入飞书 / QQ / 微信，让用户在 IM 里直接和咕咕对话、管理项目/文件/日程。
- **不用 OpenClaw**：三个平台都走各自官方直连。
- **多用户**：每个平台用户必须映射到独立咕咕账号，数据隔离（见 [[project-multiuser]]）。
- **为高流量留缝**：从一开始就按"收消息 / 跑大模型"解耦的架构建，将来加机器即可扩，不重写。

---

## 2. 为什么不用 OpenClaw

`Tencent/openclaw-weixin`、`tencent-connect/openclaw-qqbot`、`larksuite/openclaw-lark` 都是 **OpenClaw 网关的频道插件**——插件本身就是连接器，跑在 OpenClaw 里，Agent 的"大脑"也配在 OpenClaw。

要用它们得：① 跑一个 OpenClaw 网关 + 把咕咕桥接成 OpenClaw 的后端。这等于多运维一套框架、还受其版本兼容约束（如 openclaw-weixin 与 OpenClaw 2026.3.22+ 曾不兼容，issue #52885）。

**结论**：三个平台都有官方直连路径，咕咿自己写 adapter 即可，OpenClaw 是多余中间层。

---

## 3. 三平台「不用 OpenClaw」直连方式

| 平台 | 官方直连 | 收消息 | 公网 URL | 难度 / 风险 |
|------|---------|--------|---------|------------|
| **飞书** | `lark-oapi` SDK | WebSocket 长连 或 webhook | **不需要**（长连） | 🟢 最易，文档最好 |
| **QQ** | `botpy` SDK | WebSocket | 不需要 | 🟢 易，官方稳定 |
| **微信** | 直连 iLink（自写 HTTP 客户端） | 长轮询 getupdates | 不需要 | 🟢 已落地，文本/图片/语音全通；个人号自动化仍有政策风险 |

### 3.1 飞书 — `lark-oapi`（larksuite/oapi-sdk-python）· 已落地（BYO + device-flow 扫码自动创建）

实现是 **BYO（每用户自带 app）**，代码 `agent/adapters/feishu.py` + `app/api/v1/feishu_connect.py`。

- **鉴权**：App ID + App Secret（用户扫码自动创建的 PersonalAgent app），SDK 自动管 `tenant_access_token`
- **收**：`im.message.receive_v1`，走 **WebSocket 长连接**（`lark.ws.Client`）→ 不需要公网；收凭据由 supervisor 走 env 注入，payload 带 `owner_user_id`
- **发**：`lark.Client` `im.v1.message.create`，worker 端按 bot id 现查 `user_bots` 取凭据

**扫码自动创建 app（OAuth 2.0 设备授权流 RFC 8628，复刻 QwenPaw，实测无需合作方资质）** `feishu_connect.py`：
```
POST accounts.feishu.cn/oauth/v1/app/registration action=init  → supported_auth_methods（无鉴权）
POST … action=begin (archetype=PersonalAgent, auth_method=client_secret) → device_code + verification_uri_complete
  → 前端二维码 verification_uri_complete?source=Gugu（open.feishu.cn/page/launcher?user_code=..）
  → 用户手机飞书扫码 → 授权创建 PersonalAgent 应用
  → 轮询 POST … action=poll {device_code}
       （等待时按 RFC 8628 返回 400 + {"error":"authorization_pending"}，poll 不能 raise_for_status）
       成功 → client_id + client_secret → 自动写 user_bots
```
- device_code 只存服务端 Redis（按 poll_id）。`source` 仅来源标签（非白名单）。国际版 Lark 域名 `accounts.larksuite.com`。
- 与 QQ 同 BYO 模型（[[qq-scan-connect]] 同套）；早期的「共享 bot + OAuth 绑定」已废弃删除。

### 3.2 QQ — `botpy`（tencent-connect/botpy，官方）· 已落地（单聊 C2C，BYO）

实现是**单聊 C2C** + **每用户自带 bot（BYO）**，代码 `agent/adapters/qq.py`。

- **鉴权**：AppID + AppSecret（q.qq.com 开发者后台）
- **收**：WebSocket，继承 `botpy.Client`，`botpy.Intents(public_messages=True)` 订阅，事件 `on_c2c_message_create`；`message.author.user_openid` = 用户、`message.id` = 被动回复用的 msg_id
- **发**：被动回复 `BotAPI.post_c2c_message(openid, msg_type=0, content, msg_id)`（worker 端独立 `BotHttp(...).login(Token)` 取 token，过期自动重建）
- **启动**：`client.run(appid=, secret=)`（同步阻塞，botpy 自带重连）
- 注意：群/C2C 消息能力需平台审批；有 sandbox / 生产环境之分

**BYO 模型（与飞书"共享 bot"不同）**：QQ 每个用户填自己的 bot，存 `user_bots` 表（`app/api/v1/user_bots.py` 的 `/me/bots` 用户级 CRUD）。
- supervisor 从 **DB** 读启用的 user_bots，每个起一条网关子进程，凭据走 **环境变量注入**（不走 argv，避免 ps 泄漏）。
- bot 收到的消息**天然归属其 owner** → 入队 payload 带 `owner_user_id`，worker 直接认人，**无需平台用户↔咕咕用户的绑定**（这点比飞书简单）。

**扫码自动连接（复刻 QwenPaw/OpenClaw，实测无需合作方资质）** `app/api/v1/qq_connect.py`：
```
POST q.qq.com/lite/create_bind_task {"key": base64(随机32字节)} → task_id   （无鉴权）
  → 前端二维码 connect.html?task_id=..&_wv=2&source=Gugu
  → 用户手机 QQ 扫码 → QQ App 内选 bot 授权
  → 轮询 POST q.qq.com/lite/poll_bind_result {"task_id"}
       status==2 → bot_appid(明文) + bot_encrypt_secret(AES-256-GCM, iv(12)+密文+tag)
  → 用第 1 步的 key 解出 AppSecret → 自动写 user_bots
```
- **安全**：接口本身无鉴权，但 secret 用调用方本地 key 加密回传，只有创建者能解；aes_key 只存服务端 Redis（按 task_id），不下发前端。
- `source` 仅为来源标签（非白名单，任意值都跳转）。
- 拆解过程见 `docs/devlog.md` 2026-06-23 QQ 条 + `qq-scan-connect` 记忆。

### 3.3 微信 — 直连 iLink · 已落地（BYO + HTTP 长轮询，文本/图片/语音全通）

无 QQ 那种开放 bot 平台；官方新通道是 **iLink**（`ilinkai.weixin.qq.com`）。代码 `agent/adapters/wechat.py` + `agent/adapters/wechat_client.py`，与飞书/QQ 同 BYO 模型（凭据存 `user_bots`，`bot_token` 复用 `app_secret` 字段、`base_url` 复用 `app_id` 字段）。

- **登录**：扫码 → 拿 iLink bot token（24h 过期需重扫，要做自动重连）
- **请求头**：`Authorization: Bearer <token>` + `AuthorizationType: ilink_bot_token` + `X-WECHAT-UIN`（每次随机 uint32 base64）+ `iLink-App-Id: bot`
- **收**：`POST getupdates` 长轮询（服务端挂 ~35s）
- **发**：`POST sendmessage`，必填 `from_user_id` / `to_user_id` / `client_id` / `message_type:2` / `message_state:2` / `context_token` + `item_list`（iLink 特有：回复须带入站消息给的 `context_token`，是和飞书/QQ 唯一的接口差异）
- **打字指示**：`getconfig`(取 typing_ticket) → `sendtyping{1}` → 生成 → `sendmessage` → `sendtyping{2}`
- **消息体 `item_list`**：每项按 `type` 区分——`1`=文本(`text_item.text`)、`2`=图片(`image_item`)、`3`=语音(`voice_item`)、`4`=文件(`file_item`)、`5`=视频。同一条消息可以带多个 item（不像 QQ/飞书一图一消息）。
- **图片**：CDN + AES-128-ECB 解密（`image_item.media.full_url` 下载 → key=`image_item.aeskey`(32 hex) → ECB 解密去 PKCS7 padding → 按 magic bytes 判 ext/mime），走 `chat_attach.stage(kind="image")` 接入统一附件链路，见 `_ingest_wechat_media`。
- **语音**：iLink **自带 ASR 转写**在 `voice_item.text`，不用像图片那样下载解密音频——直接把转写文字包一层「🎤 用户发来一条语音（已转文字）…」的提示注入对话文本即可，逻辑在 `_handle_msg` 里、不经过 `_ingest_wechat_media`。转写为空（ASR 失败/听不清）给兜底提示，不静默丢消息。字段名来自开源参考 [hao-ji-xing/openclaw-weixin](https://github.com/hao-ji-xing/openclaw-weixin) 的 `wechat-claude-bridge.mjs`，已用真实语音验证跑通。
- **文件**（`file_item`）：格式仍未逆向，暂留日志待补（`_ingest_wechat_media` 里非 `image_item` 的项会打印 `暂不支持的媒体项` 日志）。
- **风险**：须守《微信 ClawBot 功能使用条款》，腾讯保留内容过滤/限速；个人号自动化风险自负。

### 3.4 三平台条款合规与封号风险（商用前确认，2026-07-02 记录）

| 平台 | 适用条款 | 主要合规点 | 封号/中断风险评估 |
|------|---------|-----------|------------------|
| **飞书** | 《飞书开放平台开发者服务协议》+《飞书个人应用（PersonalAgent）规范》 | BYO：应用由**用户本人**扫码创建、归属用户自己的账号；咕咕只代持凭据（AES-256-GCM 加密存储）。消息仅限用户与自己 bot 的对话，不涉及群发/营销 | 🟢 低——官方开放能力、个人应用形态本就面向此场景；最坏情况是单个用户的 app 被限，不影响他人 |
| **QQ** | 《QQ 机器人开发者协议》（q.qq.com）+ 平台内容规范 | BYO：bot 由用户在官方开发者后台创建；C2C 单聊能力需平台审批，sandbox/生产分环境；消息内容经官方 API，受平台内容审核约束 | 🟢 低——官方 bot 平台正规通道；风险点是**内容审核**（回复触发平台过滤会发送失败，已有 ret 日志），非封号 |
| **微信** | 《微信 ClawBot 功能使用条款》 | iLink 是官方新通道但形态是**个人号自动化**；腾讯保留内容过滤/限速权 | 🟡 中——三平台里唯一挂"个人号"的，条款明确风险自负；商用放量前建议：向用户明示该风险 + 微信侧默认不开启、用户主动选择接入 |

> 共同点：三平台都是 **BYO（用户自带 bot/凭据）**——封禁风险落在单个用户自己的 bot 上，不存在"咕咕官方账号被封、全体用户中断"的单点。隐私政策（`privacy.md` 第三节）已列三家隐私政策链接；本表补的是**平台服务条款**维度的合规确认（商用就绪评审 P0-5）。

---

## 4. 高流量架构

核心一句：**把"收消息"和"跑大模型"拆开，中间塞队列。** 大模型调用又慢又有速率上限，是唯一瓶颈，绝不能在长连接里同步等它。

```
飞书WS网关 ┐                          ┌→ Worker池 ×N（跑大模型，非流式）→ 调平台API发送
QQ WS网关  ├→ 规范化成 AgentRequest ──→ [Redis Streams 队列] ─┤
微信轮询网关┘   + 秒回"在干活" ack      └→ 加 worker = 加吞吐
                     │                              │
            [Redis: 用户状态/平台token/事件去重/用户映射缓存]
                     │                              │
            [Postgres: 用户/对话/用量]        [OSS: 记忆/文件]
```

三层各自独立扩展：

| 层 | 职责 | 扩展方式 |
|----|------|---------|
| **网关**（每平台 1 个/可分片） | 持长连接；只做"收→规范化→入队→秒回 ack"，**不碰大模型** | 轻量；按平台/账号分片 |
| **队列**（Redis Streams） | 削峰、解耦；消费组负载均衡 + ack + 失败重投 | 已有 Redis；Streams 轻松扛十万级/秒 |
| **Worker 池** | 出队→映射用户→跑 `core.LLMRunner`(非流式)→发送 | **横向加进程**；真瓶颈在此 |

**为什么能扛量**：网关不阻塞（只入队）→ 一条长连接吞海量消息；突发洪峰被队列吸住，不打爆大模型；加 worker 直到撞**大模型速率上限**——这才是真天花板，靠**多 key/预设轮询**（已有 `ai_presets`）突破。

> **不要上 Kafka/RabbitMQ**：瓶颈永远是大模型不是队列，Redis Streams 足够，别过度设计。

---

## 5. 关键设计缝（现在留好，将来不重写）

代码库已有 `agent/models.py` 的 `AgentRequest` / `AgentResponse` + `agent/adapters/base.py`——缝早留好了。守住两个边界：

1. **非流式 runner = 纯函数** `(AgentRequest) → AgentResponse`：从现有 `core.LLMRunner` 抽出"攒完整段"版本。内联调、worker 里调，代码一字不改。
2. **`dispatch(request)` 单一间接层**：今天 = 入队，明天 = 换 broker 也只改这一处。

只要这两处干净，从单机长到集群是**加组件，不是重构**。

> Web SSE 适配器（`adapters/web.py`）保持不变（流式、请求驱动）；bot 走新的非流式队列路径；两者共用 `core.LLMRunner`。

---

## 6. 现状盘点（2026-06-24，step 1-5 已落地）

| 能力 | 现状 |
|------|------|
| 轻量后台 runtime | ✅ 有：FastAPI `lifespan` 拉起常驻 asyncio 循环（回收站清理 / DB 重连 / 日志刷盘）+ 反思 `create_task` |
| 队列 / worker 框架 | ✅ **已建**：`app/core/redis.py`(Streams 封装) + `worker.py`(独立进程消费) |
| Redis | ✅ **已接入**：共享异步客户端（懒加载单例）+ Streams；config 改 redis 配置 reset 重建 |
| 非流式 runner | ✅ **已有**：`agent/runner.py` `run_collect()`，复用大脑收成完整回复 |
| 网关进程管理 | ✅ **已建**：`agent/adapters/supervisor.py` 按 DB `user_bots` 动态 spawn/kill 飞书·QQ·微信网关子进程，带指数退避（详见 §10） |
| 微信接入 | ✅ **已落地**：`agent/adapters/wechat.py`，BYO + iLink 长轮询，文本/图片/语音全通（图片 CDN+AES-128-ECB 解密，语音走 iLink 自带 ASR 转写，见 §3.3） |
| 多渠道附件解析隔离 | ✅ **已加固**：`chat_attach.resolve_attach` 兜底解析按当前渠道（`imctx`）收窄候选，避免跨渠道/跨类型误取（如把另一渠道的语音当成这次要存的图片）；`stage`/`stage_sync` 新增 `platform` 字段打标签 |
| Runtime Router + 状态机（文档 29 / Phase 1.7） | ✅ **已落地**：`agent/router.py`(关键词分类) + `agent/runtime_state.py`(Redis 状态机 IDLE/THINKING/SEARCHING/GENERATING + 取消标志)；网关层短路状态查询/取消，详见 [`agent-决策环.md`](agent-决策环.md) §⓪。**注**：情绪/催词用「句首锚定」防话题误判（「法拉利怎么这么慢」不算催咕咕）；催促只在咕咕真在忙时才拦、回「还在想/正在弄」，空闲交主模型 |
| 平台用户 ↔ 咕咕用户映射 | ✅ **BYO 免映射**：每用户自带 bot，消息天然归属 owner，入队 payload 带 `owner_user_id`，worker 直接认人——无需 `(platform, platform_user_id) → user_id` 绑定表 |

> **重要坑**：后端现为 `uvicorn --workers 1`（生产 backend 单元用 2）。若为扩量把 web 开多 worker，每个进程会各自再拉一遍 bot 长连接 → 重复连接/处理。故 **bot 网关/worker 脱离 web 当独立进程起**（`adapters/` 不依赖 FastAPI request 即为此）——见 §10 三进程拆分。

---

## 7. 落地路线 —— 直接从「队列架构」起步

决策：**不先做内联 MVP 再重构，直接按队列+worker 架构建**（理由：dispatch 缝两种做法一样，Redis 已配置，省一次重构）。但**每条缝单独验证**，避免一上来同时调一堆未知。

构建顺序（每步独立可测）：

| 步 | 做什么 | 单独验证 | 状态 |
|----|--------|---------|------|
| 1 | `app/core/redis.py` 共享异步连接池 + Streams 封装（produce/consume/ack/claim） | 脚本自产自消一条 | ✅ 实测远程 Redis 8.8.0 通 |
| 2 | `agent/runner.py` 非流式 runner：从 `core.LLMRunner` 抽"攒完整段"版 | 喂假 AgentRequest 看完整回复 | ✅ 实测真打 MiniMax 通 |
| 3 | `worker.py` 独立进程：消费→runner→打印（先不发平台） | 手动 XADD 一条看 worker 跑通 | ✅ 实测 队列→大脑→ack 通 |
| 4 | 第一个平台网关（飞书 + QQ）：收→XADD | 网关打印收到消息，确认鉴权/事件格式 | ✅ 飞书 `lark.ws` + QQ `botpy` 均通 |
| 5 | 接通：网关→队列→worker→真发送 | 端到端"hello from 咕咕" | ✅ 飞书/QQ 双向收发 + 文件 + 多模态 |
| 6 | 事件去重、token 共享、背压、状态机/取消 | 逐个加 | 🚧 状态机+取消已做；去重/背压待加 |

> step 1-5 全部对真实平台跑通：飞书/QQ 走 BYO 扫码自连，`supervisor` 按 DB 起网关 → 网关入队 → worker 消费 → `run_collect` → 调平台 API 发回。用户映射用 BYO owner 免了（见 §6）。

---

## 8. 高流量必踩点（第 6 步起逐个加）

- **平台用户 ↔ 咕咿用户映射**：`(platform, platform_user_id) → user_id`，首次接触自动建号或绑定流程；热映射缓存进 Redis（咕咿是多用户，**必须隔离**）
- **幂等去重**：平台会重发事件（飞书 webhook 重试），按 message_id 在 Redis 去重
- **平台 token 存 Redis**：worker 发送时要用（微信扫码 token 尤其）
- **用户状态机**（1.7）：每用户 IDLE/WORKING 存 Redis；同一人狂发时只跑一次、其余回"还在弄哦"——既是体验也是防刷
- **秒回 ack**：无流式，收到先应一句"在看了哈～"，干完发真答案（微信有 sendtyping）
- **背压**：队列堆积时降级/限速，别无限吃
- **Postgres**：每消息读写对话历史，索引要好；量大上 PgBouncer + 读副本；热数据缓存 Redis
- **进程管理**：worker 是独立进程，要进 `make`/`start.sh` 的起停（现仅起 uvicorn）

---

## 9. 待定决策

1. ~~**第一个平台**：飞书（文档最顺）还是 QQ（看受众）？微信最后。~~ 已解决：三平台均已落地（飞书/QQ 先行，微信最后接，符合当初计划）。
2. **用户映射策略**：IM 用户首次对话即自动建咕咿号，还是要求绑定已有账号？
3. **反思等附加 LLM 调用是否计入用户配额**（现不计，高流量下成本需重算）。

---

## 10. 进程部署与启停（现状）

> **部署形态：默认单机**（2026-06-24 决策）——三个服务 + 网关同机，一套配置管全部、Admin 配置/重启全生效。跨主机为可选路径（§10.3 / [`deploy.md`](deploy.md) §4.3）、Admin 推不到远端；扩量靠单机内手段。详见 [`并发优化ROADMAP.md`](并发优化ROADMAP.md) 部署形态决策。

IM 这套在生产以 **三个 systemd 常驻服务**跑（单元文件在 `backend/*.service`，由 `./start.sh install` 按 `RUN_USER`/`APP_DIR` 填占位符后写到 `/etc/systemd/system/`）：

| 服务 | ExecStart | 角色 | Restart | 日志 |
|------|-----------|------|---------|------|
| `gugu-backend` | `uvicorn app.main:app`（生产 `--workers 2`） | Web / Admin / API（用户在此注册 bot） | on-failure | `logs/gugu.log` |
| `gugu-worker` | `python -m worker` | **IM 大脑**：消费 Redis 队列 → `run_collect` 跑 agent → 回发平台 | **always**（死了消息无限排队） | `logs/gugu-worker.log` |
| `gugu-supervisor` | `python -m agent.adapters.supervisor` | **网关管家**：按 DB 拉起/看管飞书·QQ 网关子进程 | always | `logs/gugu-supervisor.log` |

### 10.1 网关是 supervisor 动态 spawn 的子进程（无独立单元）

`supervisor.py` 不是固定起几个网关，而是**对账循环**（`POLL_SEC=5`，每 5s 一轮）：

1. 读 `user_bots` 表里 `enabled=True` 的 bot（BYO：每用户自带 bot，凭据在 DB，不在 `.env`），平台→模块映射 `feishu`/`qqbot`/`wechat` → `agent.adapters.{feishu,qq,wechat}`
2. 每个启用的 bot → `subprocess.Popen([python, -m, 对应模块])`，凭据（`app_id`/`app_secret`/`owner`/QQ `sandbox`）作为**环境变量注入**子进程（不走 argv，避免 `ps` 泄漏）
3. 持续 reconcile：新启用/挂掉的 → 拉起；停用/删除的 → kill
4. **秒崩退避**（防凭据错误等必现问题无限重启刷日志）：进程存活不到 5s 就退出，判定「秒崩」→ 指数退避（10s→20s→40s…封顶 5 分钟）再重试；正常跑了一阵子才挂的（更像网络抖动）不退避、立即重启。退避期间只是暂不重启、不是放弃——凭据修好后最多 5 分钟内自动捡回，不用重启服务。（实战：某测试 bot QQ 凭据填错，加退避前每 5s 重启刷屏、184MB 日志有很大一部分是这么来的）
5. 单元设 `KillMode=control-group`：重启 supervisor 会**连带杀掉它 spawn 的全部网关子进程**，再由新进程统一拉起

> 含义：**在 Admin 里启用/停用某个 bot 不用碰 systemd**——supervisor 5 秒内自动 spawn/kill 对应网关。只有改了代码/凭据机制才需重启服务。

### 10.2 启停命令

**生产（有 systemd）：**
```bash
systemctl restart gugu-worker        # 改了 agent 代码（core.py / skills / runner）→ 重启大脑
systemctl restart gugu-supervisor    # 改了网关或路由（router.py / feishu.py / qq.py / wechat.py / supervisor.py）→ 重启网关（连带子进程）
systemctl status gugu-backend gugu-worker gugu-supervisor
journalctl -u gugu-worker -f         # 或 tail -f logs/gugu-worker.log
```

**本机 / dev（macOS 无 systemd）：**
- `./start.sh {start|stop|restart}` —— **只管 web 后端 uvicorn**，不含 worker/supervisor
- dev 起 IM 需手动：`python -m worker`、`python -m agent.adapters.supervisor`（后者需 DB 里有启用的 bot）；或临时单起一个网关：`FEISHU_BOT_ID=… FEISHU_APP_ID=… python -m agent.adapters.feishu`

### 10.3 改代码后该重启谁

进程启动时把对应模块**载进内存**；改磁盘文件不影响已在跑的进程，必须重启对应服务，且**先把新代码同步到该进程所在主机**（worker / supervisor 可能与本机不在一台）。

| 改了什么 | 重启 |
|---------|------|
| `agent/core.py`、`skills/*`、`runner.py`、prompts 之外的 agent 逻辑 | `gugu-worker` |
| `router.py`、`runtime_state.py`、`adapters/feishu.py`/`qq.py`/`wechat.py`/`supervisor.py` | `gugu-supervisor`（取消标志的*读*在 worker，故路由判定改了也重启 worker 稳妥） |
| `app/` 下的 Web/API | `gugu-backend` |
| `prompts/*.md`（persona/skills/policy/reflection 等） | 不用重启，每轮现读热生效 |

---

## 附：相关文件 / 现有缝

- `agent/models.py` — `AgentRequest` / `AgentResponse`（`cancelled` 透传取消）
- `agent/adapters/web.py`（SSE 流式）/ `feishu.py` / `qq.py` / `wechat.py`（IM 网关，BYO env 注入）/ `supervisor.py`（网关管家，按 DB spawn，带秒崩退避）
- `agent/core.py` — `LLMRunner`（流式 + 轮顶/流式途中查取消）；`agent/runner.py` — `run_collect()` 非流式收集
- `agent/router.py` + `agent/runtime_state.py` — 前置路由 + Redis 状态机/取消标志
- `worker.py`（顶层）— IM 队列消费进程；`app/core/redis.py` — Streams 封装（produce/consume/ack/claim）
- `app/api/v1/user_bots.py` / `feishu_connect.py` / `qq_connect.py` — bot CRUD + 扫码自连
- `backend/{gugu-backend,gugu-worker,gugu-supervisor}.service` + `start.sh install` — 三进程部署（见 §10）

## 附：参考来源

- [tencent-connect/botpy](https://github.com/tencent-connect/botpy)（QQ 官方 SDK）
- [larksuite/oapi-sdk-python](https://github.com/larksuite/oapi-sdk-python)（飞书官方 SDK）
- [SiverKing/weixin-ClawBot-API](https://github.com/SiverKing/weixin-ClawBot-API)（微信 iLink 直连示例）
- [hao-ji-xing/openclaw-weixin](https://github.com/hao-ji-xing/openclaw-weixin)（`wechat-claude-bridge.mjs` 给出 `item_list` 各 type 字段，语音 `voice_item.text` 自带 ASR 转写就是从这份代码逆向出来的）
- 三个 OpenClaw 插件（不采用）：`Tencent/openclaw-weixin`、`tencent-connect/openclaw-qqbot`、`larksuite/openclaw-lark`
