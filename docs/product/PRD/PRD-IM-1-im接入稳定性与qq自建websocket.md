# IM 接入稳定性与 QQ 自建 WebSocket PRD

> 状态：Phase 1 / Phase 2 / Phase 3 / Phase 4 / Phase 6 已实现
> 创建：2026-07-09
> 最近更新：2026-07-10
> 关联模块：`backend/agent/gateway/feishu.py`、`backend/agent/gateway/qq.py`、`backend/worker.py`
> 背景参考：QwenPaw `src/qwenpaw/app/channels/{feishu,qq}/channel.py`

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：飞书稳定性补强 | ✅ 已完成 | 已实现 `app_id` 错投保护、`message_id` LRU 去重、stale retry 丢弃，并补充网关入口测试。 |
| FR-FS-4：飞书流式收尾 | ✅ 已完成 | 流式卡片最终 patch 成功后调用 CardKit settings 接口关闭 `streaming_mode` 并设置 summary；finalize 失败不触发重复普通文本。收尾另调一次 `_do_update_card`（独立失败域）把标题从「咕咕思考中」改成「咕咕」——**devserver 实测踩坑**：整卡 PUT 起初用了独立的 sequence 计数器，报 `300317 sequence number compare failed`；CardKit 对同一 card_id 的 sequence 是跨端点（element content / settings / 整卡 PUT）共享同一套单调序列，改成复用 `_stream_seq_key` 计数器后修复。QwenPaw 没有这个功能——他们的流式卡片压根不设 `header`，没有"思考中"标题可改。**已在 devserver 用户实测确认标题正确改成「咕咕」。** |
| Phase 2：QQ 自建 WebSocket 接收侧 | ✅ 已完成 | `serve()` 走 raw WebSocket；支持 C2C 与群 @ raw event、引用文本/引用附件解析、现有 worker payload 兼容。 |
| Phase 3：QQ raw HTTP 发送侧 | ✅ 已完成（未按 3-7 天灰度期提前实施） | `send_c2c`/`send_group`/`send_file`/短路回复/ack 全部改 raw HTTP 直连 QQ Bot API，按 channel_id 缓存 access_token 并在过期前刷新；markdown 无权限回退纯文本、401 清缓存重试逻辑保留。 |
| 清理：完全移除 botpy | ✅ 已完成 | `_GuguQQClient`（botpy `Client` 子类）、monkey patch、`QQ_RAW_WS_ENABLED` 回退开关、`qq-botpy` 依赖全部删除；本地已 `pip uninstall qq-botpy` 验证 83 个测试仍全过。QQ 群聊 raw event 已在后续联调中继续扩展。 |
| Phase 4：QQ 群聊普通消息读取 | ✅ 已完成 | 支持 `GROUP_MESSAGE_CREATE`；未 @ 消息可按 bot 开关只记录、不调用模型、不回复；按群共享会话，数据库每群最多保留最近 50 条消息。 |
| Phase 5：QQ 身份采集与 Bot owner 绑定 | 🔲 未做 | 每个 Gugu 账号只绑定一个 Bot；保存该 Bot 的 owner `sender_id`，不做跨 Bot QQ 身份自动合并。新用户可从首次 C2C 消息绑定，老用户通过 C2C Keyboard 确认；群消息不能自动抢占 owner。 |
| Phase 6：群成员权限隔离与工具白名单 | ✅ 已完成 | 已按当前 Bot 的 `owner_platform_user_id` 解析 `owner/member/unknown`；owner 使用完整工具集，群成员/未知身份只使用 Bot 级白名单，默认开放网页搜索；runner 提供工具集过滤，dispatch 再做服务端拦截；个人设置可切换网页搜索和当前群上下文搜索。当前方案不按群单独绑定 owner，`im_chats` 群级开关作为后续独立需求保留。 |
| Phase 7：群聊短期/长期记忆 | 🔲 未做 | 计划按 `platform_user_id` 记录群成员信息，并像个人聊天一样做短期、长期记忆压缩；需另行设计权限、可见范围和删除策略。 |
| 飞书多媒体入站补齐 post/media/interactive | ✅ 已完成 | `post`（图文）拼接段落文字+下载内嵌图片/视频；`media`（视频消息）复用单附件下载逻辑；`interactive`（用户转发卡片）抽取可读文字，不下载卡片内嵌媒体（组件结构太杂，价值有限）。`_fetch_quoted_text` 引用反查同步支持这三种类型的占位/文字提取。 |
| 修复：引用咕咕自己的流式卡片回复反查失败 | ✅ 已完成并经用户 devserver 实测确认（两轮踩坑才修好） | **devserver 实测踩坑 #1**：不带 `card_msg_content_type=user_card_content` 查询参数时反查拿到的是飞书兼容性占位文案「请升级至最新版本客户端，以查看内容」，不是卡片真实内容；对照 QwenPaw 同款逻辑补上参数后修复。**踩坑 #2**：补完参数后又变成反查出「[空消息]」——`_extract_card_text` 一直只从 `content["elements"]` 起步找文字，但咕咕流式卡片是 CardKit schema 2.0，elements 实际嵌在 `content["body"]["elements"]` 里一层，旧代码假设的是非流式卡片那种扁平 `{"elements":[...]}` 结构。改成直接从整个 `content` 递归（两种结构都能兼容）后才真正修好。**用户实测确认引用文字和引用图片都恢复正常。** |
| 修复：只发文件不说话时飞书卡片是空的 | ✅ 已完成 | **devserver 实测踩坑**：用户让咕咕发个 md 文件，模型调 `send_file` 工具没配任何文字说明，`AgentResponse.text` 是空串——流式卡片的 `_patch`/`_do_finalize_streaming_card`/`_do_update_card` 全部拿这个空串去更新，卡片正文真的是空的，用户得追问「发了吗」模型才在下一轮正常说话。worker.py 非流式路径本来就有「有文件配一句给你～」的兜底，但只在 `not (platform == "feishu" and stream_sent)` 时才发送，飞书流式成功时被跳过，所以两边逻辑没对齐。新增 `_stream_fallback_text()`，在流式路径的三处 final 处理（两个 create_card/send_card_message 失败的 fallback 分支 + 主路径）都补上同款兜底文案。 |
| 修复：IM 引用消息在网页显示成一堆原始 markdown + 微信引用图片下不了 | ✅ 已完成 | 引用原文之前拼进用户消息正文一起存/一起显示，网页气泡纯文本渲染，引用一条带表格的历史回复就整段 markdown 摊平显示。改成 `ConversationMessage.quoted_text` 单独一列存（`agent/models.py`/`app/models`/alembic 迁移/`agent/runner.py` 的 `_with_quoted_context`），完整内容仍喂给模型，展示层单独渲染成浅色预览条。顺带发现微信 iLink 的 `quoted_text` payload 字段此前一直没被 `worker.py` 读进 `AgentRequest`（字段压根不存在），等于微信引用从没真正喂给模型过。**微信引用图片本身也下载不到**：对照 QwenPaw 实现确认，引用/回复里带的图片没有 `media.full_url`，只有 `media.encrypt_query_param`，需要另外拼 CDN 下载地址（`https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=...`），之前只认 `full_url` 导致引用图片一律被跳过。 |

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
- QQ 现有能力不倒退：C2C 私聊、群聊 @、普通群消息读取、文字回复、附件暂存、图片/文件发送、群聊开关、忙碌状态短路都继续可用。

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
- 不承诺 QQ 在未取得平台权限时一定能接收未 @ 机器人的全量消息；应用侧开关不能替代 QQ 机器人后台权限。
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
| 引用消息 | ✅ 支持 `parent_id` 反查文字/interactive card 文本/流式卡片文本，引用图片可正常识别（见 FR-FS-5） | 支持文字和引用媒体 | 已完成并经 devserver 实测确认 |
| 多媒体入站 | ✅ text/post/image/file/media/audio/interactive | text/post/image/file/media/audio/interactive | 已补齐 `post`（图文拼段落+内嵌图片/视频下载）、`media`（视频）、`interactive`（转发卡片抽取文字，不下载内嵌媒体） |
| 流式回复 | ✅ raw httpx CardKit，失败回落普通文本，成功后 finalize | SDK CardKit hook | 已补 finalize |

