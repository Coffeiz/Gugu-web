# Telegram Bot 群聊与消息接入 PRD

> 状态：Phase 0 完成；Phase 1/2 代码主体完成，用户已确认私聊和群聊基本对话可用；Phase 3 代码完成，待真实媒体验收；Phase 4 尚未完成（全量回归有失败项，OpenAPI 生成差异待审）。Telegram 频道暂不支持（Telegram 官方 HTTPS Token 路径例外已获用户明确批准）
> 创建：2026-10-08
> 关联模块：`backend/agent/gateway/`、`backend/agent/im/`、`backend/app/api/v1/user_bots.py`、`frontend/src/components/common/profile/ProfileImPane.vue`
> 调研依据：Telegram 官方 Bot API、Bot FAQ、Bot Features，以及当前 Gugu IM/Gateway 实现

## 1. 背景与目标

Gugu 已有 QQ、飞书和微信 IM 接入。Telegram Bot API 提供私聊、群聊、消息实体、命令、文件和长轮询/Webhook 能力；当前 Gugu 尚无 Telegram 平台适配。目标是在不复制 Agent 主流程、不另建 Gateway 服务的前提下，让用户在个人设置中接入自己的 Telegram Bot，并按 Gugu 统一 IM 协议处理私聊和群聊。

本 PRD 的“QQ 对等”指主要对话和安全能力对齐，不代表平台字段、隐私权限、流式样式和所有操作 API 一一相同。

### 1.1 用户目标

- 在个人设置输入 BotFather 创建的 Bot Token，验证并接入自己的 Bot。
- Bot 能处理私聊和群聊；群聊可配置关闭、仅在明确触发时回复、或处理群内普通消息。
- 群消息保留群与发言人身份，遵循 owner/member/unknown 权限隔离、工具白名单和群记忆设置。
- 常用文本格式、命令、回复上下文、取消、图片/文件等能力能以 Telegram 适配方式工作。
- 用户可在个人设置查看/停用/删除接入，并安全替换 Token。

### 1.2 非目标

- 不实现 MTProto 用户客户端，不要求用户提供个人账号登录码、手机号或 session。
- 不实现 Telegram 群成员全量枚举、通讯录同步、任意用户资料抓取；只使用消息事件中可见的数据及按需成员查询。
- 不承诺群聊管理员管理、群封禁、邀请链接管理、投票/支付、Business Bot、Mini App 等完整 Telegram 管理功能。
- 首期不实现论坛群 topic 独立会话、全量群历史导入、跨 Telegram Bot 或跨平台账号自动合并。
- 首期不支持 Telegram 广播频道（Channel）；只接入私聊、普通群和 supergroup。频道的 `channel_post` / `edited_channel_post` 不订阅、不解析，也不创建会话。
- 不引入新的独立 Gateway 守护服务，也不在此 PRD 中变更现有 IM 运行模型。

## 2. 官方能力与产品决策

### 2.1 群消息可见性

Telegram Bot 默认开启 Privacy Mode。隐私模式下 Bot 主要接收显式发给它的命令、相关回复及平台规定的其他消息，不等于普通文本 `@bot` 提及后必然能收到整条消息。若要像 QQ `GROUP_MESSAGE_CREATE` 一样处理普通群消息，用户必须关闭 BotFather 的 Privacy Mode，或将 Bot 设为群管理员；管理员会收到所有群消息（其他 Bot 消息除外）。

因此：

1. Gugu 的群聊总开关默认关闭，与 Telegram 当前事件订阅/隐私设置分开表达。
2. 接入提示必须说明：关闭 Privacy Mode 或授予管理员身份是“读取普通群消息”的平台前提；只想用命令/回复时可先不开放全群消息。
3. Gugu 的“全部回复 / 仅触发时回复 / 只记录”是收到事件后的产品策略，不会替用户修改 BotFather 设置，也不能让平台向 Bot 投递其不可见的消息。
4. 仅触发模式支持 `/command@bot_username`、对 Bot 消息的回复；普通 `@bot` 文本提及只有在 Bot 能收到该消息时才参与 Gugu 判定。

### 2.2 用户身份和用户名

Telegram `User.id` 是成员身份主键；事件通常同时带 `first_name`，`last_name`、`username` 为可选资料。Username 可缺失且可变，只能作展示/寻址辅助，不能作权限主键。若需要补查已知成员，可调用 `getChatMember(chat_id, user_id)`；对其他用户的信息，官方只保证 Bot 为该群管理员时该方法可用。Bot API 不提供可依赖的普通群成员目录全量扫描路径。

匿名管理员或以频道身份发言的消息可能以 `sender_chat` 作为发言主体，不能总是解析成个人 Telegram `User.id`；此类消息映射为未知/群身份，不能因昵称或 title 授予 owner 权限。

### 2.3 API 与 SDK 决策

- 使用官方 HTTPS Bot API。Telegram 官方提供 API 文档和按语言分类的社区库清单；没有官方维护的 Python Bot SDK 承诺。
- 首期沿用现有 `agent.gateway.gateway` 每 Bot 子进程模型，在 `agent.gateway.telegram` 内用项目已使用的异步 HTTP 客户端直接调用 Bot API。这样可及时使用官方新方法，不被第三方 SDK 的 API schema 发布节奏阻塞。
- 接收使用 `getUpdates` 长轮询，按 Bot Token 一进程一连接；与现有 Gateway 生命周期、配置热重载和重启策略一致。Webhook 与 `getUpdates` 互斥，首期不新增公网 webhook endpoint。若 `getWebhookInfo` 显示已有 webhook，接入校验应明确提示冲突，不得擅自清除用户原配置。
- 本轮复核时官方当前版本为 Bot API 10.3；Rich Messages 与草稿流式能力已在 10.1 引入，但仍不属于 V1 验收范围，留在后续评估，不依赖未验证的 SDK 封装。
- Bot API 的官方授权 URL 固定为 `https://api.telegram.org/bot<TOKEN>/METHOD_NAME`，Token 必然位于出站 HTTPS 请求路径，官方没有 Header 认证方式。用户已明确批准仅针对 Telegram 官方 API 的必要例外：允许 Token 在进程内构造固定官方主机的 HTTPS 请求时短暂进入路径；必须禁用重定向，完整 URL 不得记录、持久化、展示、加入队列或传播。应用自身路由、其他主机/平台和其他凭据仍禁止 Token 入 URL。该批准不授权读取或使用生产凭据。
- Telegram Bot API 在管理员启用“后端代理设置”时显式使用该代理；代理故障不得回退直连。该配置不会自动改写其他 Provider、IM Gateway 或内部服务路由；固定官方 HTTPS 主机约束、禁用重定向和 Token 脱敏保持不变。
- Bot API 10.0 起存在受设置限制的 Bot-to-Bot 消息能力。Gugu V1 仍按产品安全策略忽略其他 Bot 的消息，不依赖或开启该能力。

