"""IM 出口兜底：咕咕回复发给用户之前的确定性清洗（prompt 之外的代码层保险）。

prompt 是概率性的（模型大概率守规矩但偶尔破）；这里做**确定性**拦截：
- 小泄露（tool_call id / 内部 id 噪声）→ 抹掉
- 大泄露（系统提示词被复述出来，多为 prompt injection 得手）→ 整条换成安全话术

只管**字面**泄露；语义层（「我是个 agent」这种换说法）仍靠 policy 提示词。IM 路（run_collect）会调用，防止「脏内容混进历史，污染下一轮」。
"""
from __future__ import annotations

import re

# 这是 Web 内部动作协议，不是 IM 平台可发送的外链。IM 出站保留可读文案，
# 由 Web 聊天继续保留原始 gugu:// href 并处理点击。
_GUGU_MARKDOWN_LINK_RE = re.compile(
    r"\[([^\]\n]+)\]\(gugu://[^)\s]+\)", re.IGNORECASE
)
_GUGU_URI_RE = re.compile(r"(?<![\w])gugu://[^\s)]+", re.IGNORECASE)


def sanitize_im_links(text: str) -> str:
    """把 Web 专用 gugu:// 动作链接转换为适合 IM 发送的可读文本。"""
    text = _GUGU_MARKDOWN_LINK_RE.sub(r"\1", text)
    return _GUGU_URI_RE.sub("", text)

# tool_call id / 内部 id：纯噪声，对用户无意义，直接抹掉
_NOISE = re.compile(
    r"\bcall_function_[A-Za-z0-9]+(?:_\d+)?\b"          # call_function_xxx_1
    r"|\bcall_[A-Za-z0-9]{12,}\b"                        # call_<长随机串>
    r"|\b(?:tool_use_id|trace_id|request_id|message_id|tool_id)\b"
    r"\s*[:=]?\s*[\"']?[A-Za-z0-9_\-]*[\"']?",
    re.IGNORECASE,
)

# 伪工具调用语法泄露：某些模型偶尔不走正常的结构化 tool_calls，而是把 <function=xxx>/
# <parameter=xxx> 这类（Llama 风格）伪 XML 语法直接当成回复正文吐出来——不只是体验难看，
# 这段畸形文本会被存进对话历史，下一轮当作历史消息发回去时，MiniMax 的 prefill 解析这段
# 内容直接 400（devlog 2026-07-14：BadRequestError "prefill failed: unexpected end of
# data"）。一旦泄露出这个开头，后面到本条消息结尾的内容全部丢弃（不尝试挽救半截 XML），
# 通常前面已经有一段正常的自然语言回复，只截掉泄露开始之后的部分不影响体验。
_FUNCTION_LEAK = re.compile(r"<function=.*", re.DOTALL)

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
    # 伪工具调用语法泄露：截掉泄露开始往后的全部内容，前面的正常文字保留
    text = _FUNCTION_LEAK.sub("", text).rstrip()
    # 小泄露：抹掉 tool_id / 内部 id 噪声
    cleaned = _NOISE.sub("", text)
    if cleaned != text:
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)      # 抹完留下的多余空格
        cleaned = re.sub(r"\(\s*\)|（\s*）", "", cleaned)   # 残留空括号
        cleaned = cleaned.strip()
    return cleaned or _DEFLECT
