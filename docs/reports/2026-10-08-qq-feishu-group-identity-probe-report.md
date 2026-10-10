# QQ 群与飞书群身份映射及探针调查报告

日期：2026-10-08
范围：只读检查当前仓库实现与飞书开放平台资料；未访问用户新建的群、未查询生产数据库，未改动运行逻辑。

## 结论摘要

1. **QQ 群的核心映射已经比较完整**：Gugu 账号 → `UserBot` → QQ Bot；Bot owner 与发言人分别有平台身份；群用平台 `group_openid` 路由；消息落到 `(platform, bot_id, chat_id)` 会话，并以发言人身份标注消息。
2. **飞书并非从零开始支持群消息**：飞书入口已经传入 `chat_id`、`chat_type`、发言人 `open_id`，通用会话路由能按群隔离，出站也使用 `chat_id` 回复；群/成员记忆也已有共享路径。
3. **尚未达到 QQ 群功能对等**：群开关、回应模式、群消息静默记录、群成员工具白名单等 UI 和入站策略目前明确是 QQ 专用。飞书收到群消息时没有同等的显式启用策略；实际能收到哪些消息主要由飞书事件订阅与权限范围决定。
4. **当前没有 QQ ID ↔ 飞书 ID 的跨平台映射表，也没有独立的群目录/群成员关系表**。群成员关系主要由群消息历史中的 `(platform, bot_id, chat_id, platform_user_id)` 隐式表达。不同平台的用户不能靠昵称自动合并。
5. **先做一轮最小权限探针最合适**：用用户刚创建的群验证事件是否到达、平台 ID 类型、owner 私聊与群聊 ID 是否一致、机器人 @ 是否正确识别、群消息/回复是否进入预期会话。不要先申请全量通讯录或历史消息权限。

## QQ 当前映射表

| 业务实体 | QQ 来源/字段 | Gugu 当前字段或落点 | 作用与边界 |
|---|---|---|---|
| Gugu 账号 | QQ Bot 所属账号 | `user_bots.user_id` / 入站 `owner_user_id` | Bot 的 Gugu 数据归属；不是 QQ 用户身份 |
| Gugu Bot 记录 | 数据库主键 | `user_bots.id` → 网关 `channel_id`，统一协议中也称 `bot_id` | 隔离同一 Gugu 用户的多个 Bot；与 QQ AppID 不同 |
| QQ 应用 | `app_id` / `app_secret` | `user_bots.app_id` / 加密存储的 `app_secret` | Bot 凭据及连接；不是群 ID、不是 Bot 用户 ID |
| QQ Bot 平台身份 | mention / Bot 用户标识 | `user_bots.bot_platform_user_id`、入站 `platform_bot_user_id` | 用于识别被 @ 的具体 Bot；有事件格式兼容分支 |
| Bot owner 的 QQ 身份 | C2C `author.user_openid`；群消息优先 `author.user_openid`，缺失时回退 `member_openid` | `user_bots.owner_platform_user_id` + `owner_bound_at` | 按单个 Bot 绑定，供群内 owner/普通成员权限判断；不作为全局 QQ 身份 |
| 群 | `group_openid` | 入站 `chat_id`；会话 `ConversationSession.chat_id` | 群会话路由键；群 ID 不独立登记在群目录表 |
| 群成员/发言人 | `user_openid` 优先，其次 `member_openid` / 旧 `id` | 入站 `platform_user_id`；消息 `ConversationMessage.platform_user_id` | 身份主键；昵称只用于展示，不能作为权限依据 |
| 消息 | QQ `id` 与 `msg_idx` | 入站 `message_id`、`platform_message_id` | 入站去重、引用索引等；当前消息表没有独立平台消息 ID 列 |
| 群策略 | Bot 设置 | `group_chat_enabled`、`group_requires_at`、`group_read_enabled`、记忆开关、`group_allowed_tools` | 目前是 **每个 Bot 一套设置，作用于该 Bot 的所有群**，不是逐群配置 |
| 群成员关系 | 群消息中的 sender ID | 由消息历史和记忆投影隐式形成；群记忆对象按平台、Bot、群作用域存储 | 没有持久化的 `(群, 成员)` 权威映射表；历史窗口可能裁剪消息 |

