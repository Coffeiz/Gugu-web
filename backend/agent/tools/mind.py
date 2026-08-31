"""思维面板工具：检索、读取及受限块协议下的笔记 CRUD。"""
from datetime import date, datetime, time
from typing import Any

from app.core.mind import (
    create_mind_note, restore_mind_note, soft_delete_mind_note, update_mind_note,
)
from app.core.date_input import parse_flexible_date
from app.core.mind_content import MindContentError, serialize_mind_blocks, validate_mind_references
from app.services.mind import get_live_note, get_user_node, latest_gugu_note, list_live_nodes, list_node_relations, search_live_nodes
from app.search.query import normalize_queries
from app.core.tz import LOCAL_TZ
from agent.tools.base import BaseSkill, Tool

_MAX_RESULTS = 10
_PREVIEW_LENGTH = 240

# 之前 blocks 字段的 JSON Schema 只声明了 type:array，没有 items 子模式（嵌套结构全靠下面
# description 文字描述）——实测证明这是错的：模型的结构化参数生成一旦遇到"没有形状提示的
# 数组/对象"，会自己套一层通用包装兜底（数组包成 {"item": 值}，无 schema 的对象直接整个
# JSON.stringify 塞进 {"$text": "..."}），跟 description 写没写例子无关，是 schema 层缺失
# 导致的系统性问题（devlog 2026-07-14，日志证据见 gugu.log 的 [DEBUG_BLOCKS] 记录）。
# 下面用真正的 JSON Schema（INLINE_ITEM_SCHEMA + _BLOCK_ITEM_SCHEMA）把两层结构都声明出来；
_INLINE_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["text", "reference"]},
        "text": {"type": "string"},
        "marks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["bold", "italic", "strike", "code", "link"]},
                    "href": {"type": "string"},
                },
                "required": ["type"],
            },
        },
        "ref_type": {"type": "string", "enum": ["project", "file", "event"]},
        "ref_id": {"type": "integer"},
        "label": {"type": "string"},
    },
    "required": ["type"],
}
# bullet_list/ordered_list/task_list 每项、blockquote 每段共用同一个扁平形状（不用 anyOf 挑
# "带 checked 的 task 项" 还是 "纯 content 项"）——实测证明 anyOf 是另一种坑：模型面对两个
# object 分支的选择歧义时，会连哪个分支都不选，直接吐个空对象 {}（跟之前"没形状提示时瞎包装"
# 是两种独立的退化模式，都在这条 blocks 协议上踩过）。checked 设为可选字段、服务端校验层
# （mind_content.py）继续按 block 类型强制 task_list 必须带 checked，两边分工不冲突。
_CONTENT_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "checked": {"type": "boolean"},
        "content": {"type": "array", "items": _INLINE_ITEM_SCHEMA},
    },
    "required": ["content"],
}
_BLOCK_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": [
            "paragraph", "heading", "bullet_list", "ordered_list",
            "task_list", "blockquote", "code_block", "horizontal_rule",
        ]},
        "content": {"type": "array", "items": _INLINE_ITEM_SCHEMA},
        "items": {
            "type": "array",
            "items": _CONTENT_ITEM_SCHEMA,
        },
        "paragraphs": {
            "type": "array",
            "items": _CONTENT_ITEM_SCHEMA,
        },
        "code": {"type": "string"},
        "language": {"type": "string"},
    },
    "required": ["type"],
}

# bullet_list/ordered_list/blockquote 的每一项都用 {"content":[行内...]} 对象包一层，不是行内
# 数组本身——两层裸嵌套数组（`items:[[...],[...]]`）实测模型生成不稳定，几乎每次都退化成
# `{"item":值}` 兜底包装；包一层对象把嵌套深度压回一层（跟 task_list 已有的
# `{"checked":...,"content":[...]}` 同构），模型才能稳定生成（devlog 2026-07-14）。
def _node_summary(node: Any) -> dict:
    """返回适合列表召回的节点摘要，不把整篇笔记塞进搜索结果。"""
    plain = node.content_plain.strip()
    return {
        "node_id": node.id,
        "kind": node.kind,
        "title": node.title,
        "color": node.color,
        "preview": plain[:_PREVIEW_LENGTH],
        "captured_at": node.captured_at.isoformat(),
        "source": {"type": node.ref_type, "id": node.ref_id} if node.ref_type else None,
    }


def _note_detail(node: Any) -> dict:
    return {
        **_node_summary(node),
        "content_md": node.content_md,
        "content_plain": node.content_plain,
        "origin": node.origin,
    }


