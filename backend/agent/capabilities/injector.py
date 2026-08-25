"""能力目录与 provider Schema 注入的纯函数。"""

from __future__ import annotations

from .index import CapabilityIndex
from .models import CapabilitySnapshot, SelectedCapabilities
from .selector import CapabilitySelector


CATALOG_DESCRIPTION_MAX_CHARS = 48


class CapabilityToolContext:
    """Run 内的能力上下文。

    固定 Adapter 模式只把稳定入口注册给 Provider，业务工具通过 ``use_skill``
    按需追加 canonical Schema；非固定模式保留 selector 供未来 RAG 候选接入。
    """

    def __init__(
        self,
        snapshot: CapabilitySnapshot,
        selector: CapabilitySelector,
        limit: int = 5,
        *,
        fixed_adapter: bool = False,
    ):
        self.snapshot = snapshot
        self.selector = selector
        self.limit = limit
        self.fixed_adapter = fixed_adapter
        # 交互工具必须在首轮可见。否则模型只能把选项写成普通文本，用户
        # 回复选项序号后会被当成新消息，无法恢复原来的 ask_user 挂起轮。
        self.always_available_tools = tuple(
            name for name in ("ask_user",) if name in snapshot.tools
        )
        initial = tuple(snapshot.tools)
        self.selection = SelectedCapabilities(tuple(dict.fromkeys(initial)))

    def select_for_messages(self, messages) -> SelectedCapabilities:
        if self.fixed_adapter:
            names = tuple(name for name in ("call_tool", "use_skill", "ask_user") if name in self.snapshot.tools)
            self.selection = SelectedCapabilities(names, shadow=False)
            return self.selection
        query = ""
        for message in reversed(getattr(messages, "conversation", messages) or []):
            if message.get("role") == "user":
                content = message.get("content", "")
                query = content if isinstance(content, str) else str(content)
                break
        self.selection = self.selector.select(query, self.snapshot, self.limit)
        return self.selection

    def skill_meta(self, name: str):
        value = str(name or "").strip().lower()
        return self.snapshot.skills.get(value)

    def skill_digest(self, name: str) -> str | None:
        meta = self.skill_meta(name)
        return (meta.content_digest or None) if meta is not None else None


def _build_fixed_context(index, *, limit: int = 5, names: list[str]) -> CapabilityToolContext:
    from .selector import RegistryCapabilitySelector
    snapshot = index.snapshot(authorized_names=names)
    return CapabilityToolContext(
        snapshot, RegistryCapabilitySelector(), limit=limit, fixed_adapter=True,
    )


def build_fixed_adapter_context(tool_names: list[str], *, limit: int = 5) -> CapabilityToolContext:
    """Phase 5：业务工具不进入 Provider tools，只保留固定 Adapter 入口。"""
    fixed = ["call_tool", "use_skill", "ask_user"]
    names = list(dict.fromkeys([*tool_names, *fixed]))
    return _build_fixed_context(CapabilityIndex.from_registries(tool_names=names), limit=limit, names=names)


async def build_fixed_adapter_context_for_user(
    tool_names: list[str], *, limit: int = 5, db=None, owner_id=None,
) -> CapabilityToolContext:
    """构建当前 owner 的能力快照；用户 Skill 只进入 metadata，不加载正文。"""
    if db is None or owner_id is None:
        return build_fixed_adapter_context(tool_names, limit=limit)
    names = list(dict.fromkeys([*tool_names, "call_tool", "use_skill", "ask_user"]))
    index = await CapabilityIndex.from_registries_for_user(db, owner_id, tool_names=names)
    return _build_fixed_context(index, limit=limit, names=names)


def catalog_block(snapshot: CapabilitySnapshot, *, kind: str | None = None) -> str:
    lines = [
        "## 当前可用能力索引",
        "这里只是稳定的能力名称和极短简介，不是已经发生的工具调用记录；"
        "固定 Adapter 模式下使用 `call_tool(name, arguments)` 调用业务工具。"
        "需要完整参数时，先使用 `use_skill`，对应的 canonical tool-schema 会追加到历史。",
    ]
    for item in snapshot.catalog:
        if kind is not None and item.kind != kind:
            continue
        if item.kind == "tool" and item.name not in snapshot.tools:
            continue
        description = " ".join(str(item.description_short or "").split())
        if len(description) > CATALOG_DESCRIPTION_MAX_CHARS:
            description = description[:CATALOG_DESCRIPTION_MAX_CHARS - 1].rstrip() + "…"
        lines.append(f"- {item.name}：{description}")
    return "\n".join(lines)


def selected_tool_names(selection: SelectedCapabilities) -> list[str]:
    return list(dict.fromkeys(selection.tool_names))
