"""能力目录与 provider Schema 注入的纯函数。"""

from __future__ import annotations

from .models import CapabilitySnapshot, SelectedCapabilities
from .selector import CapabilitySelector


class CapabilityToolContext:
    """Run 内的两阶段工具上下文。

    首轮只保留 ``declare_tools``；模型声明后，下一轮才携带声明工具的完整
    Schema。RAG 未来只替换候选来源，不改变这里的声明、权限和注入职责。
    """

    def __init__(
        self,
        snapshot: CapabilitySnapshot,
        selector: CapabilitySelector,
        limit: int = 12,
        *,
        declaration_enabled: bool = False,
        declaration_tool: str = "declare_tools",
        fixed_adapter: bool = False,
    ):
        self.snapshot = snapshot
        self.selector = selector
        self.limit = limit
        self.declaration_enabled = declaration_enabled and declaration_tool in snapshot.tools
        self.declaration_tool = declaration_tool
        self.fixed_adapter = fixed_adapter
        # 交互工具必须在首轮可见。否则模型只能把选项写成普通文本，用户
        # 回复选项序号后会被当成新消息，无法恢复原来的 ask_user 挂起轮。
        self.always_available_tools = tuple(
            name for name in ("ask_user",) if name in snapshot.tools
        )
        self.declared_tool_names: tuple[str, ...] | None = None
        initial = (
            (declaration_tool, *self.always_available_tools)
            if self.declaration_enabled
            else tuple(snapshot.tools)
        )
        self.selection = SelectedCapabilities(tuple(dict.fromkeys(initial)))

    def declare(self, names) -> tuple[str, ...]:
        """校验并固化本轮声明，返回可注入的授权工具名。"""
        allowed = set(self.snapshot.tools)
        declared: list[str] = []
        for name in names or ():
            if not isinstance(name, str) or name == self.declaration_tool:
                continue
            if name in allowed and name not in declared:
                declared.append(name)
        self.declared_tool_names = tuple(declared[: self.limit])
        return self.declared_tool_names

    def select_for_messages(self, messages) -> SelectedCapabilities:
        if self.fixed_adapter:
            names = tuple(name for name in ("call_tool", "use_skill", "ask_user") if name in self.snapshot.tools)
            self.selection = SelectedCapabilities(names, shadow=False)
            return self.selection
        if self.declaration_enabled:
            names = self.declared_tool_names or ()
            # 保留声明入口和交互工具，允许 Agent 在同一个 Run 中刷新业务工具集合。
            selected = (self.declaration_tool, *self.always_available_tools, *names)
            self.selection = SelectedCapabilities(tuple(dict.fromkeys(selected)), shadow=False)
            return self.selection
        query = ""
        for message in reversed(getattr(messages, "conversation", messages) or []):
            if message.get("role") == "user":
                content = message.get("content", "")
                query = content if isinstance(content, str) else str(content)
                break
        self.selection = self.selector.select(query, self.snapshot, self.limit)
        return self.selection


def build_compatibility_context(tool_names: list[str], *, limit: int = 12) -> CapabilityToolContext:
    """构建迁移期上下文。

    当前不依赖 RAG：首轮通过固定的 ``declare_tools`` 元工具完成声明；RAG 接入后
    只替换候选来源，不改变声明和注入链路。
    """
    from .index import CapabilityIndex
    from .selector import RegistryCapabilitySelector

    index = CapabilityIndex.from_registries(tool_names=tool_names)
    snapshot = index.snapshot(authorized_names=tool_names)
    return CapabilityToolContext(
        snapshot,
        RegistryCapabilitySelector(),
        limit=limit,
        declaration_enabled=True,
    )


def build_fixed_adapter_context(tool_names: list[str], *, limit: int = 12) -> CapabilityToolContext:
    """Phase 5：业务工具不进入 Provider tools，只保留固定 Adapter 入口。"""
    from .index import CapabilityIndex
    from .selector import RegistryCapabilitySelector
    fixed = ["call_tool", "use_skill", "ask_user"]
    names = list(dict.fromkeys([*tool_names, *fixed]))
    index = CapabilityIndex.from_registries(tool_names=names)
    snapshot = index.snapshot(authorized_names=names)
    return CapabilityToolContext(
        snapshot, RegistryCapabilitySelector(), limit=limit, fixed_adapter=True,
    )


def catalog_block(snapshot: CapabilitySnapshot, *, kind: str | None = None) -> str:
    lines = [
        "## 当前可用能力目录",
        "这里只是工具简介。固定 Adapter 模式下使用 `call_tool(name, arguments)` 调用业务工具；"
        "需要完整参数时，先使用 `use_skill`，对应的 canonical tool-schema 会追加到历史。",
    ]
    for item in snapshot.catalog:
        if kind is not None and item.kind != kind:
            continue
        if item.kind == "tool" and item.name == "declare_tools":
            continue
        if item.kind == "tool" and item.name not in snapshot.tools:
            continue
        lines.append(f"- {item.name}：{item.description_short}")
    return "\n".join(lines)


def selected_tool_names(selection: SelectedCapabilities) -> list[str]:
    return list(dict.fromkeys(selection.tool_names))