### 4.2 QQ

| 能力 | 咕咕现状 | QwenPaw 参考 | 本次要求 |
|---|---|---|---|
| 接收侧 | ✅ 默认 raw QQ Gateway WebSocket，保留 botpy 回退开关 | 自建 QQ Gateway WebSocket | 已改为自建 WebSocket |
| 引用识别 | ✅ raw event 读取 `msg_elements/message_scene` | raw event 直接读取 `msg_elements/message_scene` | 已支持文本与引用附件 |
| C2C | 支持 | 支持 | 保持 |
| 群聊 @ | 支持 `GROUP_AT`，按 per-bot 开关处理 | 支持 `GROUP_AT_MESSAGE_CREATE` | 保持 |
| 群聊普通消息读取 | ✅ 支持 `GROUP_MESSAGE_CREATE`，未 @ 时只记录不回复 | raw Gateway event | 已完成，按 bot 开关控制 |
| 群聊上下文 | ✅ 按 `group_openid` 共享近期消息，最多保留 50 条 | 按 channel/session 组织 | 已完成短期窗口，长期记忆未做 |
| 群成员权限 | 🔲 暂无 owner / non-owner 隔离 | 需按平台身份扩展 | 后续阶段实现 |
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

#### FR-FS-5：引用消息识别（✅ 已完成，已用户 devserver 实测确认）

