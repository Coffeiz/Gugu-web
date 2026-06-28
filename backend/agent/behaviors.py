"""行为模块（Behavior Skills）：一文件一能力（DO+DON'T），按感知信号**条件点亮**、拼进 system prompt。

现有三个：`emotion-first`（接情绪·Presence）、`stuck-first`（卡住给最小一步·Advance）、
`decision-explore`（纠结里陪想清·Decide-with）。选择走**廉价线索**（本句 cue）+ World Model(summary)——
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
# 卡住 cue（推进·家族 A）：带任务动词也照点（"帮我推进，卡住了" 仍是要找最小一步）
_STUCK_CUES = (
    "卡住", "卡了", "卡在", "推进不", "进行不", "搞不定", "弄不下去", "做不下去",
    "没思路", "没头绪", "无从下手", "不知道怎么开始", "不知道从哪", "不知道先做",
    "迈不开", "动不了", "停滞", "一直拖", "推不动", "进展不", "起不了头",
)
# 纠结 cue（决策探索·家族 B）：带任务动词也照点（"帮我选" 仍是陪决策、非替决）
_DECISION_CUES = (
    "纠结", "犹豫", "拿不定", "拿不准", "选哪个", "选哪", "哪个好", "哪个更",
    "二选一", "要不要", "该不该", "举棋不定", "难抉择", "难选", "不知道选",
    "怎么选", "做不了决定", "下不了决心",
)


def select(user_msg: str, summary: str = "") -> list[str]:
    """据本句廉价线索 + World Model 软点亮行为模块。保守：宁可不点、别误伤（过度共情也烦）。
    最小裁决（完整组合裁决待做，见 §8.2）：**情绪在场优先接情绪**、不与任务型模块叠加——
    避免"该好好接住却又开始给方案/摆权衡"；其余任务型模块（stuck/decision）可共存。"""
    t = (user_msg or "").strip()
    if not t:
        return []
    tl = t.lower()   # 小写化容英文选项（"选A还是B"）；中文 cue 不受影响
    has_emo = any(c in tl for c in _EMO_CUES)
    has_task = any(v in tl for v in _TASK_VERBS)
    if has_emo and not has_task:
        return ["emotion-first"]
    out: list[str] = []
    if any(c in tl for c in _STUCK_CUES):
        out.append("stuck-first")
    # "还是"单独太宽（"还是算了"），但与"选"同现是明确"选 A 还是 B"决策信号
    if any(c in tl for c in _DECISION_CUES) or ("还是" in tl and "选" in tl):
        out.append("decision-explore")
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
