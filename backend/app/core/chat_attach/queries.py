"""附件读取与查询：按 attach_id / 渠道查暂存附件、解析容错匹配、读出字节内容。

所有权判断一律带 `user_id`——跨用户数据查询走 `app/core/ownership.py` 的
`get_owned()`；这里查的是当前用户自己的暂存池。
"""
from __future__ import annotations

import hashlib
import json

from app.core import redis as redis_module
from app.services import storage as storage_service

from . import records, staging
from .constants import MAX_TEXT_INJECT, TTL, _PREFIX, _QQ_FACE_CACHE_PREFIX
from .file_types import model_attachment_name


def _key(user_id, attach_id) -> str:
    return f"{_PREFIX}{user_id}:{attach_id}"


def _qq_face_cache_key(user_id, face_type: str, face_id: str) -> str:
    token = hashlib.sha256(f"{face_type}:{face_id}".encode("utf-8")).hexdigest()
    return f"{_QQ_FACE_CACHE_PREFIX}{user_id}:{token}"


async def get_qq_face_cached(user_id, face_type: str, face_id: str) -> dict | None:
    """返回仍有效的 QQ 表情暂存元数据，避免同一表情重复下载。"""
    if not str(face_id or "").strip():
        return None
    attach_id = await redis_module.get_redis().get(_qq_face_cache_key(user_id, str(face_type), str(face_id)))
    if not attach_id:
        return None
    return await get_meta(user_id, attach_id.decode() if isinstance(attach_id, bytes) else str(attach_id))


async def set_qq_face_cached(user_id, face_type: str, face_id: str, attach_id: str) -> None:
    if str(face_id or "").strip() and attach_id:
        await redis_module.get_redis().set(
            _qq_face_cache_key(user_id, str(face_type), str(face_id)),
            attach_id,
            ex=TTL,
        )


async def _get_attachment_row(user_id, attach_id: str):
    from app.models import ChatAttachment
    from sqlalchemy import select
    import app.db.session as db_session
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        return (await db.execute(
            select(ChatAttachment).where(
                ChatAttachment.user_id == user_id,
                ChatAttachment.attach_id == str(attach_id),
            )
        )).scalars().first()


async def get_meta(user_id, attach_id: str) -> dict | None:
    """先查 DB（所有权真相来源），DB 没有才回退查 Redis 的 legacy 元数据——只覆盖
    v3 上线前写入的旧数据，会随 Redis key 自然过期消失，不专门下线这条路径。"""
    try:
        row = await _get_attachment_row(user_id, attach_id)
        if row is not None:
            return records.row_to_meta(row)
    except Exception:
        pass
    try:
        raw = await redis_module.get_redis().get(_key(user_id, attach_id))
        return json.loads(raw) if raw else None
    except Exception:
        return None


async def get_meta_many(user_id, attach_ids: list[str]) -> dict[str, dict]:
    """一次读取多个暂存附件的元数据，返回 attach_id 到 meta 的映射。DB 优先，
    DB 没有的再回退查 Redis legacy（同 get_meta 的策略）。"""
    if not user_id or not attach_ids:
        return {}
    unique_ids = list(dict.fromkeys(str(attach_id) for attach_id in attach_ids if attach_id))
    if not unique_ids:
        return {}
    result: dict[str, dict] = {}
    try:
        from app.models import ChatAttachment
        from sqlalchemy import select
        import app.db.session as db_session
        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            rows = (await db.execute(
                select(ChatAttachment).where(
                    ChatAttachment.user_id == user_id,
                    ChatAttachment.attach_id.in_(unique_ids),
                )
            )).scalars().all()
        for row in rows:
            result[row.attach_id] = records.row_to_meta(row)
    except Exception:
        pass
    missing = [aid for aid in unique_ids if aid not in result]
    if missing:
        try:
            raw_items = await redis_module.get_redis().mget([_key(user_id, aid) for aid in missing])
            for aid, raw in zip(missing, raw_items):
                if not raw:
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode()
                result[aid] = json.loads(raw)
        except Exception:
            pass
    return result


async def list_staged(user_id) -> list[dict]:
    """该用户当前所有草稿态（未发送）暂存附件 meta，按创建时间降序（越新越靠前）。

    只查 DB（所有权真相来源）——v3 上线前遗留、只存在 Redis 里的旧草稿不会出现在
    这里，`resolve_attach` 的模糊匹配范围因此在过渡期内略微收窄，是可接受的边界
    行为（这些旧草稿本来也会在 Redis TTL 到期后自然消失）。"""
    from app.models import ChatAttachment
    from sqlalchemy import select
    import app.db.session as db_session
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        rows = (await db.execute(
            select(ChatAttachment).where(
                ChatAttachment.user_id == user_id,
                ChatAttachment.state == "draft",
            ).order_by(ChatAttachment.created_at.desc())
        )).scalars().all()
    return [records.row_to_meta(r) for r in rows]


