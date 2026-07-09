"""记忆压缩：daily 攒够后，把最老的条目沉淀进 memory.md（长期记忆）。

机制（按累积条数，不按天数，便于直接控住注入 prompt 的体积）：
- daily 达到 `DAILY_COMPACT_AT`(75) 触发
- 取最老的 `len - DAILY_KEEP_RECENT`(余 50) 条 → 连同已有 memory.md 交 LLM 融合
- 写回 memory.md，daily 留最近 DAILY_KEEP_RECENT(50) 条
即约每 25 轮对话压一次。由 reflection 在写完 daily 后顺带触发，失败不影响主流程。
"""
from __future__ import annotations

from pathlib import Path

from agent.memory import store
from agent.memory._llm import complete_json

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
_SYS_FALLBACK = (
    "你在帮咕咕维护用户的长期记忆。把近期记录里值得长期保留的并入已有长期记忆，"
    "合并重复、修正矛盾、丢弃琐碎，控制篇幅、越压越精，不评判不推测。"
    "已经能被用户画像/行为模式清楚表达的稳定结论，不要在长期记忆里原句复写；长期记忆只保留事件背景、时间脉络、变化过程。"
    '严格只输出 JSON：{"memory": "更新后的长期记忆全文（没有可沉淀的就原样返回，别清空）"}'
)


def _load_sys() -> str:
    try:
        return (_PROMPTS_DIR / "compress.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return _SYS_FALLBACK


async def compact(user_id, settings) -> bool:
    """daily 超阈值则压缩一次。返回是否执行了压缩。失败不抛。"""
    try:
        lines = await store.read_daily_lines(user_id)
        if len(lines) < store.DAILY_COMPACT_AT:
            return False

        recent = lines[:store.DAILY_KEEP_RECENT]   # 新在上，保留最近
        overflow = lines[store.DAILY_KEEP_RECENT:]  # 最老的，沉淀进长期
        if not overflow:
            return False

        existing_memory = await store.read_memory_doc(user_id)
        profile = await store.read_profile_list(user_id)
        pattern = await store.read_facts_list(user_id)
        user = (
            f"已有的长期记忆：\n{existing_memory or '（暂无）'}\n\n"
            f"已结构化的用户画像（这些是稳定结论，别在长期记忆里原句复写）：\n"
            f"{store.render_profile(profile) or '（暂无）'}\n\n"
            f"已结构化的行为模式（这些是可复用规律，别在长期记忆里原句复写）：\n"
            f"{store.render_facts(pattern) or '（暂无）'}\n\n"
            f"要沉淀进来的近期记录（旧→可丢琐碎）：\n" + "\n".join(overflow) + "\n\n"
            f"请输出融合后的长期记忆全文。"
        )
        out = await complete_json(_load_sys(), user, settings, max_tokens=1200)
        new_memory = (out.get("memory") or "").strip()

        # 防误删兜底：原本有长期记忆、模型却返回空 → 不覆盖，且不裁 daily（避免丢数据）
        if not new_memory and existing_memory:
            return False

        if new_memory:
            await store.write_memory_doc(user_id, new_memory)
            await store.sync_memory_vecs(user_id, new_memory)   # 长期记忆重写→重嵌块向量（embedding 未启用=no-op）
        # 压缩成功才裁 daily（沉淀的内容已进 memory）
        await store.write_daily_lines(user_id, recent)
        return True
    except Exception:
        return False  # 压缩是后台优化，任何失败都不影响主流程