## 3. 范围与行为需求

### FR-1：安全接入与凭据管理

1. 个人设置提供 Telegram Token 输入与验证。后端调用 `getMe` 验证 Token，并获得 Bot 的数值 ID、username、display name。
2. 仅验证成功后创建/更新 `UserBot(platform="telegram")`。首期每个 Gugu 用户最多接入一个 Telegram Bot；同一 Bot ID 不得绑定到多个 Gugu 用户。
3. Token 存入现有加密字段 `user_bots.app_secret`，不得回显明文、写日志、进入应用自身的 API URL 或写入事件 payload。Telegram 官方出站请求路径必须含 Token；用户已批准仅在固定官方主机的 HTTPS 请求中短暂携带，且必须禁用重定向、不记录或持久化完整 URL。`app_id` 存 Telegram 数值 Bot ID 字符串作为公开去重键；Bot username/display name 写 `name`，不作为身份依据。
4. 替换 Token 时先验证新 Token，再原子更新记录；验证失败不得破坏原接入。API 响应只返回掩码 Token。
5. 检测 `getWebhookInfo` 已有 webhook 的情况并阻止启动长轮询，向用户给出可理解提示；不得调用 `deleteWebhook` 自动抢占 Bot。
6. 创建、修改、禁用、删除后复用 Gateway reload 通知；删除必须走现有统一确认组件。

### FR-2：Gateway 接收和可靠入站

1. `agent.gateway.gateway` 注册 Telegram 模块，并通过环境变量传递 bot ID、Token 和 owner Gugu ID；秘密不出现在进程 argv、普通日志或 health heartbeat。
2. `agent.gateway.telegram` 使用 `getMe`/`getUpdates` 长轮询；支持启动、退出、网络错误退避、配置变更重启和 Bot API 429 `retry_after`。
3. 每个 Update 按顺序进入现有 `im:inbound` 队列。Redis Lua 原子完成 `XADD`、Bot 作用域去重标记和“最后已入队 update_id”游标写入；只有完整处理本次响应中的 Update 后，下一次 `getUpdates` 才使用 `offset=last_enqueued_update_id+1` 确认它们。去重键为 `(UserBot.id, update_id)`，保留 48 小时；游标也按 Bot 隔离，保留 6 天。重启时只在游标存在时续用 offset，否则不传 offset，从 Telegram 最早未确认更新继续；6 天过期可避免 Telegram 连续一周无新 Update 后随机重置 update_id 时沿用陈旧 offset。队列或 Redis 故障不得推进 offset。
4. 忽略 Bot 自己发出的事件；默认不处理其他 Bot 的消息。拒绝未知 Update 类型时应记录脱敏类型诊断，不记录正文或原始 payload。
5. 接收私聊、普通群与 supergroup 的文字消息及服务事件。首期仅为文字群消息提供完整 Agent loop；不可处理的消息类型不得误触发空内容生成。

### FR-3：统一身份、路由和群权限

1. 私聊统一为 `chat_type="c2c"`；群、supergroup 统一为 `chat_type="group"`。
2. 入站载荷包含 `platform="telegram"`、`channel_id=UserBot.id`、`owner_user_id`、`chat_id`、`platform_user_id`、展示名、`message_id`、`update_id`、消息时间、文本、回复目标和 mention 结构化信息。
3. owner 的 Telegram 身份通过与 QQ 一致的一次性绑定码流程绑定：Gugu 设置页生成短时单次 code，owner 在 Bot 私聊发送 `/bind <code>`；只有成功消费 code 后才写 `owner_platform_user_id`。不能仅因创建/持有 Bot Token 就推断用户 Telegram 身份。
4. 群内 owner/member/unknown 由 `(platform, bot_id, owner_platform_user_id, platform_user_id)` 精确判定；缺失用户 ID、匿名管理员、频道身份均为 unknown，不授予 owner 能力。
5. 群工具按现有 group allowlist 与服务端 dispatch 双重限制。群上下文搜索必须按 `platform + bot_id + group chat_id` 隔离；不得把 Telegram 群归到 QQ 查询路径或只按群名查询。
6. 群记忆、成员记忆、owner 群记忆开关沿用现有边界；群内 member/unknown 不读取 owner 私人记忆/文件/项目/日程。

### FR-4：群策略设置

1. Telegram 群聊总开关默认关闭；单个 Bot 的配置作用于该 Bot 可见的所有群，首期不做逐群配置。
2. 复用 `group_chat_enabled` 作为 QQ/Telegram 的独立 Bot 行配置；不复用飞书 `feishu_group_chat_enabled` 的 NULL 旧版默认语义。
3. 复用群回应模式字段：
   - `reply_all`：平台可见消息都可触发回复。
   - `reply_mentions`：仅 Bot 命令、有效 @ 触发、或对 Bot 消息的直接回复触发；其余按设置只读/不读。
   - `record_only`：满足平台事件可见范围时记录群消息，不调用模型、不发回复。
4. `group_read_enabled` 与回应模式分开：在 `reply_mentions`/`record_only` 下是否把未触发消息纳入近期上下文，受现有设置约束。平台 Privacy Mode 不可见的消息不能被记录。
5. 回复中的 `/stop`、`/cancel` 可取消当前 Bot+群的运行，不得跨 Bot、跨群或只凭文本取消他人私聊任务。`/bind` 属于接入控制命令，应在 Agent loop 前处理并避免送入模型。
6. 对 `/command@bot_username` 统一去除本 Bot 后缀后路由；发送给其他 Bot 的命令不得由本 Bot 消费。

