"""行为模块（Behavior Skills）：一文件一能力（DO+DON'T），按感知信号**条件点亮**、拼进 system prompt。

P1 起步只有 `emotion-first`。选择走**廉价线索**（本句 emotion cue）+ World Model(summary)——
不跑前置 LLM、零延迟；**软偏置、非硬切换**（persona 仍留四态地图，模型可自纠）。
增量长：以后加能力 = 加一个 behaviors/*.md + 在 select 里加点亮条件。
详见 docs/感知系统-架构升级.md §3.2 / §3.3。
"""
from __future__ import annotations

from pathlib import Path

_DIR = Path(__file__).parent / "prompts" / "behaviors"

# 情绪 cue（本句）。有明确任务动词则**不**点亮——"我好累，帮我把这个删了"仍是任务，照做。
_EMO_CUES = (
    "好累", "累死", "累惨", "疲惫", "烦死", "好烦", "烦躁", "难受", "难过", "伤心",
    "想哭", "崩溃", "压力好大", "压力大", "焦虑", "好丧", "emo", "摆烂", "不想干",
    "撑不住", "心累", "委屈", "郁闷", "没意思", "好无聊", "孤独", "孤单", "失眠", "扛不住",
)
_TASK_VERBS = (
    "帮我", "创建", "建个", "建一个", "改一下", "改成", "删掉", "删了", "查一下",
    "查查", "搜一下", "整理", "列一下", "移到", "重命名", "设个", "提醒我", "记一下",
)


def select(user_msg: str, summary: str = "") -> list[str]:
    """据本句廉价线索 + World Model 软点亮行为模块。保守：宁可不点、别误伤（过度共情也烦）。"""
    t = (user_msg or "").strip()
    if not t:
        return []
    has_emo = any(c in t for c in _EMO_CUES)
    has_task = any(v in t for v in _TASK_VERBS)
    out: list[str] = []
    if has_emo and not has_task:
        out.append("emotion-first")
    return out


def render(names: list[str]) -> str:
    """把点亮的模块拼成 system prompt 块（hot-read .md，缺失/读失败跳过，绝不抛）。"""
    parts = []
    for n in names or []:
        try:
            parts.append((_DIR / f"{n}.md").read_text(encoding="utf-8").strip())
        except Exception:
            pass
    return "\n\n".join(p for p in parts if p)
