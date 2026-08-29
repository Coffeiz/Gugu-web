"""RAG 查询前的 scope 规范化与匹配。"""
from __future__ import annotations

from collections.abc import Iterable

from agent.rag.models import IndexDocument, Scope

MAX_OWNER_GROUP_SCOPES = 3
MAX_MEMBER_GROUP_SCOPES = 3
MAX_GROUP_CHAT_CROSS_SCOPES = 2


def owner_scope(user_id: object) -> Scope:
    return Scope(owner_user_id=str(user_id), scope_type="owner")


def group_scope(user_id: object, platform: str, bot_id: str, group_id: str) -> Scope:
    return Scope(
        owner_user_id=str(user_id), platform=str(platform), bot_id=str(bot_id),
        group_id=str(group_id), scope_type="group", scope_id=str(group_id),
    )


def member_scope(
    user_id: object, platform: str, bot_id: str, group_id: str, platform_user_id: str,
) -> Scope:
    return Scope(
        owner_user_id=str(user_id), platform=str(platform), bot_id=str(bot_id),
        group_id=str(group_id), scope_type="member",
        scope_id=f"{str(group_id)}:{str(platform_user_id)}",
    )


def normalize_memory_scope(user_id: object, requested: str | Scope | None) -> Scope:
    """规范化工具查询 scope；内部自动召回可传入已完成 ACL 校验的 Scope。"""
    if isinstance(requested, Scope):
        if requested.owner_user_id != str(user_id):
            raise ValueError("记忆召回 scope 不属于当前用户")
        return requested
    value = (requested or "auto").strip().lower()
    if value not in {"auto", "private_memory"}:
        raise ValueError("当前记忆召回仅支持 auto 或 private_memory")
    return owner_scope(user_id)


def normalize_memory_scopes(user_id: object, requested: str | Scope | Iterable[Scope] | None) -> list[Scope]:
    """规范化一个检索请求的多个 scope，保持传入顺序（当前群优先）。"""
    if isinstance(requested, (str, Scope)) or requested is None:
        return [normalize_memory_scope(user_id, requested)]
    scopes = list(requested)
    if not scopes:
        return [owner_scope(user_id)]
    normalized = []
    seen = set()
    for scope in scopes:
        item = normalize_memory_scope(user_id, scope)
        if item.key() not in seen:
            normalized.append(item)
            seen.add(item.key())
    return normalized


async def resolve_memory_query_scopes(
    user_id: object,
    requested: str | Scope | None,
    *,
    im_context: dict | None = None,
    db=None,
) -> list[Scope]:
    """根据确定性的 IM 上下文解析显式 memory 工具的查询范围。

    这里不信任模型传入的群号或成员身份。群范围只从当前 IM context 和已落库的
    reflection cursor 推导；跨群范围仅在 ``all_my_groups`` 明确请求时开放，且
    member 只能匹配自己的 platform-user scope。
    """
    if isinstance(requested, Scope):
        return normalize_memory_scopes(user_id, requested)
    value = str(requested or "auto").strip().lower()
    if value not in {"auto", "current_group", "all_my_groups", "private_memory"}:
        raise ValueError("记忆召回 scope 只能是 auto、current_group、all_my_groups 或 private_memory")

    im = im_context or {}
    platform = str(im.get("platform") or "")
    chat_type = str(im.get("chat_type") or "")
    chat_id = str(im.get("chat_id") or "")
    bot_id = str(im.get("channel_id") or "")
    role = str(im.get("im_role") or "")
    platform_user_id = str(im.get("puid") or "")
    is_im = platform in {"qq", "feishu", "wechat"}
    is_group = is_im and chat_type == "group" and bool(chat_id and bot_id)

    if value == "private_memory":
        if is_im and (role != "owner" or chat_type == "group"):
            raise PermissionError("当前会话不能读取 owner 私人记忆")
        return [owner_scope(user_id)]

    if not is_im:
        return [owner_scope(user_id)]

    if value == "current_group" and not is_group:
        raise ValueError("current_group 只能在群聊中使用")

    if role == "owner" and not is_group:
        # Web/私聊默认允许 owner 查询自己的个人记忆和所属群记忆；群记忆通过
        # cursor 枚举，且后续统一服务仍执行 scope 过滤和结果预算。
        if value in {"auto", "all_my_groups"}:
            return [owner_scope(user_id), *await _stored_group_scopes(
                user_id, platform=platform or None, bot_id=bot_id or None, db=db,
                limit=MAX_OWNER_GROUP_SCOPES,
            )]
        return [owner_scope(user_id)]

    if not is_group and role == "member" and platform_user_id:
        if value in {"auto", "all_my_groups"}:
            return await _stored_member_scopes(
                user_id, platform=platform, bot_id=bot_id,
                platform_user_id=platform_user_id, db=db, limit=MAX_MEMBER_GROUP_SCOPES,
            )
        raise ValueError("current_group 只能在群聊中使用")

    if is_group:
        current = group_scope(user_id, platform, bot_id, chat_id)
        if role == "member":
            current_member = member_scope(user_id, platform, bot_id, chat_id, platform_user_id)
            scopes = [current, current_member]
        else:
            scopes = [current]
        if value == "all_my_groups":
            if role == "owner":
                scopes.extend(await _stored_group_scopes(
                    user_id, platform=platform, bot_id=bot_id, db=db,
                    exclude_group_id=chat_id, limit=MAX_GROUP_CHAT_CROSS_SCOPES,
                ))
            elif role == "member" and platform_user_id:
                scopes.extend(await _stored_member_scopes(
                    user_id, platform=platform, bot_id=bot_id,
                    platform_user_id=platform_user_id, db=db,
                    exclude_group_id=chat_id, limit=MAX_GROUP_CHAT_CROSS_SCOPES,
                ))
        return normalize_memory_scopes(user_id, scopes)

    # Unknown 私聊不能升级为 owner；没有当前群时只给空的安全范围。
    raise PermissionError("当前身份没有可用的记忆召回范围")


