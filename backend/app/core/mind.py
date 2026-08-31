"""思维面板的两条机制化不变量——把容易写错的地方收敛成唯一入口。

见 docs/product/思维面板/数据模型草案.md：

1. **乐观锁用原子 UPDATE，不是先读再比**（`update_node_atomic`）
   `Project.version` 那套「读出来 → 比 client_version → 再写」在读和写之间有窗口，
   两个并发请求可以同时通过版本比较、再互相覆盖。这里把比较和写入合成一条
   `UPDATE … WHERE id AND user_id AND version=:v`，由数据库在行锁下判定，靠 rowcount 定成败。

2. **`related` 归一 + 幂等**（`upsert_relation`）
   `related` 是无向的，A→B 与 B→A 必须归一成同一条边（按 id 排小的在前），
   配合 `uq_mind_relation` 唯一约束，用户重复点连线 / 咕咕重复建议都命中已有行，
   不堆重复边；唯一约束同时兜住并发下两个请求同时插入的竞态。

另外内容变更时 `indexed_at` 必须清回 null（否则首次向量化后改正文会被漏索引），
这条也做进 `update_node_atomic`，调用方无从忘记。
"""
from __future__ import annotations
from datetime import datetime, timezone
from uuid import UUID, uuid4
import hashlib
import re

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.core.tz import now_utc
from app.models import MindNode, MindRelation

# 时间流便签共五种状态：null=默认纸色，另外四种是 UI 色板。画布专属便签仍由画布 API
# 维持「必须选自定义色」的既有约定，不能据此把默认纸色塞进画布。
MIND_NOTE_COLORS = frozenset({"amber", "coral", "blue", "teal"})

# 无向关系：存之前按 id 归一（src < dst）。有向类型（supports/causes/…）方向有意义，不归一。
_SYMMETRIC_RELATIONS = {"related"}

# 内容字段：任一变更都要重置索引水位
_CONTENT_FIELDS = ("content_md", "content_plain")

# 便签正文里的对象引用标记：`[[project:7|某项目]]`。
# 存 type+id 这个稳定锚点（不只存名字，业务对象改名/重名都不会指错），
# 竖线后的显示名只作展示；抽纯文本时保留显示名，便签才能按「某项目」被搜到。
REF_PATTERN = re.compile(r"\[\[(?P<type>[a-z_]+):(?P<id>\d+)\|(?P<label>[^\]]*)\]\]")


def to_plain_text(md: str | None) -> str:
    """Markdown 源 → 去格式纯文本，喂给 global_search 的 ILIKE（将来还喂 embedding）。

    只做「让正文能被搜到」这一件事，不追求还原排版：
    - 对象引用 `[[project:7|某项目]]` → `某项目`（否则搜「某项目」搜不到引用了它的便签）
    - 链接/图片留文字与 alt，丢 URL；标题/列表/待办/引用符号、强调符、代码围栏统统剥掉
    """
    if not md:
        return ""
    t = REF_PATTERN.sub(lambda m: m.group("label"), md)
    t = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", t)              # 图片 → alt
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)               # 链接 → 文字
    t = re.sub(r"^\s{0,3}```.*$", "", t, flags=re.M)             # 代码围栏行
    t = re.sub(r"`([^`]*)`", r"\1", t)                           # 行内代码
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)          # 标题
    t = re.sub(r"^\s{0,3}>\s?", "", t, flags=re.M)               # 引用
    t = re.sub(r"^\s*[-*+]\s+\[[ xX]\]\s*", "", t, flags=re.M)   # 待办（先于无序列表）
    t = re.sub(r"^\s*[-*+]\s+", "", t, flags=re.M)               # 无序列表
    t = re.sub(r"^\s*\d+\.\s+", "", t, flags=re.M)               # 有序列表
    t = re.sub(r"(\*\*|__|~~|\*|_)", "", t)                      # 强调
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{2,}", "\n", t)
    return t.strip()


