"""
SQLAlchemy 2.0 async 模型定义
Files 四空间结构 + 项目内用户文件夹（Folder）。
重建表：DROP SCHEMA public CASCADE; CREATE SCHEMA public; 然后重启后端。
"""

from datetime import datetime
from typing import Optional
from uuid import UUID
import json

from sqlalchemy import (
    String, Integer, Float, Text, DateTime, ForeignKey, Boolean, BigInteger, Uuid, JSON,
    UniqueConstraint, CheckConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from uuid6 import uuid7

from app.core.tz import now_utc
from app.core.crypto import EncryptedString
from app.core.project_colors import DEFAULT_PROJECT_COLOR
from app.db.types import UtcDateTime
from app.db.base import Base


# ── User ─────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id:              Mapped[UUID]     = mapped_column(Uuid, primary_key=True, default=uuid7)
    username:        Mapped[str]      = mapped_column(String(100), unique=True, index=True)
    email:           Mapped[str]      = mapped_column(String(300), unique=True, index=True)
    hashed_password: Mapped[str]           = mapped_column(String(200))
    display_name:         Mapped[Optional[str]] = mapped_column(String(100), nullable=True, default=None)
    is_active:            Mapped[bool]          = mapped_column(Boolean, default=True)
    avatar:               Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    created_at:           Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc)
    token_limit_monthly:  Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    token_limit_6h:       Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    token_limit_weekly:   Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    storage_limit_bytes:  Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True, default=None)
    search_limit_daily:   Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    last_active_at:       Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None, index=True)
    is_developer:         Mapped[bool]          = mapped_column(Boolean, default=False)   # 开发者标记：数据面板可一键排除，看真实用户数据
    timezone:             Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)   # IANA 时区（如 Asia/Shanghai）；前端首登探测写入，日期归属/展示按它换算（见 docs/backend/时区与时钟迁移方案.md）

    projects:      Mapped[list["Project"]]             = relationship(back_populates="owner", cascade="all, delete-orphan")
    files:         Mapped[list["File"]]                = relationship(back_populates="owner", cascade="all, delete-orphan")
    folders:       Mapped[list["Folder"]]              = relationship(back_populates="owner", cascade="all, delete-orphan")
    events:        Mapped[list["CalendarEvent"]]       = relationship(back_populates="owner", cascade="all, delete-orphan")
    clients:       Mapped[list["Client"]]              = relationship(back_populates="owner", cascade="all, delete-orphan")
    mind_maps:     Mapped[list["MindMap"]]             = relationship(back_populates="owner", cascade="all, delete-orphan")
    mind_nodes:    Mapped[list["MindNode"]]            = relationship(back_populates="owner", cascade="all, delete-orphan")
    mind_canvas_items: Mapped[list["MindCanvasItem"]]  = relationship(back_populates="owner", cascade="all, delete-orphan")
    mind_relations:    Mapped[list["MindRelation"]]    = relationship(back_populates="owner", cascade="all, delete-orphan")
    conversations: Mapped[list["ConversationSession"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    preferences:   Mapped[Optional["UserPreferences"]] = relationship(back_populates="owner", cascade="all, delete-orphan", uselist=False)


# ── UserPreferences ──────────────────────────────────────────────────────────

class UserPreferences(Base):
    __tablename__ = "user_preferences"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True)
    data_json:  Mapped[str]      = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)

    owner: Mapped["User"] = relationship(back_populates="preferences")

    @property
    def data(self) -> dict:
        try:
            return json.loads(self.data_json)
        except Exception:
            return {}

    @data.setter
    def data(self, value: dict):
        self.data_json = json.dumps(value, ensure_ascii=False)


# ── Project ──────────────────────────────────────────────────────────────────

