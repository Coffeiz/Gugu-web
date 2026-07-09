# IM 接入稳定性与 QQ 自建 WebSocket PRD

> 状态：Phase 1 / Phase 2 / Phase 3 已实现
> 创建：2026-07-09
> 最近更新：2026-07-10
> 关联模块：`backend/agent/adapters/feishu.py`、`backend/agent/adapters/qq.py`、`backend/worker.py`
> 背景参考：QwenPaw `src/qwenpaw/app/channels/{feishu,qq}/channel.py`

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：飞书稳定性补强 | ✅ 已完成 | 已实现 `app_id` 错投保护、`message_id` LRU 去重、stale retry 丢弃，并补充网关入口测试。 |
| FR-FS-4：飞书流式收尾 | ✅ 已完成 | 流式卡片最终 patch 成功后调用 CardKit settings 接口关闭 `streaming_mode` 并设置 summary；finalize 失败不触发重复普通文本。收尾另调一次 `_do_update_card`（独立失败域）把标题从「咕咕思考中」改成「咕咕」——**devserver 实测踩坑**：整卡 PUT 起初用了独立的 sequence 计数器，报 `300317 sequence number compare failed`；CardKit 对同一 card_id 的 sequence 是跨端点（element content / settings / 整卡 PUT）共享同一套单调序列，改成复用 `_stream_seq_key` 计数器后修复。QwenPaw 没有这个功能——他们的流式卡片压根不设 `header`，没有"思考中"标题可改。 |
| Phase 2：QQ 自建 WebSocket 接收侧 | ✅ 已完成 | `serve()` 走 raw WebSocket；支持 C2C 与群 @ raw event、引用文本/引用附件解析、现有 worker payload 兼容。 |
| Phase 3：QQ raw HTTP 发送侧 | ✅ 已完成（未按 3-7 天灰度期提前实施） | `send_c2c`/`send_group`/`send_file`/短路回复/ack 全部改 raw HTTP 直连 QQ Bot API，按 channel_id 缓存 access_token 并在过期前刷新；markdown 无权限回退纯文本、401 清缓存重试逻辑保留。 |
| 清理：完全移除 botpy | ✅ 已完成 | `_GuguQQClient`（botpy `Client` 子类）、monkey patch、`QQ_RAW_WS_ENABLED` 回退开关、`qq-botpy` 依赖全部删除；本地已 `pip uninstall qq-botpy` 验证 83 个测试仍全过。QQ 目前不开放 aigcbot 群聊功能，群聊代码路径保留但暂无法验证。 |
| 飞书多媒体入站补齐 post/media/interactive | ✅ 已完成 | `post`（图文）拼接段落文字+下载内嵌图片/视频；`media`（视频消息）复用单附件下载逻辑；`interactive`（用户转发卡片）抽取可读文字，不下载卡片内嵌媒体（组件结构太杂，价值有限）。`_fetch_quoted_text` 引用反查同步支持这三种类型的占位/文字提取。 |
| 修复：引用咕咕自己的流式卡片回复反查失败 | ✅ 已完成 | **devserver 实测踩坑**：引用一条咕咕自己发的流式卡片回复时，`_fetch_quoted_text` 反查拿到的是飞书的兼容性占位文案「请升级至最新版本客户端，以查看内容」，不是卡片真实内容——因为咕咕的流式卡片是 CardKit 动态卡片（消息体引用 `card_id`，不是内联 `elements`），`GetMessageRequest` 默认不返回这类卡片的渲染内容。对照 QwenPaw 同款逻辑发现要带 `card_msg_content_type=user_card_content` 查询参数才能拿到真实文本，补上后修复。 |

已验证：

- 本地专项测试：`15 passed`
- 本地后端全量：`74 passed`
- devserver 专项测试：`15 passed`
- devserver 后端全量：`74 passed`
- Phase 3 本地全量：`83 passed`（新增 `tests/test_qq_raw_send.py` 覆盖 markdown 回退、401 重试清缓存、token 缓存复用、URL 模式发文件）
- 飞书多媒体补齐后本地全量：`89 passed`（新增 `tests/test_feishu_media.py` 覆盖 post 段落拼接+媒体下载、卡片文字抽取、视频消息）；devserver 待部署后跑一遍全量确认。

---

## 1. 背景

