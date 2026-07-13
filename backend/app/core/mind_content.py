"""咕咕写入便签时使用的受限块协议。

网页编辑器仍以 Markdown 作为存储协议；工具不直接接收任意 Markdown，而是先经过这里的
结构化校验与序列化，确保咕咕写出的内容不超出编辑器已支持的范围。
"""
from __future__ import annotations

from typing import Any, Dict, List, Set, Tuple
from urllib.parse import urlparse

from app.core.ownership import get_owned
from app.models import CalendarEvent, File, Project

_REF_MODELS = {"project": Project, "file": File, "event": CalendarEvent}
_MARK_TYPES = {"bold", "italic", "strike", "code", "link"}


class MindContentError(ValueError):
    """受限块不符合编辑器能力时抛出，调用方转为面向模型的参数错误。"""


def _require_text(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise MindContentError(f"{field} 必须是文本")
    if "\x00" in value:
        raise MindContentError(f"{field} 不能包含空字符")
    return value


def _safe_link(href: Any) -> str:
    value = _require_text(href, "链接地址").strip()
    parsed = urlparse(value)
    if parsed.scheme.lower() not in {"http", "https", "mailto"}:
        raise MindContentError("链接只支持 http、https 或 mailto 协议")
    return value


def _serialize_inline(content: Any) -> Tuple[str, Set[Tuple[str, int]]]:
    if not isinstance(content, list):
        raise MindContentError("content 必须是行内内容数组")
    output: List[str] = []
    refs: Set[Tuple[str, int]] = set()
    for part in content:
        if not isinstance(part, dict):
            raise MindContentError("行内内容必须是对象")
        kind = part.get("type")
        if kind == "reference":
            ref_type = part.get("ref_type")
            ref_id = part.get("ref_id")
            label = _require_text(part.get("label"), "引用显示名")
            if ref_type not in _REF_MODELS or not isinstance(ref_id, int) or ref_id < 1:
                raise MindContentError("引用必须指向已有的项目、文件或活动")
            if "]" in label or "|" in label:
                raise MindContentError("引用显示名不能包含 ] 或 |")
            output.append(f"[[{ref_type}:{ref_id}|{label}]]")
            refs.add((ref_type, ref_id))
            continue
        if kind != "text":
            raise MindContentError("行内内容只支持 text 或 reference")

        text = _require_text(part.get("text"), "文本")
        marks = part.get("marks", [])
        if not isinstance(marks, list):
            raise MindContentError("marks 必须是数组")
        names: List[str] = []
        link_href = ""
        for mark in marks:
            if not isinstance(mark, dict) or mark.get("type") not in _MARK_TYPES:
                raise MindContentError("只支持加粗、斜体、删除线、行内代码和链接样式")
            name = mark["type"]
            if name in names:
                raise MindContentError("同一种文字样式不能重复")
            names.append(name)
            if name == "link":
                link_href = _safe_link(mark.get("href"))
        if "code" in names and len(names) > 1:
            raise MindContentError("行内代码不能与其他文字样式叠加")

        value = text
        for name in names:
            if name == "bold":
                value = f"**{value}**"
            elif name == "italic":
                value = f"*{value}*"
            elif name == "strike":
                value = f"~~{value}~~"
            elif name == "code":
                if "`" in value:
                    raise MindContentError("行内代码文本不能包含反引号")
                value = f"`{value}`"
            elif name == "link":
                value = f"[{value}]({link_href})"
        output.append(value)
    return "".join(output), refs


def _serialize_items(items: Any, prefix: str) -> Tuple[List[str], Set[Tuple[str, int]]]:
    if not isinstance(items, list):
        raise MindContentError("列表 items 必须是数组")
    lines: List[str] = []
    refs: Set[Tuple[str, int]] = set()
    for item in items:
        inline, item_refs = _serialize_inline(item)
        lines.append(prefix + inline)
        refs.update(item_refs)
    return lines, refs


def serialize_mind_blocks(blocks: Any) -> Tuple[str, Set[Tuple[str, int]]]:
    """将工具块序列化为当前 TipTap 编辑器能完整读回的 Markdown。"""
    if not isinstance(blocks, list):
        raise MindContentError("blocks 必须是数组")
    if len(blocks) > 200:
        raise MindContentError("单条笔记最多支持 200 个内容块")

    rendered: List[str] = []
    refs: Set[Tuple[str, int]] = set()
    for block in blocks:
        if not isinstance(block, dict):
            raise MindContentError("每个内容块必须是对象")
        kind = block.get("type")
        if kind == "paragraph":
            text, block_refs = _serialize_inline(block.get("content", []))
            rendered.append(text)
        elif kind == "heading":
            text, block_refs = _serialize_inline(block.get("content", []))
            rendered.append(f"# {text}")
        elif kind == "bullet_list":
            lines, block_refs = _serialize_items(block.get("items"), "- ")
            rendered.append("\n".join(lines))
        elif kind == "ordered_list":
            items = block.get("items")
            if not isinstance(items, list):
                raise MindContentError("有序列表 items 必须是数组")
            lines = []
            block_refs = set()
            for index, item in enumerate(items, start=1):
                text, item_refs = _serialize_inline(item)
                lines.append(f"{index}. {text}")
                block_refs.update(item_refs)
            rendered.append("\n".join(lines))
        elif kind == "task_list":
            items = block.get("items")
            if not isinstance(items, list):
                raise MindContentError("待办 items 必须是数组")
            lines = []
            block_refs = set()
            for item in items:
                if not isinstance(item, dict) or not isinstance(item.get("checked"), bool):
                    raise MindContentError("待办项必须包含 checked 布尔值")
                text, item_refs = _serialize_inline(item.get("content", []))
                lines.append(f"- [{'x' if item['checked'] else ' '}] {text}")
                block_refs.update(item_refs)
            rendered.append("\n".join(lines))
        elif kind == "blockquote":
            paragraphs = block.get("paragraphs")
            if not isinstance(paragraphs, list):
                raise MindContentError("引用块 paragraphs 必须是数组")
            lines = []
            block_refs = set()
            for paragraph in paragraphs:
                text, item_refs = _serialize_inline(paragraph)
                lines.append(f"> {text}")
                block_refs.update(item_refs)
            rendered.append("\n".join(lines))
        elif kind == "code_block":
            code = _require_text(block.get("code"), "代码块内容")
            language = block.get("language", "")
            if not isinstance(language, str) or "\n" in language or "`" in language:
                raise MindContentError("代码块语言非法")
            if "```" in code:
                raise MindContentError("代码块内容不能包含三个连续反引号")
            rendered.append(f"```{language}\n{code}\n```")
            block_refs = set()
        elif kind == "horizontal_rule":
            rendered.append("---")
            block_refs = set()
        else:
            raise MindContentError("不支持的内容块类型")
        refs.update(block_refs)
    return "\n\n".join(rendered), refs


async def validate_mind_references(db, user_id, refs: Set[Tuple[str, int]]) -> None:
    """引用必须真实存在且属于当前用户，不能把别人的对象写进自己的笔记。"""
    for ref_type, ref_id in refs:
        if await get_owned(db, _REF_MODELS[ref_type], ref_id, user_id) is None:
            raise MindContentError("引用对象不存在")
