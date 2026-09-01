"""能力目录与 provider Schema 注入的纯函数。"""

from __future__ import annotations

from .index import CapabilityIndex
from .models import CapabilitySnapshot, SelectedCapabilities, DESCRIPTION_SHORT_MAX_CHARS
from .selector import CapabilitySelector


CATALOG_DESCRIPTION_MAX_CHARS = DESCRIPTION_SHORT_MAX_CHARS
FIXED_ADAPTER_TOOL_NAMES = ("call_tool", "get_tool_schema", "use_skill", "ask_user")


def _field_signature_type(schema: dict, *, depth: int = 0) -> str:
    """把工具字段转换成紧凑签名，嵌套对象最多展开一层，不复制 JSON Schema。"""
    if not isinstance(schema, dict):
        return "unknown"
    schema_type = schema.get("type")
    if schema_type == "array":
        item = schema.get("items")
        if isinstance(item, dict) and item.get("type") == "object":
            if depth >= 2:
                return "array<object>"
            names = tuple(
                f"{name}:{_field_signature_type(value, depth=depth + 1)}"
                for name, value in (item.get("properties") or {}).items()
            )
            return f"array<object:{','.join(names)}>" if names else "array<object>"
        return f"array<{_field_signature_type(item, depth=depth + 1)}>" if isinstance(item, dict) else "array"
    if schema_type == "object":
        if depth >= 2:
            return "object"
        names = tuple(
            f"{name}:{_field_signature_type(value, depth=depth + 1)}"
            for name, value in (schema.get("properties") or {}).items()
        )
        return f"object:{','.join(map(str, names))}" if names else "object"
    if schema_type:
        return str(schema_type)
    choices = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(choices, list):
        types = tuple(_field_signature_type(item, depth=depth) for item in choices if isinstance(item, dict))
        return "|".join(dict.fromkeys(types)) or "unknown"
    return "unknown"


def _tool_field_signature(name: str) -> str:
    """从唯一工具注册表生成字段签名，避免 description_short 再维护一份字段文案。"""
    try:
        from agent.tools import registry

        tool = registry.get(name)
        schema = getattr(tool, "input_schema", None)
    except Exception:
        schema = None
    if not isinstance(schema, dict):
        return ""
    properties = schema.get("properties") or {}
    if not isinstance(properties, dict):
        return ""
    required = set(schema.get("required") or ())
    fields = []
    for field_name, field_schema in properties.items():
        field = f"{field_name}({_field_signature_type(field_schema)})"
        if field_name in required:
            field += ",必填"
        fields.append(field)
    return "、".join(fields)


class CapabilityToolContext:
    """Run 内的能力上下文。

    固定 Adapter 模式只把稳定入口注册给 Provider，业务工具通过 ``get_tool_schema``
    按需追加 canonical Schema；非固定模式保留 selector 供未来 RAG 候选接入。
    """

    def __init__(
        self,
        snapshot: CapabilitySnapshot,
        selector: CapabilitySelector,
        limit: int = 5,
        *,
        fixed_adapter: bool = False,
        owner_id=None,
        search_settings=None,
    ):
        self.snapshot = snapshot
        self.selector = selector
        self.limit = limit
        self.fixed_adapter = fixed_adapter
        self.owner_id = owner_id
        self.search_settings = search_settings
        self.recommendation_enabled = bool(getattr(search_settings, "capability_rag_enabled", False))
        initial = tuple(snapshot.tools)
        self.selection = SelectedCapabilities(tuple(dict.fromkeys(initial)))
        self.recommendation_selection = self.selection

    def select_for_messages(self, messages) -> SelectedCapabilities:
        if self.fixed_adapter:
            names = tuple(name for name in FIXED_ADAPTER_TOOL_NAMES if name in self.snapshot.tools)
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

    async def select_for_query(self, query: str) -> SelectedCapabilities:
        if self.fixed_adapter and self.recommendation_enabled:
            select_async = getattr(self.selector, "select_async", None)
            if select_async is not None:
                self.selection = await select_async(query, self.snapshot, self.limit)
                self.recommendation_selection = self.selection
                return self.selection
        return self.select_for_messages([{"role": "user", "content": query}])

    def skill_meta(self, name: str):
        value = str(name or "").strip().lower()
        return self.snapshot.skills.get(value)

    def skill_digest(self, name: str) -> str | None:
        meta = self.skill_meta(name)
        return (meta.content_digest or None) if meta is not None else None


