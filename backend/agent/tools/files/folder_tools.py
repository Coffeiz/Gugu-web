"""文件工具定义。"""
from agent.tools.base import Tool

from .folders import _create_folder, _delete_folder, _move_items, _rename_folder

FOLDER_TOOLS = [
        Tool(
            name="move_items", label="移动文件/文件夹",
            description_short='移动文件或文件夹；批量传 files/folders，目标传 target；folder_id 优先，project 空间传 project_id',
            description="批量移动文件或文件夹；源项传 files/folders，目标传 target。目标空间统一使用 target.space（personal/project/workspace），workspace＝当前绑定工作区；项目目标用 project_id。",
            input_schema={
                "type": "object",
                "properties": {
                    "files":   {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "integer"}]}},
                    "folders": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "integer"}]}},
                    "target": {
                        "type": "object",
                        "properties": {
                            "folder": {"type": "string"},
                            "folder_id": {"type": "integer"},
                            "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                            "project_id": {"type": "integer"},
                        },
                    },
                    "destination": {"type": "string", "enum": ["same", "folder"]},
                },
                "required": ["target"],
            },
            handler=_move_items,
            mutates=True,
        ),
        Tool(
            name="create_folder", label="新建文件夹",
            description_short='新建文件夹，明确区分个人、项目或工作区。',
            description=(
                "新建文件夹，可指定 space=personal、space=project 或 space=workspace 与父文件夹（支持嵌套）。"
                "个人空间必须使用 project_id=null；项目空间必须提供有效的 project_id。"
                "workspace 空间使用当前会话绑定的工作区文件目录。未指定 space 时，显式 project_id 按项目空间处理；不传位置参数才使用当前绑定工作区或个人根目录默认落点。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "space": {"type": "string", "enum": ["personal", "project", "workspace"]},
                    # personal 空间明确允许传 null；省略时仍按 description 的默认落点规则处理。
                    "project_id": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "parent_id": {"type": "integer"},
                },
                "required": ["name"],
            },
            handler=_create_folder,
            mutates=True,
        ),
        Tool(
            name="rename_folder", label="重命名文件夹",
            description_short='重命名文件夹；跨项目存在同名文件夹时按项目范围定位。',
            description="重命名文件夹。用 name 指定要改的文件夹名（或用 folder_id）。同名文件夹存在于多个项目时必须传 project_id 避免误操作。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "folder_id": {"type": "integer"},
                    "project_id": {"type": "integer"},
                    "new_name": {"type": "string"},
                },
                "required": ["new_name"],
            },
            handler=_rename_folder,
            mutates=True,
        ),
        Tool(
            name="delete_folder", label="删除文件夹",
            description_short='删除文件夹；跨项目存在同名文件夹时按项目范围定位。',
            description="删除一个或多个文件夹。单项用 name/folder_id，批量传 folder_ids。文件夹及其内容会整体移入回收站，30 天内可恢复。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "folder_id": {"type": "integer"},
                    "folder_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                    "project_id": {"type": "integer"},
                },
            },
            handler=_delete_folder,
            mutates=True,
        ),
]
