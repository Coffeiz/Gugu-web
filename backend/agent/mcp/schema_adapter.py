"""MCP 工具的 schema 消毒、命名前缀、Tool 包装。

这里是唯一做 schema 降级的地方（规则必须可单测）：server 端 inputSchema 是不可信
外部输入，直接透传给 provider 会踩 MiniMax/各家适配坑（$ref、嵌套 oneOf/anyOf、
超深层级、非法工具名……），全部在本模块集中降级为保守形状，禁止散落到 manager/client。
"""
from __future__ import annotations

import re
from typing import Any

from app.utils.romaji import to_romaji
from agent.mcp.models import McpToolMeta, TOOL_NAME_PREFIX
from agent.tools.base import Tool

# provider 对函数名的通用约束：字母数字下划线，长度 ≤64（OpenAI 上限）
_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_]+$")
_MAX_NAME_LENGTH = 64
_MAX_SCHEMA_DEPTH = 8
_MAX_SCHEMA_PROPERTIES = 64
_DESCRIPTION_SHORT_MAX = 100

# 消毒后允许保留的 JSON Schema 关键字；其余（$schema、title、examples、
# discriminator、readOnly…）一律丢弃，保守形状对 provider 最安全
_KEEP_KEYS = frozenset({
    "type", "description", "enum", "const", "format",
    "minimum", "maximum", "minLength", "maxLength",
    "properties", "required", "items", "additionalProperties", "default",
})


def description_short_of(description: str | None) -> str:
    """取描述首个非空行，截断到 100 字符（FR-MCP-2 元数据默认值）。"""
    text = (description or "").strip()
    first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    if len(first_line) > _DESCRIPTION_SHORT_MAX:
        return first_line[: _DESCRIPTION_SHORT_MAX - 1] + "…"
    return first_line


def description_for_provider(description: str | None, fallback: str = "") -> str:
    """返回 MCP server 提供的完整描述；缺失时才使用适配器默认文案。

    MCP 描述是 server 的工具契约，不能复用面向目录/RAG 的短摘要。这里不做
    长度截断；Provider 自身会按模型上下文能力处理描述长度。
    """
    if isinstance(description, str) and description.strip():
        return description
    return fallback


def prefixed_tool_name(server_name: str, tool_name: str) -> str | None:
    """组装 `mcp_<server>_<tool>`；Provider 名称非法或超长返回 None=拒载。

    server 名是用户可见名称，先转为拼音/罗马音再组成 ASCII 命名空间；工具名则保持
    Provider 的 ASCII 约束——server 给什么就是什么，非法直接跳过并诊断（FR-MCP-2）。
    """
    raw_server = (server_name or "").strip()
    romanized_server = to_romaji(raw_server, "zh-CN") if raw_server else ""
    safe_server = re.sub(r"[^a-zA-Z0-9_]", "_", romanized_server)
    if not re.search(r"[a-zA-Z0-9_]", safe_server):
        # pypinyin 不可用或遇到未覆盖文字时仍生成确定的 ASCII 命名空间，避免
        # 不同中文服务都退化成同一串下划线。
        safe_server = "_".join(
            f"u{ord(char):x}" if not char.isascii() else char
            for char in raw_server
        )
    safe_server = safe_server or "server"
    tool = (tool_name or "").strip()
    if not tool or not _NAME_PATTERN.match(tool):
        return None
    name = f"{TOOL_NAME_PREFIX}{safe_server}_{tool}"
    if not _NAME_PATTERN.match(name) or len(name) > _MAX_NAME_LENGTH:
        return None
    return name


def _degraded_string() -> dict[str, Any]:
    return {"type": "string", "description": "该参数结构过于复杂，已降级为字符串"}


def _resolve_ref(ref: str, defs: dict[str, Any]) -> Any | None:
    """仅支持本文档内引用：#/$defs/x、#/definitions/x；其余返回 None=不可解析。"""
    prefix = "#/"
    if not ref.startswith(prefix):
        return None
    parts = [p for p in ref[len(prefix):].split("/") if p]
    if len(parts) == 2 and parts[0] in ("$defs", "definitions"):
        node = defs.get(parts[1])
        return node if isinstance(node, dict) else None
    return None


