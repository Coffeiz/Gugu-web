# IM 会话复用与消息窗口裁剪 PRD

> 状态：✅ 已实施（Phase 1～5 代码完成，测试通过；消息物理保留已扩展为所有会话通用）
> 创建：2026-08-06
> 最近更新：2026-08-24
> 关联模块：`backend/app/services/conversation_retention.py`、`backend/agent/im/session.py`、`backend/agent/im/loop.py`、`backend/agent/im/owner_session.py`、`backend/agent/runner.py`、`backend/agent/gateway/web.py`、`backend/app/scheduled_tasks.py`、`backend/app/models/__init__.py`
> 关联文档：[`【已完成】PRD-IM-2-im-loop与gateway解耦.md`](./【已完成】PRD-IM-2-im-loop与gateway解耦.md)、[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)、[`21-群聊消息架构.md`](../../agent/21-群聊消息架构.md)

> 上下文预算、baseline 增量读取、provider overflow 压缩和 retry 统一以
> [`PRD-AGENT-4：统一 ContextBudget 上下文压缩重构`](./PRD-AGENT-4-统一ContextBudget上下文压缩重构.md)
> 为准。本文只保留 IM 会话复用、物理保留和渠道适配规则，不再定义独立的消息窗口预算。

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1：会话复用 | ✅ 已完成 | `session_scope_filters` 扩展 `platform_user_id`；`get_or_create_session` 作用域复用；新建 session 补写 `platform_user_id`；`_im_continuity_bridge` 传 `platform_user_id` |
| Phase 2：消息窗口裁剪 | ✅ 已完成 | `conversation_retention` 提供跨平台统一规则（600 阈值裁到 500）；Web、IM、流式/非流式 runner、主动消息统一在完整持久化后触发 |
| Phase 3：读取窗口统一 | ✅ 已完成 | `_history_query_limit` 私聊从 40 提到 50 |
| Phase 4：定时任务归并 | ✅ 已完成 | `_persist_push_im` 修 Redis key 格式、复用所属 session，并调用跨平台 `conversation_retention`；主动推送与 Web/IM 普通消息共用 600→500 规则 |
| Phase 5：测试 | ✅ 已完成 | 新增 `test_im_session_reuse.py`（9 用例）；更新群聊裁剪测试；完整后端套件 714 通过 |

## 0. 背景与问题

### 0.1 现状：IM 会话碎片化，上下文断裂

当前 IM 会话的创建依赖 Redis 缓存，生命周期短，导致同一私聊/群会反复新建 `conversation_sessions` 记录：