咕咕当前已经完成飞书、QQ、微信三平台 BYO 接入，用户可以用自己的机器人在 IM 里直接和咕咕对话。近期飞书已接入 CardKit 流式回复，QQ 已支持 C2C 私聊、群聊、附件收发和基础引用消息解析。

但继续放量前，IM 接入还有两类风险需要处理：

1. 飞书入站链路缺少平台级异常防护。飞书 WebSocket 可能因 SDK 重投、平台 retry、错投事件等原因产生重复或过期消息；咕咕当前主要依赖 worker 侧 stream entry 幂等，网关层还没有按飞书 `message_id` 做去重和 stale retry 丢弃。
2. QQ 当前基于 `botpy` SDK，引用消息识别依赖 monkey patch 保留原始 payload。该方式不稳定，且 botpy 暴露的消息对象不完整，无法可靠拿到 `msg_elements` / `message_scene` 等引用上下文字段。QwenPaw 已验证自建 QQ WebSocket 可直接读取 raw event，从而可靠识别引用消息。

本 PRD 定义飞书稳定性补强和 QQ 自建 WebSocket 改造的产品目标、功能范围、验收标准与实施阶段。

---

## 2. 目标

### 2.1 用户目标

- 用户在飞书里发送消息时，不会因为平台 retry 或连接抖动收到重复回复。
- 用户在 QQ 里“回复/引用某条历史消息”时，咕咕能理解被引用的原文，而不是只看到用户补充的短句。
- QQ 现有能力不倒退：C2C 私聊、群聊 @、文字回复、附件暂存、图片/文件发送、群聊开关、忙碌状态短路都继续可用。

### 2.2 业务目标

- 降低 IM 放量后的重复处理、错发、漏理解风险。
- 移除 QQ 对 botpy 消息对象内部实现的 monkey patch 依赖。
- 保持咕咕现有 BYO 架构，不引入 QwenPaw 的整套 channel framework。

### 2.3 技术目标

- 飞书网关层具备 `message_id` 去重、stale retry 丢弃、event `app_id` 错投保护。
- QQ 接收侧改为自建 WebSocket，直接处理 QQ Gateway raw event。
- QQ 发送侧第一阶段可继续复用现有 botpy `BotAPI`，待接收侧稳定后再评估是否完全 raw HTTP 化。
- 新增协议解析单测，避免真实平台联调成为唯一验证手段。

---

## 3. 非目标

- 不重构整体 IM 架构为 QwenPaw 风格的 `BaseChannel + ChannelManager`。
- 不改变 `worker.py` 当前 Redis Streams 消费模型。
- 不改变用户接入 QQ / 飞书的 BYO 配置流程。
- 不承诺 QQ 群聊可接收未 @ 机器人的全量消息；这是 QQ 平台能力限制。
- 不在本次解决微信 iLink 群聊回复路由遗留问题。

---

## 4. 现状对比

### 4.1 飞书

| 能力 | 咕咕现状 | QwenPaw 参考 | 本次要求 |
|---|---|---|---|
| BYO 多用户 | 每个 user_bot 一条子进程，payload 带 `owner_user_id` | 单实例多 channel | 保持咕咕现状 |
| 收消息 | `lark.ws.Client` WebSocket | `lark.ws.Client` WebSocket | 保持 |
| `app_id` 错投保护 | ✅ 已实现 | 检查 event header `app_id` | 已补齐 |
| stale retry 丢弃 | ✅ 已实现 | 基于 event `create_time` + server Date offset | 已补齐（首期用本机时间，保留校时扩展点） |
| `message_id` 去重 | ✅ 已实现 | OrderedDict LRU | 已补齐 |
| 引用消息 | 支持 `parent_id` 反查文字/interactive card 文本 | 支持文字和引用媒体 | 保持，后续可扩引用媒体 |
| 多媒体入站 | ✅ text/post/image/file/media/audio/interactive | text/post/image/file/media/audio/interactive | 已补齐 `post`（图文拼段落+内嵌图片/视频下载）、`media`（视频）、`interactive`（转发卡片抽取文字，不下载内嵌媒体） |
| 流式回复 | ✅ raw httpx CardKit，失败回落普通文本，成功后 finalize | SDK CardKit hook | 已补 finalize |

### 4.2 QQ

