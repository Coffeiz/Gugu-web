"""行为模块（Behavior Skills）：一文件一能力（DO+DON'T），按本轮 stance 条件点亮、拼进 system prompt。

选择走**反思驱动 stance**（异步 LLM 判，非正则）：反思把本轮 `perception.intent` 当 stance 落 per-user，
builder 下一轮读它 + 新鲜度闸 → 1:1 点亮模块。`baseline` **永远在场**（四态地图 + 中性默认），
具体 stance 模块叠在其上；stance 过期/缺失 → 仅 baseline。详见 docs/agent/感知系统.md §2.6。
"""
from __future__ import annotations

import time
from pathlib import Path

_DIR = Path(__file__).parent / "prompts" / "behaviors"

# stance（= 反思 perception.intent）→ 行为模块。1:1 映射（见 §2.6）。
_STANCE_MODULE = {
    "执行": "execution",
    "推进": "stuck-first", "卡住": "stuck-first",
    "记录": "record",
    "查询": "query",
    "决策": "decision-explore", "决策探索": "decision-explore",
    "反思": "reflect",
    "情绪": "emotion-first",
    "陪伴": "companion", "闲聊": "companion", "分享": "companion",
}

# 新鲜度闸：stance 超此秒数（默认 30 分钟）视为过期 → 退回仅 baseline。
# stance 是 per-user、跨 session（一天可能多 session），防昨晚某 stance 污染今早新 session 首轮。
STANCE_FRESH_SECS = 1800


def select(stance: str | None, stance_ts: float | None = None) -> list[str]:
    """据 per-user stance（反思上轮判的 intent）+ 新鲜度软点亮。
    `baseline` 永远在场；stance 新鲜且有映射 → 叠上对应模块；过期/缺失 → 仅 baseline。"""
    names = ["baseline"]
    s = (stance or "").strip()
    if not s:
        return names
    # 新鲜度闸：有 ts 且超窗口 → 当过期（无 ts 兼容旧数据，按新鲜处理）
    if stance_ts is not None and (time.time() - stance_ts) > STANCE_FRESH_SECS:
        return names
    mod = _STANCE_MODULE.get(s)
    if mod and mod not in names:
        names.append(mod)
    return names


def render(names: list[str]) -> str:
    """把点亮的模块拼成 system prompt 块（hot-read .md，缺失/读失败跳过，绝不抛）。"""
    parts = []
    for n in names or []:
        try:
            parts.append((_DIR / f"{n}.md").read_text(encoding="utf-8").strip())
        except Exception:
            pass
    return "\n\n".join(p for p in parts if p)