- **私聊**：session 唯一性依赖 Redis 绑定 `im:owner-session:{user_id}:{platform}:{puid}`（[owner_session.py](backend/agent/im/owner_session.py#L150-L158)）。普通私聊用户从未绑定 Web session → Redis 无值 → `get_or_create_session` 直接新建（[session.py](backend/agent/im/session.py#L137-L181)）。
- **群聊**：session 唯一性依赖 Redis key `imsession:{platform}:{bot_id}:{scope_id}`（[session.py](backend/agent/im/session.py#L72)），有 12h 滑动 TTL，过期后也会新建。

**后果**：
1. 同一 peer 的对话被拆到多个 session，咕咕"失忆"，要靠 `_im_continuity_bridge`（[runner.py](backend/agent/runner.py#L180-L229)）打补丁去"猜"上一条对话。
2. 数据库堆积大量碎片 session，`max_sessions=50` 上限频繁触发，旧 session 被静默删除。
3. 定时任务推送会新建临时 session，且 `_persist_push_im` 用的 Redis key 是**旧格式**（`imsession:{platform}:{puid}`，2 段），根本路由不到新格式 session（`imsession:{platform}:{bot_id}:{scope_id}`，3 段）——**独立 bug**，定时任务推送的上下文丢失。

### 0.2 目标

1. **每个私聊/群只对应一个 session**：私聊按 `(source, bot_id, platform_user_id)` 复用，群聊按 `(source, bot_id, chat_id)` 复用，不再每次新对话都新建。
2. **数据库每个 session 只保留最近 500 条消息**（物理裁剪，Web、IM、定时任务等所有会话来源一致）。
3. **上下文读取窗口统一为 50 条**（私聊从 40 条提升到 50 条，与群聊一致）。
4. **裁剪阈值 600 条**：消息数超过 600 才裁剪到 500，避免每轮都做 DELETE。该规则是会话级策略，不按平台分叉。
5. **定时任务投递归并到所属 peer 的 session**，并修复 `_persist_push_im` 的 Redis key 格式 bug；推送写入后使用公共会话保留服务。

## 1. 方案设计

### 1.1 会话复用：`get_or_create_session` 增加作用域查找

**改动点**：[session.py](backend/agent/im/session.py#L137-L181) 的 `get_or_create_session`。

当前逻辑：`request.session_id` 为空时直接新建。改为：`request.session_id` 为空时，先按作用域查已有 session，命中则复用。

```python
async def get_or_create_session(db, request, user_id, max_sessions: int = 50) -> SessionState:
    session = None
    if request.session_id:
        session = (await db.execute(
            select(ConversationSession).where(
                ConversationSession.id == request.session_id,
                ConversationSession.user_id == user_id,
                *session_scope_filters(
                    ConversationSession,
                    request.source,
                    request.chat_id,
                    getattr(request, "platform_bot_id", None),
                    getattr(request, "platform_user_id", None),
                ),
            )
        )).scalars().first()
    if session is None:
        # 新增：按作用域复用已有 session（私聊按 platform_user_id，群聊按 chat_id）
        session = (await db.execute(
            select(ConversationSession).where(
                ConversationSession.user_id == user_id,
                *session_scope_filters(
                    ConversationSession,
                    request.source,
                    request.chat_id,
                    getattr(request, "platform_bot_id", None),
                    getattr(request, "platform_user_id", None),
                ),
            ).order_by(ConversationSession.updated_at.desc()).limit(1)
        )).scalars().first()
    if session:
        return SessionState(session, False)
    # ... 原有新建逻辑 ...
```

**关键点**：
- 复用查找必须带 `user_id` 归属过滤，避免跨用户串用。
- 复用查找按 `updated_at` 倒序取最新一条，处理存量重复 session。
- 复用查找只在 `request.source in IM_SOURCES` 时生效（Web 会话不参与，避免误复用）。

### 1.2 `session_scope_filters` 扩展支持 `platform_user_id`

**改动点**：[session.py](backend/agent/im/session.py#L86-L96)。

当前签名 `(model, source, chat_id, bot_id)`，私聊时 `chat_id=None` 生成 `chat_id.is_(None)`，无法区分不同私聊对象。扩展为：

```python
def session_scope_filters(model, source, chat_id, bot_id=None, platform_user_id=None):
    if source not in {"feishu", "qq", "wechat"}:
        return []
    filters = [
        model.source == source,
        model.bot_id == bot_id if bot_id else model.bot_id.is_(None),
    ]
    if chat_id:
        filters.append(model.chat_id == chat_id)
    elif platform_user_id:
        filters.append(model.platform_user_id == platform_user_id)
    else:
        filters.append(model.chat_id.is_(None))
    return filters
```

**注意**：`_im_continuity_bridge`（[runner.py](backend/agent/runner.py#L180-L229)）也调用 `session_scope_filters`，私聊时需传入 `platform_user_id`，避免匹配到所有私聊 session。

### 1.3 消息窗口裁剪：跨平台统一 `conversation_retention`

**改动点**：[conversation_retention.py](../../../../backend/app/services/conversation_retention.py)。

物理保留策略不属于 QQ、群聊或任何单一入口，由公共服务统一负责计数、裁剪和
消息附件清理。`agent/im/session.py` 只保留兼容包装，旧调用方无需立即迁移。

```python
MESSAGE_RETENTION_LIMIT = 500   # 每个 session 物理保留上限
MESSAGE_TRIM_THRESHOLD = 600    # 超过该条数才触发裁剪（避免每轮 DELETE）
GROUP_CONTEXT_LIMIT = 50        # IM 上下文读取窗口，不是物理保留规则

async def trim_session_messages(session_id, limit=MESSAGE_RETENTION_LIMIT,
                                threshold=MESSAGE_TRIM_THRESHOLD):
    """消息数超过 threshold 时，物理裁剪到最近 limit 条。"""
    # 先 count，超过 threshold 才执行 DELETE
    # 保留最近 limit 条，删除更旧的
```

**兼容**：IM 入口保留 `trim_session_messages` 包装，避免破坏已有调用方和测试；实际默认阈值只在公共服务维护。

**触发点**：
1. `run_collect` / `run_stream` 在完整持久化 assistant/tool turn 后裁剪。
2. Web 命令回复和普通生成落库后裁剪。
3. `persist_im_session`、`record_passive_im_message` 等 IM 写入路径裁剪。
4. `_persist_push_im` 定时任务推送后裁剪。

所有触发点都在当前写入事务提交后执行，不会在 provider round 中途裁剪；重复触发只做一次轻量条数检查。

### 1.4 上下文读取窗口统一为 50 条

**改动点**：[runner.py](backend/agent/runner.py#L38-L43) 的 `_history_query_limit`。

```python
def _history_query_limit(request: AgentRequest) -> int:
    """IM 会话（私聊/群聊）从保留池取最近 50 条，Web 会话沿用原窗口。"""
    if request.source in IM_SOURCES:
        return GROUP_CONTEXT_LIMIT
    return tokens.HISTORY_MAX_MSGS
```

**影响**：私聊读取窗口从 40 提升到 50。`select_history` 仍按 token 预算（`HISTORY_TOKEN_BUDGET=3000`）二次裁剪，实际进入上下文的条数受 token 限制，50 只是 DB 查询上限。

### 1.5 定时任务投递归并 + Redis key 格式修复

**边界说明**：定时任务按渠道分两类，只有 **IM 渠道**（feishu/qq/wechat）会创建/复用 session：

- **web 渠道**（`{"web", "chat"} & chans`）：走 `_ev.publish(uid, notification=...)` 发网页弹窗/提醒，**不创建 session**，也不调 `_persist_push_im`（[scheduled_tasks.py](backend/app/scheduled_tasks.py#L330-L340)）。用户从弹窗点进去走的是 web 端 GuguChat 的 `source="web"` session，属另一套逻辑，**不在本 PRD 范围内**。
- **IM 渠道**：`_deliver_im` 发送成功后，才调 `_persist_push_im` 把推送写进 IM 会话历史（[scheduled_tasks.py](backend/app/scheduled_tasks.py#L385-L392)）。**本节的改动只针对 IM 渠道。**

**改动点**：[scheduled_tasks.py](backend/app/scheduled_tasks.py#L408-L460) 的 `_persist_push_im`。

1. **修复 Redis key 格式**：`imsession:{platform}:{puid}`（2 段）→ `imsession:{platform}:{bot_id}:{scope_id}`（3 段），与 [session.py](backend/agent/im/session.py#L72) 的 `session_key()` 一致。
2. **复用所属 session**：从 `delivery_targets` 带上 `bot_id` 和 `scope_id`（私聊 `scope_id=puid`，群聊 `scope_id=chat_id`），优先复用所属 peer 的 session，而不是新建临时会话。
3. **推送后裁剪**：调用 `trim_session_messages`，避免长会话里推送消息无限累积。

**配套**：`_resolve_delivery_targets`（[scheduled_tasks.py](backend/agent/tools/scheduled_tasks.py#L60-L100)）和 `owner_private_targets`（[scheduled_tasks.py](backend/app/scheduled_tasks.py#L567-L590)）需在 `delivery_targets` 里补 `bot_id` 字段。

### 1.6 群聊被动记录复用查找（已有模式，确认覆盖）

`record_passive_im_message`（[loop.py](backend/agent/im/loop.py#L300-L310)）已有按 `(user_id, source, bot_id, chat_id, chat_type="group")` 回查数据库复用的逻辑。本方案需确认：
- 群聊主动消息（走 `get_or_create_session`）与被动记录（走 `record_passive_im_message`）是否命中同一个 session。
- 私聊是否也需要类似的"Redis miss 时回查数据库"兜底。

## 2. 改动点清单

| 文件 | 改动 |
|---|---|
| `backend/app/services/conversation_retention.py` | 新增跨平台会话物理保留服务、统一阈值和附件清理 |
| `backend/agent/im/session.py` | 常量改为公共服务导出；保留兼容包装；`session_scope_filters` 扩展 `platform_user_id`；`get_or_create_session` 增加作用域复用 |
| `backend/agent/im/loop.py` | `persist_im_session` 私聊分支新增裁剪；`record_passive_im_message` 改用新函数 |
| `backend/agent/runner.py` | `_history_query_limit` 私聊窗口改 50；`_im_continuity_bridge` 传 `platform_user_id` |
| `backend/app/scheduled_tasks.py` | `_persist_push_im` 修 key 格式 + 复用所属 session + 裁剪；`owner_private_targets` 补 `bot_id` |
| `backend/agent/tools/scheduled_tasks.py` | `_resolve_delivery_targets` 补 `bot_id` |
| `backend/alembic/versions/` | 新增迁移：合并存量重复 session（可选） |
| `backend/tests/` | 新增/更新测试 |

## 3. 迁移与兼容

### 3.1 存量重复 session

同一 peer 可能已有多个 session。处理策略：
- **新消息**：复用查找按 `updated_at` 倒序取最新，新消息写入最新 session，旧 session 自然闲置。
- **可选迁移脚本**：合并同一 `(user_id, source, bot_id, chat_id/platform_user_id)` 的多个 session，把 `ConversationMessage` 迁移到最新 session，删除空 session。**建议先不合并**，观察复用后旧 session 是否自然淘汰，避免迁移风险。

### 3.2 存量超长 session

复用后，存量私聊 session 可能超过 500 条。处理策略：
- 任意会话来源首次触发裁剪时（消息数 > 600）自动裁到 500。
- 不主动对存量做一次性裁剪，避免影响线上。

### 3.3 常量重命名兼容

IM 入口的 `trim_session_messages` 包装保留为兼容层，默认值从公共服务读取，避免再次形成 QQ 专用规则。

## 4. 测试计划

### 4.1 单元测试

| 用例 | 断言 |
|---|---|
| 私聊复用：同一 `(source, bot_id, platform_user_id)` 发两条消息 | 命中同一 session，`is_new=False` |
| 群聊复用：同一 `(source, bot_id, chat_id)` 发两条消息 | 命中同一 session |
| 不同私聊对象隔离 | 不同 `platform_user_id` 不串用 |
| 不同 bot 隔离 | 不同 `bot_id` 不串用 |
| `session_scope_filters` 私聊带 `platform_user_id` | 只匹配该私聊对象 |
| `trim_session_messages` 超过 600 条 | 裁到 500 条 |
| `trim_session_messages` 未超过 600 条 | 不执行 DELETE |
| `_persist_push_im` 写入后 | session 不超过 500 条，Redis key 为新格式 |

### 4.2 回归测试

- `test_qq_group_history.py`：群聊 500 条裁剪，改用新函数后仍通过。
- `test_im_conversation_key.py`、`test_im_identity.py`：session 作用域隔离。
- 定时任务投递相关测试。

### 4.3 E2E / 人工验收

- 私聊连续对话，确认上下文连续（不"失忆"）。
- 私聊发 600+ 条消息，确认数据库裁剪到 500。
- 定时任务推送后，用户回复能路由到同一 session，上下文带上推送内容。
- 群聊被动记录 + 主动 @ 回复，确认命中同一 session。

## 5. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 复用后私聊上下文无限累积 | 话题漂移、token 超限 | 500 条物理裁剪 + 50 条读取窗口 + token 预算裁剪兜底 |
| 存量重复 session 合并 | 数据丢失 | 先不合并，靠 `updated_at` 倒序自然淘汰 |
| `_im_continuity_bridge` 失效 | 复用后"上一条对话"就是当前 session，桥接逻辑可能误判 | 复用后 `current_session_id` 就是上一条，桥接自然跳过；需验证 |
| 定时任务投递目标缺 `bot_id` | 复用查找失败 | `_resolve_delivery_targets` 补字段 |
| 裁剪 DELETE 性能 | 每轮 DELETE 开销 | 600 条阈值，超过才裁 |

**回滚**：改动集中在 `get_or_create_session`、`trim_session_messages`、`_persist_push_im`，均为可独立回滚的提交。常量重命名保留别名，回滚不破坏引用。

## 6. 实施顺序

1. **Phase 1**：`session_scope_filters` 扩展 `platform_user_id` + `get_or_create_session` 作用域复用（私聊 + 群聊）。
2. **Phase 2**：`trim_session_messages` 泛化 + 600 阈值 + 私聊/群聊/被动记录触发点。
3. **Phase 3**：`_history_query_limit` 私聊窗口改 50。
4. **Phase 4**：`_persist_push_im` 修 key 格式 + 复用所属 session + 裁剪；`delivery_targets` 补 `bot_id`。
5. **Phase 5**：测试补齐 + 人工验收。