def content_hash(text: str | None) -> str:
    """content_plain 的 sha256（64 位十六进制，正好填满 indexed_hash 列）。

    索引管线据此判断「内容真变过才重索引」——只挪画布位置这类改动会动 updated_at，
    但 content_plain 没变，哈希一致就不必重算向量。
    """
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def validate_note_color(color: str | None) -> str | None:
    """笔记卡只允许默认纸色或 UI 已提供的四种色板，不能透传任意 CSS。"""
    if color is not None and color not in MIND_NOTE_COLORS:
        raise ValueError("便签颜色必须是现有色板中的值")
    return color


def validate_note_title(title: str | None) -> str | None:
    """标题既要能清空，也要在工具直调服务层时守住数据库列边界。"""
    if title is None:
        return None
    if not isinstance(title, str):
        raise ValueError("便签标题必须是文本")
    if len(title) > 300:
        raise ValueError("便签标题不能超过 300 个字符")
    return title


def validate_captured_at(captured_at: datetime) -> datetime:
    """记录可补录过去，但不能写进未来。"""
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    if captured_at > now_utc():
        raise ValueError("不能创建未来日期的记录")
    return captured_at


async def create_mind_note(
    db,
    user_id,
    *,
    content_md: str,
    title: str | None = None,
    color: str | None = None,
    captured_at: datetime | None = None,
    origin: str = "user",
) -> MindNode:
    """网页 API 与咕咕共用的 note 写入入口；调用方负责 commit。"""
    when = validate_captured_at(captured_at or now_utc())
    color = validate_note_color(color)
    title = validate_note_title(title)
    plain = to_plain_text(content_md)
    node = MindNode(
        user_id=_as_uuid(user_id), kind="note", title=title, color=color,
        content_md=content_md, content_plain=plain, indexed_hash=content_hash(plain),
        indexed_at=None, captured_at=when, origin=origin,
    )
    db.add(node)
    await db.flush()
    return node


async def update_mind_note(
    db,
    node_id: int,
    user_id,
    client_version: int,
    fields: dict,
) -> bool:
    """校验 note 可写字段后走原子更新；调用方根据 False 返回版本冲突。"""
    if "color" in fields:
        fields["color"] = validate_note_color(fields["color"])
    if "title" in fields:
        fields["title"] = validate_note_title(fields["title"])
    if "captured_at" in fields:
        fields["captured_at"] = validate_captured_at(fields["captured_at"])
    if "content_md" in fields:
        fields["content_plain"] = to_plain_text(fields["content_md"])
    return await update_node_atomic(db, node_id, user_id, client_version, fields)


async def soft_delete_mind_note(db, node_id: int, user_id, client_version: int) -> bool:
    """原子软删一条 live note，避免删到刚被其他端改过的版本。"""
    res = await db.execute(
        update(MindNode)
        .where(
            MindNode.id == node_id,
            MindNode.user_id == _as_uuid(user_id),
            MindNode.kind == "note",
            MindNode.version == client_version,
            MindNode.deleted_at.is_(None),
        )
        .values(deleted_at=now_utc(), updated_at=now_utc(), version=MindNode.version + 1)
    )
    return res.rowcount == 1


async def restore_mind_note(db, node_id: int, user_id) -> bool:
    """恢复软删 note；恢复本身不覆盖正文，版本递增以通知其他端刷新。"""
    res = await db.execute(
        update(MindNode)
        .where(
            MindNode.id == node_id,
            MindNode.user_id == _as_uuid(user_id),
            MindNode.kind == "note",
            MindNode.deleted_at.is_not(None),
        )
        .values(deleted_at=None, updated_at=now_utc(), version=MindNode.version + 1)
    )
    return res.rowcount == 1


def _as_uuid(user_id) -> UUID:
    """user_id 在不同调用路径下可能是 UUID 对象或字符串，统一成 UUID 再进 SQL。"""
    return user_id if isinstance(user_id, UUID) else UUID(str(user_id))