| 能力 | 咕咕现状 | QwenPaw 参考 | 本次要求 |
|---|---|---|---|
| 接收侧 | ✅ 默认 raw QQ Gateway WebSocket，保留 botpy 回退开关 | 自建 QQ Gateway WebSocket | 已改为自建 WebSocket |
| 引用识别 | ✅ raw event 读取 `msg_elements/message_scene` | raw event 直接读取 `msg_elements/message_scene` | 已支持文本与引用附件 |
| C2C | 支持 | 支持 | 保持 |
| 群聊 @ | 支持 `GROUP_AT`，按 per-bot 开关处理 | 支持 `GROUP_AT_MESSAGE_CREATE` | 保持 |
| 发送文本 | botpy `BotAPI.post_c2c_message/post_group_message` | raw HTTP `/v2/users|groups/.../messages` | 第一阶段可保留 botpy |
| 发送媒体 | botpy HTTP raw route 混用 | raw HTTP `/files` + `msg_type=7` | 保持现有能力 |
| 重连 | ✅ 接收侧自管 heartbeat/resume/reconnect，发送侧 botpy 保留 | 自管 heartbeat/resume/reconnect | 接收侧已自管 |
| token | ✅ 接收侧 `getAppAccessToken`，发送侧 botpy 保留 | `getAppAccessToken` | 已按阶段落地 |

---

## 5. 功能需求

### 5.1 飞书稳定性补强

#### FR-FS-1：event `app_id` 错投保护（✅ 已完成）

飞书网关收到 `im.message.receive_v1` 后，应读取 event header 中的 `app_id`。如果存在且不等于当前进程环境变量 `FEISHU_APP_ID`，直接丢弃该事件。

验收标准：

- 错投事件不会入队。
- 日志只记录 app_id 摘要和丢弃原因，不打印消息正文。
- 正常事件不受影响。

#### FR-FS-2：message_id LRU 去重（✅ 已完成）

飞书网关应维护进程内 `message_id` LRU 集合，已处理过的 `message_id` 直接丢弃。

建议参数：

- 最大缓存量：`1000` 条起步。
- 数据结构：`OrderedDict[str, None]`。
- 超出上限时丢弃最旧项。

验收标准：

- 同一 `message_id` 连续投递两次，只入队一次。
- 去重日志不包含消息正文。

#### FR-FS-3：stale retry 丢弃（✅ 已完成）

飞书网关应识别平台 retry 的旧消息。若 event header 提供 `create_time`，且消息创建时间相对当前时间超过阈值，则丢弃。

建议参数：

- 阈值：20 秒。
- 若能从飞书 API 响应 Date header 校准 server clock offset，则优先使用校准后的时间；首期也可先用本机时间，保留扩展点。

验收标准：

- 超过阈值的 retry 事件不会入队。
- 当前新消息不受影响。
- 本机时间异常时，日志能帮助定位。

#### FR-FS-4：流式回复收尾优化（✅ 已完成）

飞书 CardKit 流式回复成功后，可调用 settings/finalize 接口关闭 `streaming_mode` 并设置 summary，避免客户端长期显示生成中状态。

验收标准：

- finalize 失败不影响最终回复展示。
- finalize 失败时不重复发送普通文本，除非最终 patch 也失败。

### 5.2 QQ 自建 WebSocket 接收侧

#### FR-QQ-1：自建 Gateway 连接（✅ 已完成）

QQ 网关启动时，不再用 botpy `Client.run()` 接收消息，而是：

1. 用 `QQ_APP_ID` / `QQ_APP_SECRET` 调 `POST https://bots.qq.com/app/getAppAccessToken` 获取 access token。
2. 用 `GET https://api.sgroup.qq.com/gateway` 获取 WebSocket URL。
3. 建立 WebSocket 连接。
4. 收到 `HELLO` 后按协议发送 `IDENTIFY`。
5. 定时发送 heartbeat。
6. 支持 `READY`、`RESUMED`、`RECONNECT`、`INVALID_SESSION`。

验收标准：

- 网关启动日志显示 QQ WebSocket ready。
- 网络断开后可自动重连。
- token 失效后可刷新 token 并重连。

#### FR-QQ-2：事件类型覆盖（✅ 已完成）

首期必须覆盖：

- `C2C_MESSAGE_CREATE`
- `GROUP_AT_MESSAGE_CREATE`

