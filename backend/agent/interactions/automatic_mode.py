"""交互式 Agent 的自动模式与确认类别。"""

from __future__ import annotations

from contextvars import ContextVar, Token
from enum import StrEnum


class ConfirmationPurpose(StrEnum):
    """操作确认可跳过；权限或访问范围授权必须由用户明确确认。"""

    ACTION = "action"
    AUTHORIZATION = "authorization"


ACTION = ConfirmationPurpose.ACTION
AUTHORIZATION = ConfirmationPurpose.AUTHORIZATION


_automatic_mode_enabled: ContextVar[bool] = ContextVar(
    "agent_automatic_mode_enabled", default=False
)


def set_automatic_mode_enabled(enabled: bool) -> Token[bool]:
    return _automatic_mode_enabled.set(enabled is True)


def reset_automatic_mode_enabled(token: Token[bool]) -> None:
    _automatic_mode_enabled.reset(token)


def is_automatic_mode_enabled() -> bool:
    return _automatic_mode_enabled.get()


def should_skip_confirmation(purpose: ConfirmationPurpose) -> bool:
    return purpose is ConfirmationPurpose.ACTION and is_automatic_mode_enabled()


__all__ = [
    "ACTION", "AUTHORIZATION", "ConfirmationPurpose", "is_automatic_mode_enabled", "reset_automatic_mode_enabled",
    "set_automatic_mode_enabled", "should_skip_confirmation",
]
