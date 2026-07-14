"""思维面板工具：检索、读取及受限块协议下的笔记 CRUD。"""
from datetime import datetime

from sqlalchemy import or_, select

from app.core.mind import (
    create_mind_note, restore_mind_note, soft_delete_mind_note, update_mind_note,
)
from app.core.mind_content import MindContentError, serialize_mind_blocks, validate_mind_references
from app.core.ownership import get_owned
from app.models import MindNode, MindRelation
from agent.tools.base import BaseSkill, Tool

_MAX_RESULTS = 10
_PREVIEW_LENGTH = 240

# blocks 字段的 JSON Schema 只声明了 type:array，没有嵌套结构（8 种块类型 + 行内内容两层
# 各自的字段名/形状用 JSON Schema 表达要么写成很深的 oneOf、要么根本表达不出"数组的数组"
# 这种形状，性价比不高）——模型唯一能拿到结构信息的地方就是这段 description 文字，之前
# 只写了一句"受限内容块数组"，没有任何字段名/例子，咕咕只能瞎猜，几乎每次都传错（比如直接
# 塞纯文本字符串数组，而不是 {"type":"paragraph","content":[...]} 这种对象），见
# serialize_mind_blocks 报的"每个内容块必须是对象"。这里把 app/core/mind_content.py 实际
# 校验的完整形状搬进 description，给足字段名和一个可直接照抄结构的例子。
_BLOCKS_SCHEMA_HELP = (
    "blocks 是对象数组，每个对象的 type 字段只能是以下 8 种之一（其余字段按 type 各不相同）：\n"
    '- {"type":"paragraph","content":[行内...]}\n'
    '- {"type":"heading","content":[行内...]}（渲染成标题）\n'
    '- {"type":"bullet_list","items":[[行内...],[行内...]]}（items 是"每一项一组行内数组"的数组，不是行内数组本身）\n'
    '- {"type":"ordered_list","items":[[行内...],[行内...]]}（结构同 bullet_list，渲染成数字序号）\n'
    '- {"type":"task_list","items":[{"checked":false,"content":[行内...]}]}（每项必须带 checked 布尔值）\n'
    '- {"type":"blockquote","paragraphs":[[行内...],[行内...]]}（paragraphs 是"每段一组行内数组"的数组）\n'
    '- {"type":"code_block","code":"...","language":"python"}（language 可省略，普通字符串，不能含反引号）\n'
    '- {"type":"horizontal_rule"}（没有其它字段）\n'
    "「行内」是数组，每个元素是：\n"
    '- 文本：{"type":"text","text":"...","marks":[{"type":"bold"}]}（marks 可省略；可选 bold/italic/strike/code/link，link 要带 {"type":"link","href":"https://..."}）\n'
    '- 引用：{"type":"reference","ref_type":"project"|"file"|"event","ref_id":123,"label":"显示名"}\n'
    "示例（一段话 + 一条待办）：\n"
    '[{"type":"paragraph","content":[{"type":"text","text":"今天开会讨论了预算"}]},'
    '{"type":"task_list","items":[{"checked":false,"content":[{"type":"text","text":"周五前提交方案"}]}]}]'
)


def _node_summary(node: MindNode) -> dict:
    """返回适合列表召回的节点摘要，不把整篇笔记塞进搜索结果。"""
    plain = node.content_plain.strip()
    return {
        "node_id": node.id,
        "kind": node.kind,
        "title": node.title,
        "color": node.color,
        "version": node.version,
        "preview": plain[:_PREVIEW_LENGTH],
        "captured_at": node.captured_at.isoformat(),
        "source": {"type": node.ref_type, "id": node.ref_id} if node.ref_type else None,
    }


def _note_detail(node: MindNode) -> dict:
    return {
        **_node_summary(node),
        "content_md": node.content_md,
        "content_plain": node.content_plain,
        "origin": node.origin,
    }


def _parse_captured_at(value) -> datetime:
    if not isinstance(value, str):
        raise MindContentError("captured_at 必须是带时区的 ISO 8601 时间")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MindContentError("captured_at 必须是带时区的 ISO 8601 时间") from exc
    if parsed.tzinfo is None:
        raise MindContentError("captured_at 必须带时区")
    return parsed