async def update_node_atomic(db, node_id: int, user_id, client_version: int, fields: dict) -> bool:
    """按乐观锁原子更新一个节点。返回 True=更新成功，False=版本已变或不归属（调用方抛 409）。

    - 比较条件写在 WHERE 里，没有 read-compare-write 的窗口。
    - `user_id` 一并进 WHERE，跨用户改不动别人的节点（get_owned 之外再兜一道）。
    - 传入 `content_md`/`content_plain` 时，同一条 UPDATE 里把 `indexed_at` 清回 null、
      并按新 `content_plain` 刷 `indexed_hash`——内容变了就必须重新索引。
    """
    if not fields:
        return False

    values = dict(fields)
    if any(k in values for k in _CONTENT_FIELDS):
        # content_md 与 content_plain 必须成对：正文一变就要重算纯文本、清索引水位、刷哈希。
        # 调用方只给 content_md 时这里兜底推导 content_plain——否则 indexed_hash 会停在旧值、
        # 与正文脱钩，P3 索引管线据此误判「内容没变」而漏掉重索引。
        if "content_md" in values and "content_plain" not in values:
            values["content_plain"] = to_plain_text(values["content_md"])
        values["indexed_at"] = None
        values["indexed_hash"] = content_hash(values["content_plain"])

    values["version"] = MindNode.version + 1
    values["updated_at"] = now_utc()

    res = await db.execute(
        update(MindNode)
        .where(
            MindNode.id == node_id,
            MindNode.user_id == _as_uuid(user_id),
            MindNode.version == client_version,
            # 墓碑不可再改：软删与本次更新并发时（先读到 live、UPDATE 前被软删），
            # 这道 WHERE 让写落空、rowcount=0，避免编辑静默写进已删除节点（TOCTOU 兜底）。
            MindNode.deleted_at.is_(None),
        )
        .values(**values)
    )
    return res.rowcount == 1


async def _find_relation(db, user_id: UUID, src: int, dst: int, rel_type: str, canvas_id: int | None = None) -> MindRelation | None:
    return await db.scalar(
        select(MindRelation).where(
            MindRelation.user_id == user_id,
            MindRelation.canvas_id == canvas_id,
            MindRelation.src_node_id == src,
            MindRelation.dst_node_id == dst,
            MindRelation.rel_type == rel_type,
            MindRelation.edge_key == "",
        )
    )


async def upsert_relation(
    db,
    user_id,
    src_node_id: int,
    dst_node_id: int,
    *,
    rel_type: str = "related",
    origin: str = "user",
    status: str = "confirmed",
    note: str | None = None,
    allow_parallel: bool = False,
    canvas_id: int | None = None,
) -> MindRelation:
    """建一条关系；默认幂等，画布通过 canvas_id 隔离并可明确请求平行边。

    无向类型（related）先按 id 归一，于是 (A,B) 与 (B,A) 落同一行。
    默认模式下已有边直接返回，保留咕咕建议/重复操作的幂等语义；allow_parallel 只由画布在
    两端点组合不同的情况下传入，创建另一条独立边供 loop 使用。

    节点连向自己在 DB 层也有 CheckConstraint 挡着，这里提前拦掉给个明确错误。
    """
    if src_node_id == dst_node_id:
        raise ValueError("节点不能连向自己")

    uid = _as_uuid(user_id)
    src, dst = src_node_id, dst_node_id
    if rel_type in _SYMMETRIC_RELATIONS and src > dst:
        src, dst = dst, src

    if not allow_parallel:
        found = await _find_relation(db, uid, src, dst, rel_type, canvas_id)
        if found is not None:
            return found

    rel = MindRelation(
        user_id=uid, canvas_id=canvas_id, src_node_id=src, dst_node_id=dst,
        rel_type=rel_type, edge_key=uuid4().hex if allow_parallel else "",
        origin=origin, status=status, note=note,
    )
    try:
        async with db.begin_nested():          # SAVEPOINT：冲突只回滚这一小段，不带崩外层事务
            db.add(rel)
            await db.flush()
    except IntegrityError:
        # 平行边必须让错误完整暴露，不能静默退回旧边，否则前端会以为 loop 已创建却只拿到
        # 同一条线；默认幂等模式才回查旧边兼容迁移前的唯一约束并发保护。
        if allow_parallel:
            raise
        found = await _find_relation(db, uid, src, dst, rel_type, canvas_id)
        if found is None:
            raise                              # 不是唯一约束撞车（比如外键不存在），照实抛
        return found
    return rel