代码依据：QQ 入站字段归一化在 `backend/agent/gateway/qq.py`；`UserBot` 字段在 `backend/app/models/__init__.py`；会话分流在 `backend/agent/im/session.py`；群成员记忆投影在 `backend/agent/memory/im_reflection.py`。

## 飞书当前映射表（已有/待验证/待补齐）

| 业务实体 | 飞书候选标识/事件字段 | 当前 Gugu 落点 | 调查判断 |
|---|---|---|---|
| Gugu 账号 | 已连接应用的 owner | `user_bots.user_id` / `owner_user_id` | 已有，和平台用户身份分开 |
| 飞书应用 | `app_id` (`cli_…`) | `user_bots.app_id` | 已有；密钥单独加密存储 |
| 应用租户 | 事件头 `tenant_key` | 当前入站 payload 未保存 | 探针应采集其是否存在/稳定；若未来支持一个应用服务多个租户，需纳入租户边界，而不能依赖群名 |
| 飞书 Bot 平台身份 | 应用 Bot 的 `open_id` | `user_bots.bot_platform_user_id` 字段存在，但飞书入站没有提供/回填该字段 | 待探测。需要独立取得 Bot 自身 ID，不能拿消息 sender 的 open_id 代替 |
| Gugu owner 的飞书身份 | Device flow 返回的 `user_info.open_id` | `user_bots.owner_platform_user_id` + `owner_bound_at` | 已存；群内 owner 授权应验证同 Bot、同 app 下的 ID 是否与 owner 私聊一致 |
| 群 | 消息 `message.chat_id`，通常是 `oc_…` | 入站 `chat_id` → `ConversationSession.chat_id` | 主路由已有；当前未存群名、`external` 等群元数据 |
| 会话类型 | `message.chat_type`，典型为 `group` / `p2p` | 入站 `chat_type`；协议层将 `p2p` 归一为 `c2c` | 主路由已有；探针验证 SDK 实际值及统一后的值 |
| 群成员/发言人 | `sender.sender_id.open_id`；事件可能另外包含 `user_id`、`union_id` | 入站 `platform_user_id`；消息 `ConversationMessage.platform_user_id` | `open_id` 是当前实现已用主键。其 ID 类型/是否跨私聊群聊一致必须实测；不可用显示名合并 |
| 消息 | `message_id`、`parent_id`、`root_id`、创建时间、类型 | 入站保留 `message_id` / 引用文字；消息表无平台消息 ID 列 | 探针需验证普通消息、回复/话题消息的关联字段；如需跨重启去重/引用原始消息，评估是否要持久化平台消息 ID |
| @ 信息 | `message.mentions[].id.open_id` 等结构化节点 | `bot_mentioned` 布尔值 | 现有实现存在需优先验证的疑点：调用处把当前发言人的 `open_id` 传给“是否 @ 当前 Bot”判断；若 mentions 表示被 @ 的对象，这会把发送者误当 Bot。需要探针确认并修正身份来源后，才能复用 QQ 的“只响应 @”模式 |
| 群策略 | 飞书权限/事件订阅 + Gugu 用户设置 | 目前没有与 QQ 一致的显式群启用、回应模式设置；群 owner 记忆开关已在 UI 出现 | 需设计策略的默认值和显式开关，避免“应用一加群就意外接收/回复所有消息” |

飞书 `open_id`、`user_id`、`union_id` 不是可互换的通用主键。当前应以事件提供的 `open_id` 做应用作用域内身份；只在确有跨应用/租户关联需求时，再研究 `union_id` 并要求明确权限与边界。QQ ID 与飞书 ID 之间不应自动推导身份关系。

## 当前能力差距（QQ 群 → 飞书群）