### FR-5：发送、格式和媒体

1. 普通文本支持安全格式化；首期覆盖粗体、斜体、链接、行内代码和代码块。MarkdownV2 必须正确转义特殊字符并有行为测试；复杂表格/不支持结构转为可读纯文本，不得拼接未经校验的 HTML。
2. 回复接口支持普通发文、回复已有消息、拆分超长文本，并遵循 Telegram 单消息限制；消息拆分不得切断 UTF-8 字符或 Markdown 实体。
3. 支持私聊/群聊发送图片和文件、入站图片/文件的暂存与安全校验；语音/视频作为兼容性单列，只有实现下载、大小限制、mime 校验及上下文描述后才标为支持。不得因平台文件下载失败把 URL 当成本地附件。
   - 当前官方云端 Bot API 限制：`getFile` 下载上限 20 MB；multipart 上传照片上限 10 MB、其他文件上限 50 MB。实现应集中表达这些运行限制，并在官方限制变更时复核，不承诺超出能力的文件。
4. 首期普通回答为最终消息发送；编辑式逐段流式输出不作为上线门槛。后续评估 Bot API streaming draft / Rich Messages，并通过平台实测确定私聊和群聊行为。
5. 已有 `reply_to_message` 可提供引用文本；引用附件复用只能按可验证的消息 ID 查找当前 Gugu 已保存的附件，不得任意访问 Telegram 历史消息。
6. 按 Telegram rate limit 处理 429 与重试时间；同一群发送节奏由共享发送层控制，避免工具摘要/分片造成消息轰炸。

## 4. 数据映射表

### 4.1 平台账号、Bot 与会话身份

| 业务实体 | Telegram 来源 | Gugu 规范字段/存储 | 映射规则与边界 |
|---|---|---|---|
| Gugu 用户 | 当前登录账户 | `UserBot.user_id` / 入站 `owner_user_id` | 数据所有者，不等于 Telegram 用户 ID |
| Telegram Bot Token | BotFather | `UserBot.app_secret`（加密） | 唯一秘密；应用 API、日志、队列、仓库和持久化 URL 禁止出现；官方出站请求路径必含 Token，须先获安全规则例外 |
| Telegram Bot 平台 ID | `getMe.id` | `UserBot.app_id` 与 `bot_platform_user_id` | 数值 ID 字符串；username 不作 Bot 主键 |
| Telegram Bot 用户名 | `getMe.username` | `UserBot.name` 或展示元数据 | 可变、可能缺失；仅展示和命令提示，不作授权依据 |
| Gugu Bot 记录 | 数据库主键 | `UserBot.id` → IM `channel_id`/`bot_id` | 与 Telegram Bot ID 不同，用于隔离同一 Gugu 用户的连接和群策略 |
| owner Telegram 身份 | 私聊 `/bind <code>` 的 `from.id` | `UserBot.owner_platform_user_id` + `owner_bound_at` | 一次性 code 绑定；不得仅凭 Token 控制权或显示名推断 |
| 私聊 | `Message.chat.id`，`chat.type=private` | `chat_type=c2c`、`chat_id` | 使用 chat ID 做路由；发言者 `from.id` 单独用于成员身份 |
| 群/supergroup | `Message.chat.id`、`chat.type` | `chat_type=group`、`chat_id` | 按 `(platform, bot_id, chat_id)` 隔离；群 title 仅展示 |
| forum topic | `message_thread_id` | 首期不映射为独立会话 | V1 忽略独立 topic 路由，明确列为后续；不能把 topic ID 冒充群 ID |
| 群成员 | `Message.from.id` | `platform_user_id`；消息历史/记忆沿现有路径存储 | 数值 ID 转字符串；权限键附带 platform 与 Bot 作用域 |
| 成员显示资料 | `first_name`（必有）、可选 `last_name`/`username` | 入站展示名/成员记忆 profile | 资料可变；缺 username 时不报错，绝不作为身份主键 |
| 匿名/频道发言 | `sender_chat` 或无普通 `from` | `platform_user_id` 缺省，actor=unknown | 不根据 title/name 绑定 owner 或提升权限 |
| 消息 ID | `Message.message_id` | 入站 `message_id` / 回复定位 | 仅在 Chat 范围内唯一，外部复合键须包含 chat_id |
| 更新 ID | `Update.update_id` | 入站 `platform_event_id` / 去重键 | 在 Bot 作用域内用于投递幂等与 offset 进度，不替代消息 ID |
| 命令 | `MessageEntityBotCommand` / 文本 `/cmd@username` | 规范化 command + 参数 | 只剥离当前 Bot username；转给其他 Bot 的命令忽略 |
| @提及 | `MessageEntityMention`/`text_mention` | 规范化目标 Bot ID/username、`bot_mentioned` | 必须与当前 Bot 身份精确比较，不能从普通文本猜用户身份 |
| 回复关系 | `reply_to_message.message_id` | `quoted_message_id`/引用文本 | 只读取事件实际提供的引用；不推断任意历史内容 |
| 附件 | `photo`、`document` 等 file_id | 附件暂存记录与 `attach_id` | `file_id` 为平台资源定位符，不是本地路径；下载使用 Bot API 且有大小/类型限制 |

### 4.2 群策略字段复用

| 设置 | Telegram V1 存储字段 | 与 QQ 的关系 | 默认值/安全语义 |
|---|---|---|---|
| 群聊总开关 | `group_chat_enabled` | 每条 UserBot 独立字段；QQ 行与 Telegram 行互不影响 | Telegram 新记录默认 `false` |
| 是否要求触发 | `group_requires_at` / 规范化回应模式 | 共用每 Bot 群策略配置，不共享跨 Bot 状态 | 对应回复模式；平台 Privacy Mode 是额外前提 |
| 未触发消息读取 | `group_read_enabled` | 沿用现有含义 | 默认关闭；不可突破平台不可见范围 |
| 工具白名单 | `group_allowed_tools` | 按 Telegram Bot 行读取 | 使用服务端 allowlist，成员/unknown 不获 owner 权限 |
| 群记忆/成员记忆 | `group_memory_enabled`、`member_memory_enabled` | 复用通用群记忆开关 | 保留现有权限过滤和作用域隔离 |
| owner 群记忆 | `group_owner_memory_enabled` | 复用当前显式授权机制 | 默认关闭 |
| 消息格式 | 首期不增加字段 | 不复用 QQ 专属格式选择语义 | Telegram 的实体转义/格式化按 adapter 实现 |

