"""最终回复守卫与 goal/verify 收尾判定（PRD-LLM-25 LLM25-012 / FR-LLM25-006）。

基础文本判断复用 `security/core_guards.py` 与 locale 文案；本模块只承载
goal 协议、核实占位与完成标记这类 Loop 收尾判定的单一实现，
`core.py` 保留兼容导出供旧测试导入。
"""
from __future__ import annotations

import re as _re_mod

_GOAL_DONE_MARKER = "<!-- GUGU_GOAL_DONE -->"


def goal_completed(text: str) -> bool:
    """判定最终答复是否携带 goal 完成标记。"""
    return bool(text) and _GOAL_DONE_MARKER in text


def strip_goal_marker(text: str) -> str:
    """剥掉 goal 完成标记；标记不向用户展示。"""
    return text.replace(_GOAL_DONE_MARKER, "").rstrip()


def is_verify_placeholder(text: str) -> bool:
    """判断核验轮文本是否只是过程播报，而不是可以直接交付的结果摘要。"""
    normalized = _re_mod.sub(r"[\s，。！？、,.!?：:；;‘’“”\"'`~～…]+", "", text or "")
    if not normalized:
        return True
    process_phrases = (
        "确认一下", "核实一下", "检查一下", "看一下", "查一下",
        "正在核实", "正在检查", "正在确认", "已核实", "已确认",
        "核对完成", "复查完成", "都核实过了", "没问题",
    )
    return len(normalized) <= 16 and any(phrase in normalized for phrase in process_phrases)
