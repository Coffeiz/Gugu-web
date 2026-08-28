"""交互式 PTY 与 sandboxd 之间的 JSON Lines 协议校验。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


PtyClientMessageType = Literal["input", "resize", "signal", "detach"]
PtyServerMessageType = Literal["ready", "output", "status", "exit", "error"]
_SIGNALS = {"SIGINT", "SIGTERM", "SIGTSTP"}


@dataclass(frozen=True)
class PtyClientMessage:
    type: PtyClientMessageType
    data: str | None = None
    cols: int | None = None
    rows: int | None = None
    signal: str | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "PtyClientMessage":
        if not isinstance(value, dict):
            raise ValueError("PTY 客户端消息必须是对象")
        message_type = value.get("type")
        if message_type not in {"input", "resize", "signal", "detach"}:
            raise ValueError("PTY 客户端消息类型无效")
        if message_type == "input":
            data = value.get("data")
            if not isinstance(data, str) or not data:
                raise ValueError("PTY input 缺少 data")
            if len(data.encode("utf-8")) > 64 * 1024:
                raise ValueError("PTY input 超出单次大小限制")
            return cls(type="input", data=data)
        if message_type == "resize":
            cols, rows = value.get("cols"), value.get("rows")
            if not isinstance(cols, int) or not isinstance(rows, int):
                raise ValueError("PTY resize 缺少有效尺寸")
            if not 20 <= cols <= 500 or not 5 <= rows <= 200:
                raise ValueError("PTY resize 超出范围")
            return cls(type="resize", cols=cols, rows=rows)
        if message_type == "signal":
            signal = value.get("signal")
            if signal not in _SIGNALS:
                raise ValueError("PTY signal 不受支持")
            return cls(type="signal", signal=signal)
        return cls(type="detach")


@dataclass(frozen=True)
class PtyServerMessage:
    type: PtyServerMessageType
    data: str | None = None
    terminal_id: str | None = None
    cols: int | None = None
    rows: int | None = None
    status: str | None = None
    code: int | None = None
    signal: str | None = None
    error_code: str | None = None

    @classmethod
    def output(cls, data: str) -> "PtyServerMessage":
        if not data:
            raise ValueError("PTY output 不能为空")
        return cls(type="output", data=data)


__all__ = ["PtyClientMessage", "PtyClientMessageType", "PtyServerMessage", "PtyServerMessageType"]
