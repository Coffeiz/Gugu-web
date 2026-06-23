"""IM 出口兜底：咕咕回复发给用户之前的确定性清洗（prompt 之外的代码层保险）。

prompt 是概率性的（模型大概率守规矩但偶尔破）；这里做**确定性**拦截：
- 小泄露（tool_call id / 内部 id 噪声）→ 抹掉
- 大泄露（系统提示词被复述出来，多为 prompt injection 得手）→ 整条换成安全话术

只管**字面**泄露；语义层（「我是个 agent」这种换说法）仍靠 policy 提示词。仅 IM 路用
（run_collect，非流式、文字完整好扫）；网页流式另说。
"""
from __future__ import annotations

import re

# tool_call id / 内部 id：纯噪声，对用户无意义，直接抹掉
_NOISE = re.compile(
    r"\bcall_function_[A-Za-z0-9]+(?:_\d+)?\b"          # call_function_xxx_1
    r"|\bcall_[A-Za-z0-9]{12,}\b"                        # call_<长随机串>
    r"|\b(?:tool_use_id|trace_id|request_id|message_id|tool_id)\b"
    r"\s*[:=]?\s*[\"']?[A-Za-z0-9_\-]*[\"']?",
    re.IGNORECASE,
)

# 系统提示词被吐出的锚词：正常陪伴对话绝不会出现这些（多为 prompt injection 套出来）
_PROMPT_LEAK_ANCHORS = (
    "工具使用准则", "真实性铁律", "对外口径", "内容政策（红线", "执行规则",
    "不可逆操作", "四种相处状态", "主动思考（陪着", "高风险内容",
)

_DEFLECT = "我是咕咕呀~ 这个就不展开啦，你今天想做点啥？"


def sanitize_outbound(text: str) -> str:
    """清洗咕咕要发给用户的回复。返回清洗后的文本（大泄露则整条换成安全话术）。"""
    if not text:
        return text
    # 大泄露：系统提示词/规则被复述 → 整条换掉
    if any(a in text for a in _PROMPT_LEAK_ANCHORS):
        return _DEFLECT
    # 小泄露：抹掉 tool_id / 内部 id 噪声
    cleaned = _NOISE.sub("", text)
    if cleaned != text:
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)      # 抹完留下的多余空格
        cleaned = re.sub(r"\(\s*\)|（\s*）", "", cleaned)   # 残留空括号
        cleaned = cleaned.strip()
    return cleaned or _DEFLECT