async def _get_live_note(db, user_id, node_id) -> MindNode | None:
    node = await get_owned(db, MindNode, node_id, user_id)
    if node is None or node.kind != "note" or node.deleted_at is not None:
        return None
    return node


async def _live_nodes_by_ids(db, user_id, node_ids: set[int]) -> dict[int, MindNode]:
    if not node_ids:
        return {}
    rows = (await db.execute(
        select(MindNode).where(
            MindNode.user_id == user_id,
            MindNode.id.in_(node_ids),
            MindNode.deleted_at.is_(None),
        )
    )).scalars().all()
    return {node.id: node for node in rows}


async def _relations_for_nodes(db, user_id, node_ids: set[int]) -> list[MindRelation]:
    if not node_ids:
        return []
    return (await db.execute(
        select(MindRelation).where(
            MindRelation.user_id == user_id,
            or_(
                MindRelation.src_node_id.in_(node_ids),
                MindRelation.dst_node_id.in_(node_ids),
            ),
        ).order_by(MindRelation.created_at.desc())
    )).scalars().all()


def _relation_summary(relation: MindRelation, current_node_id: int, nodes: dict[int, MindNode]) -> dict | None:
    other_id = relation.dst_node_id if relation.src_node_id == current_node_id else relation.src_node_id
    other = nodes.get(other_id)
    if other is None:
        return None
    return {
        "relation_id": relation.id,
        "type": relation.rel_type,
        "status": relation.status,
        "origin": relation.origin,
        "note": relation.note,
        "node": _node_summary(other),
    }


async def _mind_search(db, user_id, args: dict):
    q = (args.get("q") or "").strip()
    if not q:
        return {"error": "需要提供搜索关键词 q"}

    limit = args.get("limit", 5)
    if not isinstance(limit, int):
        limit = 5
    limit = max(1, min(limit, _MAX_RESULTS))
    pattern = f"%{q}%"
    matches = (await db.execute(
        select(MindNode).where(
            MindNode.user_id == user_id,
            MindNode.kind.in_(("note", "canvas_note")),
            MindNode.deleted_at.is_(None),
            or_(MindNode.title.ilike(pattern), MindNode.content_plain.ilike(pattern)),
        ).order_by(MindNode.captured_at.desc()).limit(limit)
    )).scalars().all()

    match_ids = {node.id for node in matches}
    relations = await _relations_for_nodes(db, user_id, match_ids)
    neighbor_ids = {
        relation.dst_node_id if relation.src_node_id in match_ids else relation.src_node_id
        for relation in relations
    } - match_ids
    nodes = await _live_nodes_by_ids(db, user_id, match_ids | neighbor_ids)

    related = []
    for relation in relations:
        for match_id in match_ids & {relation.src_node_id, relation.dst_node_id}:
            item = _relation_summary(relation, match_id, nodes)
            if item is not None:
                related.append({"from_node_id": match_id, **item})

    return {
        "query": q,
        "count": len(matches),
        "matches": [
            _note_detail(node) if args.get("include_content") is True else _node_summary(node)
            for node in matches
        ],
        "related": related,
    }


async def _mind_get(db, user_id, args: dict):
    node_id = args.get("node_id")
    node = await get_owned(db, MindNode, node_id, user_id)
    if node is None or node.deleted_at is not None:
        return {"error": "找不到这条思维节点"}

    relations = await _relations_for_nodes(db, user_id, {node.id})
    neighbor_ids = {
        relation.dst_node_id if relation.src_node_id == node.id else relation.src_node_id
        for relation in relations
    }
    neighbors = await _live_nodes_by_ids(db, user_id, neighbor_ids)
    related = [
        item for relation in relations
        if (item := _relation_summary(relation, node.id, neighbors)) is not None
    ]
    return {
        "node": _note_detail(node),
        "related": related,
    }


async def _create_note(db, user_id, args: dict):
    if "blocks" not in args:
        return {"error": "需要提供 blocks"}
    try:
        content_md, refs = serialize_mind_blocks(args["blocks"])
        await validate_mind_references(db, user_id, refs)
        captured_at = _parse_captured_at(args["captured_at"]) if "captured_at" in args else None
        node = await create_mind_note(
            db, user_id, content_md=content_md, title=args.get("title"), color=args.get("color"),
            captured_at=captured_at, origin="gugu",
        )
        await db.commit()
        await db.refresh(node)
    except (MindContentError, ValueError) as exc:
        await db.rollback()
        return {"error": str(exc)}
    return {"note": _note_detail(node)}


