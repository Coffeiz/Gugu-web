"""轻量 token 估算 + 历史窗口裁剪。

不引入 tokenizer 依赖，用 CJK 感知的廉价估算：中文/日文等表意字符约
1.3 token/字，其余（英文/数字/符号）约 4 字符/token。用于按 token 预算
裁剪对话历史，比按条数更贴近真实上下文体积与成本。
"""
from __future__ import annotations

# 历史窗口默认参数（后续可接入 AgentBehaviorSettings）
HISTORY_TOKEN_BUDGET = 3000   # 历史最多占用的估算 token
HISTORY_MAX_MSGS = 40         # 条数安全上限（兜底 DB 查询与极端情况）


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


def select_history(messages_newest_first: list, token_budget: int = HISTORY_TOKEN_BUDGET) -> list:
    """从最新往回按 token 预算收取历史，返回**时间正序**列表。

    - 整条进出，不切半条。
    - 至少保留最新一条（即使它单条超预算），以维持最低连续性。
    """
    picked = []
    used = 0
    for m in messages_newest_first:
        t = estimate_tokens(getattr(m, "content", "") or "")
        if picked and used + t > token_budget:
            break
        picked.append(m)
        used += t
    picked.reverse()
    return picked
