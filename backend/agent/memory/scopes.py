"""IM 记忆作用域与安全存储 key。

这里不负责权限判断或文件内容解析，只负责把经过业务层确认的 scope
转换为不会发生路径穿越的对象存储前缀。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple
from urllib.parse import quote


IM_MEMORY_TYPES: Tuple[str, ...] = ("group", "platform-user")


def member_scope_id(group_id: object, platform_user_id: object) -> str:
    """把群和发言人绑定进旧的 scope_id 字段，兼容现有 DB schema。"""
    return f"{str(group_id).strip()}:{str(platform_user_id).strip()}"


def split_member_scope_id(scope_id: object) -> tuple[str, str]:
    value = str(scope_id or "")
    group_id, separator, member_id = value.partition(":")
    return (group_id, member_id) if separator else ("", value)


def _component(value: object, field: str) -> str:
    text = str(value or "").strip()
    if not text or text in {".", ".."} or "/" in text or "\\" in text or "\x00" in text:
        raise ValueError(f"无效的记忆作用域字段: {field}")
    return quote(text, safe="-._~")


@dataclass(frozen=True)
class MemoryScope:
    """一个 Bot 下的群组或平台用户记忆范围。"""

    owner_user_id: object
    platform: str
    bot_id: str
    scope_type: str
    scope_id: str

    def __post_init__(self) -> None:
        if self.scope_type not in IM_MEMORY_TYPES:
            raise ValueError(f"不支持的记忆作用域类型: {self.scope_type}")
        if not self.platform.strip() or not self.bot_id.strip():
            raise ValueError("记忆作用域必须包含 platform 和 bot_id")
        if not self.scope_id.strip():
            raise ValueError("记忆作用域必须包含 scope_id")
        for value, field in (
            (self.owner_user_id, "owner_user_id"),
            (self.platform, "platform"),
            (self.bot_id, "bot_id"),
            (self.scope_id, "scope_id"),
        ):
            _component(value, field)

    @property
    def prefix(self) -> str:
        branch = "groups" if self.scope_type == "group" else "platform-users"
        return "/".join((
            _component(self.owner_user_id, "owner_user_id"),
            ".agent", "im",
            _component(self.platform, "platform"),
            _component(self.bot_id, "bot_id"),
            branch,
            _component(self.scope_id, "scope_id"),
        ))

    @property
    def lock_key(self) -> str:
        """反思与删除共用的 scope 锁，防止删除过程中旧任务写回文件。"""
        return f"memory:scope:lock:{self.prefix}"

    @property
    def files(self) -> Tuple[str, ...]:
        if self.scope_type == "group":
            return ("profile.json", "summary.json", "daily.md", "memory.md", "members.json")
        return ("profile.json", "pattern.json", "summary.json", "memory.md")

    def key(self, filename: str) -> str:
        if filename not in self.files:
            raise ValueError(f"文件不属于当前记忆作用域: {filename}")
        return f"{self.prefix}/{filename}"