async def _update_note(db, user_id, args: dict):
    node_id = args.get("node_id")
    version = args.get("version")
    if not isinstance(node_id, int) or not isinstance(version, int):
        return {"error": "更新便签必须提供 node_id 和 version"}
    node = await _get_live_note(db, user_id, node_id)
    if node is None:
        return {"error": "找不到这条便签"}
    if "blocks" in args and "append_blocks" in args:
        return {"error": "blocks 和 append_blocks 不能同时提供"}

    try:
        fields = {}
        for name in ("title", "color"):
            if name in args:
                fields[name] = args[name]
        if "captured_at" in args:
            fields["captured_at"] = _parse_captured_at(args["captured_at"])
        if "blocks" in args:
            content_md, refs = serialize_mind_blocks(args["blocks"])
            await validate_mind_references(db, user_id, refs)
            fields["content_md"] = content_md
        elif "append_blocks" in args:
            appended, refs = serialize_mind_blocks(args["append_blocks"])
            if not appended:
                return {"error": "append_blocks 不能为空"}
            await validate_mind_references(db, user_id, refs)
            fields["content_md"] = f"{node.content_md}\n\n{appended}" if node.content_md else appended
        if not fields:
            return {"error": "至少提供一个要修改的字段"}
        if not await update_mind_note(db, node_id, user_id, version, fields):
            await db.rollback()
            return {"error": "便签已被其他端修改，请先重新读取后再更新"}
        await db.commit()
        await db.refresh(node)
    except (MindContentError, ValueError) as exc:
        await db.rollback()
        return {"error": str(exc)}
    return {"note": _note_detail(node)}


async def _delete_note(db, user_id, args: dict):
    node_id = args.get("node_id")
    version = args.get("version")
    if not isinstance(node_id, int) or not isinstance(version, int):
        return {"error": "删除便签必须提供 node_id 和 version"}
    if await _get_live_note(db, user_id, node_id) is None:
        return {"error": "找不到这条便签"}
    if not await soft_delete_mind_note(db, node_id, user_id, version):
        await db.rollback()
        return {"error": "便签已被其他端修改，请先重新读取后再删除"}
    await db.commit()
    return {"deleted_node_id": node_id, "can_restore": True}


async def _restore_note(db, user_id, args: dict):
    node_id = args.get("node_id")
    if not isinstance(node_id, int):
        return {"error": "恢复便签必须提供 node_id"}
    node = await get_owned(db, MindNode, node_id, user_id)
    if node is None or node.kind != "note" or node.deleted_at is None:
        return {"error": "找不到可恢复的便签"}
    if not await restore_mind_note(db, node_id, user_id):
        await db.rollback()
        return {"error": "便签状态已变化，请重新确认"}
    await db.commit()
    await db.refresh(node)
    return {"note": _note_detail(node)}


async def _undo_last_gugu_note(db, user_id, args: dict):
    node = await db.scalar(
        select(MindNode)
        .where(
            MindNode.user_id == user_id,
            MindNode.kind == "note",
            MindNode.origin == "gugu",
            MindNode.deleted_at.is_(None),
        )
        .order_by(MindNode.created_at.desc(), MindNode.id.desc())
        .limit(1)
    )
    if node is None:
        return {"error": "没有可撤销的咕咕记录"}
    if not await soft_delete_mind_note(db, node.id, user_id, node.version):
        await db.rollback()
        return {"error": "刚才的记录状态已变化，请重新确认"}
    await db.commit()
    return {"deleted_node_id": node.id, "can_restore": True}


