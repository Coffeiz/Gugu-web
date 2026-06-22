"""记忆存储：读写 {user_id}/.agent/ 下的 markdown，经 StorageBackend（本地/OSS 通吃）。

不进 File 表，是咕咕私有档案。单库，无 DB/物理同步问题。
- facts.md   稳定事实：用户是谁、偏好、习惯（反思调和重写）
- daily.md   近期记忆：每次对话提炼的要点，带日期，新在上
- memory.md  长期记忆：daily 老条目压缩沉淀的长期叙述（compress 生成）

daily 不再"满了直接丢"，而是**按累积条数压缩**：攒到 DAILY_COMPACT_AT 触发，
最老的并入 memory.md、daily 留回最近 DAILY_KEEP_RECENT 条（见 compress.py）。
DAILY_HARD_CAP 是压缩失败时的安全上限，防 daily 无限膨胀。
"""
from __future__ import annotations

from app.services.storage import get_storage

_DIR = ".agent"
DAILY_KEEP_RECENT = 30   # 压缩后 daily 保留的最近条数（也是注入 prompt 的量）
DAILY_COMPACT_AT  = 40   # daily 达到此条数触发一次压缩（每约 10 轮一次）
DAILY_HARD_CAP    = 60   # 压缩失败时的硬安全上限


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
    """返回 {facts, memory, daily}，缺失为空串。"""
    facts  = (await _read(_key(user_id, "facts.md"))).strip()
    memory = (await _read(_key(user_id, "memory.md"))).strip()
    daily  = (await _read(_key(user_id, "daily.md"))).strip()
    return {"facts": facts, "memory": memory, "daily": daily}


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


# ── memory.md（长期记忆，compress 写）──
async def read_memory_doc(user_id) -> str:
    return (await _read(_key(user_id, "memory.md"))).strip()


async def write_memory_doc(user_id, text: str) -> None:
    await _write(_key(user_id, "memory.md"), text.strip() + "\n")


# ── daily.md（按行存，新在上）──
async def read_daily_lines(user_id) -> list[str]:
    existing = await _read(_key(user_id, "daily.md"))
    return [l for l in existing.splitlines() if l.strip()]


async def write_daily_lines(user_id, lines: list[str]) -> None:
    await _write(_key(user_id, "daily.md"), "\n".join(lines) + "\n")


async def append_daily(user_id, date: str, note: str) -> None:
    """daily.md 顶部加一条带日期记录。压缩由 compress.compact 处理；此处只兜底硬上限。"""
    note = note.strip()
    if not note:
        return
    lines = await read_daily_lines(user_id)
    lines.insert(0, f"- {date} {note}")
    await write_daily_lines(user_id, lines[:DAILY_HARD_CAP])