class Project(Base):
    __tablename__ = "projects"

    id:            Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:       Mapped[UUID]          = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name:          Mapped[str]           = mapped_column(String(200))
    client:        Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    status:        Mapped[str]           = mapped_column(String(20),  default="pending")
    start_date:    Mapped[Optional[str]] = mapped_column(String(10),  nullable=True)
    deadline:      Mapped[Optional[str]] = mapped_column(String(10),  nullable=True)
    color:         Mapped[str]           = mapped_column(String(300), default=DEFAULT_PROJECT_COLOR)
    progress:      Mapped[int]           = mapped_column(Integer,     default=0)
    stages_json:   Mapped[str]           = mapped_column(Text,        default="[]")
    current_stage: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    priority:      Mapped[Optional[str]] = mapped_column(String(20),  nullable=True)
    version:       Mapped[int]           = mapped_column(Integer,     default=1)
    archived:      Mapped[bool]          = mapped_column(Boolean,     default=False)
    done_at:       Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True)
    created_at:    Mapped[datetime]      = mapped_column(UtcDateTime,    default=now_utc)
    updated_at:    Mapped[datetime]      = mapped_column(UtcDateTime,    default=now_utc, onupdate=now_utc)

    owner:   Mapped["User"]          = relationship(back_populates="projects")
    files:   Mapped[list["File"]]    = relationship(back_populates="project", lazy="select")
    folders: Mapped[list["Folder"]]  = relationship(back_populates="project", cascade="all, delete-orphan")

    @property
    def stages(self) -> list:
        try:
            return json.loads(self.stages_json)
        except Exception:
            return []

    @stages.setter
    def stages(self, value: list):
        self.stages_json = json.dumps(value, ensure_ascii=False)


# ── File ─────────────────────────────────────────────────────────────────────

class File(Base):
    __tablename__ = "files"

    id:           Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:      Mapped[UUID]          = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    display_name: Mapped[str]           = mapped_column(String(300))
    ext:          Mapped[str]           = mapped_column(String(20))
    # 所属空间：project | mind | asset | personal
    space:        Mapped[str]           = mapped_column(String(20), default="personal")
    project_id:   Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    folder_id:    Mapped[Optional[int]] = mapped_column(ForeignKey("folders.id", ondelete="SET NULL"), nullable=True)
    stage_name:   Mapped[str]           = mapped_column(String(100), default="")
    mind_map_id:  Mapped[Optional[int]] = mapped_column(ForeignKey("mind_maps.id", ondelete="SET NULL"), nullable=True)
    storage_key:  Mapped[str]           = mapped_column(String(500))
    # 现在恒为 'local'；给「需求突增直接切 OSS」留好快速通道（P4），加列 ≠ 建系统。
    storage_backend: Mapped[str]        = mapped_column(String(20), default="local")
    version:      Mapped[int]           = mapped_column(Integer,     default=1)   # 乐观锁位，供未来文件级并发编辑用
    size:         Mapped[str]           = mapped_column(String(50),  default="")
    size_bytes:   Mapped[int]           = mapped_column(BigInteger,  default=0)
    mime_type:    Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    img_width:    Mapped[Optional[int]] = mapped_column(Integer,     nullable=True)
    img_height:   Mapped[Optional[int]] = mapped_column(Integer,     nullable=True)
    created_at:   Mapped[datetime]      = mapped_column(UtcDateTime,    default=now_utc)
    updated_at:   Mapped[datetime]      = mapped_column(UtcDateTime,    default=now_utc, onupdate=now_utc)
    deleted_at:   Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None, index=True)

    owner:    Mapped["User"]              = relationship(back_populates="files")
    project:  Mapped[Optional["Project"]] = relationship(back_populates="files")
    folder:   Mapped[Optional["Folder"]]  = relationship(back_populates="files")
    mind_map: Mapped[Optional["MindMap"]] = relationship(back_populates="files")


# ── Folder（项目内用户文件夹）────────────────────────────────────────────────

class Folder(Base):
    __tablename__ = "folders"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    parent_id:  Mapped[Optional[int]] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"), nullable=True, index=True)
    name:       Mapped[str]           = mapped_column(String(200))
    created_at: Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc)
    updated_at: Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)
    version:    Mapped[int]           = mapped_column(Integer, default=1)    # 乐观锁位（P2.6，同 Project 的 409 并发模式）
    deleted_at: Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None, index=True)  # 软删（P2.2）

    owner:    Mapped["User"]              = relationship(back_populates="folders")
    project:  Mapped[Optional["Project"]] = relationship(back_populates="folders")
    files:    Mapped[list["File"]]        = relationship(back_populates="folder")
    # 软删后不再靠 DB 级联清子文件夹（那是硬删）——子树由 FolderTree 显式递归软删/恢复；
    # cascade 只在整个 Folder 行被硬删时（如所属 Project 被删）才触发，属既有行为，P2 不动。
    children: Mapped[list["Folder"]]      = relationship(back_populates="parent", cascade="all, delete-orphan")
    parent:   Mapped[Optional["Folder"]]  = relationship(back_populates="children", remote_side="Folder.id")