class MindSkill(BaseSkill):
    name = "mind"
    tools = [
        Tool(
            name="mind_search", label="搜索思维笔记",
            description="按关键词搜索思维面板中的笔记和画布便签，并带回每条命中节点的一跳关联。"
                        "用于回答用户的想法、结论、上下文之间有什么关联；需要完整正文时再调用 mind_get。",
            input_schema={
                "type": "object",
                "properties": {
                    "q": {"type": "string", "description": "要在笔记正文和标题中搜索的关键词"},
                    "limit": {"type": "integer", "description": "最多返回命中数，默认 5，最大 10"},
                    "include_content": {"type": "boolean", "description": "true 时返回命中笔记完整正文；默认只返回预览"},
                },
                "required": ["q"],
            },
            handler=_mind_search,
        ),
        Tool(
            name="mind_get", label="读取思维节点",
            description="读取一条已知思维节点的完整正文、来源对象和一跳关联。"
                        "node_id 必须来自 mind_search 或用户当前可见的思维内容，不能猜测。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer", "description": "思维节点 ID"},
                },
                "required": ["node_id"],
            },
            handler=_mind_get,
        ),
        Tool(
            name="create_note", label="记录思维笔记",
            description="在思维面板创建一条笔记。只在用户明确要求记录时调用；blocks 只能使用现有"
                        "笔记编辑器支持的段落、标题、列表、待办、引用、文字样式、代码块、引用块和分割线。"
                        "用户原话可直接记录；需要归纳或改写时，先在对话给草稿，等用户确认后再调用。",
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "可选标题"},
                    "color": {"type": ["string", "null"], "enum": ["amber", "coral", "blue", "teal", None], "description": "可选；null 为默认纸色，其余值必须选现有色板"},
                    "blocks": {"type": "array", "description": f"受限内容块数组；不得传任意 Markdown 或 HTML。{_BLOCKS_SCHEMA_HELP}"},
                    "captured_at": {"type": "string", "description": "可选，带时区的 ISO 8601 时间；只能是现在或过去"},
                },
                "required": ["blocks"],
            },
            handler=_create_note,
        ),
        Tool(
            name="update_note", label="更新思维笔记",
            description="更新一条已知便签，可一次修改标题、卡片颜色、整篇 blocks、末尾追加 blocks 或记录时间。"
                        "必须使用 mind_search/mind_get 返回的 node_id 和 version；整篇改写或改写原话前先向用户确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer", "description": "来自读取结果的便签 ID"},
                    "version": {"type": "integer", "description": "来自读取结果的当前版本"},
                    "title": {"type": ["string", "null"], "description": "标题；null 清空标题"},
                    "color": {"type": ["string", "null"], "enum": ["amber", "coral", "blue", "teal", None], "description": "五种卡片颜色之一；null 恢复默认纸色"},
                    "blocks": {"type": "array", "description": f"整篇替换的受限内容块；不能与 append_blocks 同时传。{_BLOCKS_SCHEMA_HELP}"},
                    "append_blocks": {"type": "array", "description": f"追加到笔记末尾的受限内容块；不能与 blocks 同时传。结构同 blocks，见其说明。{_BLOCKS_SCHEMA_HELP}"},
                    "captured_at": {"type": "string", "description": "带时区的 ISO 8601 时间；只能是现在或过去"},
                },
                "required": ["node_id", "version"],
            },
            handler=_update_note,
        ),
        Tool(
            name="delete_note", label="删除思维笔记",
            description="软删一条已确认的便签，可由 restore_note 恢复。只能传搜索或读取结果里的精确"
                        "node_id 和 version；绝不能按标题、关键词或日期模糊删除。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer", "description": "已确认的便签 ID"},
                    "version": {"type": "integer", "description": "已确认的当前版本"},
                },
                "required": ["node_id", "version"],
            },
            handler=_delete_note,
        ),
        Tool(
            name="restore_note", label="恢复思维笔记",
            description="恢复一条被软删的便签，只接受精确 node_id。",
            input_schema={
                "type": "object",
                "properties": {"node_id": {"type": "integer", "description": "要恢复的便签 ID"}},
                "required": ["node_id"],
            },
            handler=_restore_note,
        ),
        Tool(
            name="undo_last_gugu_note", label="撤销刚才的咕咕记录",
            description="撤销当前用户最近一次由咕咕创建的笔记；绝不会删除用户自己创建的笔记。",
            input_schema={"type": "object", "properties": {}},
            handler=_undo_last_gugu_note,
        ),
    ]


MindSkill().register()