| 能力 | QQ 当前状态 | 飞书当前状态 | 适配关注点 |
|---|---|---|---|
| 私聊/群聊统一入站 | 已有 | 已有通用消息入口 | 确认 `p2p` 正确归一为 `c2c`，`group` 不被降级 |
| 群会话隔离 | `platform + bot_id + group_openid` | `platform + bot_id + chat_id` | 增加/记录租户维度的诊断指纹；不能只按群名或用户 ID 路由 |
| 群开关 | 用户可显式开启，默认关闭 | 未见等价的飞书群开关/门控 | 首先补安全默认和可观测状态 |
| 只响应 @ / 全部回应 / 只记录 | QQ 有设置及 Loop 处理 | 依赖飞书订阅事件；当前没有同等偏好设置 | 飞书可配置只收 @ 或申请接收全群消息；Gugu 应分别决定是否回复、只记忆/上下文或忽略 |
| owner 与成员区分 | owner QQ 身份验证码绑定；按 Bot 校验 | owner open_id 已在连接时绑定；群内比较路径已存在 | 验证同一个 owner 在私聊/群聊的 open_id 一致，并验证非 owner 始终 restricted |
| 群成员工具白名单 | 已有 | 共用 group access 分支/白名单，但飞书 UI策略需要核验 | 检查飞书群成员不能因 payload 的 owner_user_id 获得 owner 权限 |
| 群/成员记忆 | 群与成员记忆开关和投影 | 通用记忆管线存在；飞书 payload 未显式携带群/成员记忆开关 | 明确 Feishu 默认开关与按 Bot/按群的作用范围 |
| 群上下文搜索 | 可查近期 QQ 群消息 | `backend/app/services/group_context.py` 查询条件硬编码 `source == "qq"` | 要让飞书群使用相同群上下文搜索，查询边界必须接受受校验的平台参数，不能只改 UI |
| 媒体/引用 | QQ 适配器有自己的格式与索引 | 飞书文字、图片/文件/音频/视频、图文、卡片和引用已有部分解析 | 需要探测真实消息事件与 API scopes，不假设两平台附件语义一致 |
| 中断、互动、回复、文件发送 | QQ 有 QQ 专用 adapter | 飞书已有取消快捷路径、卡片/互动、回复及文件发送通道 | 群聊下逐项验证，特别是取消作用域须为 Bot + 群，而不是只按发言人 |

## 建议探针清单

探针只验证用户授权的这个测试群和当前 Bot；不枚举其他群、不读取历史消息、不下载媒体、不记录原始消息正文或原始用户 ID。

| 优先级 | 探测项 | 采集字段/判定 | 用途 |
|---|---|---|---|
| P0 | 应用与 Bot 身份 | 内部 `user_bots.id`、平台、脱敏 app_id、事件 `header.app_id`、`tenant_key` 是否存在；用 Bot info API 取得 Bot 自身 `open_id`（只在探针内比较，报告输出 HMAC 指纹） | 确认 event 到了正确子进程/应用；分离 app ID、Gugu bot row ID、平台 Bot UID |
| P0 | 消息到达/群 ID | event type、消息 `chat_type`、`chat_id`、`message_id`、create_time、消息类型；event app 是否匹配、去重是否成功 | 判断已加 Bot 的群是否真正触发已订阅的消息事件，及会话 key 是否完整 |
| P0 | Sender ID 类型 | `sender_type`、`sender_id.open_id` 是否存在；`user_id` / `union_id` 仅记录存在性与类型，不输出原值；同一测试账号发私聊和群消息时在内存中比对 ID 是否一致 | 验证 owner 身份绑定能否从私聊可靠映射到群聊；确定规范化的 platform UID |
| P0 | Bot mention | mentions 节点数量、每个 target 的 ID 类型、目标是否等于 Bot info 得到的 Bot open_id；同时确认 `bot_mentioned` 结果 | 定位当前 `_feishu_mentions_current_bot` 是否传错 ID，并确认“只回应 @”能否实现 |
| P0 | 会话/消息映射 | 只记录目标 Gugu 会话的 `source`、`bot_id`、`chat_type`、`chat_id` 是否正确；消息 sender ID 是否属于同一群作用域；通过 HMAC 指纹关联私聊/群聊样本 | 确认没有跨群、跨 Bot、跨平台串会话/串身份 |
| P0 | 群回复可达性 | 对一条测试消息在目标群执行一次受控回复；检查 API 成功/失败码、目标 receive_id 类型（chat_id） | 确认“收得到”之外“能在群里回复”；避免静默失败 |
| P1 | 群元数据/成员权限 | 经批准后读取该群 `chat_id`、群名、`external`、群主 ID；仅在要实现成员列表/角色时再申请/测试 `im:chat:readonly` 与成员读取 API | 区分内部/外部群及群成员权限；当前不需要就不收集 |
| P1 | 线程/回复上下文 | `parent_id`、`root_id`、thread 相关字段是否出现，引用原文反查结果 | 决定是否需对齐 QQ 引用/话题体验 |
| P1 | 文件与富媒体 | message_type、attachment/resource key 是否存在、下载/上传结果和错误码；正文不落探针日志 | 判断现有媒体适配器能否覆盖该群实际使用的类型 |
| P1 | 权限配置快照 | 应用是否启用机器人、已发布可用范围、接收消息事件订阅、实际已授予 scopes 的名称/版本；不读密钥 | 解释无事件、仅 @ 有事件、无法回复或 API 403 的原因 |
| P2 | 成员变更事件 | 仅在需要欢迎/撤权/成员清单时订阅成员加入/退出事件，并记录事件类型及 ID 指纹 | QQ 当前基于发言历史形成成员画像，不等于拥有权威成员清单；评估飞书新能力时再扩展 |