## 5. 支持功能表

| 功能 | QQ 当前基线 | Telegram V1 目标 | 状态/限制 |
|---|---|---|---|
| BYO Bot 接入与启停 | AppID/Secret 接入 | Token 验证、掩码展示、加密保存、启停/删除 | V1 必须 |
| 私聊 | 支持 | 收发文本、owner 绑定、上下文和取消 | V1 必须 |
| 群/supergroup | 支持群事件 | 接收/回复并按 Bot+群隔离 | V1 必须；默认关闭 |
| 广播频道（Channel） | 不适用 | 暂不支持；频道帖子不接收、不建会话 | 明确不在 V1 范围 |
| 普通群消息 | 受 QQ 权限与 Bot 开关控制 | 关闭 Privacy Mode 或授予管理员后才能完整接收 | 平台设置前置；Gugu 不可代改 |
| 仅触发回复 | `@`模式 | Bot 命令、可见的 @、回复 Bot 消息 | V1；隐私模式下普通文本 @ 不保证可见 |
| 全部回复/只记录 | 支持 | 在 Bot 实际收到事件后按 Gugu 策略处理 | V1 必须 |
| owner/member/unknown | 支持 | Telegram 数值 user ID 精确判定；匿名/频道 sender 为 unknown | V1 必须 |
| 群工具权限 | 白名单与服务端拦截 | 复用策略并补平台分支测试 | V1 必须 |
| 群短期上下文/群成员记忆 | 支持 | 复用通用 IM 记忆链路，确保 Telegram source 加入查询 | V1 必须 |
| Slash 命令 | QQ 文本命令 | 支持 `/stop`、`/cancel`、`/bind` 和 Agent 命令路由 | V1 必须；`@other_bot` 不处理 |
| 消息格式 | QQ markdown/纯文本策略 | MarkdownV2 安全格式化：基础强调、链接、代码；复杂表格可读降级 | V1 必须 |
| 发送/接收图片与文件 | 支持常见媒体 | Bot API 可用范围内图片/文件收发与暂存 | 实现完成；接收 ≤20 MB、发送 ≤50 MB |
| 音频/语音/视频 | 按平台支持 | Telegram 附件进入现有通用媒体理解链路 | 实现完成；能否理解取决于模型与服务器媒体能力 |
| 引用消息/引用附件 | QQ 有引用索引 | 消息内引用文本和 Gugu 已存附件复用 | 实现完成；不对 Telegram 历史任意反查 |
| 流式输出 | QQ 私聊可选流式 | 最终消息优先；Bot API Draft/Rich streaming 后续评估 | 非 V1 门槛 |
| 群话题/topic 独立会话 | QQ 无同类 | forum topic 作为独立会话及回复线程 | 后续版本 |
| 成员目录/全量用户名 | QQ 有限度依赖消息采集 | 仅可获得已知消息用户和权限允许的成员查询 | 不承诺全员枚举；username 可缺失 |
| 管理员操作/群管理 | 非核心 | 管理员、封禁、成员变更、邀请管理 | 不在 V1 |
| Rich Messages / GFM 表格 | QQ 有自有格式能力 | Telegram Bot API 10.1 Rich Messages | 后续评估，独立验证 API/客户端兼容性 |

## 6. 实施文件清单

以下为按当前仓库静态结构梳理的完整预计清单。执行阶段若发现生成代码或共享测试落点不同，先更新本节再实现。所有已有脏改动必须原样保留；此 PRD 不授权提交或修改实现。

### 6.1 新增

| 文件 | 职责 |
|---|---|
| `backend/agent/gateway/telegram.py` | Telegram Bot API 长轮询、Update 归一化、入站投递、回复/发送/文件接口、退避和安全诊断；不实现 MTProto |
| `backend/app/api/v1/telegram_connect.py` | Token 验证、`getMe`、Webhook 冲突检查、创建/轮换 Telegram `UserBot` 和 owner 绑定码接口 |
| `backend/app/services/telegram_bot_api.py` | 固定官方主机 HTTPS 调用封装；约束 Token 路径例外并提供脱敏错误 |
| `backend/agent/im/parsers/telegram.py` | Telegram command/message entities、Bot mention、reply、媒体节点到统一 IM 结构的纯解析逻辑 |
| `backend/agent/im/telegram_format.py` | Telegram 专属 MarkdownV2 转义、基础格式转换和消息分片边界处理，避免改变其他平台格式语义 |
| `backend/agent/im/media_ingress_telegram.py` | Telegram 图片/文件下载、类型/大小校验和现有附件暂存接入；沿用 Feishu/WeChat 的平台专属媒体入口拆分 |
| `backend/tests/test_telegram_gateway.py` | 长轮询归一化、Redis offset 恢复/重复 Update、入队与游标写入崩溃窗口、退避、秘密脱敏、发送格式与错误边界测试 |
| `backend/tests/test_telegram_connect.py` | Token 校验、唯一性、加密存储、替换失败保留旧值、Webhook 冲突和 owner code 测试 |
| `backend/tests/test_telegram_im_policy.py` | Telegram 群开关默认关闭、回应模式、权限角色、取消隔离和群上下文隔离测试 |
| `backend/tests/test_telegram_message_parser.py` | command 后缀、文本实体、@Bot、引用及匿名/频道 sender 边界测试 |
| `backend/tests/test_telegram_media.py` | 文件类型、大小限制、资源下载、临时失败和附件暂存行为测试 |
| `backend/tests/test_telegram_contract.py` | Phase 0 统一消息类型、跨平台/Bot 会话隔离、owner/匿名身份与群默认关闭行为测试 |

### 6.2 修改