async def list_session_attachments(user_id, session_id: int, limit: int = 20) -> list[dict]:
    """列出指定会话中已挂载的近期附件，供 Agent 按 attach_id 重读历史媒体。

    会话与附件都校验 user_id，避免工具调用上下文异常时跨用户枚举附件。
    """
    from app.models import ChatAttachment, ConversationMessage, ConversationSession
    from sqlalchemy import select
    import app.db.session as db_session

    if not session_id:
        return []
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        rows = (await db.execute(
            select(ChatAttachment).join(
                ConversationMessage, ChatAttachment.message_id == ConversationMessage.id,
            ).join(
                ConversationSession, ConversationMessage.session_id == ConversationSession.id,
            ).where(
                ChatAttachment.user_id == user_id,
                ChatAttachment.state == "attached",
                ConversationSession.id == session_id,
                ConversationSession.user_id == user_id,
            ).order_by(
                ChatAttachment.attached_at.desc(), ChatAttachment.created_at.desc(),
            ).limit(max(1, min(int(limit), 50)))
        )).scalars().all()
    return [records.row_to_meta(row) for row in rows]


async def resolve_attach(user_id, attach_id: str) -> tuple[dict | None, str]:
    """容错解析附件，返回 (meta|None, note)。
    LLM 抄 16 位 hex 的 attach_id 经常抄错/截断，别动不动报"过期"：
    精确命中 → 前缀/子串唯一命中 → 无歧义时退到最近上传的一个。全空才算真过期。

    暂存池按 user_id 全局共享（不分渠道），同一用户可能同时绑定 QQ/飞书/微信/网页——先按「当前
    所在渠道」（imctx，见 _current_platform）收窄候选，避免把另一个渠道、甚至更早不相关对话里
    还没保存的旧附件当成这次要存的（同渠道内互相干扰的可能性也不小，但至少不会跨渠道串）。

    「无歧义」= 收窄后只剩一个附件，或类型全一致（如连发的都是图片）——这两种情况瞎猜大概率对。
    类型不一（比如同时有图片和语音）时**不再盲目取「最新」那个**：曾有真实事故——QQ 连发 4 张图
    后跟了句语音，指令那轮因防抖拆轮没带上图片 attach_id，工具退到「最近暂存」时抓到了更晚落地
    的语音、把语音当图片存进了文件库。改为返回歧义候选列表，让调用方/模型明确指定。"""
    aid = (attach_id or "").strip()
    if aid:
        meta = await get_meta(user_id, aid)
        if meta:
            return meta, ""
    staged = await list_staged(user_id)
    if not staged:
        return None, ""
    if aid:
        hit = [m for m in staged if aid in m["attach_id"] or m["attach_id"] in aid]
        if len(hit) == 1:
            return hit[0], "（按最接近的附件匹配）"

    pool = staged
    cur_platform = staging._current_platform(None)
    if cur_platform:
        same_ch = [m for m in staged if m.get("platform") == cur_platform]
        if same_ch:   # 同渠道有候选才收窄；没有则说明这渠道确实没暂存过（如刚绑定），退回全池
            pool = same_ch

    kinds = {m.get("kind") for m in pool}
    if len(pool) == 1 or len(kinds) == 1:
        return pool[0], "（没对上 attach_id，用了你最近上传的那个附件）"
    cands = "、".join(f"{model_attachment_name(m)}（{m['kind']}，attach_id={m['attach_id']}）" for m in pool[:8])
    return None, f"当前暂存了多个不同类型的附件，无法安全猜测该存哪个，请明确指定 attach_id。候选：{cands}"


async def read_bytes(meta: dict) -> bytes:
    return await storage_service.get_storage().get(meta["storage_key"])


async def read_text(meta: dict) -> str:
    """读文本内容（文本类直接 decode；PDF/Office 走 doctext 提取）。截断到 MAX_TEXT_INJECT。失败返回空串。"""
    try:
        from app.core import doctext
        raw = await read_bytes(meta)
        return (await doctext.extract_text(raw, meta.get("ext", "")))[:MAX_TEXT_INJECT]
    except Exception:
        return ""
