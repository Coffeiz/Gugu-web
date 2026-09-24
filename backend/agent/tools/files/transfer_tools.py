"""文件工具定义。"""
from agent.tools.base import Tool

from .documents import _save_uploaded_file
from .transfer import (
    _compress_files, _extract_files, _list_recent_attachments,
    _present_file, _send_file,
)

TRANSFER_TOOLS = [
        Tool(
            name="compress_files", label="压缩文件",
            description_short="把文件库中的文件或文件夹打包成 ZIP。",
            description="只操作文件库条目，不使用 Shell 路径。entries 使用 {kind:'file'|'folder', id} 明确区分文件和文件夹；可混合选择，所有条目必须属于同一空间。源内容上限 512MB；不覆盖已有文件，重名会自动追加序号。失败会返回可直接展示的原因。",
            input_schema={
                "type": "object",
                "properties": {
                    "entries": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["file", "folder"]},
                                "id": {"type": "integer", "minimum": 1},
                            },
                            "required": ["kind", "id"],
                            "additionalProperties": False,
                        },
                    },
                    "folder_id": {"type": "integer", "minimum": 1},
                    "name": {"type": "string", "maxLength": 300},
                },
                "required": ["entries"],
                "additionalProperties": False,
            },
            handler=_compress_files,
            mutates=True,
        ),
        Tool(
            name="extract_files", label="解压文件",
            description_short="把文件库中的 ZIP/TAR/TAR.GZ 解压到指定文件夹。",
            description="只操作文件库条目，不使用 Shell 路径。支持 zip、tar、tar.gz、tgz；最多解压 10,000 个条目且受 2GB 安全上限和用户剩余配额约束。压缩包保留不动，重名会自动追加序号，不覆盖已有文件。可指定 format 作为格式校验提示；失败会返回可直接展示的原因。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "minimum": 1},
                    "folder_id": {"type": "integer", "minimum": 1},
                    "format": {"type": "string", "enum": ["zip", "tar", "tar.gz", "tgz"]},
                },
                "required": ["file_id"],
                "additionalProperties": False,
            },
            handler=_extract_files,
            mutates=True,
        ),
        Tool(
            name="send_file", label="发送文件",
            description_short='发送文件或图片。',
            description="把文件、网络图片或暂存附件真正发送给用户；仅在用户明确要发送时调用。"
                        "四个来源只能选其一：文件库文件优先用 list_dir 返回的 file_id，也可以直接给文件名"
                        "（重名时会返回候选让你用 file_id 消歧）；Shell 逻辑路径 /workspace/...、/personal/...、"
                        "/project/... 用 file 传（路径方式单文件上限 10MB，更大的文件请用 file_id），不要把路径填到"
                        " file_id；url 仅接受 http(s) 网络地址，本地或工作区文件不要用 url。"
                        "title 可选：作为发给用户的展示名，所有来源通用。查位置请用文件链接。",
            input_schema={
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "file_id": {"type": "integer"},
                    "url": {"type": "string"},
                    "title": {"type": "string"},
                    "attach_id": {"type": "string"},
                    "source_type": {"type": "string", "enum": ["file", "file_id", "url", "attach_id"]},
                },
                "oneOf": [
                    {"required": ["file"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["url"]}, {"required": ["attach_id"]}]}},
                    {"required": ["file_id"], "not": {"anyOf": [{"required": ["file"]}, {"required": ["url"]}, {"required": ["attach_id"]}]}},
                    {"required": ["url"], "not": {"anyOf": [{"required": ["file"]}, {"required": ["file_id"]}, {"required": ["attach_id"]}]}},
                    {"required": ["attach_id"], "not": {"anyOf": [{"required": ["file"]}, {"required": ["file_id"]}, {"required": ["url"]}]}},
                ],
                "allOf": [
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "file"}}}, "then": {"required": ["file"]}},
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "file_id"}}}, "then": {"required": ["file_id"]}},
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "url"}}}, "then": {"required": ["url"]}},
                    {"if": {"required": ["source_type"], "properties": {"source_type": {"const": "attach_id"}}}, "then": {"required": ["attach_id"]}},
                ],
            },
            handler=_send_file,
            mutates=True,
        ),
        Tool(
            name="present_file", label="在网页展示文件",
            description_short='把文件直接推到用户当前网页上打开预览。',
            description="把文件库里的文件直接推到用户当前网页上打开预览（图片/音频/视频/文档立即展示）。"
                        "仅在用户明确要求「打开/展示/给我看」某个文件时调用；不产生聊天附件，IM 会话里不可用。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                },
                "required": [],
                # oneOf：file 与 file_id 恰好给一个；不能用 allOf 写互斥（两条 required 子句会互相矛盾，任何输入都过不了）
                "oneOf": [
                    {"required": ["file"], "not": {"required": ["file_id"]}},
                    {"required": ["file_id"], "not": {"required": ["file"]}},
                ],
            },
            handler=_present_file,
        ),
        Tool(
            name="list_recent_attachments", label="查最近暂存的附件",
            description_short='查最近暂存的附件；用于找回近期图片或文件',
            description="列出当前仍在暂存区的聊天附件；可用于找回近期图片或文件，再发送或保存。",
            input_schema={"type": "object", "properties": {}},
            handler=_list_recent_attachments,
        ),
        Tool(
            name="save_uploaded_file", label="保存上传文件",
            description_short='保存聊天附件到文件库，支持个人、项目或工作区。',
            description="保存对话附件到文件库；多个附件用 attach_ids，可用 space 指定 personal/project/workspace，也可指定项目或文件夹。workspace 使用当前会话绑定的工作区文件目录。",
            input_schema={
                "type": "object",
                "properties": {
                    "attach_id": {"type": "string"},
                    "attach_ids": {"type": "array", "items": {"type": "string"}},
                    "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                    "project_id": {"type": "integer"},
                    "folder_id": {"type": "integer"},
                    "source": {"type": "string", "enum": ["latest", "attach_id", "attach_ids"]},
                },
                "required": [],
                "allOf": [
                    {"if": {"required": ["source"], "properties": {"source": {"const": "latest"}}}, "then": {"not": {"anyOf": [{"required": ["attach_id"]}, {"required": ["attach_ids"]}]} }},
                    {"if": {"required": ["source"], "properties": {"source": {"const": "attach_id"}}}, "then": {"required": ["attach_id"]}},
                    {"if": {"required": ["source"], "properties": {"source": {"const": "attach_ids"}}}, "then": {"required": ["attach_ids"]}},
                    {"not": {"required": ["attach_id", "attach_ids"]}},
                ],
            },
            handler=_save_uploaded_file,
            mutates=True,
        ),
]
