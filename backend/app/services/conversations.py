"""历史对话的查询边界。"""
from sqlalchemy import Text, and_, case, cast, desc, func, or_, select
from sqlalchemy.orm import defer

from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import (
    ConversationMessage, ConversationSession, FilesystemAuthorizationGrant,
    UserBot, Workspace,
)
from app.search.query import keyword_condition, keyword_score


async def list_recent_sessions(db, user_id, limit):
    return (await db.execute(select(ConversationSession).where(
        ConversationSession.user_id == user_id,
    ).order_by(desc(ConversationSession.updated_at)).limit(limit))).scalars().all()


async def search_messages(db, user_id, queries, mode, limit):
    conditions = keyword_condition(
        [ConversationMessage.content, ConversationSession.title, ConversationSession.summary],
        queries,
        mode,
    )
    return (await db.execute(
        select(ConversationMessage, ConversationSession)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(ConversationSession.user_id == user_id, ConversationMessage.content_json.is_(None), conditions)
        .order_by(keyword_score([
            ConversationMessage.content, ConversationSession.title, ConversationSession.summary,
        ], queries).desc(), desc(ConversationMessage.created_at))
        .limit(limit)
    )).all()


async def search_session_titles(db, user_id, queries, mode, limit, primary_query=None):
    """按会话标题搜索当前用户的会话。"""
    primary_query = (primary_query or queries[0]).lower()
    return (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == user_id,
            keyword_condition([ConversationSession.title], queries, mode),
        ).order_by(
            keyword_score([ConversationSession.title], queries).desc(),
            case(
                (func.lower(ConversationSession.title) == primary_query, 0),
                (func.lower(ConversationSession.title).like(f"{primary_query}%"), 1),
                else_=2,
            ),
            desc(ConversationSession.updated_at),
        ).limit(limit)
    )).scalars().all()


async def search_global_messages(db, user_id, queries, mode, limit):
    """为站内搜索返回消息及其会话标题。"""
    return (await db.execute(
        select(ConversationMessage, ConversationSession.title)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationSession.user_id == user_id,
            keyword_condition([ConversationMessage.content], queries, mode),
        ).order_by(
            keyword_score([ConversationMessage.content], queries).desc(),
            desc(ConversationMessage.created_at),
        ).limit(limit)
    )).all()


async def list_sessions_for_search_scan(db, user_id, limit):
    """返回罗马音搜索需要扫描的当前用户会话。"""
    return (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == user_id,
        ).order_by(desc(ConversationSession.updated_at)).limit(limit)
    )).scalars().all()


async def list_messages_for_search_scan(db, user_id, limit):
    """返回罗马音搜索需要扫描的当前用户消息及会话标题。"""
    return (await db.execute(
        select(ConversationMessage, ConversationSession.title)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(ConversationSession.user_id == user_id)
        .order_by(desc(ConversationMessage.created_at)).limit(limit)
    )).all()


async def get_session(db, user_id, session_id):
    return await get_owned(db, ConversationSession, session_id, user_id)


async def resolve_message_session_id(db, user_id, message_id):
    """解析消息所属会话，并在同一查询中校验会话归属。"""
    return (await db.execute(
        select(ConversationMessage.session_id)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationMessage.id == message_id,
            ConversationSession.user_id == user_id,
        )
    )).scalar_one_or_none()


async def list_messages(db, session_id, limit):
    return (await db.execute(select(ConversationMessage).where(
        ConversationMessage.session_id == session_id,
        ConversationMessage.content_json.is_(None),
    ).order_by(desc(ConversationMessage.created_at)).limit(limit))).scalars().all()


async def list_agent_sessions(db, user_id, limit: int = 50):
    """分别取最近的网页与 IM 会话，避免网页会话挤掉低频 IM 会话。"""
    web_rows = await db.execute(
        select(ConversationSession, Workspace.name)
        .outerjoin(Workspace, Workspace.id == ConversationSession.workspace_id)
        .where(
            ConversationSession.user_id == user_id,
            or_(ConversationSession.source.is_(None), ConversationSession.source == "web"),
        )
        .order_by(desc(ConversationSession.updated_at))
        .limit(limit)
    )
    im_rows = await db.execute(
        select(ConversationSession, Workspace.name)
        .outerjoin(Workspace, Workspace.id == ConversationSession.workspace_id)
        .where(
            ConversationSession.user_id == user_id,
            ConversationSession.source.is_not(None),
            ConversationSession.source != "web",
        )
        .order_by(desc(ConversationSession.updated_at))
        .limit(limit)
    )
    return sorted(
        [*web_rows.all(), *im_rows.all()],
        key=lambda item: item[0].updated_at,
        reverse=True,
    )


async def list_active_session_authorization_ids(db, user_id):
    rows = await db.scalars(
        select(FilesystemAuthorizationGrant.subject_id).where(
            FilesystemAuthorizationGrant.user_id == user_id,
            FilesystemAuthorizationGrant.subject_type == "session",
            FilesystemAuthorizationGrant.revoked_at.is_(None),
            or_(
                FilesystemAuthorizationGrant.expires_at.is_(None),
                FilesystemAuthorizationGrant.expires_at > now_utc(),
            ),
        )
    )
    return {
        int(subject_id) for subject_id in rows
        if str(subject_id).isdigit()
    }