def _build_fixed_context(index, *, limit: int = 5, names: list[str], owner_id=None, search_settings=None) -> CapabilityToolContext:
    from .selector import RagCapabilitySelector, RegistryCapabilitySelector
    snapshot = index.snapshot(authorized_names=names)
    selector = (
        RagCapabilitySelector(owner_id, shadow=bool(getattr(search_settings, "capability_rag_shadow", True)))
        if bool(getattr(search_settings, "capability_rag_enabled", False))
        else RegistryCapabilitySelector()
    )
    return CapabilityToolContext(
        snapshot, selector, limit=int(getattr(search_settings, "capability_rag_limit", limit) or limit),
        fixed_adapter=True, owner_id=owner_id, search_settings=search_settings,
    )


def build_fixed_adapter_context(tool_names: list[str], *, limit: int = 5, search_settings=None, owner_id=None) -> CapabilityToolContext:
    """Phase 5：业务工具不进入 Provider tools，只保留固定 Adapter 入口。"""
    names = list(dict.fromkeys([*tool_names, *FIXED_ADAPTER_TOOL_NAMES]))
    return _build_fixed_context(CapabilityIndex.from_registries(tool_names=names), limit=limit, names=names,
                                owner_id=owner_id, search_settings=search_settings)


async def build_fixed_adapter_context_for_user(
    tool_names: list[str], *, limit: int = 5, db=None, owner_id=None, search_settings=None,
) -> CapabilityToolContext:
    """构建当前 owner 的能力快照；用户 Skill 只进入 metadata，不加载正文。"""
    if db is None or owner_id is None:
        return build_fixed_adapter_context(tool_names, limit=limit, search_settings=search_settings, owner_id=owner_id)
    names = list(dict.fromkeys([*tool_names, *FIXED_ADAPTER_TOOL_NAMES]))
    index = await CapabilityIndex.from_registries_for_user(db, owner_id, tool_names=names)
    return _build_fixed_context(index, limit=limit, names=names, owner_id=owner_id, search_settings=search_settings)


def catalog_block(snapshot: CapabilitySnapshot, *, kind: str | None = None, tool_order=None) -> str:
    lines = [
        "## 当前可用能力索引",
        "这里只是稳定的能力名称、用途和紧凑字段签名，不是完整工具 Schema，也不是已经发生的工具调用记录；"
        "固定 Adapter 模式下使用 `call_tool({name: 工具名, arguments: 业务参数对象})` 调用业务工具；"
        "禁止只传 name，也不要把目标工具参数省略成空对象。"
        "工具名必须逐字复用目录中的 canonical name，不得把自然语言翻译成自造的别名；"
        "字段签名只展示类型、必填状态和一层结构，嵌套细节及枚举值必须确认历史里有当前版本的完整 Schema；不要凭简介猜参数。"
        "本轮历史中已经存在且版本未变化的 Schema 直接复用，否则先使用 `get_tool_schema`。"
        "不要重复获取已经存在的工具 Schema；Schema 只用于理解参数，权限和执行校验由代码完成。"
        "`use_skill` 只用于加载技能正文及其关联工具 Schema。",
        "用户要求创建、保存或定义一套可复用做法时，使用 `create_skill`；不要把创建技能误当成 `create_project`，"
        "也不要先调用 `use_skill`。创建用户 Skill 时至少准备 name、description_short、body 和 related_tools，"
        "无关联工具时 related_tools 使用空数组 []。",
    ]
    ordered_tools = tuple(tool_order or snapshot.tools)
    catalog = tuple(snapshot.tools[name] for name in ordered_tools if name in snapshot.tools) + tuple(snapshot.skills.values())
    for item in catalog:
        if kind is not None and item.kind != kind:
            continue
        if item.kind == "tool" and item.name not in snapshot.tools:
            continue
        description = " ".join(str(item.description_short or "").split())
        if len(description) > CATALOG_DESCRIPTION_MAX_CHARS:
            raise ValueError(
                f"能力 {item.name} 的 description_short 超过 {CATALOG_DESCRIPTION_MAX_CHARS} 字符"
            )
        fields = _tool_field_signature(item.name) if item.kind == "tool" else ""
        suffix = f"；字段：{fields}" if fields else ""
        lines.append(f"- {item.name}：{description}{suffix}")
    return "\n".join(lines)
