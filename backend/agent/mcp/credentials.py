"""MCP 凭据槽位：统一组装 header/query 凭据，只在外呼边界解密。"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_SLOT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_PLACEHOLDER = re.compile(r"\{\{secret:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}\}")


@dataclass(frozen=True)
class CredentialSlot:
    id: str
    label: str
    target: str
    name: str
    prefix: str = ""


def normalize_slots(raw) -> list[dict[str, str]]:
    """验证通用凭据槽位定义，拒绝重复目标和未知注入位置。"""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 16:
        raise ValueError("credential_slots 必须是最多 16 项的 JSON 数组")
    result: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("credential_slots 的每一项必须是 JSON 对象")
        slot_id = str(item.get("id") or "").strip()
        label = str(item.get("label") or slot_id).strip()
        target = str(item.get("target") or "").strip().lower()
        name = str(item.get("name") or "").strip()
        prefix = str(item.get("prefix") or "")
        if not _SLOT_ID.fullmatch(slot_id) or slot_id in seen_ids:
            raise ValueError("凭据槽位 id 无效或重复")
        if target not in {"header", "query"} or not name or len(name) > 256:
            raise ValueError("凭据槽位必须指定 header 或 query 及字段名")
        if not label or len(label) > 120 or len(prefix) > 120:
            raise ValueError("凭据槽位标签或前缀过长")
        seen_ids.add(slot_id)
        result.append({"id": slot_id, "label": label, "target": target, "name": name, "prefix": prefix})
    return result


def secret_fields(slots: list[dict[str, str]]) -> list[dict[str, str]]:
    return [{"name": slot["id"], "label": slot["label"], "type": "secret"} for slot in slots]


def legacy_slots(headers: dict[str, str], query: dict[str, str]) -> tuple[list[dict[str, str]], dict[str, str]]:
    """把历史双轨字段转换为统一槽位，只用于读取旧数据库数据。"""
    slots: list[dict[str, str]] = []
    values: dict[str, str] = {}
    for index, (name, value) in enumerate((*headers.items(), *query.items())):
        target = "header" if index < len(headers) else "query"
        slot_id = f"legacy_{target}_{index}"
        slots.append({"id": slot_id, "label": name, "target": target, "name": name, "prefix": ""})
        values[slot_id] = value
    return slots, values


def assemble_credentials(endpoint: str, slots: list[dict[str, str]], values: dict[str, str] | None) -> tuple[str, dict[str, str], dict[str, str]]:
    """在请求边界组装凭据；返回值只允许留在当前运行时内。"""
    values = values or {}
    headers: dict[str, str] = {}
    query: dict[str, str] = {}
    url = endpoint
    for slot in slots:
        value = values.get(slot["id"])
        if value is None:
            raise ValueError(f"缺少凭据槽位：{slot['label']}")
        injected = slot.get("prefix", "") + value
        placeholder = "{{secret:" + slot["id"] + "}}"
        if placeholder in url:
            url = url.replace(placeholder, injected)
        elif slot["target"] == "header":
            headers[slot["name"]] = injected
        else:
            query[slot["name"]] = injected
    if query:
        parts = urlsplit(url)
        configured_names = set(query)
        existing = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
                    if key not in configured_names]
        existing.extend(query.items())
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(existing), parts.fragment))
    return url, headers, query
