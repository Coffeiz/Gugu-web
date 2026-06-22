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

### 1.4 事件订阅（关键：选长连接）
- 订阅方式选 **「长连接」**（**不是** Webhook）—— 这样不需要公网 URL/回调地址
- 订阅事件：**接收消息 `im.message.receive_v1`**

### 1.5 发布
- 「应用发布」→ 创建版本 → 发布（自建应用必须发布版本，配置才生效；企业管理员审核通过后可用）

### 1.6 拿凭据
- 「凭证与基础信息」→ 复制 **App ID**（`cli_...`）和 **App Secret**

---

## 2. 填凭据到 `.env`

`backend/.env` 追加（注意嵌套分隔符是双下划线 `__`）：

```
FEISHU__APP_ID=cli_你的id
FEISHU__APP_SECRET=你的secret
```

> `.env` 已被 gitignore，不会入库。验证读取：
> `cd backend && .venv/bin/python -c "from app.core.config import get_settings; print(get_settings().feishu.app_id)"`

---

## 3. 跑两个进程

都从 `backend/` 目录、用 `.venv`，两个终端（或后台 + 重定向日志）：

```bash
# 网关：飞书 WebSocket 长连收消息 → 入队 Redis
.venv/bin/python -m agent.adapters.feishu

# worker：消费队列 → 跑咕咕大脑 → 发回飞书
.venv/bin/python -m worker
```

后台跑法示例：
```bash
.venv/bin/python -m agent.adapters.feishu > /tmp/gugu_feishu_gw.log 2>&1 &
.venv/bin/python -m worker                 > /tmp/gugu_worker.log     2>&1 &
```

**网关连上的标志**（日志）：
```
[feishu] 网关启动，WebSocket 长连接中…
[Lark] ... connected to wss://msg-frontier.feishu.cn/ws/v2 ...
```

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
| 同一 app 两个长连接冲突 | 别同时跑官方 echo_bot / OpenClaw 与本网关（同 App ID） |

---

## 6. 当前限制 & 下一步

- **临时映射**：现在所有飞书消息都当成数据库**首个用户 root123** 回（`worker._resolve_user` 的临时实现）。能聊、但还不分人。
- **下一步：OAuth 2.0 用户扫码绑定**（方案 A 轻绑定），实现"每人各聊各的"：
  1. 绑定表 `(platform, open_id) ↔ user_id`
  2. 后端 `GET /feishu/bind/url`（授权URL+二维码）、`GET /feishu/bind/callback`（换 token 取 open_id 写绑定）
  3. 前端个人设置页「绑定飞书」二维码 + 状态
  4. 网关收消息时 `open_id → 查绑定表 → user_id`，替换 root123 临时映射
  - 前提：飞书后台开 OAuth、登记 redirect_uri（如 `https://gugugu.site/api/v1/feishu/bind/callback`）

---

## 附：涉及的代码

| 文件 | 作用 |
|------|------|
| `agent/adapters/feishu.py` | 网关（收 `im.message.receive_v1` → 入队）+ `send_text` 发回 |
| `app/core/redis.py` | Redis 客户端 + Streams（`produce_sync` 给同步网关 / `consume`/`ack` 给 worker） |
| `agent/runner.py` | `run_collect(req)` 非流式跑大脑、攒完整回复 |
| `worker.py` | 独立进程：消费队列 → 解析用户 → `run_collect` → 发回平台 |
| `app/core/config.py` | `FeishuSettings`（`app_id`/`app_secret`，走 env `FEISHU__*`） |
