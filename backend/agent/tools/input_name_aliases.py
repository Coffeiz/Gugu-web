"""Agent 工具对象名称字段的旧版兼容映射。

新工具 Schema 使用对象专属字段，避免模型把业务名称与工具协议中的工具名混淆。
本模块只负责把历史调用中的 ``name`` 映射到对应字段；持久化/API 的 ``name`` 不变。
"""
from __future__ import annotations

from typing import Any


_NAME_FIELDS = {
    "create_workspace": "workspace_name",
    "update_workspace": "workspace_name",
    "create_project": "project_name",
    "update_project": "project_name",
    "create_client": "client_name",
    "update_client": "client_name",
    "create_skill": "skill_name",
    "update_skill": "skill_name",
    "create_folder": "folder_name",
    "rename_folder": "folder_name",
    "delete_folder": "folder_name",
    "compress_files": "archive_name",
    "web_download": "file_name",
    "create_scheduled_task": "schedule_name",
    "update_scheduled_task": "schedule_name",
}


def normalize_name_aliases(tool_name: str, instance: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """归一化已知旧 name 字段，不对未知工具或业务结构做猜测。"""
    normalized = dict(instance)
    adaptations: list[str] = []

    target_field = _NAME_FIELDS.get(tool_name)
    if target_field and "name" in normalized and target_field not in normalized:
        normalized[target_field] = normalized.pop("name")
        adaptations.append(f"{tool_name}.name:renamed_to_{target_field}")

    if tool_name == "manage_mcp_servers":
        if "name" in normalized:
            action = normalized.get("action")
            # 旧 name 既可定位 server，也可在带 server_id 的 update 中改名。
            field = (
                "server_name" if action == "add" or not normalized.get("server_id")
                else "new_server_name" if action == "update"
                else "server_name"
            )
            if field not in normalized:
                normalized[field] = normalized.pop("name")
                adaptations.append(f"manage_mcp_servers.name:renamed_to_{field}")
        slots = normalized.get("credential_slots")
        if isinstance(slots, list):
            normalized_slots = []
            changed = False
            for slot in slots:
                if isinstance(slot, dict) and "name" in slot and "parameter_name" not in slot:
                    slot = {**slot, "parameter_name": slot["name"]}
                    slot.pop("name", None)
                    changed = True
                normalized_slots.append(slot)
            if changed:
                normalized["credential_slots"] = normalized_slots
                adaptations.append("manage_mcp_servers.credential_slots.name:renamed_to_parameter_name")

    if tool_name == "rename_folder" and "new_name" in normalized and "new_folder_name" not in normalized:
        normalized["new_folder_name"] = normalized.pop("new_name")
        adaptations.append("rename_folder.new_name:renamed_to_new_folder_name")

    if tool_name == "create_file" and isinstance(normalized.get("files"), list):
        items = []
        changed = False
        for item in normalized["files"]:
            if isinstance(item, dict) and "name" in item and "file_name" not in item:
                item = {**item, "file_name": item["name"]}
                item.pop("name", None)
                changed = True
            items.append(item)
        if changed:
            normalized["files"] = items
            adaptations.append("create_file.files.name:renamed_to_file_name")

    if tool_name == "call_tool" and "name" in normalized and "tool_name" not in normalized:
        normalized["tool_name"] = normalized.pop("name")
        adaptations.append("call_tool.name:renamed_to_tool_name")

    return normalized, adaptations