可选覆盖：

- `DIRECT_MESSAGE_CREATE`
- `AT_MESSAGE_CREATE`

验收标准：

- C2C 私聊消息能入队。
- 群 @ 消息在 `group_chat_enabled=true` 时入队，关闭时丢弃。
- 群消息 payload 中 `chat_id=group_openid`，`platform_user_id=member_openid`。

#### FR-QQ-3：引用消息识别（✅ 已完成）

收到 QQ raw event 后，应通过 `message_scene.ext` 中的 `ref_msg_idx` 定位 `msg_elements` 中被引用的消息元素。

处理规则：

- 若引用元素有 `content`，将其包装进 LLM 输入，例如：
  `💬 用户引用/回复了一条历史消息（原文：「...」），针对这条消息说：...`
- 若引用元素有 `attachments`，应将引用附件也纳入本轮附件处理。
- 若只有引用标记但无正文/附件，至少插入 `[引用消息]` 占位，避免模型误解上下文。

验收标准：

- 用户在 QQ 引用一条文字消息后，咕咕回复能基于被引用文字理解语境。
- 用户在 QQ 引用带图消息后，图片能进入暂存附件链路。
- 没有 `ref_msg_idx` 的普通消息不会被误判为引用。

#### FR-QQ-4：保留现有咕咕业务逻辑（✅ 已完成）

自建 WebSocket 后，以下能力必须继续保留：

- 文件/图片收到后即时 ack 冷却。
- `_ingest_qq_media()` 附件下载与暂存。
- `router.decide()` 忙碌状态短路。
- `runtime_state` cancel / awaiting 状态。
- Redis Streams 入队字段兼容 worker。
- 群聊开关 `_group_settings()` 每条群消息现查。
- 日志不打印用户消息正文，继续使用 `logsafe.fingerprint()`。

验收标准：

- worker 无需大改即可消费新 QQ payload。
- 原有 QQ C2C、群聊、附件路径测试通过。

### 5.3 QQ raw HTTP 发送侧（第二阶段）

接收侧稳定后，评估是否移除 botpy 依赖，发送侧也改为 raw HTTP。

范围：

- `send_c2c()`：`POST /v2/users/{openid}/messages`
- `send_group()`：`POST /v2/groups/{group_openid}/messages`
- `send_file()`：`POST /v2/users/{openid}/files` 或 `/v2/groups/{group_openid}/files` 后发 `msg_type=7`
- Markdown 失败回退纯文本。
- URL 被 QQ 内容策略拒绝时，按需做 URL 清洗后重试。

验收标准：

- 不再 import botpy。
- `backend/requirements.txt` 移除 `qq-botpy`，新增必要的 WebSocket/HTTP 依赖。
- 文本、Markdown fallback、图片/文件发送均通过真实平台验证。

---

## 6. 技术方案

### 6.1 飞书

在 `backend/agent/adapters/feishu.py` 中局部增强：

- 在 `serve()` 或 `_make_on_message()` 闭包中维护 `_processed_message_ids`。
- 读取 event header 的 `app_id` / `create_time`。
- 新增 helper：
  - `_should_drop_misrouted_event(data, expected_app_id) -> bool`
  - `_should_drop_stale_event(data, now_ms, threshold_ms) -> bool`
  - `_seen_message_id(message_id) -> bool`
- 保持现有 `_ingest_media()`、`_fetch_quoted_text()`、`_quick_react()` 和入队 payload 不变。

### 6.2 QQ

建议将 `backend/agent/adapters/qq.py` 分阶段重构，避免一次性替换过大：

第一阶段：

- 保留公开函数签名：`serve()`、`send_c2c()`、`send_group()`、`send_file()`。
- 新增 WebSocket 接收实现：
  - `_get_access_token_sync()`
  - `_get_gateway_url_sync(token)`
  - `_HeartbeatController`
  - `_WSState`
  - `_run_ws_forever()`
  - `_handle_ws_payload()`
  - `_handle_msg_event(event_type, data)`
  - `_extract_quoted_from_raw(data)`
- `serve()` 中从 botpy client 切换为 raw WS loop。
- 发送侧 `_api_for()`、`_post()`、`_post_group()`、`send_file()` 暂时保留 botpy。

第二阶段：

