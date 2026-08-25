"""RAG 查询前的 scope 规范化与匹配。"""
from __future__ import annotations

from agent.rag.models import IndexDocument, Scope


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


def filter_authorized_documents(
    documents: list[IndexDocument] | tuple[IndexDocument, ...],
    query_scope: Scope | None,
) -> tuple[list[IndexDocument], int]:
    """在候选进入融合前执行一次严格 owner/scope 过滤。

    ``query_scope`` 已由调用方完成身份解析；为空时保持旧调用方行为，
    由各来源 retriever 自己负责 scope-first 过滤。
    """
    if query_scope is None:
        return list(documents), 0
    allowed = [document for document in documents if matches_scope(document, query_scope)]
    return allowed, len(documents) - len(allowed)
