"""记忆存储：读写 {user_id}/.agent/ 下的 markdown，经 StorageBackend（本地/OSS 通吃）。

不进 File 表，是咕咕私有档案。单库，无 DB/物理同步问题。
- facts.md  稳定事实：用户是谁、偏好、习惯（增量合并）
- daily.md  近期记忆：每次对话提炼的要点，带日期，滚动保留最近 DAILY_KEEP 条
"""
from __future__ import annotations

from app.services.storage import get_storage

_DIR = ".agent"
DAILY_KEEP = 30


def _key(user_id, name: str) -> str:
    return f"{user_id}/{_DIR}/{name}"


async def _read(key: str) -> str:
    try:
        data = await get_storage().get(key)
        return data.decode("utf-8", errors="replace")
    except Exception:
        return ""  # 文件不存在（本地 FileNotFoundError / OSS NoSuchKey）→ 空


async def _write(key: str, text: str) -> None:
    await get_storage().put(key, text.encode("utf-8"), "text/markdown")


async def read_memory(user_id) -> dict:
    """返回 {facts, daily}，缺失为空串。"""
    facts = (await _read(_key(user_id, "facts.md"))).strip()
    daily = (await _read(_key(user_id, "daily.md"))).strip()
    return {"facts": facts, "daily": daily}


def format_facts(facts: list[str]) -> str:
    """把"全量事实列表"格式化为 markdown bullet（去重保序）。反思调和重写用。"""
    lines: list[str] = []
    seen: set[str] = set()
    for f in facts:
        f = str(f).strip().lstrip("-").strip()
        k = f.lower()
        if f and k not in seen:
            seen.add(k)
            lines.append(f"- {f}")
    return "\n".join(lines)


def merge_facts(existing: str, new_facts: list[str]) -> str:
    """把新事实追加到已有 facts（按内容去重，已含则跳过）。返回合并后文本。"""
    lines = [l for l in existing.splitlines() if l.strip()]
    haystack = existing.lower()
    for f in new_facts:
        f = str(f).strip().lstrip("-").strip()
        if f and f.lower() not in haystack:
            lines.append(f"- {f}")
            haystack += "\n" + f.lower()
    return "\n".join(lines)


async def write_facts(user_id, facts_md: str) -> None:
    await _write(_key(user_id, "facts.md"), facts_md.strip() + "\n")


async def append_daily(user_id, date: str, note: str) -> None:
    """daily.md 顶部加一条带日期记录，滚动保留最近 DAILY_KEEP 条。"""
    note = note.strip()
    if not note:
        return
    existing = await _read(_key(user_id, "daily.md"))
    lines = [l for l in existing.splitlines() if l.strip()]
    lines.insert(0, f"- {date} {note}")
    await _write(_key(user_id, "daily.md"), "\n".join(lines[:DAILY_KEEP]) + "\n")
