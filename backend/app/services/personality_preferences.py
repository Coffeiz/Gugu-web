"""用户人格偏好的校验、权益和 snapshot 失效策略。"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime
from pathlib import Path

from app.core.config import get_settings
from app.core.tz import now_utc

MAX_PERSONALITY_PREFERENCE_CHARS = 10000
_ALLOWED_CONTROL_CHARS = {"\n", "\r", "\t"}


def personality_file_path(user_id) -> Path:
    """返回用户隐藏人格文件路径；该路径不属于普通文件库。"""
    root = Path(get_settings().storage.local_path).expanduser().resolve()
    user_root = (root / str(user_id)).resolve(strict=False)
    try:
        user_root.relative_to(root)
    except ValueError as exc:
        raise ValueError("用户人格目录超出存储根范围") from exc
    path = user_root / ".agent" / "prompt" / "persona.md"
    resolved = path.resolve(strict=False)
    try:
        resolved.relative_to(user_root)
    except ValueError as exc:
        raise ValueError("用户人格文件路径无效") from exc
    return path


def read_personality_file(user_id) -> str | None:
    path = personality_file_path(user_id)
    try:
        return normalize_personality_preference(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def write_personality_file(user_id, value: str | None) -> bool:
    """原子写入或删除用户人格文件，返回内容是否发生变化。"""
    normalized = normalize_personality_preference(value)
    path = personality_file_path(user_id)
    current = read_personality_file(user_id)
    if current == normalized:
        return False
    if normalized is None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".persona-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(normalized)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    return True


def normalize_personality_preference(value: str | None) -> str | None:
    """规范化用户文本；空文本等价于恢复默认。"""
    if value is None:
        return None
    text = value.strip()
    if len(text) > MAX_PERSONALITY_PREFERENCE_CHARS:
        raise ValueError(f"人格偏好不能超过 {MAX_PERSONALITY_PREFERENCE_CHARS} 个字符")
    if any(char in {"\x00", "\ufeff"} or (ord(char) < 32 and char not in _ALLOWED_CONTROL_CHARS) for char in text):
        raise ValueError("人格偏好包含不支持的控制字符")
    return text or None


def preference_revision(data: dict) -> int:
    try:
        return max(0, int(data.get("personality_preference_revision", 0)))
    except (TypeError, ValueError):
        return 0


def preference_updated_at(data: dict) -> datetime | None:
    raw = data.get("personality_preference_updated_at")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw))
    except ValueError:
        return None


async def invalidate_personality_snapshots(db, user_id=None) -> None:
    """让人格开关或文本变更在下一次请求读取新的稳定 snapshot。"""
    from sqlalchemy import select
    from app.models import ConversationSession

    query = select(ConversationSession)
    if user_id is not None:
        query = query.where(ConversationSession.user_id == user_id)
    rows = (await db.execute(query)).scalars().all()
    now = now_utc()
    for session in rows:
        session.snapshot_expires_at = now