- 引入 raw HTTP `_qq_api_request()` 和 token cache。
- 替换 `_api_for()` 和所有 botpy send path。
- 删除 botpy import、monkey patch 和 botpy requirements。

### 6.3 依赖

第一阶段若采用 QwenPaw 同款同步线程模型，需要新增：

```txt
websocket-client>=1.8.0
```

`aiohttp` 当前项目已在 QQ 附件下载路径中使用；若 requirements 已包含则无需重复。

---

## 7. 数据与日志

### 7.1 Payload 兼容

QQ raw event 转咕咕 payload 时保持现有字段：

```json
{
  "platform": "qqbot",
  "channel_id": "<user_bot.id>",
  "owner_user_id": "<owner user_id>",
  "platform_user_id": "<user_openid/member_openid>",
  "chat_id": "<group_openid, 群聊时存在>",
  "message_id": "<qq message id>",
  "chat_type": "c2c|group",
  "text": "<包装引用后的文本>",
  "attachments": ["<attach_id>"],
  "trace_id": "<trace id>"
}
```

### 7.2 日志要求

- 禁止打印用户消息正文、附件文件名原文。
- 涉及消息内容时只打印 `len`、`fingerprint()`、附件数量、trace_id。
- raw QQ event 仅允许在本地临时调试时手动打开，默认不得打印完整 payload。
- 移除当前 QQ 适配器中的 raw keys debug 日志。

---

## 8. 测试计划

### 8.1 单元测试（✅ 已完成）

新增 `backend/tests/test_qq_raw_ws.py`：

- ✅ 引用文本按 `ref_msg_idx` 解析
- ✅ 没有 `ref_msg_idx` 时不误判
- ✅ C2C raw event 转 payload
- ✅ 群聊 raw event 转 payload
- ✅ 群聊关闭时丢弃事件
- ✅ 引用附件进入暂存链路
- 🔲 日志不含正文的自动断言暂未单独补；当前实现沿用 `len + fingerprint + trace_id` 日志口径，真实联调时继续观察

补充飞书测试：

- ✅ `test_feishu_drops_duplicate_message_id`
- ✅ `test_feishu_drops_stale_retry`
- ✅ `test_feishu_drops_misrouted_app_id`
- ✅ 流式卡片成功后 finalize
- ✅ finalize 失败不改变流式成功语义

### 8.2 集成验证（待人工端到端）

在 devserver 验证：

1. ✅ `mutagen sync flush gugu-web`
2. ✅ QQ 子进程已随部署重启，raw WebSocket 网关实际运行中（devserver 日志可见多次 READY/RESUMED）。
3. ✅ QQ 私聊发送普通文本，回复正常（devserver 日志实测 `att=1`/`att=0` 正常收发）。
4. ✅ QQ 私聊引用一条历史文本，咕咕理解引用内容（用户最初反馈即确认文字引用可用）。
5. ✅ QQ 私聊引用图片，附件暂存并进入模型输入（devserver 日志实测 `att=1` 成功下载暂存；用户本人重新测试引用图片确认成功；仅「引用太久的消息」因 QQ 平台自身上下文窗口限制会拿不到附件，见 §12）。
6. 🔲 QQ 群聊 @ 咕咕，确认群聊回复仍发回群 —— 暂无法验证：QQ 平台目前未对该 bot 开放 aigcbot 群聊功能。
7. 🔲 QQ 群聊关闭开关后，确认群消息不入队 —— 同上，暂无法验证。
8. ✅ 飞书连续投递同一 message_id mock 事件，确认只入队一次（单测覆盖）。

### 8.3 回归测试（✅ 已完成）

- ✅ 本地 `backend/.venv/bin/python -m pytest -q`：`74 passed`
- ✅ devserver `backend/.venv/bin/python -m pytest -q`：`74 passed`
- ✅ 未变更前端，不需要跑 typecheck。
- ✅ 未变更 `requirements.txt`，不需要安装新依赖。

---

## 9. 发布计划

### Phase 1：飞书稳定性补强（✅ 已完成）

范围：

- `app_id` 错投保护
- `message_id` 去重
- stale retry 丢弃
- 流式卡片收尾 finalize

风险：低。

回滚：还原 `feishu.py` 网关层判断即可。

### Phase 2：QQ 自建 WebSocket 接收侧（✅ 已完成，待人工端到端）

