# 飞书机器人接入指南（从零到跑通）

> 让咕咕住进飞书：用户私聊机器人，咕咕带人格/记忆/工具回复。
> 架构与决策见 [`agent-im接入架构.md`](agent-im接入架构.md)、[`agent.md`](agent.md) Phase 4。

---

## 0. 前置

- 后端能正常起（`backend/`，`.venv`，从 `backend/` 目录跑以加载 `.env`）
- Redis 可达（`settings.redis`，实测远程 192.168.110.50:6379 / Redis 8.8.0）
- 一个飞书企业（机器人只在本企业内可用）

---

## 1. 飞书开发者后台：创建并配置应用

到 [open.feishu.cn](https://open.feishu.cn) → 开发者后台。

### 1.1 创建应用
- **创建企业自建应用**（填名称/图标/描述）
- 省事替代：官方 CLI `npx -y @larksuite/openclaw-lark install` → 选「新建」→ 飞书扫码一键创建（产出同样的自建应用）。**只借它创建，不跑 OpenClaw 运行时**。

### 1.2 启用机器人
- 「添加应用能力」→ **机器人**

### 1.3 权限（权限管理）
至少开通：
- `im:message`（接收消息）
- `im:message:send_as_bot`（以机器人身份发消息）

### 1.4 事件订阅（两种模式二选一）
- 订阅事件都要加：**接收消息 `im.message.receive_v1`**
- **模式 A · 长连接**（推荐，省事）：订阅方式选 **「长连接」**，**不需要公网 URL/回调地址**。跑 supervisor + worker（见 §3）。
- **模式 B · 请求地址 (Webhook)**：订阅方式选 **「请求地址」**，填公网回调地址 `https://你的域名/api/v1/feishu/event/<频道id>`，需要公网可达，只跑 worker（见 §3.6）。

> 两种**只能选一种**，别对同一个 app 同时开长连接和 Webhook，否则消息会被处理两次。

### 1.5 发布
- 「应用发布」→ 创建版本 → 发布（自建应用必须发布版本，配置才生效；企业管理员审核通过后可用）

### 1.6 拿凭据
- 「凭证与基础信息」→ 复制 **App ID**（`cli_...`）和 **App Secret**

---

## 2. 填凭据：Admin 频道面板（推荐）或 `.env`（兜底）

### 2.1 推荐：Admin「频道」面板
Admin → Agent 配置 → **频道** tab → **添加频道** → 选「飞书」、填名称 + App ID + App Secret、启用 → 保存。
- 凭据存 `config.override.json` 的 `bots` 列表（明文，gitignore 不入库）。
- 增删启停**实时生效**（管家约 5s 同步，见下「频道面板原理」）。

### 2.2 兜底：`.env`
没用面板时，`backend/.env` 追加（嵌套分隔符是双下划线 `__`）：
```
FEISHU__APP_ID=cli_你的id
FEISHU__APP_SECRET=你的secret
```
> 凭据优先取面板里启用的飞书频道，没有才用 `.env`。

---

## 3. 跑两个进程（管家 + worker）

都从 `backend/` 目录、用 `.venv`：

```bash
# 频道管家：按面板启用列表，每个频道起一个网关子进程（增删启停实时生效）
.venv/bin/python -m agent.adapters.supervisor

# worker：消费队列 → 跑咕咕大脑 → 发回飞书
.venv/bin/python -m worker
```

后台跑法示例：
```bash
.venv/bin/python -m agent.adapters.supervisor > /tmp/gugu_sv.log     2>&1 &
.venv/bin/python -m worker                    > /tmp/gugu_worker.log 2>&1 &
```

**连上的标志**（管家日志 `/tmp/gugu_sv.log`）：
```
[supervisor] ▶ 启动频道 bot_xxxx
[feishu:bot_xxxx] 网关启动，WebSocket 长连接中…
[Lark] ... connected to wss://msg-frontier.feishu.cn/ws/v2 ...
```

> 调试单频道也可直接跑 `.venv/bin/python -m agent.adapters.feishu [channel_id]`，但正式用管家（支持多频道 + 动态起停）。

---

## 3.5 频道面板原理

> 详见 `agent.md` Phase 4「频道面板与动态网关」。

**为什么要管家**：lark `ws.Client` 只有 `start()`、**没有 `stop()`**——单个连接在进程内断不掉。所以用**进程级管理**：

```
Admin 频道面板（增删/启停）
   → 写 config.override.json 的 bots 列表
   → supervisor 每 5s 轮询 active_im_bots()（现读文件）
   → reconcile：启用→spawn 网关子进程；停用/删除→kill 子进程；崩溃→自动重启
```

- **一个频道 = 一个子进程**：`python -m agent.adapters.feishu <channel_id>`，用该频道凭据连接，kill = 断开。
- **多频道并存**：可同时挂多个飞书企业的 bot，消息 payload 带 `channel_id`，worker 按该频道凭据回发。
- **面板改即生效**：约 5s 内连接起/停，不用手动重启。

---

## 3.6 模式 B：请求地址 (Webhook) 接入

长连接（模式 A）需要常驻 supervisor 进程主动连飞书；如果你已有公网 HTTPS、想少跑一个进程，可改用 Webhook：飞书把事件 POST 到我们的接口。**收消息走 Webhook 时不用跑 supervisor，只跑 worker。**

### 3.6.1 填频道凭据（含 Encrypt Key / Token）
Admin → Agent 配置 → 频道 → 编辑该飞书频道 → 展开「事件订阅 Webhook」：
- **回调地址**：保存频道后这里会显示**专属地址** `https://你的域名/api/v1/feishu/event/<频道id>`，点「复制」。
- **Encrypt Key / Verification Token**：填飞书后台事件订阅页给的那两个值（留空=不加密/不校验）。
- 也可用 env 兜底：`FEISHU__ENCRYPT_KEY` / `FEISHU__VERIFICATION_TOKEN`。

### 3.6.2 飞书后台配置
事件订阅 → 订阅方式选 **「请求地址」** → 粘贴上面复制的回调地址 → 保存。
保存时飞书会发一个 `url_verification` 校验请求，咕咕后端会自动回 `{"challenge": ...}` 通过验证（**1 秒内**，所以后端要在线）。

### 3.6.3 只跑 worker
```bash
.venv/bin/python -m worker        # 消费队列 → 跑咕咕 → 发回飞书
```
> 发回复仍用频道的 App ID/Secret，所以这俩照填。Encrypt Key/Token 只用于**收**事件的解密与校验。

### 3.6.4 原理
```
飞书事件 → POST /api/v1/feishu/event/<频道id>
  → lark EventDispatcherHandler.do()：用 Encrypt Key 解密 → 校验 Token → 验签
  → url_verification 直接回 challenge；普通消息派发到 _make_on_message
  → 入队 im:inbound（payload 与长连接完全一致）→ worker 消费
```
所以 worker、绑定、人格/记忆/工具链路与长连接**完全共用**，只是「收消息」这一段从 WSS 长连接换成了 HTTP 回调。

---

## 4. 测试

飞书里**私聊那个机器人**发一句（如「你是谁」）。预期：

- 网关日志：`[feishu] 收到 ou_xxx @ oc_xxx: '你是谁'`
- worker 日志：`[worker] feishu 回复 → '我是咕咕，你的创作搭子…'`
- 飞书里收到咕咕的回复

整条链：`飞书消息 → 网关(WSS) → Redis队列 → worker → run_collect(人格+记忆+41工具) → feishu.send_text 发回`。

---

## 5. 排错

| 现象 | 原因 / 解法 |
|------|------------|
| 网关连不上 / 报鉴权错 | App ID/Secret 错，或应用**未发布版本** |
| 收不到消息 | 事件订阅没选**长连接**、没订阅 `im.message.receive_v1`、或缺 `im:message` 权限 |
| 收到但回不出（发送失败 code/msg）| 缺 `im:message:send_as_bot` 权限，或版本未发布 |
| worker 反复 `TimeoutError: Timeout reading from ...:6379` | redis 阻塞读 `XREADGROUP block` 时读超时太短。已修：`app/core/redis.py` 的 `get_redis` 设 `socket_timeout=None` |
| 同一 app 两个长连接冲突 | 别同时跑官方 echo_bot / OpenClaw 与本网关（同 App ID）；也别同时手动跑 `feishu` 网关又跑管家 |
| 面板加了频道但没连上 | 等约 5s（管家轮询周期）；看管家日志 `/tmp/gugu_sv.log` 有没有 `▶ 启动频道`；频道是否「启用」、secret 是否填了 |
| Admin 频道保存「消失」/ 404 | 后端加了 `/admin/agent/bots` 接口后要 `make restart` 才生效 |
| 配请求地址提示「返回数据不是合法的JSON格式」| 用了 Webhook 模式但回调地址错/后端没在线/`challenge` 没原样返回。确认地址是 `…/feishu/event/<频道id>`、后端在线、1 秒内可达（见 §3.6）|
| Webhook 收到消息但 500 / `signature verification failed` | 面板填的 Encrypt Key 与飞书后台不一致；或代理改写了 `X-Lark-*` 头 |

---

## 6. 用户绑定（OAuth 扫码，每人各聊各的）

咕咕是多用户产品，一个 bot 给所有人开私聊小窗。靠**绑定**让咕咕认得"飞书里这个人 = 哪个咕咕账号"。

### 6.1 流程

```
用户在咕咕「个人设置 → 咕咕设置 → 接入咕咕 → 飞书」点「绑定」
  → 后端 GET /feishu/bind/url 生成飞书授权 URL（state 用 JWT 签，带 user_id）
  → 前端渲染成二维码（qrcode 库）
  → 用户飞书 App 扫码授权
  → 飞书重定向到 redirect_uri?code=xxx&state=xxx
  → GET /feishu/bind/callback：校验 state → code 换 user_access_token 取 open_id
     → 写 platform_bindings (feishu, open_id) → user_id
  → 前端轮询 /feishu/bind/status 拿到「已绑定」自动完成
之后：私聊咕咕 → 网关 payload 带 open_id → worker 查绑定表 → 解析成 user_id → 按其数据回
未绑定者私聊 → worker 回「请先去设置里扫码绑定」提示（不跑大脑）
```

- **方案 A 轻绑定**：只存 open_id 认人，不存 user_access_token（聊天场景够用）。
- open_id 按 app 隔离 → 绑定走"启用的第一个飞书频道"的 app，与该 bot 收到的消息 open_id 一致。

### 6.2 配置 redirect_uri（必须）

OAuth 授权后飞书要把授权码**回调**到一个地址，所以要配**公网可达**的回调地址：

1. **Admin → Agent 配置 → 频道 tab → 顶部「飞书 OAuth 回调地址」** 填 `https://你的域名/api/v1/feishu/bind/callback` → 保存（存 `config.override.json` 的 `feishu.redirect_uri`，即时生效）。也可用 env `FEISHU__REDIRECT_URI`。
2. 飞书开发者后台 → 该应用 → **安全设置 → 重定向 URL** → 填**一模一样**的地址。
3. 权限：开通用户身份相关 scope（默认全量授权即可）。

> ⚠️ **必须公网可达**：扫码后是飞书在用户端重定向到它，`localhost`/内网手机访问不到 → 本地测试用内网穿透（ngrok）的公网地址。

### 6.3 为什么收消息不用公网、绑定却要

| | 方向 | 需要公网回调 |
|---|---|---|
| **收消息**（WebSocket 长连接） | 咕咕**主动连**飞书、飞书推消息给这条连接 | ❌ 不需要 |
| **OAuth 绑定** | 用户授权后飞书**重定向回调**送授权码给咕咕 | ✅ 需要 |

长连接是 outbound（我们当客户端连出去，省了公网）；OAuth 回调是 inbound（飞书来找我们），是 OAuth 标准设计，绕不开。

---

## 附：涉及的代码

| 文件 | 作用 |
|------|------|
| `agent/adapters/supervisor.py` | **频道管家**：轮询启用频道，每频道起/停一个网关子进程 |
| `agent/adapters/feishu.py` | 单频道网关（按 `channel_id` 取凭据，收消息入队）+ `send_text` 发回 |
| `app/api/v1/feishu_event.py` | **Webhook 模式**事件入口 `/feishu/event/{channel_id}`：lark `do()` 解密/验签/回 challenge → 复用 `_make_on_message` 入队 |
| `app/core/redis.py` | Redis 客户端 + Streams（`produce_sync` 给同步网关 / `consume`/`ack` 给 worker） |
| `app/core/config.py` | `active_im_bots(platform)`（现读 override 取启用频道）+ `FeishuSettings`（`app_id`/`app_secret`/`redirect_uri`，env `FEISHU__*` 兜底） |
| `app/api/v1/agent_admin.py` | `/admin/agent/bots` 频道 CRUD（secret 打码）|
| `app/api/v1/feishu_bind.py` | OAuth 绑定：`/feishu/bind/url`(授权URL) `/callback`(换 open_id 写绑定) `/status` `DELETE`；state 用 JWT 签 |
| `app/models` · `PlatformBinding` | 绑定表 `(platform, open_id) ↔ user_id`（唯一约束 open_id）|
| `components/common/ProfileModal.vue` | 个人设置「咕咕设置」里的飞书绑定 UI（二维码 + 状态轮询 + 解绑）|
| `agent/runner.py` | `run_collect(req)` 非流式跑大脑、攒完整回复 |
| `worker.py` | 独立进程：消费队列 → `_resolve_user` 查绑定表 → 未绑定回提示 / 已绑定 `run_collect` → 按频道发回 |