飞书引用/回复历史消息时，`_fetch_quoted_text` 按 `parent_id` 反查原消息内容；引用咕咕自己发的
CardKit 流式卡片回复时，需要额外处理两个坑：

- `GetMessageRequest` 必须带 `card_msg_content_type=user_card_content` 查询参数，否则反查拿到
  的是飞书兼容性占位文案「请升级至最新版本客户端」，不是卡片真实内容。
- `_extract_card_text` 抽取卡片文字时要直接从整个 `content` 递归查找，不能假设 `elements` 在
  哪一层——流式卡片是 CardKit schema 2.0，`elements` 嵌在 `content["body"]["elements"]`，跟
  非流式卡片扁平的 `{"elements":[...]}` 结构不一样。

引用原文单独走 `quoted_text`（不拼进 `text`/`ConversationMessage.content`），网页展示单独渲染
预览条，完整内容仍喂给模型（见 §7.1、`agent/runner.py` 的 `_with_quoted_context`）。

验收标准：

- 引用普通文字消息：反查出真实文字。✅
- 引用咕咕自己的流式卡片回复：反查出真实正文，不是占位文案/空消息。✅ devserver 实测确认。
- 引用图片：识别出附件并进入模型输入。✅ devserver 实测确认。
- 网页聊天记录里引用原文单独一条预览展示，不与正文混在一起摊平显示。✅

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
- `GROUP_MESSAGE_CREATE`（普通群消息读取模式）

可选覆盖：

- `DIRECT_MESSAGE_CREATE`
- `AT_MESSAGE_CREATE`

验收标准：

- C2C 私聊消息能入队。
- 群 @ 消息在 `group_chat_enabled=true` 时入队，关闭时丢弃。
- `group_read_enabled=true` 时，未 @ 的普通群消息只记录、不调用模型、不回复。
- 普通群消息和 @ 消息使用同一个 `group_openid` 会话，群会话最多保留最近 50 条消息。
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

### 5.4 QQ 群聊普通消息读取（✅ 已完成）

QQ 群聊增加独立的“普通消息读取”模式。该模式与“群聊回应”分离：

- `group_chat_enabled`：总开关，关闭后群消息丢弃。
- `group_requires_at`：是否只有 @ 咕咕的消息进入正常回复链路。
- `group_read_enabled`：是否接收并保存未 @ 咕咕的普通群消息。

当 `group_read_enabled=true` 且消息未 @ 咕咕时：

1. 网关接收 `GROUP_MESSAGE_CREATE`。
2. payload 带上 `chat_id=group_openid`、`platform_user_id=member_openid`、`group_mentioned=false`。
3. worker 找到该群共享会话。
4. 只写入 `ConversationMessage(role="user")`。
5. 不调用模型、不产生回复、不消耗精力。

