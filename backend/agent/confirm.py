"""删除二次确认 · 保底机制（显式 confirm 参数）。

不可逆删除工具在执行前调用 `needs_confirmation(args, summary)`：
- 未带 `confirm=true` → 返回需确认结果（**不执行删除**），模型据此把影响转达用户；
- 用户明确同意后，模型带 `confirm=true` 再次调用 → 放行执行。

物理保底：handler 不带 confirm 时绝不删除。模型被工具描述与 persona 指示"仅在
用户明确同意后才置 confirm=true"。比早期"跨轮强制"更贴合模型自然行为（模型常先
用文字征询），避免多轮反复确认、删不掉的问题。
"""
from __future__ import annotations

import json


def _truthy(v) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in ("true", "1", "yes"))


def needs_confirmation(args: dict, summary: str) -> str | None:
    """返回 None=已确认可执行；返回 JSON 字符串=需确认（调用方直接返回给模型）。"""
    if _truthy(args.get("confirm")):
        return None
    return json.dumps({
        "needs_confirm": True,
        "summary": summary,
        "instruction": "这是不可逆操作。请把上述影响转达用户；待用户明确同意后，带 confirm=true 再次调用本工具执行。",
    }, ensure_ascii=False)
