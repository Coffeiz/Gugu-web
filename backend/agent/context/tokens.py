"""轻量 token 估算 + 历史窗口裁剪。

不引入 tokenizer 依赖，用 CJK 感知的廉价估算：中文/日文等表意字符约
1.3 token/字，其余（英文/数字/符号）约 4 字符/token。用于按 token 预算
裁剪对话历史，比按条数更贴近真实上下文体积与成本。
"""
from __future__ import annotations

# 历史窗口默认参数（后续可接入 AgentBehaviorSettings）
HISTORY_TOKEN_BUDGET = 999999   # 历史最多占用的估算 token（临时取消限制）
HISTORY_MAX_MSGS = 9999         # 条数安全上限（临时取消限制）


def estimate_tokens(text: str) -> int:
    """CJK 感知的 token 估算。宁可略高估，避免超窗。"""
    if not text:
        return 0
    cjk = 0
    for ch in text:
        o = ord(ch)
        # CJK 统一表意 + 扩展A + 假名 + 全角标点
        if (0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF
                or 0x3040 <= o <= 0x30FF or 0xFF00 <= o <= 0xFFEF):
            cjk += 1
    other = len(text) - cjk
    return int(cjk * 1.3 + other / 4) + 1


def msg_tokens(m) -> int:
    """一条 ConversationMessage 的估算 token——含 content_json（工具轮次正文在此，不在 content）。"""
    cj = getattr(m, "content_json", None)
    if cj is not None:
        import json
        try:
            return estimate_tokens(json.dumps(cj, ensure_ascii=False))
        except Exception:
            return estimate_tokens(str(cj))
    return estimate_tokens(getattr(m, "content", "") or "")


def select_history(messages_newest_first: list, token_budget: int = HISTORY_TOKEN_BUDGET) -> list:
    """从最新往回按 token 预算收取历史，返回**时间正序**列表。

    - summary 消息（role="summary"）始终置顶，不计入 token 预算截断。
    - 整条进出，不切半条。
    - 至少保留最新一条（即使它单条超预算），以维持最低连续性。
    """
    summary = None
    normal = []
    for m in messages_newest_first:
        if getattr(m, "role", None) == "summary":
            if summary is None:
                summary = m   # 只取最新那条（正常只有一条）
        else:
            normal.append(m)

    picked = []
    used = 0
    for m in normal:
        t = msg_tokens(m)
        if picked and used + t > token_budget:
            break
        picked.append(m)
        used += t
    picked.reverse()

    if summary:
        picked = [summary] + picked
    return picked