当消息 @ 咕咕时，仍进入原有 Agent Loop，并把该群近期消息作为上下文。

数据库保留策略：

- 每个群会话最多保留最近 50 条 `conversation_messages`。
- 普通消息落库后清理一次。
- 正常 @ 回复完成后再清理一次，防止工具往返和 assistant 回复绕过上限。
- 这只是数据库短期窗口，不代表已经实现群聊长期记忆。

### 5.5 群聊身份权限与工具白名单（✅ 已完成，Phase 6）

Phase 6 是独立的权限实施阶段，依赖 Phase 5 已经为当前 Bot 保存 owner `sender_id`，但不负责身份绑定本身。具体身份绑定见下方 Phase 5 说明和 [`IM 用户数据结构`](../../agent/22-IM用户数据结构.md)。

第一版权限模型：

```text
绑定 bot 的 QQ 用户
  → owner，可使用全部工具

其他群成员
  → non_owner，只能聊天和使用允许的白名单工具

无法校验 QQ 用户身份
  → identity_error，只能聊天，拒绝所有工具
```

当前实现按 Bot 级 owner 和白名单执行：每个 Bot 只有一个 owner，owner 身份不因进入不同群而变化；其他成员仍可聊天，但工具集在 runner 进入模型前过滤，并在统一 dispatch 层再次硬拦截。`users.id` 是咕咕账号自身的全局 ID，不用于跨 Bot 自动猜测 QQ 身份。按群单独开关和成员管理的 `im_chats` / `im_chat_members` 仍作为后续独立需求，不属于本阶段。

#### WebChat 与 IM 身份边界

WebChat 和 IM 使用两套不同的身份语义：

- WebChat 只使用 Gugu 的 `users.id` / `user_name`，不设置或注入 `platform_user_id`、`chat_type`、`im_role`。
- QQ、飞书、微信才使用当前平台的 `platform_user_id`，并在需要时附带私聊/群聊类型、会话 ID 和权限角色。
- IM 身份上下文只在当前 IM 会话中参与模型判断，不能用 WebChat 历史推断 QQ 发言人，也不能把 Gugu 用户名当作平台昵称。
- 原始平台 ID 只供内部身份比较和权限判断，默认不直接展示给用户；`platform_user_name` 只用于当前发言人的自然称呼。
- username 不能参与身份绑定、权限判断或“是否同一个人”的判断；不同 QQ ID 即使属于同一个 Gugu Bot owner，也必须保留为不同发言人。
- QQ raw WebSocket 当前可从 `author.username` 获取发言人显示名，并映射为 `platform_user_name`；该字段随消息保存。群名不从正文或昵称猜测，查询不到时不填。

#### 当前已知边界：群聊共享会话与用户资料隔离

群聊短期上下文按 `chat_id=group_openid` 共享，这是为了理解群内连续对话；但 `owner_user_id` 只是 Bot 的 Gugu 账号归属，不等于当前 QQ 发言人。当前实现已用 `platform_user_id` 做 owner/member 权限判断，并把当前 username 作为称呼元数据；后续仍需完成非 owner 对 owner profile、记忆、项目和文件的资料范围隔离，避免共享历史让模型误把其他 QQ 号称为 owner。

```text
网页搜索               chat_safe，固定开放
当前群聊上下文搜索     chat_safe，由 owner 在设置中选择
项目/文件/日历/记忆    owner_only
创建/修改/删除          owner_only + 现有确认门
```

设置入口已放在 `个人设置 → 接入咕咕 → QQ → 群聊工具权限`，当前允许切换 `web_search` 和 `group_context_search`。群上下文搜索只查询当前群的 `chat_id` 会话，不会读取其他群、私聊或网页历史对话。

已完成：`backend/app/services/im_identity.py` 权限解析、`user_bots.group_allowed_tools` 白名单、runner/dispatch 双层拦截、`group_context_search` 当前群隔离和权限专项测试。后续若需要群级开关，再单独设计 `im_chats`，不改变本阶段的 Bot owner 规则。

### 5.6 群聊短期/长期记忆（🔲 未做，Phase 7）

未来计划记录群成员的 `platform_user_id` 及其个人信息，并像个人聊天一样建立：