def _date_anchor(value: date) -> datetime:
    """日期-only 使用本地当天的固定锚点，避免模型参与生成排序时间。"""
    return datetime.combine(value, time(12), tzinfo=LOCAL_TZ)


def _parse_date_only(text: str) -> datetime | None:
    try:
        parsed = parse_flexible_date(text)
    except ValueError as exc:
        if "格式" not in str(exc):
            raise
        return None
    return _date_anchor(parsed)


def _parse_captured_at(value) -> datetime:
    if not isinstance(value, str):
        raise MindContentError("captured_at 必须是日期或带时区的 ISO 8601 时间")
    text = value.strip()
    if not text:
        raise MindContentError("captured_at 不能为空")
    try:
        date_only = _parse_date_only(text)
    except ValueError as exc:
        raise MindContentError("captured_at 日期格式无法识别") from exc
    if date_only is not None:
        return date_only
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MindContentError("captured_at 必须是日期或带时区的 ISO 8601 时间") from exc
    if parsed.tzinfo is None:
        raise MindContentError("captured_at 日期时间必须带时区")
    return parsed


async def _get_live_note(db, user_id, node_id) -> Any:
    return await get_live_note(db, user_id, node_id)


async def _live_nodes_by_ids(db, user_id, node_ids: set[int]) -> dict[int, Any]:
    if not node_ids:
        return {}
    return await list_live_nodes(db, user_id, node_ids)


async def _relations_for_nodes(db, user_id, node_ids: set[int]) -> list[Any]:
    if not node_ids:
        return []
    return await list_node_relations(db, user_id, node_ids)


def _relation_summary(relation: Any, current_node_id: int, nodes: dict[int, Any]) -> dict | None:
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


async def _note_search(db, user_id, args: dict):
    # 对模型统一暴露 query；q 保留为历史调用兼容别名。
    q = (args.get("query") or args.get("q") or "").strip()
    queries = args.get("queries") if isinstance(args.get("queries"), list) else None
    search_queries = normalize_queries(q, queries)
    if not search_queries:
        return {"error": "需要提供搜索关键词 query 或 queries"}

    limit = args.get("limit", 5)
    if not isinstance(limit, int):
        limit = 5
    limit = max(1, min(limit, _MAX_RESULTS))
    matches = await search_live_nodes(db, user_id, search_queries, args.get("mode"), limit)

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


async def _note_get(db, user_id, args: dict):
    node_id = args.get("node_id")
    node = await get_user_node(db, user_id, node_id)
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
    except (MindContentError, ValueError) as exc:
        await db.rollback()
        return {"error": str(exc)}
    return {"note": _note_detail(node)}


async def _update_note(db, user_id, args: dict):
    node_id = args.get("node_id")
    if not isinstance(node_id, int):
        return {"error": "更新便签必须提供 node_id"}
    node = await _get_live_note(db, user_id, node_id)
    if node is None:
        return {"error": "找不到这条便签"}

    try:
        fields = {}
        for name in ("title", "color"):
            if name in args:
                fields[name] = args[name]
        if "captured_at" in args:
            fields["captured_at"] = _parse_captured_at(args["captured_at"])
        if "append_blocks" in args:
            appended, refs = serialize_mind_blocks(args["append_blocks"])
            if not appended:
                return {"error": "append_blocks 不能为空"}
            await validate_mind_references(db, user_id, refs)
            fields["content_md"] = f"{node.content_md}\n\n{appended}" if node.content_md else appended
        if not fields:
            return {"error": "至少提供一个要修改的字段"}
        if not await update_mind_note(db, node_id, user_id, node.version, fields):
            await db.rollback()
            return {"error": "便签刚被修改，请稍后重试；本次只允许追加或修改指定字段"}
        await db.commit()
    except (MindContentError, ValueError) as exc:
        await db.rollback()
        return {"error": str(exc)}
    return {"note": _note_detail(node)}


async def _delete_note(db, user_id, args: dict):
    node_id = args.get("node_id")
    if not isinstance(node_id, int):
        return {"error": "删除便签必须提供 node_id"}
    node = await _get_live_note(db, user_id, node_id)
    if node is None:
        return {"error": "找不到这条便签"}
    if not await soft_delete_mind_note(db, node_id, user_id, node.version):
        await db.rollback()
        return {"error": "便签刚被修改，请稍后重试"}
    await db.commit()
    return {"deleted_node_id": node_id, "can_restore": True}


async def _restore_note(db, user_id, args: dict):
    node_id = args.get("node_id")
    if not isinstance(node_id, int):
        return {"error": "恢复便签必须提供 node_id"}
    node = await get_user_node(db, user_id, node_id)
    if node is None or node.kind != "note" or node.deleted_at is None:
        return {"error": "找不到可恢复的便签"}
    if not await restore_mind_note(db, node_id, user_id):
        await db.rollback()
        return {"error": "便签状态已变化，请重新确认"}
    await db.commit()
    return {"note": _note_detail(node)}


