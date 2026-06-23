# 咕咕 · IM 多平台接入架构

> **状态**：💡 设计中（未开工）
> **分类**：技术架构 / Agent 平台接入
> **创建**：2026-06-23
> **目标**：把咕咕接入飞书 / QQ / 微信三个 IM 平台，**不依赖 OpenClaw**，且架构**未来可平滑扩到高流量**。

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
| **微信** | 直连 iLink（自写 HTTP 客户端） | 长轮询 getupdates | 不需要 | 🟡 中，文本可控；个人号有风险 |

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

### 3.3 微信 — 直连 iLink（参考 SiverKing/weixin-ClawBot-API）

无 QQ 那种开放 bot 平台；官方新通道是 **iLink**（`ilinkai.weixin.qq.com`）。**纯文本不涉及加密**，就是个 HTTP 长轮询客户端：

- **登录**：扫码 → 拿 iLink bot token（24h 过期需重扫，要做自动重连）
- **请求头**：`Authorization: Bearer <token>` + `AuthorizationType: ilink_bot_token` + `X-WECHAT-UIN`（每次随机 uint32 base64）+ `iLink-App-Id: bot`
- **收**：`POST getupdates` 长轮询（服务端挂 ~35s）
- **发**：`POST sendmessage`，必填 `from_user_id` / `to_user_id` / `client_id` / `message_type:2` / `message_state:2` / `context_token` + `item_list`
- **打字指示**：`getconfig`(取 typing_ticket) → `sendtyping{1}` → 生成 → `sendmessage` → `sendtyping{2}`
- **媒体**（图片/语音）：AES-128-ECB + CDN，**首版不做，文本先行**
- **风险**：须守《微信 ClawBot 功能使用条款》，腾讯保留内容过滤/限速；个人号自动化风险自负 → **建议三平台里最后接**

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

## 6. 现状盘点（2026-06-23，step 1-3 已落地）

| 能力 | 现状 |
|------|------|
| 轻量后台 runtime | ✅ 有：FastAPI `lifespan` 拉起常驻 asyncio 循环（回收站清理 / DB 重连 / 日志刷盘）+ 反思 `create_task` |
| 队列 / worker 框架 | ✅ **已建**：`app/core/redis.py`(Streams 封装) + `worker.py`(独立进程消费) |
| Redis | ✅ **已接入**：共享异步客户端（懒加载单例）+ Streams；config 改 redis 配置 reset 重建 |
| 非流式 runner | ✅ **已有**：`agent/runner.py` `run_collect()`，复用大脑收成完整回复 |
| Runtime Router（状态机，文档 29） | ❌ 仅设计（用户状态机并入 step 6） |
| 平台用户 ↔ 咕咕用户映射 | ❌ 无（step 6） |

> **重要坑**：后端现为 `uvicorn --workers 1`。若为扩量把 web 开多 worker，每个进程会各自再拉一遍 bot 长连接 → 重复连接/处理。故 **bot 网关/worker 必须能脱离 web 当独立进程起**（`adapters/` 不依赖 FastAPI request 即为此）。

---

## 7. 落地路线 —— 直接从「队列架构」起步

决策：**不先做内联 MVP 再重构，直接按队列+worker 架构建**（理由：dispatch 缝两种做法一样，Redis 已配置，省一次重构）。但**每条缝单独验证**，避免一上来同时调一堆未知。

构建顺序（每步独立可测）：

| 步 | 做什么 | 单独验证 | 状态 |
|----|--------|---------|------|
| 1 | `app/core/redis.py` 共享异步连接池 + Streams 封装（produce/consume/ack/claim） | 脚本自产自消一条 | ✅ 实测远程 Redis 8.8.0 通 |
| 2 | `agent/runner.py` 非流式 runner：从 `core.LLMRunner` 抽"攒完整段"版 | 喂假 AgentRequest 看完整回复 | ✅ 实测真打 MiniMax 通 |
| 3 | `worker.py` 独立进程：消费→runner→打印（先不发平台） | 手动 XADD 一条看 worker 跑通 | ✅ 实测 队列→大脑→ack 通 |
| 4 | 第一个平台网关（飞书或 QQ）：收→XADD | 网关只打印收到消息，确认鉴权/事件格式 | ⏭️ 待选平台+SDK+凭据 |
| 5 | 接通：网关→队列→worker→真发送 | 端到端"hello from 咕咕" | ⏭️ |
| 6 | 用户映射、事件去重、token 共享、背压 | 逐个加 | ⏭️ |

> step 1-3 是平台无关的消息骨架，已全部对真实 Redis/LLM 验证；step 4 起才接真平台。消息流：`XADD im:inbound → worker 消费 → run_collect → 回复(暂打印) → ack`。

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

1. **第一个平台**：飞书（文档最顺）还是 QQ（看受众）？微信最后。
2. **用户映射策略**：IM 用户首次对话即自动建咕咿号，还是要求绑定已有账号？
3. **反思等附加 LLM 调用是否计入用户配额**（现不计，高流量下成本需重算）。

---

## 附：相关文件 / 现有缝

- `agent/models.py` — `AgentRequest` / `AgentResponse`（非流式响应预留）
- `agent/adapters/base.py` — adapter 接口；`adapters/web.py` 为 SSE 实现，bot 各加一个
- `agent/core.py` — `LLMRunner`（待抽非流式版）
- `app/core/config.py` — `RedisSettings`（已配，待真正接入）
- `app/main.py` — `lifespan` 背景任务模式（MVP 可借，扩量须拆独立进程）

## 附：参考来源

- [tencent-connect/botpy](https://github.com/tencent-connect/botpy)（QQ 官方 SDK）
- [larksuite/oapi-sdk-python](https://github.com/larksuite/oapi-sdk-python)（飞书官方 SDK）
- [SiverKing/weixin-ClawBot-API](https://github.com/SiverKing/weixin-ClawBot-API)（微信 iLink 直连示例）
- 三个 OpenClaw 插件（不采用）：`Tencent/openclaw-weixin`、`tencent-connect/openclaw-qqbot`、`larksuite/openclaw-lark`
