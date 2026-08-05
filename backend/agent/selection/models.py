"""平台无关的选择交互协议模型。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class SelectionOption:
    """一个可被平台 Keyboard 或文本 fallback 表达的选项。"""

    label: str
    value: str


@dataclass(frozen=True)
class SelectionPrompt:
    """一次选择请求；当前只生成模型，不管理等待和回调生命周期。"""

    action_id: str
    title: str
    options: List[SelectionOption] = field(default_factory=list)
    context: Dict[str, Any] = field(default_factory=dict)
    expires_at: Optional[str] = None
