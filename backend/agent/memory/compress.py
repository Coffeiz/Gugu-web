"""记忆压缩：daily 攒够后，把最老的条目沉淀进 memory.md（长期记忆主档）。

机制（按累积条数，不按天数，便于直接控住注入 prompt 的体积）：
- daily 达到 `DAILY_COMPACT_AT`(100) 触发
- 每次只取最老的 `COMPACTION_BATCH_SIZE`(100) 条 → 连同已有 memory.md 交 LLM 整理
- 写回 memory.md，daily 保留最近 DAILY_KEEP_RECENT(50) 条和未处理的旧记录
压缩失败时不裁剪 daily，避免历史丢失。由 reflection 在写完 daily 后顺带触发，失败不影响主流程。
"""
from __future__ import annotations

import re
from pathlib import Path

from agent.memory import store
from agent.memory.daily_compaction import merge_remaining, should_compact, split_batch
from agent.memory._llm import complete_json

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
_SYS_FALLBACK = (
    "你在帮咕咕维护用户的长期记忆主档。把近期记录并入已有长期记忆，"
    "合并明确重复、修正矛盾，并保留有价值的历史、日期、事件背景和变化过程。"
    "不要因为内容较旧、较细或篇幅限制而删除历史；稳定结论可以不重复，但不能因此丢掉事件背景。"
    "不评判、不推测，日期和时间顺序必须保留。"
    '严格只输出 JSON：{"memory": "更新后的长期记忆全文（没有可沉淀的就原样返回，别清空）"}'
)

_DATE_RE = re.compile(r"20\d{2}-\d{1,2}-\d{1,2}")


def _preserves_incoming_dates(overflow: list[str], memory: str) -> bool:
    """新沉淀批次带日期时，防止 LLM 整体重写时把这批历史的时间锚点全丢掉。"""
    dates = set(_DATE_RE.findall("\n".join(overflow)))
    return not dates or dates.issubset(set(_DATE_RE.findall(memory)))


def _load_sys() -> str:
    try:
        return (_PROMPTS_DIR / "compress.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return _SYS_FALLBACK


async def compact(user_id, settings) -> bool:
    """daily 超阈值则压缩一次。返回是否执行了压缩。失败不抛。"""
    try:
        lines = await store.read_daily_lines(user_id)
        if not should_compact(
            len(lines), trigger=store.DAILY_COMPACT_AT,
            keep_recent=store.DAILY_KEEP_RECENT,
        ):
            return False

        recent, overflow, remaining = split_batch(
            lines, keep_recent=store.DAILY_KEEP_RECENT,
        )
        if not overflow:
            return False

        existing_memory = await store.read_memory_doc(user_id)
        profile = await store.read_profile_list(user_id)
        pattern = await store.read_pattern_list(user_id)
        user = (
            f"已有的长期记忆：\n{existing_memory or '（暂无）'}\n\n"
            f"已结构化的用户画像（这些是稳定结论，别在长期记忆里原句复写）：\n"
            f"{store.render_profile(profile) or '（暂无）'}\n\n"
            f"已结构化的行为模式（这些是可复用规律，别在长期记忆里原句复写）：\n"
            f"{store.render_pattern(pattern) or '（暂无）'}\n\n"
            f"要沉淀进来的近期记录（按日期保留有价值的历史，不要丢掉日期）：\n" + "\n".join(overflow) + "\n\n"
            f"请输出整理后的完整长期记忆主档。"
        )
        out = await complete_json(_load_sys(), user, settings, max_tokens=10000)
        new_memory = (out.get("memory") or "").strip()

        # 防误删兜底：模型返回空或丢掉本批次全部日期 → 不覆盖，也不裁 daily。
        if (not new_memory and existing_memory) or not _preserves_incoming_dates(overflow, new_memory):
            return False

        if new_memory:
            await store.write_memory_doc(user_id, new_memory)
            await store.sync_memory_vecs(user_id, new_memory)   # 长期记忆重写→重嵌块向量（embedding 未启用=no-op）
        # 压缩成功才裁 daily（沉淀的内容已进 memory）
        await store.write_daily_lines(user_id, merge_remaining(recent, remaining))
        return True
    except Exception:
        return False  # 压缩是后台优化，任何失败都不影响主流程