async def latest_visible_assistant_message_ids(db, session_ids: list[int]) -> dict[int, int]:
    """返回会话列表里可见的最新助手正文版本，不把工具/空检查点算作未读。"""
    if not session_ids:
        return {}
    rows = await db.execute(
        select(ConversationMessage.session_id, func.max(ConversationMessage.id))
        .where(
            ConversationMessage.session_id.in_(session_ids),
            ConversationMessage.role == "assistant",
            ConversationMessage.content_json.is_(None),
            or_(
                ConversationMessage.content != "",
                and_(
                    ConversationMessage.files.is_not(None),
                    cast(ConversationMessage.files, Text).notin_(["[]", "null"]),
                ),
            ),
        )
        .group_by(ConversationMessage.session_id)
    )
    return dict(rows.all())


def _display_message_filters(session_id: int):
    return (
        ConversationMessage.session_id == session_id,
        ConversationMessage.role != "summary",
        or_(
            ConversationMessage.content_json.is_(None),
            and_(
                ConversationMessage.display_timeline.is_not(None),
                cast(ConversationMessage.display_timeline, Text) != "null",
            ),
        ),
    )


def _safe_timeline_projection(db):
    timeline_column = ConversationMessage.display_timeline
    if db.get_bind().dialect.name == "postgresql":
        stored_size = func.pg_column_size(timeline_column)
    else:
        stored_size = func.length(cast(timeline_column, Text))
    return case((stored_size > 1024 * 1024, None), else_=timeline_column)


async def load_display_message_page(
    db,
    session_id: int,
    limit: int,
    *,
    before_id: int | None = None,
    after_id: int | None = None,
    run_id: str | None = None,
):
    """读取分页展示消息与受大小限制的时间线投影。"""
    row_filters = _display_message_filters(session_id)
    statement = select(
        ConversationMessage,
        ConversationMessage.content_json.is_(None).label("is_display_body"),
    ).options(
        defer(ConversationMessage.display_timeline),
        defer(ConversationMessage.content_json),
    ).where(*row_filters)
    if run_id is not None:
        statement = statement.where(or_(
            ConversationMessage.run_id == run_id,
            ConversationMessage.display_timeline[0]["runId"].as_string() == run_id,
        ))
    if before_id is not None:
        statement = statement.where(ConversationMessage.id < before_id).order_by(
            desc(ConversationMessage.id)
        )
    elif after_id is not None:
        statement = statement.where(ConversationMessage.id > after_id).order_by(
            ConversationMessage.id
        )
    else:
        statement = statement.order_by(desc(ConversationMessage.id))
    fetched_rows = (await db.execute(statement.limit(limit))).all()
    page_rows = [row[0] for row in fetched_rows]
    display_body_ids = {row[0].id for row in fetched_rows if row.is_display_body}
    if before_id is not None or after_id is None:
        page_rows.reverse()

    display_timeline_by_id: dict[int, list | None] = {}
    oversized_timeline_ids: set[int] = set()
    message_ids = [message.id for message in page_rows]
    timeline_column = ConversationMessage.display_timeline
    if message_ids:
        timeline_rows = (await db.execute(
            select(
                ConversationMessage.id,
                _safe_timeline_projection(db).label("display_timeline"),
                timeline_column.is_not(None).label("has_display_timeline"),
            ).where(ConversationMessage.id.in_(message_ids))
        )).all()
        for row in timeline_rows:
            display_timeline_by_id[row.id] = row.display_timeline
            if row.has_display_timeline and row.display_timeline is None:
                oversized_timeline_ids.add(row.id)

    has_more = False
    has_newer = False
    if page_rows:
        older_probe = await db.execute(
            select(ConversationMessage.id)
            .where(*row_filters, ConversationMessage.id < page_rows[0].id)
            .limit(1)
        )
        has_more = older_probe.first() is not None
        if after_id is not None and len(page_rows) == limit:
            newer_probe = await db.execute(
                select(ConversationMessage.id)
                .where(*row_filters, ConversationMessage.id > page_rows[-1].id)
                .limit(1)
            )
            has_newer = newer_probe.first() is not None
    return {
        "messages": page_rows,
        "display_body_ids": display_body_ids,
        "timelines": display_timeline_by_id,
        "oversized_timeline_ids": oversized_timeline_ids,
        "has_more": has_more,
        "has_newer": has_newer,
    }


async def get_session_owner_platform_ids(db, user_id, platform: str, bot_id: int | None):
    statement = select(UserBot).where(
        UserBot.user_id == user_id,
        UserBot.platform == platform,
    )
    if bot_id:
        statement = statement.where(UserBot.id == int(bot_id))
    bot = (await db.execute(statement)).scalars().first()
    if bot is None:
        return None, None
    return bot.owner_platform_user_id, bot.bot_platform_user_id


async def get_display_timeline_item(db, session_id: int, message_id: int):
    """读取单条消息时间线；超大旧记录在数据库侧降为 None。"""
    return (await db.execute(
        select(_safe_timeline_projection(db)).where(
            ConversationMessage.id == message_id,
            ConversationMessage.session_id == session_id,
        )
    )).scalar_one_or_none()


async def resolve_display_message_location(db, user_id, message_id: int):
    """按消息 ID 解析会话位置；只返回可展示的正文消息。"""
    row = (await db.execute(
        select(ConversationMessage.id, ConversationMessage.session_id)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(
            ConversationMessage.id == message_id,
            ConversationSession.user_id == user_id,
            ConversationMessage.content_json.is_(None),
            ConversationMessage.role != "summary",
        )
    )).first()
    return (row.id, row.session_id) if row else None