- 群级短期记忆：近期群聊事实和当前话题。
- 用户级短期记忆：某个成员在群中的偏好、身份和上下文。
- 群级/用户级长期记忆：经过压缩、复核后保留的稳定信息。

该阶段必须先明确：群成员可见范围、owner 删除权、个人信息提取规则、记忆过期与清理策略。当前 50 条消息上限只解决数据库增长，不包含上述记忆能力。

---

## 6. 技术方案

### 6.1 飞书

在 `backend/agent/gateway/feishu.py` 中局部增强：

- 在 `serve()` 或 `_make_on_message()` 闭包中维护 `_processed_message_ids`。
- 读取 event header 的 `app_id` / `create_time`。
- 新增 helper：
  - `_should_drop_misrouted_event(data, expected_app_id) -> bool`
  - `_should_drop_stale_event(data, now_ms, threshold_ms) -> bool`
  - `_seen_message_id(message_id) -> bool`
- 保持现有 `_ingest_media()`、`_fetch_quoted_text()`、`_quick_react()` 和入队 payload 不变。

### 6.2 QQ

建议将 `backend/agent/gateway/qq.py` 分阶段重构，避免一次性替换过大：

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

QQ raw event 转咕咕 payload 时保持现有字段；**2026-07-10 起 `text` 不再包装引用原文，引用原文单独一个 `quoted_text` 字段**（None=没有引用）——网页气泡是纯文本渲染 `text`，引用原文拼进去会把整段 markdown 原样摊平显示得很难看（真实反馈：引用一条带表格的历史回复，网页上看到一堆 `**粗体**`/`| P | 车手 |` 符号）。`quoted_text` 只在 `agent/runner.py` 组装喂给模型的输入时才会跟 `text`拼接（`_with_quoted_context`），`ConversationMessage.content` 和网页展示只用裸 `text`，`quoted_text` 单独一列存、前端单独渲染成一条浅色引用预览：

```json
{
  "platform": "qqbot",
  "channel_id": "<user_bot.id>",
  "owner_user_id": "<owner user_id>",
  "platform_user_id": "<user_openid/member_openid>",
  "chat_id": "<group_openid, 群聊时存在>",
  "message_id": "<qq message id>",
  "chat_type": "c2c|group",
  "text": "<用户自己打的话，不含引用原文>",
  "quoted_text": "<引用的原消息文字，没有引用则为 null>",
  "attachments": ["<attach_id>"],
  "group_read_enabled": true,
  "group_mentioned": false,
  "trace_id": "<trace id>"
}
```

飞书/微信同款（`agent/gateway/feishu.py`/`wechat.py`）也是 `text`+`quoted_text` 分开两个字段；微信 iLink 在这次改动前就已经在 payload 里带 `quoted_text` 了，但 `worker.py` 从没把它读进 `AgentRequest`（`AgentRequest` 之前压根没有这个字段），等于微信引用功能一直没真正喂给模型过，这次顺带修了。

### 7.2 日志要求

- 禁止打印用户消息正文、附件文件名原文。
- 涉及消息内容时只打印 `len`、`fingerprint()`、附件数量、trace_id。
- raw QQ event 仅允许在本地临时调试时手动打开，默认不得打印完整 payload。
- 移除当前 QQ 适配器中的 raw keys debug 日志。

**2026-07-10 全量审计**（用 general-purpose agent 逐文件核对 feishu.py/qq.py/wechat*.py/
worker.py/logsafe.py/runner.py 的每一条 print/log）：

- ✅ 确认：所有"收到消息"/"发送回复"日志行都走 `logsafe.fingerprint()` + `len()`，没有一处
  直接打印 `message.text`/`content`；引用结构诊断日志（`_log_quote_shape_if_needed` 系列）
  只打 key 名/类型，不打值。`logsafe.fingerprint()` 本身是 md5 前 8 位单向摘要，没有可逆
  风险。
- 🔧 发现真实违规并修复：`worker.py` 里三处"发文件"日志（wechat/feishu/qq）直接打印真实文件名
  （可能带敏感信息，如"张三合同.pdf"），跟本节要求的"附件文件名原文"红线不符——已改成
  `logsafe.fingerprint(fname)`。