async def _undo_last_gugu_note(db, user_id, args: dict):
    node = await latest_gugu_note(db, user_id)
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
            name="note_search", label="搜索思维笔记",
            description_short='全局搜索时间流笔记和画布便签。',
            description="按一个或多个关键词（默认 OR）搜索思维面板中的笔记和画布便签，并带回每条命中节点的一跳关联。"
                        "用于回答用户的想法、结论、上下文之间有什么关联；需要完整正文时再调用 note_get。",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "q": {"type": "string"},
                    "queries": {"type": "array", "items": {"type": "string"}},
                    "mode": {"type": "string", "enum": ["OR", "AND"]},
                    "limit": {"type": "integer"},
                    "include_content": {"type": "boolean"},
                },
                # q / queries 至少传一个；具体校验由 handler 统一完成，兼容 queries-only 调用。
                "required": [],
            },
            handler=_note_search,
        ),
        Tool(
            name="note_get", label="读取思维节点",
            description_short='固定工具名 note_get：读取搜索到的思维节点正文；传 node_id',
            description="读取一条已知思维节点的完整正文、来源对象和一跳关联。"
                        "node_id 必须来自 note_search 或用户当前可见的思维内容，不能猜测。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer"},
                },
                "required": ["node_id"],
            },
            handler=_note_get,
        ),
        Tool(
            name="note_create", label="记录思维笔记",
            description_short='创建时间流笔记；可选 captured_at 指定日期，不填就是今天。',
            description="按用户要求创建时间流笔记；blocks 使用受限块结构，需改写时先确认草稿。日记只按日期归档，同一天的先后顺序由系统按写入顺序自动决定。补录历史日记时传 captured_at 日期即可，支持 MM-DD、MM/DD、YYYY-MM-DD、YYYY/MM/DD、年份前后和中文日期。",
            input_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "color": {"type": ["string", "null"], "enum": ["amber", "coral", "blue", "teal", None]},
                    "blocks": {"type": "array", "items": _BLOCK_ITEM_SCHEMA},
                    "captured_at": {"type": "string"},
                },
                "required": ["blocks"],
            },
            handler=_create_note,
            mutates=True,
        ),
        Tool(
            name="note_update", label="更新思维笔记",
            description_short='更新思维笔记；captured_at 只用于指定归属日期，不用于指定排序序号。',
            description="对已知笔记做增量更新；使用 node_id 指定目标，只能追加 append_blocks 或修改标题、颜色、归属日期，不能整篇覆盖。日期支持 MM-DD、MM/DD、YYYY-MM-DD、YYYY/MM/DD、年份前后和中文日期。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer"},
                    "title": {"type": ["string", "null"]},
                    "color": {"type": ["string", "null"], "enum": ["amber", "coral", "blue", "teal", None]},
                    "append_blocks": {"type": "array", "items": _BLOCK_ITEM_SCHEMA},
                    "captured_at": {"type": "string"},
                },
                "required": ["node_id"],
                "additionalProperties": False,
            },
            handler=_update_note,
            mutates=True,
        ),
        Tool(
            name="note_delete", label="删除思维笔记",
            description_short='删除思维笔记，执行前确认。',
            description="软删一条已确认的便签，可由 note_restore 恢复。只能传搜索或读取结果里的精确 node_id；"
                        "服务端自动读取当前记录，绝不能按标题、关键词或日期模糊删除。",
            input_schema={
                "type": "object",
                "properties": {
                    "node_id": {"type": "integer"},
                },
                "required": ["node_id"],
                "additionalProperties": False,
            },
            handler=_delete_note,
            mutates=True,
        ),
        Tool(
            name="note_restore", label="恢复思维笔记",
            description_short='恢复思维笔记。',
            description="恢复一条被软删的便签，只接受精确 node_id。",
            input_schema={
                "type": "object",
                "properties": {"node_id": {"type": "integer"}},
                "required": ["node_id"],
            },
            handler=_restore_note,
            mutates=True,
        ),
        Tool(
            name="note_undo", label="撤销刚才的咕咕记录",
            description_short='撤销最近一条咕咕创建的笔记；无需参数',
            description="撤销当前用户最近一次由咕咕创建的笔记；绝不会删除用户自己创建的笔记。",
            input_schema={"type": "object", "properties": {}},
            handler=_undo_last_gugu_note,
            mutates=True,
        ),
    ]


MindSkill().register()
