"""KeyStrategy：物理 storage key 的生成策略（P0.1，见 docs/refactor/文件存储架构方案.md 附三）。

现在只有 `PathMirrorStrategy`（Local，可挂盘浏览，存量方案）；OSS 到来时加 `OpaqueStrategy`，
**签名不变**。业务命名（space/项目/文件夹 → 逻辑路径）在 `keys.compose_logical_path`，本层只吃结果。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from app.services.storage.keys import _safe_name, _resolve_conflict


@dataclass
class KeyContext:
    """构造 storage key 所需的全部上下文——**只放存储字段**，不放业务字段（project_year 等）。"""
    user_id: UUID            # 运行时是 User.id；测试可传 int（仅做 f-string 插值）
    file_id: int | None      # Opaque 用；PathMirror 忽略
    name: str
    ext: str
    logical_path: str = ""   # 已解析的可浏览逻辑路径（compose_logical_path 产出）


@dataclass
class ResolvedKey:
    """冲突改名后 key 与 name 都会变，两者都要落库（storage_key + display_name）。"""
    key: str
    name: str


class KeyStrategy(Protocol):
    def build_key(self, ctx: KeyContext) -> str: ...
    async def resolve_conflict(self, storage, base_key: str, display_name: str, ext: str) -> ResolvedKey: ...
    @property
    def move_semantics(self) -> Literal["relocate", "db-only"]: ...


class PathMirrorStrategy:
    """路径镜像：key = `{uid}/{logical_path}/{safe_name}.{ext}`。可挂盘浏览；移动=物理搬（relocate）。"""

    def build_key(self, ctx: KeyContext) -> str:
        return f"{ctx.user_id}/{ctx.logical_path}/{_safe_name(ctx.name)}.{ctx.ext.lower()}"

    async def resolve_conflict(self, storage, base_key: str, display_name: str, ext: str) -> ResolvedKey:
        key, name = await _resolve_conflict(storage, base_key, display_name, ext)
        return ResolvedKey(key=key, name=name)

    @property
    def move_semantics(self) -> Literal["relocate", "db-only"]:
        return "relocate"