# ── 思维面板（记录 + 画布）────────────────────────────────────────────────────
# 三层结构见 docs/product/思维面板/数据模型草案.md：
#   mind_nodes        全局节点层（便签 / 业务对象引用代理 / 咕咕建议）
#   mind_canvas_items 画布视图层（某节点摆在某画布上的位置，删它不碰节点）
#   mind_relations    全局关系层（节点↔节点的有向边，跨画布跨项目成立）
# 一条便签可出现在多张画布上；画布只保存展示状态，不拥有节点。

class MindMap(Base):
    """画布容器。

    `project_id` 只是**可选关联 / 初始筛选**，不是节点归属——节点归属在 mind_nodes 自己身上。
    `data_json` 存画布级视图状态（平移、缩放），不再塞节点数据。
    `files.mind_map_id` 是历史字段，只留给旧的"思维空间文件存储"归档，
    **不得再用它判断"文件在哪张画布"**——那由 ref 节点 + mind_canvas_items 表达。
    """
    __tablename__ = "mind_maps"

    id:         Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]          = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title:      Mapped[str]           = mapped_column(String(300))
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    data_json:  Mapped[str]           = mapped_column(Text, default="{}")
    created_at: Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc)
    updated_at: Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)

    owner: Mapped["User"]       = relationship(back_populates="mind_maps")
    files: Mapped[list["File"]] = relationship(back_populates="mind_map")


class MindNode(Base):
    """全局节点层。画布项和关系都只 FK 到这里，不做 (type, id) 多态外键。

    kind：
      - `note`       用户的 Markdown 便签，正文存本行
      - `canvas_note` 画布专属便签，不进入记录时间流
      - `ref`        业务对象（项目/文件/活动…）的引用代理，`ref_type`+`ref_id` 指过去
      - `suggestion` 咕咕的待确认结论（P4 才启用，届时另加节点级 status）

    `ref_id` 故意**不做真实外键**：业务对象被删时不连带删节点，而是让它靠 `title` 快照
    降级成「[已删除]」墓碑，图谱不静默断裂。
    """
    __tablename__ = "mind_nodes"

    id:      Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind:    Mapped[str]  = mapped_column(String(20), default="note")

    # note / suggestion 的内容
    title:         Mapped[Optional[str]] = mapped_column(String(300), nullable=True)   # 便签标题 / ref 快照名 / 墓碑显示名
    content_md:    Mapped[str]           = mapped_column(Text, default="")             # 块编辑器序列化出的 Markdown 源
    content_plain: Mapped[str]           = mapped_column(Text, default="")             # 去格式纯文本：global_search 匹配 + 将来 embedding
    # 300：不只装便签的 amber/coral/blue/teal 短枚举值，项目引用会缓存 Project.color 的完整
    # CSS 渐变字符串（如 "linear-gradient(135deg,#7b7fb2,#c4afc8)"，默认值就有 38 字符）
    # 进来——之前是 String(30)，渐变色的项目第一次建 ref 节点时插入直接超长报错
    # （StringDataRightTruncationError），已有 ref 节点因为走复用分支不会再 INSERT，
    # 表现为"没拖过画布的项目卡添加失败、拖过的正常"（devlog 2026-07-15）。跟
    # Project.color 本身的 String(300) 对齐，不再单独设更小的上限。
    color:         Mapped[Optional[str]] = mapped_column(String(300), nullable=True)

    # ref 节点指向的业务对象
    ref_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)   # project | file | event | client | folder
    ref_id:   Mapped[Optional[int]] = mapped_column(Integer, nullable=True)      # 业务对象主键（这些表都是 int PK）
    # 项目引用创建时缓存的极简快照（{client, status, startDate, deadline, doneAt}）：跟 title/
    # color 同一套「快照降级」思路，只在创建那一刻拍照，之后原对象改这些字段不会回填。
    # 只给 project 类型填，其它 ref_type 为 None。
    ref_snapshot: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # 咕咕相关
    origin:       Mapped[str]                = mapped_column(String(10), default="user")   # user | gugu
    indexed_at:   Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None)   # null=待索引
    indexed_hash: Mapped[Optional[str]]      = mapped_column(String(64), nullable=True, default=None) # content_plain 的 sha256

    version:     Mapped[int]      = mapped_column(Integer, default=1)   # 乐观锁，走 core.mind.update_node_atomic 的原子 UPDATE
    captured_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc, index=True)  # 面向用户的「发生/记录时间」，可编辑
    created_at:  Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)              # 落库时间，只作审计
    updated_at:  Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)
    deleted_at:  Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None, index=True)  # 软删=墓碑

    owner: Mapped["User"] = relationship(back_populates="mind_nodes")

    __table_args__ = (
        # 同一用户对同一业务对象只保留一个引用代理，关系才不会散在多个 ref 上。
        # note 节点两列都是 NULL，SQL 里 NULL 互不相等 → 不会互相冲突。
        UniqueConstraint("user_id", "ref_type", "ref_id", name="uq_mind_node_ref"),
        # 底线约束，不只靠 API 校验：ref 节点两列都得有值，非 ref 两列都得为空
        CheckConstraint(
            "(kind = 'ref' AND ref_type IS NOT NULL AND ref_id IS NOT NULL) "
            "OR (kind <> 'ref' AND ref_type IS NULL AND ref_id IS NULL)",
            name="ck_mind_node_ref_shape",
        ),
    )


