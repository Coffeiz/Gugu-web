"""文件工具定义。"""
from agent.tools.base import Tool

from .documents import (
    _DOC_MIME, _copy_file, _create_file, _delete_file, _edit_file, _list_dir,
    _rename_file,
)
from .grep import _grep_files
from .read import _read_file

FILE_TOOLS = [
        Tool(
            name="list_dir", label="浏览目录",
            description_short='浏览目录：文件夹只列当前层直属子目录，不递归；未指定目录时列根级文件夹。',
            description="列出文件与当前层直属子文件夹，可按空间、项目、工作区或目录筛选；文件仍按传入条件过滤，不传位置条件时覆盖当前用户所有可访问空间。"
                        "folder 传目录名（支持 a/b/c 式路径，也可用 folder_id/parent_id 传 id），限定该目录的子文件夹与直属文件。"
                        "folders 只返回当前层的直属子目录，不递归展开；未传目录时只返回各空间根目录下的文件夹。需要深入时，再对目标子目录传 folder_id 调用。"
                        "返回 {shown, total, files, folders}：total/shown 只统计文件——shown<total 说明未取完，"
                        "加大 limit、加 offset 翻页或改用更精确的过滤条件，不能把部分结果当全量下结论；确认「全部/清空/还剩几个」类问题时务必核对 total。"
                        "limit 只约束 files（上限 200）；folders 恒全量，每项带 file_count（直属文件数）。kind=file/folder 可只看其中一种。"
                        "超大目录看全量：sort=\"name\" + limit=200 + offset 递增分页拉完（名字序翻页稳定不漏重）。"
                        "按关键词找文件时优先一次传 queries（默认 OR）；决定新文件落点时先看当前层，需要确认更深位置时对候选子目录继续浏览。",
            input_schema={
                "type": "object",
                "properties": {
                    "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                    "project_id": {"type": "integer"},
                    "workspace_directory_id": {"type": "integer"},
                    "folder": {"type": "string"},
                    "folder_id": {"type": "integer"},
                    "parent_id": {"type": "integer"},
                    "kind": {"type": "string", "enum": ["both", "file", "folder"]},
                    "ext": {"type": "string"},
                    "query": {"type": "string"},
                    "q": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "mode": {"type": "string", "enum": ["OR", "AND"]},
                    "offset": {"type": "integer", "minimum": 0},
                    "sort": {"type": "string", "enum": ["updated", "name"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                },
            },
            handler=_list_dir,
        ),
        Tool(
            name="read_file", label="读取文件",
            description_short='读取一个或一批文件/媒体；图片、音频、视频可直接交给模型分析。',
            description="读取文件库、聊天附件或图片 URL；单个来源使用 file_id/file/attach_id/url，多个来源放在 items 数组，一次最多 20 项、源文件总量最多 64 MiB。URL 仅允许网络图片，并执行安全校验与下载限制；文件库支持文本、文档、图片、音频和视频，历史聊天附件支持图片/音频/视频，其他附件先保存到文件库再读。媒体按当前模型能力交付原生内容或音频转写。图片共用格式白名单、视觉能力、大小限制与图像处理策略；SVG 按源码文本读取。每个 items 项只能指定一种来源，可选 title/result_id 标记结果；某项失败不影响其他项。文本/文档可用 target_lines 按原始物理行读取，支持 all、8、8-11、8,11，默认 all。不要传本地路径或 file:/// URI。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "attach_id": {"type": "string"},
                    "url": {"type": "string"},
                    "image_url": {"type": "string"},
                    "img_src": {"type": "string"},
                    "title": {"type": "string"},
                    "target_lines": {"type": "string", "pattern": "^(all|[0-9]+([-,][0-9]+)?)$"},
                    "items": {
                        "type": "array", "minItems": 1, "maxItems": 20,
                        "items": {
                            "type": "object",
                            "properties": {
                                "file_id": {"type": "integer"},
                                "file": {"type": "string"},
                                "attach_id": {"type": "string"},
                                "url": {"type": "string"},
                                "image_url": {"type": "string"},
                                "img_src": {"type": "string"},
                                "title": {"type": "string"},
                                "result_id": {"type": "string"},
                                "target_lines": {"type": "string", "pattern": "^(all|[0-9]+([-,][0-9]+)?)$"},
                            },
                            "anyOf": [
                                {"required": ["file_id"]}, {"required": ["file"]},
                                {"required": ["attach_id"]}, {"required": ["url"]},
                                {"required": ["image_url"]}, {"required": ["img_src"]},
                            ],
                        },
                    },
                },
                "oneOf": [
                    {"required": ["items"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["file"]}, {"required": ["attach_id"]}, {"required": ["url"]}, {"required": ["image_url"]}, {"required": ["img_src"]}]}},
                    {"required": ["file_id"], "not": {"anyOf": [{"required": ["file"]}, {"required": ["attach_id"]}, {"required": ["url"]}, {"required": ["image_url"]}, {"required": ["img_src"]}, {"required": ["items"]}]}},
                    {"required": ["file"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["attach_id"]}, {"required": ["url"]}, {"required": ["image_url"]}, {"required": ["img_src"]}, {"required": ["items"]}]}},
                    {"required": ["attach_id"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["file"]}, {"required": ["url"]}, {"required": ["image_url"]}, {"required": ["img_src"]}, {"required": ["items"]}]}},
                    {"required": ["url"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["file"]}, {"required": ["attach_id"]}, {"required": ["image_url"]}, {"required": ["img_src"]}, {"required": ["items"]}]}},
                    {"required": ["image_url"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["file"]}, {"required": ["attach_id"]}, {"required": ["url"]}, {"required": ["img_src"]}, {"required": ["items"]}]}},
                    {"required": ["img_src"], "not": {"anyOf": [{"required": ["file_id"]}, {"required": ["file"]}, {"required": ["attach_id"]}, {"required": ["url"]}, {"required": ["image_url"]}, {"required": ["items"]}]}},
                ],
            },
            handler=_read_file,
        ),
        Tool(
            name="grep", label="搜索文件正文",
            description_short='在当前权限内的个人、项目和 Workspace 文本文件中查找内容。',
            description="按关键词逐行搜索当前用户有权访问的个人、项目和 Workspace 文本文件；返回 file_id、逻辑路径、命中行号、匹配行和可选上下文，不执行 Shell grep。可用 context_lines 控制命中行前后行数，limit 限制总命中数；需要完整正文或精确读取时再调用 read_file。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "path": {"type": "string", "description": "可选逻辑路径，如 /personal/F1、/project/项目名、/workspace/workspace-1"},
                    "context_lines": {"type": "integer", "minimum": 0, "maximum": 20},
                    "case_sensitive": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            handler=_grep_files,
        ),
        Tool(
            name="edit_file", label="修改文件",
            description_short='修改 UTF-8 文本；单项编辑模式互斥，批量编辑时每个条目分别选择一种操作。',
            description="修改 UTF-8 文本文件；支持整体替换、追加、查找替换和按 target_lines 更新/删除指定行，多个文件用 edits 批量处理。target_lines 支持 8、8-11、8,11，content 为空表示删除；行号以最新 read_file 内容为准，多个范围不能重叠。",
            input_schema={
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string"},
                                "file_id": {"type": "integer"},
                                "mode": {"type": "string", "enum": ["replace", "append", "find_replace", "line_edit"]},
                                "content": {"type": "string"},
                                "find": {"type": "string"},
                                "replace": {"type": "string"},
                                "line_edits": {"type": "array", "items": {"type": "object", "properties": {"target_lines": {"type": "string", "pattern": "^(all|[0-9]+([-,][0-9]+)?)$"}, "content": {"type": "string"}, "expected": {"type": "string"}}, "required": ["target_lines", "content"], "additionalProperties": False}},
                            },
                            "required": ["mode"],
                            "allOf": [
                                {
                                    "if": {"required": ["mode"], "properties": {"mode": {"const": "replace"}}},
                                    "then": {
                                        "required": ["content"],
                                        "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}, {"required": ["line_edits"]}]},
                                    },
                                },
                                {
                                    "if": {"required": ["mode"], "properties": {"mode": {"const": "append"}}},
                                    "then": {
                                        "required": ["content"],
                                        "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}, {"required": ["line_edits"]}]},
                                    },
                                },
                                {
                                    "if": {"required": ["mode"], "properties": {"mode": {"const": "find_replace"}}},
                                    "then": {
                                        "required": ["find", "replace"],
                                        "not": {"anyOf": [{"required": ["content"]}, {"required": ["line_edits"]}]},
                                    },
                                },
                                {"if": {"required": ["mode"], "properties": {"mode": {"const": "line_edit"}}}, "then": {"required": ["line_edits"], "not": {"anyOf": [{"required": ["content"]}, {"required": ["find"]}, {"required": ["replace"]}]}}},
                            ],
                        },
                    },
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "mode": {"type": "string", "enum": ["replace", "append", "find_replace", "line_edit"]},
                    "content": {"type": "string"},
                    "find": {"type": "string"},
                    "replace": {"type": "string"},
                    "line_edits": {"type": "array", "items": {"type": "object", "properties": {"target_lines": {"type": "string", "pattern": "^(all|[0-9]+([-,][0-9]+)?)$"}, "content": {"type": "string"}, "expected": {"type": "string"}}, "required": ["target_lines", "content"], "additionalProperties": False}},
                },
                "allOf": [
                    {"if": {"required": ["mode"], "properties": {"mode": {"const": "replace"}}}, "then": {"required": ["content"], "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}, {"required": ["line_edits"]}]}}},
                    {"if": {"required": ["mode"], "properties": {"mode": {"const": "line_edit"}}}, "then": {"required": ["line_edits"], "not": {"anyOf": [{"required": ["content"]}, {"required": ["find"]}, {"required": ["replace"]}]}}},
                    {
                        "if": {"required": ["mode"], "properties": {"mode": {"const": "append"}}},
                        "then": {
                            "required": ["content"],
                            "not": {"anyOf": [{"required": ["find"]}, {"required": ["replace"]}, {"required": ["line_edits"]}]},
                        },
                    },
                    {
                        "if": {"required": ["mode"], "properties": {"mode": {"const": "find_replace"}}},
                        "then": {
                            "required": ["find", "replace"],
                            "not": {"anyOf": [{"required": ["content"]}, {"required": ["line_edits"]}]},
                        },
                    },
                ],
            },
            handler=_edit_file,
            mutates=True,
        ),
        Tool(
            name="create_file", label="创建文件",
            description_short='批量创建 UTF-8 文本文件；支持自定义扩展名。',
            description="批量创建 UTF-8 文本文件；files 必须是数组，name 和 content 写在数组项内，不要放到顶层。每项填写完整文件名（如 script.py、page.html、config.custom）和 content，未知扩展名也按文本保存。可用 target 指定默认 personal/project、project_id、folder_id，单项可覆盖；会话绑定 Workspace 时可显式传 target.space=workspace（或整体省略目标参数）写入当前工作区。不做格式转换、不执行内容，同名自动保留副本。",
            input_schema={
                "type": "object",
                "properties": {
                    "target": {
                        "type": "object",
                        "properties": {
                            "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                            "project_id": {"type": "integer"},
                            "folder_id": {"type": "integer"},
                        },
                        "additionalProperties": False,
                    },
                    "files": {
                        "type": "array", "minItems": 1, "maxItems": 20,
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "minLength": 1, "maxLength": 300},
                                "content": {"type": "string", "maxLength": 262144},
                                "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                                "project_id": {"type": "integer"},
                                "folder_id": {"type": "integer"},
                            },
                            "required": ["name", "content"],
                            "additionalProperties": False,
                            "allOf": [
                                {
                                    "if": {"required": ["space"], "properties": {"space": {"const": "project"}}},
                                    "then": {"required": ["project_id"]},
                                },
                            ],
                        },
                    },
                },
                "required": ["files"],
                "additionalProperties": False,
            },
            handler=_create_file,
            mutates=True,
        ),
        Tool(
            name="rename_file", label="重命名文件",
            description_short='重命名文件；可选修改扩展名。',
            description="重命名文件，可单个或批量修改名称及后缀，不改变位置。",
            input_schema={
                "type": "object",
                "properties": {
                    "renames": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "string"},
                                "file_id": {"type": "integer"},
                                "new_name": {"type": "string"},
                                "format": {"type": "string", "enum": sorted(_DOC_MIME)},
                            },
                            "required": ["new_name"],
                        },
                    },
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "new_name": {"type": "string"},
                    "format": {"type": "string", "enum": sorted(_DOC_MIME)},
                },
            },
            handler=_rename_file,
            mutates=True,
        ),
        Tool(
            name="copy_file", label="复制文件",
            description_short='复制文件。',
            description="复制一份文件到目标位置（target.folder 填文件夹名；不填则在原位复制一份）。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "target": {
                        "type": "object",
                        "properties": {
                            "folder": {"type": "string"},
                            "space": {"type": "string", "enum": ["project", "workspace", "personal"]},
                            "project_id": {"type": "integer"},
                            "folder_id": {"type": "integer"},
                        },
                    },
                },
                "oneOf": [
                    {"required": ["file_id"], "not": {"required": ["file"]}},
                    {"required": ["file"], "not": {"required": ["file_id"]}},
                ],
                "allOf": [
                    {"if": {"required": ["destination"], "properties": {"destination": {"const": "folder"}}}, "then": {"required": ["target"]}},
                    {"if": {"required": ["destination"], "properties": {"destination": {"const": "same"}}}, "then": {"not": {"required": ["target"]}}},
                ],
            },
            handler=_copy_file,
            mutates=True,
        ),
        Tool(
            name="delete_file", label="删除文件",
            description_short='删除文件到回收站。',
            description="删除一个或多个文件（移入回收站，30 天内可还原，非永久删除）。单项传 file_id/file，批量传 file_ids。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "file": {"type": "string"},
                    "file_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                },
                "required": [],
            },
            handler=_delete_file,
            mutates=True,
        ),
]
