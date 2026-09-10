"""统一 run 收尾：持久化 canonical turn、裁剪历史并调度 baseline。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable


@dataclass(frozen=True)
class FinalizeResult:
    """收尾阶段实际记账的用量。"""

    tokens_in: int
    tokens_out: int


async def _insert_or_get_batch(db, batch_model, values: dict[str, Any]):
    """原子写入 canonical batch，唯一键竞争时复用已有行。"""
    from sqlalchemy import select

    session_id = values["session_id"]
    batch_digest = values["digest"]
    dialect_name = db.get_bind().dialect.name
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        raise RuntimeError(f"canonical batch 不支持数据库方言：{dialect_name}")

    statement = (
        dialect_insert(batch_model)
        .values(**values)
        .on_conflict_do_nothing(
            index_elements=[batch_model.session_id, batch_model.digest]
        )
        .returning(batch_model.id)
    )
    result = await db.execute(statement)
    inserted_id = result.scalar_one_or_none()
    if inserted_id is not None:
        row = await db.get(batch_model, inserted_id)
        if row is not None:
            return row, True

    existing = (await db.execute(
        select(batch_model).where(
            batch_model.session_id == session_id,
            batch_model.digest == batch_digest,
        )
    )).scalars().first()
    if existing is None:
        raise RuntimeError("canonical batch 插入后无法读取结果")
    return existing, False


async def finalize_run(
    *,
    session_factory: Callable[[], Any],
    session_id: int,
    user_id: str,
    settings: Any,
    model_cfg: Any,
    rag_context: dict | None,
    messages: list,
    initial_len: int,
    text: str,
    display_timeline: list[dict] | None = None,
    files: list | None,
    tokens_in: int,
    tokens_out: int,
    cache_read: int = 0,
    cache_write: int = 0,
    tools_used: list[str] | None = None,
    compaction_applied: bool = False,
    session_exists_required: bool = False,
    stance_text: str | None = None,
    user_message_id: int | None = None,
    run_id: str | None = None,
    canonical_batches: list[dict] | tuple[dict, ...] | None = None,
) -> FinalizeResult:
    """用一个契约完成 canonical turn、展示时间线、trim 与压缩边界持久化。

    Web/IM 只负责渠道事件和输出清洗；canonical history 与展示时间线分开保存，
    消息结构、配额封顶及 baseline 入口在这里保持一致。
    ``session_exists_required`` 供 Web 删除竞态使用：会话已删除时跳过消息，但仍保留 usage 记账。
    """
    from agent.context import assembly, compress_conv
    from app.models import ConversationMessage, ConversationSession
    from app.core import chat_attach
    from app.services.conversation_retention import trim_session_messages

    async with session_factory() as db:
        session_alive = True
        if session_exists_required:
            from app.models import ConversationSession
            session_alive = await db.get(ConversationSession, session_id) is not None
        if session_alive:
            stance_persisted = False
            user_message = (
                await db.get(ConversationMessage, user_message_id)
                if user_message_id else None
            )
            rag_blocks = [
                block for block in (rag_context or {}).get("blocks", [])
                if isinstance(block, dict)
            ]
            if stance_text and user_message_id:
                if user_message is not None:
                    # 当前用户消息已在生成前写入；把姿态事件排在它之前，保持
                    # provider 首轮的「姿态 → 用户消息」顺序。每次变化都追加，
                    # 不按正文去重；下一轮从 canonical history 稳定恢复。
                    stance_offset = len(rag_blocks) + 1
                    db.add(ConversationMessage(
                        session_id=session_id,
                        role="user",
                        content="",
                        content_json=[{
                            "type": "stance-context",
                            "digest": assembly.stance_digest(stance_text),
                            "text": f"[system-reminder]\n{stance_text}\n[/system-reminder]",
                        }],
                        created_at=user_message.created_at - timedelta(microseconds=stance_offset),
                    ))
                    stance_persisted = True
            if stance_persisted:
                session_row = await db.get(ConversationSession, session_id)
                if session_row is not None:
                    context = dict(session_row.session_context or {})
                    context["stance_digest"] = assembly.stance_digest(stance_text)
                    session_row.session_context = context
            # 当前用户行在生成前已经落库。RAG 需要在 provider 首轮和下一轮 history
            # 中都出现在它前面；因此用用户行的时间作为锚点，不能让数据库默认的
            # now_utc() 把 RAG 排到用户消息后面。多个块按原顺序占用连续微秒。
            for index, block in enumerate(rag_blocks):
                values = {
                    "session_id": session_id,
                    "role": "user",
                    "content": "",
                    "content_json": [block],
                }
                if user_message is not None:
                    values["created_at"] = user_message.created_at - timedelta(
                        microseconds=len(rag_blocks) - index,
                    )
                db.add(ConversationMessage(**values))
            if canonical_batches is None:
                # 旧调用方/旧 worker 的过渡路径。新 runner 必须传入已封存的
                # canonical batch，不能在这里从 provider wire 二次推导。
                from agent.context.history import canonicalize_tool_messages
                tool_history = assembly.newly_appended(messages, initial_len)
                for tm in canonicalize_tool_messages(tool_history):
                    db.add(ConversationMessage(
                        session_id=session_id,
                        role=tm["role"],
                        content="",
                        content_json=chat_attach.strip_vision_for_history(tm["content"]),
                    ))
            else:
                from app.models import ConversationBatch
                from sqlalchemy import select
                for record in canonical_batches:
                    if not isinstance(record, dict):
                        continue
                    canonical_messages = record.get("messages") or []
                    if not canonical_messages:
                        continue
                    digest = str(record.get("digest") or "")
                    metadata = record.get("metadata") or {}
                    if not digest:
                        from agent.context.canonical_context import digest as canonical_digest

                        digest = canonical_digest({
                            "messages": canonical_messages,
                            "metadata": metadata,
                        })
                    batch_row, is_new_batch = await _insert_or_get_batch(
                        db,
                        ConversationBatch,
                        {
                            "session_id": session_id,
                            "version": "v1",
                            "run_id": run_id or str(metadata.get("run_id") or "") or None,
                            "round_id": str(metadata.get("round_id") or "") or None,
                            "digest": digest,
                        },
                    )
                    if is_new_batch:
                        for message in canonical_messages:
                            db.add(ConversationMessage(
                                session_id=session_id,
                                role=message["role"],
                                content=message.get("content") if isinstance(message.get("content"), str) else "",
                                content_json=(
                                    chat_attach.strip_vision_for_history(message["content"])
                                    if not isinstance(message.get("content"), str) else None
                                ),
                                canonical_batch_id=batch_row.id,
                            ))
            if text or files or display_timeline:
                db.add(ConversationMessage(
                    session_id=session_id,
                    role="assistant",
                    content=text,
                    files=files or None,
                    display_timeline=display_timeline or None,
                ))

        from agent.usage import record_usage
        # BYOK 不参与平台配额封顶，但仍记录实际 token，供用户查看自己的模型用量。
        usage_result = await record_usage(
            user_id,
            settings,
            model_cfg,
            db=db,
            session_id=session_id if session_alive else None,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cache_read=cache_read,
            cache_write=cache_write,
            tools_used=tools_used,
        )
        await db.commit()

    await trim_session_messages(session_id)
    # 只有当前 run 已经在 provider round 边界执行过 >=90% 压缩，才同步推进
    # 持久 baseline。这里不再独立判断 token，也不再创建结束后的后台压缩任务。
    if compaction_applied:
        await compress_conv.compress_if_needed(
            session_id, user_id, settings, force=False,
        )
    return FinalizeResult(
        tokens_in=usage_result.tokens_in,
        tokens_out=usage_result.tokens_out,
    )