class MindCanvasItem(Base):
    """画布视图层：某节点摆在某画布上的展示状态。删这一行只是「从画布上拿掉」，不动节点。"""
    __tablename__ = "mind_canvas_items"

    id:      Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 冗余一份 user_id 省掉查归属时的 join；但它挡不住跨用户拼接，
    # 真正的隔离在 API 写入路径上对 canvas_id / node_id 各过一次 get_owned（见数据模型草案）
    user_id:   Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    canvas_id: Mapped[int]  = mapped_column(ForeignKey("mind_maps.id",  ondelete="CASCADE"), index=True)
    node_id:   Mapped[int]  = mapped_column(ForeignKey("mind_nodes.id", ondelete="CASCADE"), index=True)

    x:         Mapped[float]           = mapped_column(Float, default=0)
    y:         Mapped[float]           = mapped_column(Float, default=0)
    w:         Mapped[Optional[float]] = mapped_column(Float, nullable=True)   # 空=用节点默认尺寸
    h:         Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    z:         Mapped[int]             = mapped_column(Integer, default=0)
    collapsed: Mapped[bool]            = mapped_column(Boolean, default=False)
    data_json: Mapped[str]             = mapped_column(Text, default="{}")     # 预留展示扩展

    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)

    owner: Mapped["User"] = relationship(back_populates="mind_canvas_items")

    __table_args__ = (
        UniqueConstraint("canvas_id", "node_id", name="uq_canvas_node"),   # 同一节点在一张画布上最多一份
    )


class MindRelation(Base):
    """全局关系层：节点↔节点的有向边。

    P1/P2 只写默认的 `related`；P4 才开放 supports / derived_from / verifies 等少量高价值类型。
    `related` 是无向的，服务层按 id 归一。默认创建仍按节点对幂等，避免重复连线、咕咕重复
    建议堆边；画布明确请求平行边时允许同一节点对存多条，以表达从两端分别绕出的 loop。
    端点属于画布视图状态，仍存 data_json，不落进这张全局语义表。见 core.mind.upsert_relation。
    """
    __tablename__ = "mind_relations"

    id:          Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:     Mapped[UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    src_node_id: Mapped[int]  = mapped_column(ForeignKey("mind_nodes.id", ondelete="CASCADE"), index=True)
    dst_node_id: Mapped[int]  = mapped_column(ForeignKey("mind_nodes.id", ondelete="CASCADE"), index=True)

    rel_type: Mapped[str]           = mapped_column(String(20), default="related")
    # 默认边固定为空，平行边用随机 key 区分；端点仍是画布视图 data_json，不是全局语义字段。
    edge_key: Mapped[str]           = mapped_column(String(32), default="")
    origin:   Mapped[str]           = mapped_column(String(10), default="user")        # user | gugu
    status:   Mapped[str]           = mapped_column(String(10), default="confirmed")   # confirmed | suggested
    note:     Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)

    owner: Mapped["User"] = relationship(back_populates="mind_relations")

    __table_args__ = (
        # 默认边（edge_key=''）保留幂等/并发保护；平行边各自带独立 key。
        UniqueConstraint("user_id", "src_node_id", "dst_node_id", "rel_type", "edge_key", name="uq_mind_relation"),
        CheckConstraint("src_node_id <> dst_node_id", name="ck_mind_relation_no_self"),
    )


