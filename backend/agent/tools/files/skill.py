"""组合文件工具域并注册统一的 FilesSkill。"""
from agent.tools.base import BaseSkill

from .file_tools import FILE_TOOLS
from .folder_tools import FOLDER_TOOLS
from .transfer_tools import TRANSFER_TOOLS

TOOL_ORDER = (
    "list_dir", "read_file", "grep", "edit_file", "create_file", "rename_file",
    "move_items", "copy_file", "create_folder", "delete_file", "rename_folder",
    "delete_folder", "compress_files", "extract_files", "send_file", "present_file",
    "list_recent_attachments", "save_uploaded_file",
)
_TOOLS_BY_NAME = {
    tool.name: tool for tool in FILE_TOOLS + FOLDER_TOOLS + TRANSFER_TOOLS
}


class FilesSkill(BaseSkill):
    name = "files"
    tools = [_TOOLS_BY_NAME[name] for name in TOOL_ORDER]