- 🔧 顺手收紧三处 BORDERLINE（非确认违规但不够谨慎）：`qq.py` 富媒体上传失败日志、QQ
  session 失效日志、`wechat.py` sendmessage 失败日志，之前分别打印完整响应体/原始 WS
  payload，改成只打字段名或去掉整个 payload。
- 剩余约 35 处 `... 失败: {type(e).__name__}: {e}` 异常信息打印（分布在四个适配器）标记
  BORDERLINE 未动：`str(e)` 理论上可能在极端情况下回显请求/响应片段，但都是网络库/SDK 抛出
  的异常，正常运行下不含聊天正文，暂不逐一处理，后续如有实锤再改。

---

## 8. 测试计划

### 8.1 单元测试（✅ 已完成）

新增 `backend/tests/test_qq_raw_ws.py`：

- ✅ 引用文本按 `ref_msg_idx` 解析
- ✅ 没有 `ref_msg_idx` 时不误判
- ✅ C2C raw event 转 payload
- ✅ 群聊 raw event 转 payload
- ✅ 群聊关闭时丢弃事件
- ✅ `group_read_enabled` 开启时普通群消息进入静默记录分支
- ✅ 群会话消息上限保留最近 50 条
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
6. ✅ QQ 群聊 @ 咕咕，确认群聊回复仍发回群。
7. ✅ QQ 群聊开启“读取普通群消息”后，未 @ 消息不触发回复、后续 @ 能读取近期群上下文。
8. 🔲 QQ 群聊关闭开关后，确认群消息不入队 —— 需在目标 bot 的真实群权限下补测。
9. ✅ 飞书连续投递同一 message_id mock 事件，确认只入队一次（单测覆盖）。

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
- ✅ QQ 引用图片 attachments URL 可直接沿用现有 `_ingest_qq_media()` 下载逻辑（devserver 日志实测 `att=1` 成功下载暂存）。引用消息 `msg_elements=0` 的已知限制（疑似平台时效窗口）详见 [`docs/ops/known-issues.md`](../../ops/known-issues.md)。
- ✅ 飞书 stale retry 首期使用本机时间，后续如遇误杀再补平台 Date header 校时。
- ✅ Phase 2 原计划保留 botpy 接收路径开关至少一个小版本，实际因功能验证完成、决定直接全部移除（`_GuguQQClient`/monkey patch/`QQ_RAW_WS_ENABLED`/`qq-botpy` 依赖），不再保留回退路径。
- 🔲 Phase 3 raw HTTP 发送侧（文本/markdown 回退/URL 与 base64 发文件/群消息）尚未在真实 QQ 环境端到端验证，仅本地 mock 测试覆盖；`_send_tokens` 无锁，理论上并发首次请求可能重复取 token（浪费一次调用，不影响正确性）。
- ✅ QQ 群聊 raw WebSocket、@ 回复和普通消息读取已在当前 bot 环境验证；仍需补做关闭开关后的真实平台验收，并确认不同 QQ 权限配置下 `GROUP_MESSAGE_CREATE` 的覆盖范围。
- 🔲 群聊身份权限与工具白名单：按 `platform_identities`、`im_chats`、`im_chat_members` 三层结构落地；非绑定成员 chat-only，网页搜索固定开放，当前群聊上下文搜索可选，其余工具 owner-only。具体执行顺序见 [`IM 用户数据结构`](../../agent/22-IM用户数据结构.md) 第 6 节。
- 🔲 群聊短期/长期记忆：按 `platform_user_id` 记录个人信息并做群级/用户级压缩，需先完成隐私、可见范围和删除策略设计。
- ✅ 微信 iLink 引用消息无法识别原文，已确认是平台/协议限制（`getupdates` 接口本身不回传引用原文，不分发送者），非代码 bug。已核实 `@tencent-weixin/openclaw-weixin` 真实源码同样无法覆盖这一场景。占位文案统一为「[微信暂不支持消息引用识别]」。完整排查过程（含参考实现对比）详见 [`docs/ops/known-issues.md`](../../ops/known-issues.md)。引用图片下载失败已修复（`encrypt_query_param` vs `full_url`）。
