"""group/member 记忆反思执行器。

它只处理已持久化的反思任务：读取消息快照、调用专用 Prompt、写 scoped
memory 文件并推进游标。owner 的 reflection.py 不从这里反向调用。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import hashlib
import json
import re

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
GROUP_MEMORY_MAX_TOKENS = 15000
_DATE_RE = re.compile(r"20\d{2}-\d{1,2}-\d{1,2}")
GROUP_PROFILE_TYPES = {"name", "nature", "rule", "role", "project", "preference", "note"}
_GROUP_INTERNAL_ID_RE = re.compile(r"(?:platform_user_id|user_openid|member_openid|group_openid)\s*=", re.I)


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


def _preserves_group_dates(entries: List[tuple[str, str]], memory: str) -> bool:
    """防止群组长期记忆重写时丢掉本批记录的日期锚点。"""
    dates = set(_DATE_RE.findall("\n".join(date for date, _ in entries)))
    return not dates or dates.issubset(set(_DATE_RE.findall(memory)))


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
            if scope.scope_type == "group":
                # members.json 的 DB 字段独立于下面的 LLM 调用是否成功，见 _merge_members 注释。
                try:
                    aggregated = await _aggregate_members(db, scope)
                    prior_doc = (await read_scope(scope)).get("members") or {}
                    prior_members = prior_doc.get("members") if isinstance(prior_doc, dict) else {}
                    await write_scope_json(
                        scope, "members.json",
                        _merge_members(prior_members if isinstance(prior_members, dict) else {}, aggregated),
                    )
                except Exception as exc:
                    # 不让本轮反思跟着失败；临时性错误下次任务会重新聚合一次，不是丢失只是晚一轮。
                    # 但完全不留痕的话，schema/SQL/OSS 权限这类持续性故障会永久停更且无法排查
                    # ——这正是本 PRD 最初诞生的原因（真实故障排查困难），不能在这里重蹈覆辙。
                    from app.core.redaction import diag_log
                    diag_log("agent.memory.im_members.aggregate", exc)
            current = await read_scope(scope)
            payload = "\n".join(
                f"[{m.created_at.isoformat() if m.created_at else '未知时间'}] {_message_text(m)}"
                for m in messages
            )
            # members.json 不进反思 prompt——它是 execute_job 里独立聚合写入的持久化文件
            # （见上面的 members.json 写入块），不该被当成"已有记忆"整份塞给 LLM：群成员
            # 越多，prompt 越大，纯粹是无意义的 token 开销；nicknames_add 判断用的是本批
            # 消息自带的 sender id，也不需要旧 members 全量做参照。
            reflection_current = {k: v for k, v in current.items() if k != "members"}
            user = (
                f"已有群组/用户记忆：\n{json.dumps(reflection_current, ensure_ascii=False)}\n\n"
                f"本批新增消息：\n{payload or '（无消息）'}"
            )
            out = await complete_json(_scope_prompt(scope), user, settings, max_tokens=2500, thinking="disabled")
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


async def _aggregate_members(db, scope: MemoryScope) -> dict[str, dict]:
    """按 chat_id 全量聚合群成员：platform_user_id → {name, last_seen_at, message_count}。

    数据源是 ConversationMessage 表按 chat_id 聚合。群聊消息受 MESSAGE_RETENTION_LIMIT
    （500）/MESSAGE_TRIM_THRESHOLD（600）限制，message_count 天然是"保留窗口内"的计数
    而非全量历史，语义上贴近"近期活跃度"。
    这里刻意不用 execute_job 本批 messages 累加——会漏掉窗口内、不在本批范围的历史，
    也没法正确反映消息裁剪后的实际计数；全量聚合成本很低，每次都查一遍。

    不按 (platform_user_id, platform_user_name) 联合 GROUP BY——同一个人在保留窗口内改过
    群昵称时，联合分组会把他的消息拆成两行，逐行覆盖写只会留下其中一行，导致 message_count
    被低估、name/last_seen_at 也可能取到过期值（曾经复现过：窗口内改名一次，message_count
    从 5 条被腰斩成 3 条）。改成只取原始行按时间顺序在 Python 里聚合：count 累加所有行，
    name/last_seen_at 始终跟随时间最新的那一行，不受改名次数影响。
    """
    from app.models import ConversationMessage, ConversationSession

    rows = (await db.execute(
        select(
            ConversationMessage.platform_user_id,
            ConversationMessage.platform_user_name,
            ConversationMessage.created_at,
        )
        .join(ConversationSession, ConversationSession.id == ConversationMessage.session_id)
        .where(
            ConversationSession.user_id == scope.owner_user_id,
            ConversationSession.source == scope.platform,
            ConversationSession.bot_id == scope.bot_id,
            ConversationSession.chat_type == "group",
            ConversationSession.chat_id == scope.scope_id,
            ConversationMessage.role == "user",
            ConversationMessage.platform_user_id.is_not(None),
        )
        .order_by(ConversationMessage.created_at, ConversationMessage.id)
    )).all()
    members: dict[str, dict] = {}
    for pid, name, created_at in rows:
        if not pid:
            continue
        member = members.setdefault(pid, {"name": "", "last_seen_at": None, "message_count": 0})
        member["message_count"] += 1
        ts = created_at.timestamp() if created_at else None
        # 行按 created_at 升序处理，靠 >= 保证同一时刻多条也以最后处理的为准，
        # 天然拿到时间最新的 name（改名后的消息排在后面，自然覆盖旧名字）。
        if ts is not None and (member["last_seen_at"] is None or ts >= member["last_seen_at"]):
            member["last_seen_at"] = ts
            member["name"] = name or member["name"]
    return members


def _merge_members(current: Any, aggregated: dict[str, dict]) -> dict[str, dict]:
    """合并 DB 聚合结果，写回 members.json。只处理 name/aliases/last_seen_at/message_count
    这几个纯 DB 字段，不碰 nicknames——nicknames 的合并见 _apply_nicknames()。

    这个函数只依赖 ConversationMessage 表，不依赖任何 LLM 调用结果，因此在
    execute_job 里独立于 complete_json() 是否成功执行、独立写入（见 PRD-IM-8
    Phase 4：曾经把这一步跟 LLM 反思结果绑在同一段 try 里，LLM 那次调用失败
    ——即便是跟这几个字段完全无关的原因，比如内容审核拦截——就会连带这几个
    本该实时的字段也一起卡住不更新，这是明确要避免的耦合）。

    name 变了把旧值追加进 aliases（去重）。注意：members.json 刻意不适用
    _GROUP_INTERNAL_ID_RE 过滤——profile.json 不落地任何 platform_user_id，而
    members.json 每条必须挂在具体 platform_user_id 下才有意义，这是两个文件
    唯一但关键的设计分歧点，不要"修正"掉。
    """
    now = now_utc().timestamp()
    out: dict[str, dict] = {}
    for pid, agg in aggregated.items():
        prev = (current or {}).get(pid) if isinstance(current, dict) else None
        aliases = list(prev.get("aliases") or []) if isinstance(prev, dict) else []
        if isinstance(prev, dict) and prev.get("name") and prev["name"] != agg["name"]:
            if prev["name"] not in aliases:
                aliases.append(prev["name"])
        nicknames = list(prev.get("nicknames") or []) if isinstance(prev, dict) else []
        out[pid] = {
            "name": agg["name"],
            "aliases": aliases,
            "nicknames": nicknames,
            "last_seen_at": agg["last_seen_at"],
            "message_count": agg["message_count"],
        }
    return {"updated_at": now, "members": out}


def _apply_nicknames(members: dict[str, dict], nicknames_add: Any) -> dict[str, dict]:
    """把 LLM 提炼的群友称呼（nicknames_add）追加进已有的 members 字典。

    只在反思调用成功、真的拿到 nicknames_add 时才调用——跟 _merge_members()
    分开是因为这是唯一还需要 LLM 结果的字段，其余字段不该等它。只处理已存在
    于 members 里的 pid（DB 聚合已经写过一次，这里不该凭空新增成员），去重追加。
    """
    for raw in nicknames_add if isinstance(nicknames_add, list) else []:
        if not isinstance(raw, dict):
            continue
        pid = str(raw.get("platform_user_id") or "").strip()
        nickname = str(raw.get("nickname") or "").strip()
        if not pid or not nickname or pid not in members:
            continue
        nicknames = list(members[pid].get("nicknames") or [])
        if nickname not in nicknames:
            nicknames.append(nickname)
            members[pid]["nicknames"] = nicknames
    return members


async def _apply_output(
    scope: MemoryScope,
    current: Dict[str, Any],
    output: Dict[str, Any],
    messages: List[Any],
    settings,
) -> None:
    if scope.scope_type == "group":
        profile = _merge_group_profile(current.get("profile"), output.get("profile_add"), output.get("profile_remove"))
        if profile or output.get("profile_add") or output.get("profile_remove"):
            await write_scope_json(scope, "profile.json", profile)
        # members.json 的 DB 字段（name/aliases/last_seen_at/message_count）已经在
        # _execute_job_locked 里、调用 LLM 之前独立写过一次；这里只补 nicknames——
        # 唯一依赖本轮 LLM 结果的字段，只有 output 里真有内容才需要再写一次文件。
        nicknames_add = output.get("nicknames_add")
        if nicknames_add:
            doc = (await read_scope(scope)).get("members") or {}
            members = doc.get("members") if isinstance(doc, dict) else {}
            if isinstance(members, dict) and members:
                updated = _apply_nicknames(members, nicknames_add)
                await write_scope_json(scope, "members.json", {"updated_at": now_utc().timestamp(), "members": updated})
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


def _merge_group_profile(current: Any, additions: Any, removals: Any) -> list[dict]:
    """合并群组公开 profile；只接受群组类型，不保存成员内部 ID。

    复用 store._pattern_similar 做相似度去重（与 owner 记忆一致），但保留 group 特有
    类型（nature/rule/role/project）——store.apply_profile_ops 的类型 normalize 会把
    它们降级为 note（store.PROFILE_TYPES 不含这些类型），故不直接调用 apply_profile_ops，
    而是复用其相似度判断函数，避免破坏 group 类型白名单。
    """
    from agent.memory.store import _pattern_similar

    values = []
    for item in current if isinstance(current, list) else []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        item_type = str(item.get("type") or "note").strip()
        if text and item_type in GROUP_PROFILE_TYPES and not _GROUP_INTERNAL_ID_RE.search(text):
            values.append({"type": item_type, "text": text, "ts": item.get("ts")})

    for raw in removals if isinstance(removals, list) else []:
        target = str(raw.get("text") if isinstance(raw, dict) else raw).strip()
        if target:
            values = [item for item in values if not _pattern_similar(item["text"], target)]

    now = now_utc().timestamp()
    for raw in additions if isinstance(additions, list) else []:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        item_type = str(raw.get("type") or "note").strip()
        if not text or item_type not in GROUP_PROFILE_TYPES or _GROUP_INTERNAL_ID_RE.search(text):
            continue
        hit = next((item for item in values if _pattern_similar(item["text"], text)), None)
        if hit:
            hit["type"] = item_type
            hit["ts"] = now
            if len(text) > len(hit.get("text", "")):
                hit["text"] = text
        else:
            values.append({"type": item_type, "text": text, "ts": now})
    return values


def _merge_profile(current: Any, incoming: Any) -> list:
    """合并成员 profile；复用 store.apply_profile_ops 的相似度去重。

    member 路径现状是每次输出整份 profile 列表，当作 add 传入，remove 传空数组
    （member 暂不支持主动删除，见 PRD-IM-8 FR-IM-8-3）。member 的 profile 类型集合
    与 store.PROFILE_TYPES 一致，直接调用 apply_profile_ops 不会破坏类型。
    """
    from agent.memory.store import apply_profile_ops

    return apply_profile_ops(
        current if isinstance(current, list) else [],
        incoming if isinstance(incoming, list) else [],
        [],
    )


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
        max_tokens=GROUP_MEMORY_MAX_TOKENS,
        thinking="disabled",
    )
    memory = str(result.get("memory") or "").strip() if isinstance(result, dict) else ""
    if not memory or not _preserves_group_dates(entries, memory):
        return
    await write_scope_file(scope, "memory.md", memory + "\n")
    await write_scope_file(scope, "daily.md", _render_daily(entries[:GROUP_DAILY_KEEP_RECENT]))
