# PRD-IM-2 Phase 5 代码审查报告

> 审查日期：2026-08-04  
> 范围：IM Loop 与 Gateway 解耦 Phase 5（会话隔离、身份边界、worker 编排、Loop 与回复层）  
> 结论：✅ 已完成，可进入 Phase 6 的群组/成员记忆设计

## 1. 结论摘要

Phase 5 的目标已落地：IM 请求现在以 `platform + bot_id + chat_type + scope_id` 作为统一路由范围；数据库会话、Redis 防抖/锁、owner session 绑定和消息身份字段不再跨 Bot 或跨群串用。`worker.py` 已降为队列生命周期层，业务编排由 `agent/im/loop.py` 统一负责。

三类身份都经过同一套 `ActorContext` 与 `ImContextPolicy`：owner 可使用完整个人上下文，member/unknown 只使用群会话和最小工具白名单，不加载 owner 的项目、文件、日程、profile、pattern、memory，也不触发 owner memory reflection。

## 2. 分项审查

### 2.1 会话与数据库作用域

- `ImConversationKey`、`SessionRoute`、Redis session key 均包含 `bot_id`。
- `ConversationSession.bot_id` 与 `ConversationMessage.platform_bot_user_id` 已有模型字段和 Alembic 增量迁移。
- owner 私聊绑定 key 与数据库校验均包含 Bot 作用域；显式绑定 Web session 前会校验来源和归属。
- 被动群记录在写入前重新校验 `user_id/source/bot_id/chat_id`，旧 Redis 路由不会把消息写入其他会话。

### 2.2 平台协议与身份映射

- QQ、飞书、微信统一进入 `PlatformMessage`，微信群 ID 统一为 `ChatTarget`。
- QQ 群事件优先使用稳定的 `user_openid`，避免把 `member_openid` 和 C2C 身份混用。
- Bot 的平台身份保存为 `UserBot.bot_platform_user_id`，消息保留 `platform_bot_user_id`，网页会话历史可以正确显示 `@咕咕`。
- 飞书连接时记录 owner `open_id`；微信群聊当前没有可靠的 owner 身份来源，因此固定降级为 `unknown`，属于平台能力限制。

### 2.3 权限和上下文边界

- `resolve_access()` 统一返回 owner/member/unknown 和工具白名单。
- `policy_for()` 是 runner 的唯一上下文开关；member/unknown 不读取个人资源，不做连续会话桥接，不做 memory reflection。
- 权限解析异常不会升级权限，统一降级到 `unknown + web_search`。
- 工具层仍使用现有资源归属校验，IM scope 不会绕过 owner 校验。

### 2.4 worker 与 Loop 职责

- `worker.handle()` 只调用 `dispatch_im_message()`；不再导入身份、权限、runner、文件发送或 Gateway 业务实现。
- `dispatch_im_message()` 统一处理协议归一化、身份准备、被动记录、shortcut、命令、typing/activity、runner 选择、session 写回和回复收尾。
- `OwnerAgentLoop` 与 `MemberAgentLoop` 共用 `agent.runner`，member loop 不复制模型/工具执行逻辑。

### 2.5 回复能力

- `PlatformReply` 声明文本、文件、图片、引用、Keyboard、流式能力并在发送前做平台 capability 检查。
- 文本、文件和流式 fallback 均由 `agent/im/replies.py` 负责平台分发；`agent/im/files.py` 只负责文件解析和限制。
- 飞书流式成功时只收尾附件，失败时由同一回复层补发文本，避免重复发送。

## 3. 自动验证

本次审查运行的核心回归集合：

```text
PYTHONPATH=. .venv/bin/pytest -q \
  tests/test_im_identity.py \
  tests/test_im_conversation_key.py \
  tests/test_im_owner_session.py \
  tests/test_qq_raw_ws.py \
  tests/test_im_protocol.py \
  tests/test_feishu_streaming.py
```

覆盖范围包括：三平台私聊/群聊归一化、跨群/跨 Bot 隔离、owner/member/unknown 权限、owner session 绑定、QQ raw WebSocket 身份、飞书流式失败 fallback、worker 只委托 Loop，以及 Bot 平台身份字段保留。

## 4. 遗留边界

- 微信群聊仍无法从平台事件可靠确认 owner，按最小权限处理；后续若平台提供稳定身份字段，再补绑定策略。
- `run_collect()` 与 `run_stream()` 的 token 消费循环不同，保留两处是为了支持飞书实时卡片；两者共享上下文策略、session、附件、持久化、反思和压缩收尾，不再复制业务权限逻辑。
- Phase 6 继续负责群组长期记忆的 namespace、可见范围和删除授权，不在本阶段扩展。