def _sanitize_node(node: Any, depth: int, defs: dict[str, Any],
                   resolving: frozenset[str]) -> Any:
    if depth > _MAX_SCHEMA_DEPTH:
        return _degraded_string()
    if isinstance(node, list):
        return [_sanitize_node(item, depth + 1, defs, resolving) for item in node]
    if not isinstance(node, dict):
        return node

    # $ref：就地展开一次（环引用降级为 string）
    if "$ref" in node:
        target = _resolve_ref(str(node["$ref"]), defs)
        if target is None:
            return _degraded_string()
        ref_key = str(node["$ref"])
        if ref_key in resolving:
            return _degraded_string()
        merged = {k: v for k, v in node.items() if k != "$ref"}
        resolved = _sanitize_node(target, depth + 1, defs, resolving | {ref_key})
        if isinstance(resolved, dict):
            return _sanitize_node({**resolved, **merged}, depth, defs, resolving)
        return resolved

    # oneOf/anyOf：取第一个非 null 分支（MiniMax 对嵌套组合最不稳，保守降级）
    for combo_key in ("oneOf", "anyOf"):
        if combo_key in node:
            branches = [b for b in (node.get(combo_key) or [])
                        if isinstance(b, dict) and b.get("type") != "null"]
            chosen = branches[0] if branches else None
            if chosen is None:
                return _degraded_string()
            rest = {k: v for k, v in node.items() if k not in ("oneOf", "anyOf", "allOf")}
            return _sanitize_node({**_sanitize_node(chosen, depth, defs, resolving),
                                   **rest}, depth, defs, resolving)

    # allOf：浅合并各分支的 properties/required
    if "allOf" in node:
        merged: dict[str, Any] = {k: v for k, v in node.items() if k != "allOf"}
        props: dict[str, Any] = dict(merged.get("properties") or {})
        required: list[str] = list(merged.get("required") or [])
        for branch in node.get("allOf") or []:
            if not isinstance(branch, dict):
                continue
            branch = _sanitize_node(branch, depth + 1, defs, resolving)
            if not isinstance(branch, dict):
                continue
            props.update(branch.get("properties") or {})
            for req in branch.get("required") or []:
                if req not in required:
                    required.append(req)
        if props:
            merged["type"] = merged.get("type") or "object"
            merged["properties"] = props
        if required:
            merged["required"] = required
        return _sanitize_node(merged, depth, defs, resolving)

    out: dict[str, Any] = {}
    for key, value in node.items():
        if key not in _KEEP_KEYS:
            continue
        if key == "properties" and isinstance(value, dict):
            out[key] = {
                name: _sanitize_node(sub, depth + 1, defs, resolving)
                for name, sub in list(value.items())[:_MAX_SCHEMA_PROPERTIES]
            }
        elif key == "required":
            out[key] = [r for r in (value or []) if isinstance(r, str)]
        elif key == "items":
            out[key] = _sanitize_node(value, depth + 1, defs, resolving)
        else:
            out[key] = value
    return out


def sanitize_input_schema(schema: Any) -> dict[str, Any]:
    """消毒 server 端 inputSchema：$ref 就地展开、oneOf/anyOf 取首分支、allOf 浅合并、
    超深降级 string、属性数量封顶、仅保留保守关键字。顶层保证 type=object。"""
    defs: dict[str, Any] = {}
    if isinstance(schema, dict):
        defs = {**(schema.get("$defs") or {}), **(schema.get("definitions") or {})}
    sanitized = _sanitize_node(schema if isinstance(schema, dict) else {}, 0, defs, frozenset())
    if not isinstance(sanitized, dict):
        sanitized = {}
    sanitized.pop("$defs", None)
    sanitized.pop("definitions", None)
    sanitized.setdefault("type", "object")
    if sanitized.get("type") != "object":
        # 顶层不是 object 的声明 FR-MCP-2 直接拒载（validate_input_schema 负责）；
        # 这里只是防御性兜底，保证返回值永远形状合法。
        sanitized = {"type": "object", "properties": {}}
    sanitized.setdefault("properties", {})
    return sanitized


def validate_input_schema(schema: Any) -> str | None:
    """拒载判定：返回人话错误（拒载原因），None=通过。"""
    if not isinstance(schema, dict):
        return "inputSchema 不是对象"
    if schema.get("type") != "object":
        return f"inputSchema 顶层类型必须是 object（实际 {schema.get('type')!r}）"
    props = schema.get("properties")
    if props is not None and not isinstance(props, dict):
        return "inputSchema.properties 必须是对象"
    return None


def build_mcp_tool(meta: McpToolMeta, handler) -> Tool:
    """把 server 工具包装为内部 Tool 对象（不进 SkillRegistry）。

    元数据默认值按 FR-MCP-2：source=mcp、
    mutates=True（无法证明只读，定时任务不得自动重放）。确认门在 handler 内按
    server 的 confirm_mode 处理，不走 Tool.requires_confirmation（那是 registry 工具的机制）。
    """
    tool = Tool(
        name=meta.prefixed_name,
        description=meta.provider_description or meta.description_short,
        input_schema=sanitize_input_schema(meta.input_schema),
        handler=handler,
        label=f"[{meta.server_name}] {meta.tool_name}",
        destructive=False,
        mutates=True,
        verify_after_call=False,
        requires_confirmation=False,
        description_short=meta.description_short,
        category="mcp",
        source="mcp",
    )
    tool.provider_description = meta.provider_description or meta.description_short
    # LoopScope 需要区分动态 MCP 工具与同名的内置工具；这里只挂载服务和工具
    # 元数据，不携带 endpoint、请求头或其他凭据。
    tool.mcp_server_id = str(meta.server_id)
    tool.mcp_server_name = meta.server_name
    tool.mcp_tool_name = meta.tool_name
    return tool