async def _stored_group_scopes(
    user_id: object, *, platform: str | None, bot_id: str | None,
    db=None, exclude_group_id: str = "", limit: int = 3,
) -> list[Scope]:
    if db is None:
        return []
    from sqlalchemy import select
    from app.models import MemoryReflectionCursor

    query = select(MemoryReflectionCursor).where(
        MemoryReflectionCursor.owner_user_id == user_id,
        MemoryReflectionCursor.scope_type == "group",
    )
    if platform:
        query = query.where(MemoryReflectionCursor.platform == platform)
    if bot_id:
        query = query.where(MemoryReflectionCursor.bot_id == bot_id)
    rows = (await db.execute(query.limit(max(1, min(int(limit), 20))))).scalars().all()
    return [
        group_scope(user_id, row.platform, row.bot_id, row.scope_id)
        for row in rows
        if row.scope_id and row.scope_id != exclude_group_id
    ]


async def _stored_member_scopes(
    user_id: object, *, platform: str, bot_id: str,
    platform_user_id: str, db=None, exclude_group_id: str = "", limit: int = 3,
) -> list[Scope]:
    if db is None:
        return []
    from sqlalchemy import select
    from app.models import MemoryReflectionCursor
    from agent.memory.scopes import split_member_scope_id

    rows = (await db.execute(select(MemoryReflectionCursor).where(
        MemoryReflectionCursor.owner_user_id == user_id,
        MemoryReflectionCursor.platform == platform,
        MemoryReflectionCursor.bot_id == bot_id,
        MemoryReflectionCursor.scope_type == "platform-user",
    ).limit(max(1, min(int(limit) * 3, 40))))).scalars().all()
    scopes = []
    for row in rows:
        group_id, member_id = split_member_scope_id(row.scope_id)
        if group_id and member_id == platform_user_id and group_id != exclude_group_id:
            scopes.append(member_scope(user_id, platform, bot_id, group_id, platform_user_id))
            if len(scopes) >= max(1, min(int(limit), 20)):
                break
    return scopes


def matches_scope(document: IndexDocument, query_scope: Scope) -> bool:
    """严格匹配 owner 和已指定的 platform/group 边界。"""
    actual = document.scope
    if actual.owner_user_id != query_scope.owner_user_id:
        return False
    for field in ("platform", "bot_id", "group_id", "scope_type", "scope_id"):
        wanted = getattr(query_scope, field)
        if wanted and getattr(actual, field) != wanted:
            return False
    return True


def matches_any_scope(document: IndexDocument, query_scopes: Iterable[Scope]) -> bool:
    """判断文档是否落在任一已解析 scope 内，统一多 scope ACL 判断。"""
    return any(matches_scope(document, query_scope) for query_scope in query_scopes)