范围：

- 接收侧从 botpy 切到 raw WS。
- 发送侧暂保留 botpy。
- 新增 QQ raw event 解析测试。

风险：中。

灰度方式：

- 已增加环境变量 `QQ_RAW_WS_ENABLED=0` 回退开关；默认走 raw WebSocket。
- 单个 user_bot 子进程启用验证。
- 稳定后移除 botpy 接收路径。

回滚：关闭 `QQ_RAW_WS_ENABLED` 或切回 botpy `serve()`。

### Phase 3：QQ raw HTTP 发送侧

范围：

- 文本、Markdown fallback、媒体发送全部 raw HTTP。
- 移除 botpy 依赖。

风险：中高。

建议在 Phase 2 稳定 3-7 天后再做。

---

## 10. 指标

上线后观察：

- QQ 引用消息识别成功率。
- QQ 网关重连次数与连续失败次数。
- QQ 消息入队失败数。
- 飞书重复消息丢弃数。
- 飞书 stale retry 丢弃数。
- IM 回复发送失败率。
- 用户反馈中“咕咕没看懂我引用的消息”的数量。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| QQ Gateway 协议字段与 QwenPaw 观察不一致 | 引用识别失败 | 单测覆盖已知 raw payload，真实联调时保留短期结构日志，只打印 keys 和指纹 |
| raw WS 重连不如 botpy 稳 | QQ 掉线 | 实现 heartbeat、resume、invalid session token refresh、指数退避 |
| 发送侧仍依赖 botpy，接收侧已 raw | 代码短期并存复杂 | ~~Phase 2 明确只改接收侧~~ Phase 3 已把发送侧也改成 raw HTTP，`send_*` 对外签名不变；接收侧 botpy 回退路径暂保留 |
| Phase 3 未按建议等 3-7 天灰度就直接实施 | 若 Phase 2 接收侧仍有未暴露的问题，发送侧同时变更放大排查难度 | 发送侧改动与接收侧解耦（各自独立函数），出问题可单独定位；本地/devserver 需各跑一遍全量再上线 |
| 飞书 stale 阈值误杀正常消息 | 用户消息无回复 | 阈值先保守，日志记录 age；必要时做配置项 |
| raw event 日志泄露正文 | 隐私风险 | 默认禁止打印 raw payload，测试中也断言日志不含正文 |

---

## 12. 待确认问题

- ✅ QQ raw WS 已按 `QQ_SANDBOX` 切 `api.sgroup.qq.com` / `sandbox.api.sgroup.qq.com`，仍需真实 sandbox/生产各测一次。
- 🔲 QQ `GROUP_AT_MESSAGE_CREATE` raw payload 中引用消息的 `msg_elements` 是否在所有群类型都稳定提供。
- ✅ QQ 引用图片 attachments URL 可直接沿用现有 `_ingest_qq_media()` 下载逻辑（devserver 日志实测 `att=1` 成功下载暂存）。真实观察到的失败案例是 `msg_elements=0`（QQ 侧压根没给引用上下文），怀疑是 QQ 引用功能本身对「多久之前的消息」有时效窗口，超出窗口引用不到任何上下文，不是解析代码的问题；具体窗口时长未知，暂无用户可感知的提示（`msg_elements=0` 时用户只会看到「没引用上」而不知道原因），后续如高频出现再补提示文案。
- ✅ 飞书 stale retry 首期使用本机时间，后续如遇误杀再补平台 Date header 校时。
- ✅ Phase 2 原计划保留 botpy 接收路径开关至少一个小版本，实际因功能验证完成、决定直接全部移除（`_GuguQQClient`/monkey patch/`QQ_RAW_WS_ENABLED`/`qq-botpy` 依赖），不再保留回退路径。
- 🔲 Phase 3 raw HTTP 发送侧（文本/markdown 回退/URL 与 base64 发文件/群消息）尚未在真实 QQ 环境端到端验证，仅本地 mock 测试覆盖；`_send_tokens` 无锁，理论上并发首次请求可能重复取 token（浪费一次调用，不影响正确性）。
- 🔲 QQ 群聊（aigcbot 群聊功能）目前平台未开放，`group_chat_enabled`/`GROUP_AT_MESSAGE_CREATE` 相关代码路径无法在真实环境验证，等平台开放后再测。