# ── CalendarEvent ─────────────────────────────────────────────────────────────

class CalendarEvent(Base):
    __tablename__ = "calendar_events"

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:     Mapped[UUID]          = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title:       Mapped[str]           = mapped_column(String(300))
    date:        Mapped[str]           = mapped_column(String(10))
    time:        Mapped[Optional[str]] = mapped_column(String(5), nullable=True)   # 开始时间 HH:MM，可选；空=全天
    end_time:    Mapped[Optional[str]] = mapped_column(String(5), nullable=True)   # 结束时间 HH:MM，可选
    type:        Mapped[str]           = mapped_column(String(50),  default="event")
    client:      Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    project_id:  Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    version:     Mapped[int]           = mapped_column(Integer, default=1)
    created_at:  Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc)

    owner: Mapped["User"] = relationship(back_populates="events")


# ── Client ────────────────────────────────────────────────────────────────────

class Client(Base):
    __tablename__ = "clients"

    id:         Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]          = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name:       Mapped[str]           = mapped_column(String(200))
    contact:    Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    email:      Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    phone:      Mapped[Optional[str]] = mapped_column(String(50),  nullable=True)
    notes:      Mapped[str]           = mapped_column(Text,        default="")
    created_at: Mapped[datetime]      = mapped_column(UtcDateTime,    default=now_utc)

    owner: Mapped["User"] = relationship(back_populates="clients")


# ── AI 会话 ───────────────────────────────────────────────────────────────────

class ConversationSession(Base):
    __tablename__ = "conversation_sessions"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title:      Mapped[str]      = mapped_column(String(300), default="新对话")
    summary:    Mapped[str]      = mapped_column(Text, default="")   # 一句话「这段对话聊了啥」，供跨 session 查找/续接（随会话刷新；绑 session、删则同删）
    source:     Mapped[str]      = mapped_column(String(20), default="web")
    chat_id:   Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)
    platform_user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)
    chat_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)

    owner:    Mapped["User"]                      = relationship(back_populates="conversations")
    messages: Mapped[list["ConversationMessage"]] = relationship(
        back_populates="session",
        order_by="ConversationMessage.created_at",
        cascade="all, delete-orphan",
    )


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id:           Mapped[int]             = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id:   Mapped[int]             = mapped_column(ForeignKey("conversation_sessions.id", ondelete="CASCADE"), index=True)
    role:         Mapped[str]             = mapped_column(String(20))
    content:      Mapped[str]             = mapped_column(Text, default="")
    content_json: Mapped[Optional[list]]  = mapped_column(JSON, nullable=True, default=None)
    files:        Mapped[Optional[list]]  = mapped_column(JSON, nullable=True, default=None)  # 咕咕发的文件卡片 [{file_id,name,ext,size_bytes}]
    # IM 引用/回复的原消息文字（仅 IM 来源的 user 消息可能有）；null=这条不是引用。
    # 单独一列，别拼进 content——网页气泡按纯文本渲染 content，拼进去会把引用原文（可能带 markdown
    # 表格等）原样摊平显示，见 devlog 2026-07-10。
    quoted_text:  Mapped[Optional[str]]    = mapped_column(Text, nullable=True, default=None)
    platform_user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)
    platform_user_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    chat_type:    Mapped[Optional[str]]    = mapped_column(String(20), nullable=True)
    created_at:   Mapped[datetime]        = mapped_column(UtcDateTime, default=now_utc)

    session: Mapped["ConversationSession"] = relationship(back_populates="messages")