| 文件 | 预计修改 |
|---|---|
| `backend/agent/gateway/gateway.py` | 注册 Telegram 子进程模块和环境变量注入；凭据继续只经环境注入，不进 argv |
| `backend/agent/im/models.py` | 注册 Telegram 统一消息类型、chat type、payload 校验与规范化 |
| `backend/agent/im/session.py` | 允许 `source="telegram"`，会话键隔离 platform/bot/group；明确 topic 暂不构成独立 key |
| `backend/agent/im/context_policy.py` | Telegram 纳入 IM source/context 策略白名单 |
| `backend/agent/im/context_loader.py` | Telegram 纳入群/成员上下文加载及作用域过滤 |
| `backend/agent/im/actor.py` | 支持 Telegram 用户身份解析；无 `from.id`/匿名 sender 固定为 unknown |
| `backend/agent/im/permissions.py` | Telegram 使用独立的 `group_chat_enabled` 默认关闭策略；群工具白名单按 Telegram Bot 记录生效 |
| `backend/agent/im/mentions.py` | 按 Telegram 实体和 Bot 身份判定 mention/command，不从正文猜测身份 |
| `backend/agent/im/loop.py` | Telegram 入站运行接入、`/bind`/取消控制命令、出站 streaming 分支不误调用 QQ/飞书实现 |
| `backend/agent/im/replies.py` | Telegram 文本、回复、消息分片、格式化/转义及平台发送分发 |
| `backend/agent/im/files.py` | 支持 Telegram 平台文件发送和能力校验 |
| `backend/agent/im/media_ingress.py` | 将 Telegram 文件暂存接到统一附件/上下文路径，避免平台逻辑泄漏到 Agent 核心 |
| `backend/app/api/v1/user_bots.py` | 对 Telegram 允许群策略更新、校验 platform 字段并返回掩码状态；复用 `group_chat_enabled`，不引入 Telegram 专属迁移字段 |
| `backend/app/main.py` | 注册 Telegram 接入 API router |
| `backend/worker.py` | 让 Telegram 群消息进入相同 owner/成员策略、取消范围和群 payload 准备链路 |
| `backend/app/services/group_context.py` | 群上下文查询接受受校验的 platform 参数，增加 Telegram 隔离，去掉仅 QQ 假设 |
| `frontend/src/components/common/profile/ProfileImPane.vue` | Telegram 平台入口、Token 接入/替换、群聊与已有群策略设置、二维码/表单位置与状态 |
| `frontend/src/services/api.ts`（以仓库实际 API service 文件为准） | 增加 Telegram connect/verify/poll 或普通提交 API 客户端 |
| `frontend/src/i18n/sections/common.ts` | Telegram 接入、Token、安全提示、Privacy Mode、错误和群策略文案的简中/日/英文案 |
| `frontend/src/types/api.ts` | 后端 OpenAPI 类型生成后更新，不手改生成结果；确认生成命令与差异范围 |
| `frontend/tests/profile/ProfileImPane.test.ts` | 接入流程、Token 不回显、群设置按平台隔离和错误提示测试 |
| `CHANGELOG.md` | 功能验收后增加简短用户可感知的 Telegram 接入说明 |

### 6.3 明确不改/不新增

| 范围 | 决策 |
|---|---|
| 删除文件 | 无；首期不删除 QQ、飞书、微信适配器或共享 IM 逻辑 |
| 数据库迁移 | 预计不需要：Token、平台 ID、owner ID、群策略均复用 `UserBot` 现有字段；若实现证明必须新增独立策略字段，应先修订 PRD 并说明迁移/默认值 |
| `backend/agent/gateway/gateway.py` 外的新常驻管理器 | 不新增；继续使用当前子进程调度器 |
| `backend/agent/im/loop.py` 内的平台专属完整业务栈 | 不复制一份 Telegram Agent loop；只加平台边界适配 |
| MTProto client、用户账号登录 | 不新增依赖、不读取用户个人账号凭据 |
| Telegram Bot Token 文档/fixture | 测试只用合成 Token；任何真实 Token 不进入日志、PRD、截图或仓库 |

## 7. API 与配置契约

### 7.1 接入接口建议

- `POST /api/v1/me/telegram/connect`：输入 Bot Token，后端校验 `getMe` 并创建连接；响应只含 bot 记录、显示名和掩码 Token。
- `PUT /api/v1/me/telegram/connect/{bot_id}`：先校验新 Token，再轮换密钥并触发 Gateway reload。
- `POST /api/v1/me/telegram/connect/{bot_id}/binding-code`：生成一次性 owner 绑定 code；如果实现可复用 QQ 通用绑定服务，复用后本接口只负责平台路由。
- `PATCH /api/v1/me/bots/{bot_id}`：允许 Telegram 更新 `enabled`、`group_chat_enabled` 与已有群策略；校验该 Bot 归当前用户所有。
- 删除走既有 UserBot 删除能力和统一确认路径。最终路由形式以现有 API 风格为准；应用自身路由不得包含 Token。官方出站 API 请求的 Token 路径冲突按 §2.3 的安全门处理。

### 7.2 入站事件契约（示意）

```json
{
  "platform": "telegram",
  "channel_id": "<UserBot.id>",
  "owner_user_id": "<Gugu user id>",
  "chat_type": "group",
  "chat_id": "<Telegram chat.id>",
  "platform_user_id": "<Telegram User.id or null>",
  "platform_event_id": "<Update.update_id>",
  "message_id": "<Message.message_id>",
  "message_thread_id": null,
  "display_name": "<first_name + optional last_name>",
  "text": "<normalized message text>",
  "bot_mentioned": false,
  "reply_to_message_id": null
}
```

真实样例、token、个人 ID、群 ID 和消息正文不得写入文档或普通日志。字段缺失应由 Pydantic/协议校验明确处理，不得静默伪造默认身份。

## 8. 验收标准

### 8.1 安全与接入

- 有效 Token 能添加；无效 Token、Bot ID 冲突、Webhook 冲突给出安全且可操作的错误；失败不创建半成品记录。
- Token 只落加密字段，列表/错误/普通日志/子进程 argv 均无明文。
- 替换 Token 验证失败时原 Bot 仍可运行；有效替换触发旧进程退出、新进程启动。
- owner 绑定 code 单次、限时、绑定到当前 Gugu 用户和 Telegram Bot；重放或其他 Bot 使用失败。

