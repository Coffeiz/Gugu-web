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


def _run_compaction_summary(
    messages: Any,
    model_cfg: Any,
    user_message_id: int | None,
) -> str | None:
    """取出本 run 在 provider 边界生成的压缩摘要正文；取不到就退回旧的重生成。

    run 内压缩的分支请求与主对话共享前缀、能命中缓存；run 收尾的 baseline
    再用摊平文本把同一批历史送一遍，是结构性不可能共享前缀的全冷大输入调用。
    复用必须确认候选确实是摘要（而不是正文里恰好带标记的用户消息）并仍然
    通过输出预算校验，否则返回 None 让调用方走旧路径。
    """
    if not user_message_id:
        return None
    from agent.context.compaction import resolve_compaction_limits, validate_compact_summary
    from agent.context.summary_format import SUMMARY_OPEN, unwrap_compacted_summary

    # finalize 传入的是冻结的 CanonicalAreaSnapshot.messages；摘要识别属于
    # canonical 收尾规则，不应再反向生成 Provider wire。
    conversation = messages
    candidate = None
    for item in conversation:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "")
        # 摘要由组装器写成 <compacted-summary> 开头的 history 消息；run 内多次
        # 压缩时取最后一条（最新一次已经把上一版滚动合并进去）。
        if item.get("role") == "summary" or content.lstrip().startswith(SUMMARY_OPEN):
            candidate = content
    if not candidate:
        return None
    try:
        limits = resolve_compaction_limits(model_cfg)
    except Exception:
        # 取不到输出预算就无法确认候选仍然可用，退回旧的重生成路径。
        return None
    text = unwrap_compacted_summary(candidate)
    ok, _reason = validate_compact_summary(text, max_output_tokens=limits.output_tokens)
    return text if ok else None


async def finalize_run(
    *,
    session_factory: Callable[[], Any],
    session_id: int,
    user_id: str,
    settings: Any,
    model_cfg: Any,
    message_area: Any,
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
    user_message_id: int | None = None,
    run_id: str | None = None,
    round_id: str | None = None,
    interrupted: bool = False,
) -> FinalizeResult:
    """用一个契约完成 canonical turn、展示时间线、trim 与压缩边界持久化。

    Web/IM 只负责渠道事件和输出清洗；canonical history 与展示时间线分开保存，
    消息结构、配额封顶及 baseline 入口在这里保持一致。
    ``session_exists_required`` 供 Web 删除竞态使用：会话已删除时跳过消息，但仍保留 usage 记账。
    """
    from agent.context import compress_conv
    from app.models import ConversationMessage, ConversationSession
    from app.services.conversation_retention import trim_session_messages
    persisted_round_id = round_id or "round-1"

    if message_area is None:
        raise ValueError("finalize_run 必须接收 MessageArea")

    async with session_factory() as db:
        session_alive = True
        if session_exists_required:
            session_alive = await db.get(ConversationSession, session_id) is not None
        if session_alive:
            cache_anchor = getattr(message_area, "provider_cache_anchor", None)
            if cache_anchor:
                session_row = await db.get(ConversationSession, session_id)
                if session_row is not None:
                    session_context = dict(session_row.session_context or {})
                    session_context["provider_cache_anchor"] = cache_anchor
                    session_row.session_context = session_context
            user_message = (
                await db.get(ConversationMessage, user_message_id)
                if user_message_id else None
            )
            if user_message is not None and run_id:
                user_message.run_id = run_id
                user_message.round_id = "round-1"
            from agent.context.message_area_repository import commit_delta
            outcome = "interruption" if interrupted else "success"
            delta = message_area.persistence_delta(outcome=outcome)
            await commit_delta(
                db,
                session_id=session_id,
                delta=delta,
                run_id=run_id,
                default_round_id=persisted_round_id if run_id else None,
                user_message=user_message,
                interrupted=interrupted,
            )
            persisted_timeline = display_timeline or None
            if persisted_timeline and user_message_id:
                # 展示时间线可能在取消收尾时才落库，而下一条用户消息已先提交。
                # 用发起本 run 的用户消息锚定其顺序，避免刷新后按 assistant 行的
                # 晚到自增 id 把旧 run 的工具卡排到后续用户消息之后。
                persisted_timeline = [
                    {
                        **item,
                        "timelineOrder": item.get("timelineOrder") or user_message_id * 1000 + index + 1,
                    }
                    for index, item in enumerate(persisted_timeline)
                ]
            if text or files or persisted_timeline:
                assistant_created_at = None
                if interrupted and user_message is not None:
                    anchor = delta.user_anchor_sequence
                    persisted_after_anchor = [
                        entry.sequence for entry in delta.entries
                        if anchor is not None and entry.sequence > anchor
                    ]
                    assistant_created_at = user_message.created_at + timedelta(
                        microseconds=max(
                            (sequence - anchor + 1 for sequence in persisted_after_anchor),
                            default=1,
                        ),
                    )
                assistant_content = text
                if interrupted and assistant_content:
                    assistant_content += "\n\n[本轮已中止，以上内容未完成]"
                assistant_values = dict(
                    session_id=session_id,
                    role="assistant",
                    content=assistant_content,
                    files=files or None,
                    display_timeline=persisted_timeline,
                    run_id=run_id,
                    round_id=persisted_round_id if run_id else None,
                )
                if assistant_created_at is not None:
                    assistant_values["created_at"] = assistant_created_at
                db.add(ConversationMessage(**assistant_values))

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
        # run 内压缩已经在 provider 边界生成过摘要（那次分支请求与主对话共享
        # 前缀、能命中缓存）。baseline 直接复用它并只重算水位，不再用摊平文本
        # 重放一遍——那条路结构上不可能共享前缀，每次都是全冷的大输入调用。
        # 摘要取不到时退回旧的重生成路径。
        reuse_summary = _run_compaction_summary(message_area.snapshot().messages, model_cfg, user_message_id)
        await compress_conv.compress_if_needed(
            session_id, user_id, settings, force=False,
            reuse_summary=reuse_summary,
            reuse_before_message_id=user_message_id if reuse_summary else None,
        )
    return FinalizeResult(
        tokens_in=usage_result.tokens_in,
        tokens_out=usage_result.tokens_out,
    )