# ── AgentUsage ───────────────────────────────────────────────────────────────

class AgentUsage(Base):
    __tablename__ = "agent_usage"

    id:         Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]          = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    session_id: Mapped[Optional[int]] = mapped_column(ForeignKey("conversation_sessions.id", ondelete="SET NULL"), nullable=True)
    tokens_in:  Mapped[int]           = mapped_column(Integer, default=0)
    tokens_out: Mapped[int]           = mapped_column(Integer, default=0)
    model:      Mapped[str]           = mapped_column(String(100))
    provider:   Mapped[str]           = mapped_column(String(50))
    tools_used: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=None)
    created_at: Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc, index=True)


# ── SearchUsage ───────────────────────────────────────────────────────────────

class SearchUsage(Base):
    """深度研究用量：每次 deep_research（Tavily）记一行，用于每日次数配额统计。
    （web_search 走自建 SearXNG、免费，不计配额。）"""
    __tablename__ = "search_usage"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    query:      Mapped[str]      = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc, index=True)


# ── UserBot（BYO：每用户自带的 IM 机器人）─────────────────────────────────────

class UserBot(Base):
    """用户自带机器人（Bring-Your-Own）：每用户存自己的 bot 凭据，咕咕为其起独立网关。

    目前用于 QQ（platform=qqbot）。消息天然属于该 bot 的 owner（user_id），
    所以不需要再做平台用户↔咕咕用户的绑定——bot 即归属。
    """
    __tablename__ = "user_bots"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    platform:   Mapped[str]      = mapped_column(String(20), default="qqbot")
    name:       Mapped[str]      = mapped_column(String(100), default="")
    # app_id 是公开标识符（qq_connect.py/feishu_connect.py 用它做 SQL 等值查询去重），不加密；
    # app_secret 是真正的凭据，落库前 AES-256-GCM 加密（见 app/core/crypto.py）
    app_id:     Mapped[str]      = mapped_column(String(128), default="")
    app_secret: Mapped[str]      = mapped_column(EncryptedString, default="")
    sandbox:    Mapped[bool]     = mapped_column(Boolean, default=False)
    enabled:    Mapped[bool]     = mapped_column(Boolean, default=True)
    # 群聊：是否处理群消息、群消息是否要求 @ 机器人才响应、是否记录普通群消息。
    group_chat_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    group_requires_at:  Mapped[bool] = mapped_column(Boolean, default=False)
    group_read_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # 群成员可用工具白名单；默认只开放联网搜索，不暴露用户私有内容和写操作。
    group_allowed_tools: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=lambda: ["web_search"])
    # QQ 当前 Bot 作用域内的 owner 身份；不作为跨 Bot 全局 QQ ID 使用。
    owner_platform_user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, default=None)
    owner_bound_at: Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)


# ── InviteCode ────────────────────────────────────────────────────────────────

class InviteCode(Base):
    __tablename__ = "invite_codes"

    id:         Mapped[int]              = mapped_column(Integer, primary_key=True, autoincrement=True)
    code:       Mapped[str]              = mapped_column(String(32), unique=True, index=True)
    note:       Mapped[Optional[str]]    = mapped_column(String(200), nullable=True)
    used_at:    Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None)
    used_by:    Mapped[Optional[UUID]]   = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime]         = mapped_column(UtcDateTime, default=now_utc)


# ── AuditLog ──────────────────────────────────────────────────────────────────

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    username:    Mapped[str]           = mapped_column(String(100), index=True)
    action:      Mapped[str]           = mapped_column(String(50), index=True)
    description: Mapped[str]           = mapped_column(Text)
    ip:          Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    created_at:  Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc, index=True)


# ── SystemLog ─────────────────────────────────────────────────────────────────

class SystemLog(Base):
    __tablename__ = "system_logs"

    id:         Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    level:      Mapped[str]           = mapped_column(String(20), index=True)   # ERROR WARNING INFO
    module:     Mapped[str]           = mapped_column(String(200), index=True)
    message:    Mapped[str]           = mapped_column(Text)
    traceback:  Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime]      = mapped_column(UtcDateTime, default=now_utc, index=True)