### 8.2 群聊与权限

- 新 Telegram Bot 群开关默认为关闭；开启后 Telegram 群路由能分别生成稳定会话。
- 两个 Bot 的同群、同 Bot 的两个群以及 QQ/Telegram 相同数值 `chat_id` 均不会共享 session、工具上下文、记忆或取消信号。
- Privacy Mode 开启时，测试确认 Bot API 可见事件按事实处理，UI/文档不暗示普通 @ 必定可达；关闭 Privacy Mode 后普通群消息可按 Gugu 回应策略工作。
- 只有绑定 owner 的精确 Telegram `User.id` 获得 owner 身份；username 变更、username 缺失、同名用户、匿名管理员、频道 sender 都不会升权。
- `reply_mentions`、`reply_all`、`record_only` 和 `group_read_enabled` 的组合有行为测试；成员与 unknown 始终受服务端白名单限制。
- 群 `/stop`/`/cancel` 只终止相同 Bot+群的运行；其他群、其他平台和私聊不受影响。

### 8.3 消息和恢复

- 同一 `update_id` 重投不会重复创建 Agent run；队列投递失败不提前确认该 Update。
- MarkdownV2 特殊字符、链接、代码段、代码围栏和拆分边界均有发送测试；不支持的结构可读且不造成 API parse error。
- 支持的图片/文件能经过大小与类型校验进入附件暂存；恶意/过大/无权限资源明确失败并通过脱敏日志排查。
- Bot API 429 按 `retry_after` 等待；网络断线、进程重启和 SIGTERM 后能恢复或明确报告待处理状态。
- 发送错误不丢失 Agent 最终回答；禁止因不确定 API 结果而无界重复发送。

### 8.4 回归与真实平台验收

- 后端目标测试覆盖 Gateway、连接管理、权限/路由、格式和媒体；运行 IM 相关回归测试与完整后端测试。
- 前端运行 Profile 接入测试、typecheck 与 lint/build。
- 使用独立测试 Bot 和测试群完成真实平台验收：私聊、群命令、Bot 回复、普通群消息可见性、仅触发/只记录、owner/member 权限、取消、Markdown、文件发送/接收、重启去重。
- 不使用生产 Bot Token 做单测；真实测试日志不得包含消息正文、Token、原始用户/群 ID。

## 9. 实施计划与完整 TODO

| 阶段 | 内容 | 完成门槛 |
|---|---|---|
| Phase 0：冻结契约与测试 | 核验官方 API、统一事件 schema、群安全默认和投递幂等；先加跨平台回归测试 | 安全不变量、失败语义、跨平台隔离有测试约束 |
| Phase 1：连接与私聊 | Token 验证、Gateway 长轮询、私聊文本、owner 绑定、回复/取消、基本格式、设置页接入 | 独立测试 Bot 私聊端到端通过，Token 全链路安全 |
| Phase 2：群安全与权限 | 群设置 UI/API、消息可见性说明、owner/member/unknown、群上下文/记忆、工具白名单 | Privacy Mode 两种设置及权限矩阵通过真实群验收 |
| Phase 3：消息拓展 | 图片/文件、引用、消息分片、限流/重启恢复 | 每个声明支持的媒体类型均有行为测试和真实平台验收 |
| Phase 4：回归与交付 | OpenAPI 类型、完整回归、文档、安全审查和交付复查 | V1 验收标准与文件清单逐项复核完成 |
| Phase 5：独立后续评估 | Rich Messages、流式草稿、forum topic | 单独评审；不阻塞 V1 完成，不得把未实现项标记为支持 |

### Phase 0：契约与回归基线

- [x] 复核官方 Bot API 10.3、`getMe`、`getUpdates`、`getWebhookInfo`、媒体限额、MarkdownV2 与 429 `retry_after`；只采用官方文档确认的字段和行为。Bot API 10.1 Rich Messages 和 Bot-to-Bot 能力不纳入 V1。
- [x] 冻结接入接口、`UserBot` 字段映射和入站事件 schema；Telegram 新 Bot 的 `group_chat_enabled` 默认关闭，不继承 Feishu nullable 默认行为。
- [x] 冻结长轮询游标：以 Gugu `UserBot.id` 作为 Redis Bot 作用域；Lua 原子执行 Stream `XADD`、`(bot_id, update_id)` 去重标记和游标更新；只有本次返回的 Update 全部可靠入队后才在下次请求使用 `offset=last_enqueued_update_id+1`。Update 去重保留 48 小时、游标保留 6 天；游标过期时不传 offset，以兼容 Telegram 一周无更新后随机重置 update_id 的规则。任何队列/Redis 错误都不得推进 offset。
- [x] 明确首期不支持 forum topic 独立 session、全量群成员枚举、Rich Messages streaming；不在 API/UI 承诺这些能力。
- [x] 为平台 source/session 隔离、匿名 sender 权限、群开关默认值、跨平台相同外部 ID 不串数据建立行为测试；测试使用合成数据。
- [x] 测试经仓库内存数据库与假 Redis 基座隔离，只使用合成 Bot Token、用户 ID、群 ID 和消息；不读取或写入 `backend/.env`、`backend/config.override.json`。

### Phase 1：Token 接入、Gateway 与私聊闭环

