"""group/member 记忆反思执行器。

它只处理已持久化的反思任务：读取消息快照、调用专用 Prompt、写 scoped
memory 文件并推进游标。owner 的 reflection.py 不从这里反向调用。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import hashlib
import json

from sqlalchemy import select

from app.core import redis as R
from app.core.tz import now_utc
from agent.memory._llm import complete_json
from agent.memory.reflection_jobs import MAX_RETRIES, RETRY_BACKOFF_MINUTES
from agent.memory.scoped_store import read_scope, write_scope_file, write_scope_json
from agent.memory.scopes import MemoryScope


GROUP_DAILY_COMPACT_AT = 1000
GROUP_DAILY_KEEP_RECENT = 500
GROUP_DAILY_HARD_CAP = 1200


def _daily_entries(text: str) -> List[tuple[str, str]]:
    entries: List[tuple[str, str]] = []
    current = ""
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith("## ") and len(line) >= 12:
            current = line[3:].strip()
        elif current and line.startswith("- ") and line[2:].strip():
            entries.append((current, line[2:].strip()))
    return entries


def _render_daily(entries: List[tuple[str, str]]) -> str:
    out: List[str] = []
    current = ""
    for date, note in entries:
        if date != current:
            if out:
                out.append("")
            out.append(f"## {date}")
            current = date
        out.append(f"- {note}")
    return "\n".join(out).strip() + ("\n" if out else "")


def _message_text(message) -> str:
    name = message.platform_user_name or "未提供昵称"
    sender = message.platform_user_id or "未知ID"
    return f"[{name}，platform_user_id={sender}] {message.content or '（无文字）'}"


def _scope_prompt(scope: MemoryScope) -> str:
    filename = "group_reflection.md" if scope.scope_type == "group" else "member_reflection.md"
    path = Path(__file__).resolve().parents[1] / "prompts" / "im" / filename
    return path.read_text(encoding="utf-8")


async def _db_session():
    import app.db.session as db_session

    if db_session._engine is None:
        db_session._build_engine()
    return db_session._SessionLocal()


async def _messages_for_job(db, job):
    from app.models import ConversationMessage, ConversationSession

    query = (
        select(ConversationMessage)
        .join(ConversationSession, ConversationSession.id == ConversationMessage.session_id)
        .where(
            ConversationSession.user_id == job.owner_user_id,
            ConversationSession.source == job.platform,
            ConversationSession.bot_id == job.bot_id,
            ConversationMessage.role == "user",
            ConversationMessage.platform_user_id.is_not(None),
            ConversationMessage.id >= (job.from_message_id or 0),
            ConversationMessage.id <= job.to_message_id,
        )
    )
    if job.scope_type == "group":
        query = query.where(ConversationSession.chat_type == "group", ConversationSession.chat_id == job.scope_id)
    else:
        query = query.where(ConversationMessage.platform_user_id == job.scope_id)
    return (await db.execute(query.order_by(ConversationMessage.id))).scalars().all()


async def _mark_failure(db, job, exc: BaseException) -> None:
    now = now_utc()
    job.retry_count += 1
    job.last_error_code = type(exc).__name__[:100]
    if job.retry_count >= MAX_RETRIES:
        job.status = "dead"
        job.dead_at = now
        job.next_attempt_at = None
    else:
        job.status = "retry"
        delay = RETRY_BACKOFF_MINUTES[min(job.retry_count - 1, len(RETRY_BACKOFF_MINUTES) - 1)]
        from datetime import timedelta
        job.next_attempt_at = now + timedelta(minutes=delay)
    job.locked_at = None
    job.updated_at = now
    await db.commit()


async def execute_job(job_id: int, settings) -> bool:
    """在 scope 分布式锁内执行任务，确保同一 scope 严格串行。"""
    from app.models import MemoryReflectionJob

    async with await _db_session() as db:
        job = await db.get(MemoryReflectionJob, job_id)
        if job is None:
            return False
        scope = MemoryScope(
            job.owner_user_id,
            job.platform,
            job.bot_id,
            job.scope_type,
            job.scope_id,
        )
    lock = R.get_redis().lock(scope.lock_key, timeout=1800, blocking=False)
    if not await lock.acquire(blocking=False):
        return False
    try:
        return await _execute_job_locked(job_id, settings)
    finally:
        try:
            await lock.release()
        except Exception:
            pass


async def _execute_job_locked(job_id: int, settings) -> bool:
    """执行单个反思任务；成功返回 True，失败按协议转 retry/dead。"""
    from app.models import MemoryReflectionCursor, MemoryReflectionJob, MemoryEntry, MemorySource

    async with await _db_session() as db:
        job = await db.get(MemoryReflectionJob, job_id)
        if not job or job.status in {"completed", "dead"}:
            return False
        now = now_utc()
        if job.next_attempt_at and job.next_attempt_at > now:
            return False
        job.status = "running"
        job.locked_at = now
        job.updated_at = now
        await db.commit()
        try:
            scope = MemoryScope(job.owner_user_id, job.platform, job.bot_id, job.scope_type, job.scope_id)
            existing_entry = (await db.execute(
                select(MemoryEntry).where(
                    MemoryEntry.owner_user_id == scope.owner_user_id,
                    MemoryEntry.platform == scope.platform,
                    MemoryEntry.bot_id == scope.bot_id,
                    MemoryEntry.scope_type == scope.scope_type,
                    MemoryEntry.scope_id == scope.scope_id,
                    MemoryEntry.entry_key == f"job-{job.id}",
                )
            )).scalars().first()
            if existing_entry:
                cursor = (await db.execute(
                    select(MemoryReflectionCursor).where(*[
                        MemoryReflectionCursor.owner_user_id == scope.owner_user_id,
                        MemoryReflectionCursor.platform == scope.platform,
                        MemoryReflectionCursor.bot_id == scope.bot_id,
                        MemoryReflectionCursor.scope_type == scope.scope_type,
                        MemoryReflectionCursor.scope_id == scope.scope_id,
                    ])
                )).scalars().first()
                if cursor:
                    cursor.last_reflected_message_id = job.to_message_id
                job.status = "completed"
                job.locked_at = None
                job.updated_at = now
                await db.commit()
                return True
            cursor = (await db.execute(
                select(MemoryReflectionCursor).where(
                    MemoryReflectionCursor.owner_user_id == scope.owner_user_id,
                    MemoryReflectionCursor.platform == scope.platform,
                    MemoryReflectionCursor.bot_id == scope.bot_id,
                    MemoryReflectionCursor.scope_type == scope.scope_type,
                    MemoryReflectionCursor.scope_id == scope.scope_id,
                )
            )).scalars().first()
            if cursor and cursor.last_reflected_message_id:
                job.from_message_id = max(
                    job.from_message_id or 0,
                    cursor.last_reflected_message_id + 1,
                )
            messages = await _messages_for_job(db, job)
            current = await read_scope(scope)
            payload = "\n".join(
                f"[{m.created_at.isoformat() if m.created_at else '未知时间'}] {_message_text(m)}"
                for m in messages
            )
            user = (
                f"已有群组/用户记忆：\n{json.dumps(current, ensure_ascii=False)}\n\n"
                f"本批新增消息：\n{payload or '（无消息）'}"
            )
            out = await complete_json(_scope_prompt(scope), user, settings, max_tokens=2500)
            if not out and messages:
                raise RuntimeError("memory_reflection_empty_result")
            await _apply_output(scope, current, out, messages, settings)

            cursor = (await db.execute(
                select(MemoryReflectionCursor).where(
                    MemoryReflectionCursor.owner_user_id == scope.owner_user_id,
                    MemoryReflectionCursor.platform == scope.platform,
                    MemoryReflectionCursor.bot_id == scope.bot_id,
                    MemoryReflectionCursor.scope_type == scope.scope_type,
                    MemoryReflectionCursor.scope_id == scope.scope_id,
                )
            )).scalars().first()
            if cursor:
                cursor.last_reflected_message_id = job.to_message_id
                cursor.updated_at = now
            entry = MemoryEntry(
                owner_user_id=scope.owner_user_id,
                platform=scope.platform,
                bot_id=scope.bot_id,
                scope_type=scope.scope_type,
                scope_id=scope.scope_id,
                entry_key=f"job-{job.id}",
                kind="reflection",
                content_hash=hashlib.sha256((job.idempotency_key).encode()).hexdigest(),
                created_at=now,
                updated_at=now,
            )
            db.add(entry)
            await db.flush()
            for message in messages:
                db.add(MemorySource(entry_id=entry.id, message_id=message.id, created_at=now))
            job.status = "completed"
            job.locked_at = None
            job.updated_at = now
            await db.commit()
            return True
        except Exception as exc:
            await _mark_failure(db, job, exc)
            return False


async def _apply_output(
    scope: MemoryScope,
    current: Dict[str, Any],
    output: Dict[str, Any],
    messages: List[Any],
    settings,
) -> None:
    if scope.scope_type == "group":
        entries = _daily_entries(current.get("daily") or "")
        date = (messages[-1].created_at.date().isoformat() if messages and messages[-1].created_at else now_utc().date().isoformat())
        for item in output.get("daily") or []:
            if str(item).strip():
                entries.insert(0, (date, str(item).strip()))
        await write_scope_file(scope, "daily.md", _render_daily(entries))
        summary = str(output.get("summary") or "").strip()
        if summary:
            await write_scope_json(scope, "summary.json", {"text": summary, "ts": now_utc().timestamp()})
        if len(entries) >= GROUP_DAILY_COMPACT_AT:
            try:
                await _compact_group_daily(scope, entries, current.get("memory") or "", settings)
            except Exception as exc:
                # 压缩失败不能让本轮反思重跑，避免 daily 重复追加。
                if len(entries) >= GROUP_DAILY_HARD_CAP:
                    from app.core.redaction import diag_log

                    diag_log("im.memory.group_daily_compaction_overdue", exc)
        return
    profile = _merge_profile(current.get("profile"), output.get("profile"))
    pattern = _merge_pattern(current.get("pattern"), output.get("pattern"))
    summary = str(output.get("summary") or "").strip()
    if isinstance(profile, list) and profile:
        await write_scope_json(scope, "profile.json", profile)
    if isinstance(pattern, list) and pattern:
        await write_scope_json(scope, "pattern.json", pattern)
    if summary:
        await write_scope_json(scope, "summary.json", {"text": summary, "ts": now_utc().timestamp()})


def _merge_profile(current: Any, incoming: Any) -> list:
    values = []
    for item in (current if isinstance(current, list) else []) + (incoming if isinstance(incoming, list) else []):
        text = str(item).strip()
        if text and text not in values:
            values.append(text)
    return values


def _merge_pattern(current: Any, incoming: Any) -> list:
    values = []
    seen = set()
    for item in (current if isinstance(current, list) else []) + (incoming if isinstance(incoming, list) else []):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        values.append({
            "text": text,
            "kind": str(item.get("kind") or "observed"),
            "importance": int(item.get("importance") or 1),
        })
    return values


async def _compact_group_daily(scope: MemoryScope, entries: List[Any], current_memory: str, settings) -> None:
    """把群 daily 压缩进 memory，并保留最近一段原始记录作为可追溯窗口。"""
    prompt = (Path(__file__).resolve().parents[1] / "prompts" / "im" / "group_compress.md").read_text(encoding="utf-8")
    daily = _render_daily(entries)
    result = await complete_json(
        prompt,
        f"已有长期记忆：\n{current_memory}\n\n近期群聊记录：\n{daily}",
        settings,
        max_tokens=1800,
    )
    memory = str(result.get("memory") or "").strip() if isinstance(result, dict) else ""
    if not memory:
        return
    await write_scope_file(scope, "memory.md", memory + "\n")
    await write_scope_file(scope, "daily.md", _render_daily(entries[:GROUP_DAILY_KEEP_RECENT]))