### 诊断脱敏规则

- 原始正文、附件名、群名和原始 `open_id` / `chat_id` 不写入普通日志或提交报告。
- 日志使用 `agent/logsafe.py` 的稳定指纹；比较私聊与群聊时在内存中比较原值，只输出“相同/不同”和指纹。
- 探针不得输出 app secret、access token、授权码或完整原始事件体；权限列表只记 scope 名称与是否已授权。
- 对全群消息订阅、历史消息、通讯录/成员列表等增加敏感访问范围的权限，按需单独授权，不为探针预先开启。

## 飞书开放平台能力核实

- 飞书官方文档明确区分 `im:message.group_at_msg`（群内 @ 机器人消息事件）和 `im:message.group_msg`（群内全部消息事件）；基础 `im:message` 负责收发消息。可先用只收 @ 的最小权限跑通，再由用户决定是否扩展全群消息。
- 飞书群聊支持机器人收发消息；机器人必须在目标群内，应用可用范围和群类型/外部分享设置会影响权限。外部群需要额外核对外部分享能力。
- 官方消息历史 API 还要求 Bot 已启用且在目标群内；全量读取群历史需额外的 `im:message.group_msg`。本次目标是实时群聊适配，探针阶段不需要历史读取权限。
- 飞书群成员/员工与业务账号之间如需业务关联，官方集成指南建议业务系统显式建立映射；不应把昵称当作身份桥接。

参考：

- [飞书开放平台：运维工单集成方案（群消息权限说明）](https://open.feishu.cn/solutions/detail/ticket?lang=zh-CN)
- [飞书开放平台：获取历史消息（应用权限、群内 Bot、群消息 scope）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)
- [飞书开放平台：群配置变更事件（`chat_id`、事件及权限）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/events/updated)
- [飞书开放平台：机器人群组管理能力](https://open.feishu.cn/solutions/detail/groups?lang=zh-CN)

## 建议的探针执行顺序

1. 先确认用户新建群属于内部群还是外部群，并确认机器人已添加；检查 app 的机器人能力、发布可见范围、已订阅事件和当前已授权 scopes。
2. 使用测试账号在群里发一条普通消息和一条明确 @ Bot 的消息；只订阅 @ 的配置下，预期只有 @ 消息进入事件处理。记录字段类型/是否存在及 ID 指纹。
3. 同一测试账号给 Bot 发一条私聊，比较群与私聊中的 `open_id` 指纹；再比较群消息 mentions 中的目标 ID 与 Bot 自身 open_id。确认 owner 匹配与 `bot_mentioned` 判定。
4. 核对一条目标群消息最终路由到 `platform=feishu`、正确 `bot_id`、`chat_type=group`、正确 `chat_id`；检查数据库中成员 ID 只被存为该群会话消息身份。
5. 在群里做一次受控回复和一次引用回复；根据结果再决定是否做媒体、线程、成员变更事件探测。

**设计建议**：内部统一映射优先采用 `(platform, bot_id, tenant_key?, chat_type, chat_id)` 标识会话，消息成员用 `(platform, bot_id, platform_user_id)` 标识，并将名字视为可变展示属性。对于普通 BYO 单租户应用，`tenant_key` 可先作为探针/诊断元数据；若一个 app 可能跨租户服务，则应纳入明确的隔离键。跨平台 owner 关联继续由 Gugu 用户显式拥有多个 Bot 记录表达，不建立“QQ UID == 飞书 UID”的伪映射。