- [x] 开始本阶段前，解决 Telegram 官方“Token 必须位于 HTTPS 请求路径”与仓库禁止凭据进入 URL 的规则冲突；用户仅批准固定官方主机的 HTTPS 请求路径例外，禁用重定向且完整 URL 不记录、不持久化、不传播。
- [x] 新增 `backend/app/services/telegram_bot_api.py`：仅请求固定官方 HTTPS 主机，禁用重定向；异常不携带 Token、请求 URL 或响应正文。
- [x] Telegram Bot API 在管理员启用后端代理时显式复用配置代理且不回退直连；管理员页面明确该代理适用范围，网页抓取原有 DoH、IP 钉扎及 SSRF 防护不变；代理配置失败时有 fail-closed 回归测试。
- [x] 新增 `backend/agent/im/parsers/telegram.py`：解析普通文本、命令实体、`/command@username`、文本提及与回复；未知/匿名 sender 不伪造 user ID，媒体消息在 Phase 1 不触发空生成。
- [x] 新增 `backend/app/api/v1/telegram_connect.py`：实现 Token 验证、`getMe` 元数据读取、Bot ID 唯一性、Webhook 冲突拒绝、Bot 创建/Token 轮换及一次性绑定码接口；错误信息不泄露原异常/Token。
- [x] 修改 `backend/app/main.py` 注册 Telegram connect router，并覆盖鉴权、CSRF（如适用）和用户数据所有权。
- [x] 修改 `backend/app/api/v1/user_bots.py`：允许 Telegram Bot 读取/更新/删除其自身设置；按 platform 校验群聊开关字段；群策略只修改当前用户自己的 Telegram Bot。
- [x] 修改 `backend/agent/gateway/gateway.py` 注册 Telegram module 和环境变量注入；Token 不进入 argv、heartbeat、普通日志或 Redis payload。
- [x] 新增 `backend/agent/gateway/telegram.py`：实现异步 Bot API 调用、长轮询、`getMe`/Webhook 状态检查、Update 归一化、入队、Redis 游标恢复、重复 Update 幂等、429 `retry_after`、网络退避、SIGTERM 收尾和脱敏诊断。
- [x] 修改 `backend/agent/im/models.py` 注册 Telegram source/chat 类型和 payload 约束；保持 `private→c2c`、`group/supergroup→group` 口径清晰。
- [x] 修改 `backend/agent/im/session.py`、`backend/agent/im/context_policy.py`、`backend/agent/im/context_loader.py` 纳入 Telegram source；验证同群跨 Bot、跨群、跨平台严格隔离。
- [x] 修改 `backend/agent/im/actor.py`：按 `(telegram, bot_id, User.id)` 解析 owner/member；缺 ID、匿名管理员、sender_chat 固定为 unknown。
- [x] 修改 `backend/agent/im/loop.py`、`backend/agent/im/replies.py`：完成私聊文本收发、回复路由、超长消息分片、`/bind` 前置处理、`/stop`/`/cancel` 范围隔离和 Telegram 出站分派；不走 QQ/飞书专属发送分支。附件收发与 `files.py` 集成留在 Phase 3，不提前声明媒体支持。
- [x] 新增 `backend/agent/im/telegram_format.py`：实现 MarkdownV2 特殊字符转义、基础格式转换和按 UTF-16 长度安全分片；不改变 QQ/Feishu/WeChat 的共享格式语义。
- [x] 修改 `frontend/src/services/api.ts` 增加 Token 接入/轮换 API 客户端；不在 URL 或前端日志中携带 Token。
- [x] 修改 `frontend/src/components/common/profile/ProfileImPane.vue` 增加 Telegram Bot 接入表单、Token 替换和 Bot 信息展示；避免 Token 回显，绑定状态通过 `im_channels` 实时事件刷新。
- [x] 修改 `frontend/src/i18n/sections/common.ts` 增加简中、日文、英文接入说明、Privacy Mode 提示、Webhook 冲突、Token 错误和绑定说明。
- [x] 新增/扩展 `backend/tests/test_telegram_message_parser.py`、`backend/tests/test_telegram_gateway.py`、`backend/tests/test_telegram_connect.py` 覆盖 parser、长轮询/offset、重复事件、连接授权、加密字段、轮换原子性、Webhook 冲突、owner code 防重放和秘密脱敏。
- [x] 扩展 `frontend/tests/profile/ProfileImPane.test.ts` 覆盖接入、Token 不回显、Token 验证失败、取消路径和绑定状态事件刷新。
- [x] 运行后端 Telegram/IM 定向回归、前端 Profile 与表单规范测试、i18n 扫描和 typecheck。
- [x] 用户绑定成功后发布 `im_channels` 状态事件；设置页订阅并补刷权威 Bot 状态，不使用固定频率的绑定状态轮询。
- [x] 用户确认测试 Bot 的私聊与群聊基本文本对话可用。
- [ ] 使用独立测试 Bot 验收 owner 绑定、取消、进程重启后的 Update 去重与配置轮换。

### Phase 2：群消息、策略、身份与记忆

- [x] 修改 `backend/agent/im/permissions.py`：Telegram 读取独立 UserBot 行的 `group_chat_enabled`，新连接默认关闭；不将平台权限可见性误当作 Gugu 群策略开关。
- [x] 修改 `backend/worker.py`：将 Telegram 群载荷接入 group owner/member/unknown、取消作用域、群记忆和工具过滤准备链路；确认 owner 角色只能来自已绑定 Telegram 数值 ID。
- [x] 修改 `backend/app/services/group_context.py`：查询接受 Telegram platform，并将条件限制到 `platform + bot_id + chat_id`；保留原 QQ/Feishu 行为。
- [x] 修改 Telegram parser：测试隐私模式下可见命令、显式 Bot 命令、有效 @、直接回复 Bot 和转发给其他 Bot 的命令；普通 @ 不可见时不得虚报已触发。
- [x] 修改 `frontend/src/components/common/profile/ProfileImPane.vue` 增加 Telegram 群开关、回应模式、只记录/上下文读取、记忆和工具白名单设置；说明关闭 Privacy Mode 或 Bot 管理员权限是普通群消息可见前提。
- [x] 修改 `frontend/src/i18n/sections/common.ts` 完成群策略说明与所有状态文案三语覆盖。
- [x] 新增 `backend/tests/test_telegram_im_policy.py` 覆盖群开关默认关闭、reply_all/reply_mentions/record_only、group_read_enabled、工具白名单、owner 群记忆开关、匿名 sender 不升权、跨 Bot/跨群 session 和取消隔离。
- [x] 扩展 `backend/tests/test_im_permissions_types.py`、`backend/tests/test_im_protocol.py` 或对应现有测试，验证新增平台不改变 QQ、Feishu、WeChat 已有策略。
- [x] 用户确认真实群基本消息收发可用。
- [ ] 真实群验收 Privacy Mode 开启与关闭两种状态；分别验证命令、回复、普通文本、普通 @ 的实际事件可见性，并记录只含脱敏状态的验收结果。
- [ ] 真实群验收 owner/member/unknown 权限、只响应触发、只记录、群记忆、成员记忆、群上下文搜索和 `/stop`/`/cancel` 的 Bot+群作用域。