# ── FrontendEvent（前端行为埋点）─────────────────────────────────────────────

class FrontendEvent(Base):
    __tablename__ = "frontend_events"

    id:         Mapped[int]                = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]               = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event:      Mapped[str]                = mapped_column(String(64), index=True)   # chat_open / chat_expanded / chat_message
    properties: Mapped[Optional[dict]]     = mapped_column(JSON, nullable=True, default=None)
    created_at: Mapped[datetime]           = mapped_column(UtcDateTime, default=now_utc, index=True)


# ── Feedback（用户反馈）─────────────────────────────────────────────────────

class Feedback(Base):
    __tablename__ = "feedbacks"

    id:         Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]           = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    username:   Mapped[str]            = mapped_column(String(64))   # 冗余存，用户删除后仍可读
    category:   Mapped[str]            = mapped_column(String(32), index=True)   # bug / suggestion / other
    content:    Mapped[str]            = mapped_column(Text)
    created_at: Mapped[datetime]       = mapped_column(UtcDateTime, default=now_utc, index=True)


# ── ScheduledTask（定时任务）─────────────────────────────────────────────────

class ScheduledTask(Base):
    __tablename__ = "scheduled_tasks"

    id:          Mapped[int]                = mapped_column(Integer, primary_key=True, autoincrement=True)
    # null = 系统级任务（如截稿扫描，跨用户）；有值 = 用户自定义任务
    user_id:     Mapped[Optional[UUID]]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    # 绑定的日历事件 id（活动编辑面板里加的提醒）；null = 普通独立任务。
    # 故意不设 DB 外键：删事件时由应用层显式删其提醒任务（_delete_event），避免 FK 命名/迁移复杂度、更可移植。
    event_id:    Mapped[Optional[int]]      = mapped_column(Integer, nullable=True, index=True)
    name:        Mapped[str]                = mapped_column(String(100))
    payload:     Mapped[str]                = mapped_column(Text, default="")   # 到点要执行的指令（交给 agent 跑）
    cron:        Mapped[str]                = mapped_column(String(60))    # crontab "m h dom mon dow"
    channels:    Mapped[str]                = mapped_column(String(40), default="chat,im")   # chat / im 逗号分隔
    enabled:     Mapped[bool]               = mapped_column(Boolean, default=True)
    # 执行时按需精简注入用：{"tool_groups": ["web","meta"], "projects": false, "calendar": false,
    # "files": false, "memory": false}。null = 不裁剪，走全量（兼容旧任务/未判断出结果时的安全默认）。
    context_config: Mapped[Optional[dict]]  = mapped_column(JSON, nullable=True, default=None)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None)
    created_at:  Mapped[datetime]           = mapped_column(UtcDateTime, default=now_utc)
    updated_at:  Mapped[datetime]           = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)


# ── SiteNotification（站点通知广播）──────────────────────────────────────────
class SiteNotification(Base):
    __tablename__ = "site_notifications"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    title:      Mapped[str]      = mapped_column(String(200))
    content:    Mapped[str]      = mapped_column(Text, default="")
    color:      Mapped[str]      = mapped_column(String(50), default="#7b7fb2")
    target:     Mapped[str]      = mapped_column(String(50), default="all")   # "all" 或 user_id
    bubble:     Mapped[bool]     = mapped_column(Boolean, default=True)        # 是否弹气泡（实时 + 上线补弹）
    persist:    Mapped[bool]     = mapped_column(Boolean, default=True)        # 是否进通知中心（持久列表）
    bubble_expire_at: Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True)  # 气泡时限，null=永久
    created_by: Mapped[str]      = mapped_column(String(100), default="admin")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)


class NotificationRead(Base):
    """按用户记录已读的站内通知（site_notifications.id）。一条记录 = 该用户读过该通知；无记录 = 未读。"""
    __tablename__ = "notification_reads"
    __table_args__ = (UniqueConstraint("user_id", "notification_id", name="uq_notif_read"),)

    id:              Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:         Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    notification_id: Mapped[int]      = mapped_column(ForeignKey("site_notifications.id", ondelete="CASCADE"), index=True)
    read_at:         Mapped[datetime] = mapped_column(UtcDateTime, default=now_utc)