### Phase 3：媒体、引用与稳态恢复

- [x] 新增 `backend/agent/im/media_ingress_telegram.py`，实现 Telegram file_id 获取、固定官方文件主机下载、MIME/大小校验及统一附件暂存；修改 `backend/agent/im/media_ingress.py` 注册平台分派。
- [x] 修改 `backend/agent/im/parsers/telegram.py` 解析 Telegram 图片、文件、音频、语音和视频节点；媒体消息进入正式队列前保留 file_id、caption 和消息回复关系。
- [x] 修改 `backend/agent/im/media_ingress.py`、`backend/agent/im/replies.py`、`backend/agent/im/files.py` 接入 Telegram 附件；附件仍经过用户归属检查，下载使用有界内存，不创建未清理的临时文件。
- [x] 在 `backend/agent/gateway/telegram.py` 实现图片/文件发送和接收；限制单文件下载 20 MB、发送 50 MB，处理 429 Retry-After、请求失败和无效 file_id。
- [x] 支持 reply_to_message 文本引用；引用附件只复用当前用户在同 Bot、同群/私聊来源消息中已保存的附件，不调用任意历史检索。
- [x] 将语音/音频/视频附件接入现有通用媒体理解链路；实际理解能力取决于所选模型及服务器媒体处理能力，不承诺所有类型均可识别。
- [x] 新增 `backend/tests/test_telegram_media.py` 覆盖文档媒体下载暂存、非法 MIME、超限、API 失败、用户归属和引用附件复用边界。
- [x] 定向验证长文本分片、MarkdownV2 边界、按 Bot 与会话的 Telegram 限流、429 Retry-After、网络/Redis 暂时失败重连、SIGTERM 停止信号与游标恢复。
- [ ] 真实测试群验收文件收发、图片入站、引用文本、允许的引用附件、消息分片和限流状态；日志必须完成秘密及个人标识审查。

### Phase 4：前端类型、回归、文档和交付

- [ ] 运行 OpenAPI 类型生成命令更新 `frontend/src/types/api.ts`；检查生成差异，不手工伪造 schema。当前生成结果相对已跟踪文件包含大量 Telegram 之外的 API 漂移，需单独审阅后再纳入，避免混入其他接口变化。
- [x] `CHANGELOG.md` 已增加 Telegram 私聊/群聊接入说明，并明确暂不支持频道。
- [x] Telegram/IM 定向测试 97 项通过；Profile 与聊天接入前端测试 9 项通过；前端 typecheck 和生产 build 通过。
- [ ] 全量回归仍未通过：后端 4242 项通过、2 项失败（文件同步库存与全局搜索测试触发 `files.user_id, files.storage_key` 唯一约束）；前端 712 项通过、1 项失败（日文缺少现有 `filesyncAdmin.queueAll*` 翻译键）。全量测试期间测试文件发生暂存重排，工作区稳定后需重跑确认。
- [x] 检查 Telegram 实现与文档未发现真实 Token、用户/群标识、消息正文、机器地址或凭据；Token 格式命中仅为测试中的合成 fixture，错误与诊断路径按 `fingerprint()`/`redact()` 约定处理。
- [ ] 逐项回看 §8 验收标准和 §6 文件清单；未实现的能力留在 Phase 4 后续项或明确标为不支持，不能勾选 V1 完成。
- [ ] 功能验收后更新本 PRD 顶部状态、完成日期和各 TODO 状态；只在用户要求或符合仓库提交时机时提交，不擅自部署或触发 GitHub CI。

### Phase 5：独立后续评估（不阻塞 V1）

- [ ] 调研并验证 Bot API 10.1 Rich Messages 与目标 Telegram 客户端对 GFM 表格/引用/公式的实际渲染。
- [ ] 验证流式草稿接口在私聊和群聊的行为、编辑频率限制、恢复语义及失败时重复消息风险。
- [ ] 评估 forum topic 的会话隔离键、回复路由和现有 session schema；需要数据库字段时另行提出迁移方案。
- [ ] 每项能力单独补充范围、API 限制、测试和文件清单，经评审后才从“后续”转为实现范围。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 用户误以为普通 @ 一定能唤起 Bot | 接入和群设置页明确 Privacy Mode 约束；先以实际 Update 可见性验证 |
| Bot Token 泄露或被覆盖 | encrypted field、全链路不打印、Token 替换先验证、接口掩码、测试合成凭据 |
| 官方 API 必须把 Token 放入请求路径 | 仅在固定官方主机的 HTTPS 请求中短暂携带；禁用重定向，完整 URL 不记录、不持久化、不传播；应用路由及其他主机仍禁止 Token 入 URL |
| 长轮询重启造成重复/丢消息 | 入队成功再推进 offset；`update_id` 幂等；记录 last acknowledged offset 和可观测积压 |
| Telegram ID/用户名混淆导致串人或升权 | user/chat/bot ID 分字段；所有授权只用数值平台 ID + Bot 作用域 |
| Telegram 限流导致消息重复或乱序 | 统一发送节奏、按 `retry_after` 退避、单次发送幂等策略和可见失败状态 |
| 新 Bot API/SDK schema 滞后 | 首期使用官方 HTTPS API 与现有异步 HTTP 客户端；Rich API 单独验证，不依赖 SDK 当前是否生成对应类型 |
| 群策略字段语义被跨平台误用 | Telegram 新 Bot 默认关闭，策略按 UserBot 行隔离；后端 platform 校验与回归测试覆盖 |

## 11. 官方资料

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Bots FAQ：Bot 能收到哪些群消息、长轮询与 Webhook](https://core.telegram.org/bots/faq)
- [Telegram Bot Features：Privacy Mode、命令和消息格式](https://core.telegram.org/bots/features)
- [Telegram Bot API Changelog](https://core.telegram.org/bots/api-changelog)
- [Telegram 官方列出的 Bot API 社区库示例](https://core.telegram.org/bots/samples)

> 本 PRD 描述目标设计而非已完成能力。官方资料于 2026-10-08 复核；平台 API 可能演进，后续阶段以当时官方文档复核为准。
