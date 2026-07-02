"""
SQLAlchemy 2.0 async 模型定义
Files 四空间结构 + 项目内用户文件夹（Folder）。
重建表：DROP SCHEMA public CASCADE; CREATE SCHEMA public; 然后重启后端。
"""

import json
from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import String, Integer, Text, DateTime, ForeignKey, Boolean, BigInteger, Uuid, JSON, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from uuid6 import uuid7

from app.core.crypto import EncryptedString
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
    created_at:           Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)
    token_limit_monthly:  Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    token_limit_6h:       Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    token_limit_weekly:   Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    storage_limit_bytes:  Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True, default=None)
    search_limit_daily:   Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    last_active_at:       Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None, index=True)
    is_developer:         Mapped[bool]          = mapped_column(Boolean, default=False)   # 开发者标记：数据面板可一键排除，看真实用户数据

    projects:      Mapped[list["Project"]]             = relationship(back_populates="owner", cascade="all, delete-orphan")
    files:         Mapped[list["File"]]                = relationship(back_populates="owner", cascade="all, delete-orphan")
    folders:       Mapped[list["Folder"]]              = relationship(back_populates="owner", cascade="all, delete-orphan")
    events:        Mapped[list["CalendarEvent"]]       = relationship(back_populates="owner", cascade="all, delete-orphan")
    clients:       Mapped[list["Client"]]              = relationship(back_populates="owner", cascade="all, delete-orphan")
    mind_maps:     Mapped[list["MindMap"]]             = relationship(back_populates="owner", cascade="all, delete-orphan")
    conversations: Mapped[list["ConversationSession"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    preferences:   Mapped[Optional["UserPreferences"]] = relationship(back_populates="owner", cascade="all, delete-orphan", uselist=False)


# ── UserPreferences ──────────────────────────────────────────────────────────

class UserPreferences(Base):
    __tablename__ = "user_preferences"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True)
    data_json:  Mapped[str]      = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

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
    color:         Mapped[str]           = mapped_column(String(300), default="linear-gradient(135deg,#7b7fb2,#c4afc8)")
    progress:      Mapped[int]           = mapped_column(Integer,     default=0)
    stages_json:   Mapped[str]           = mapped_column(Text,        default="[]")
    current_stage: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    priority:      Mapped[Optional[str]] = mapped_column(String(20),  nullable=True)
    version:       Mapped[int]           = mapped_column(Integer,     default=1)
    archived:      Mapped[bool]          = mapped_column(Boolean,     default=False)
    done_at:       Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at:    Mapped[datetime]      = mapped_column(DateTime,    default=datetime.utcnow)
    updated_at:    Mapped[datetime]      = mapped_column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)

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
    size:         Mapped[str]           = mapped_column(String(50),  default="")
    size_bytes:   Mapped[int]           = mapped_column(BigInteger,  default=0)
    mime_type:    Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    img_width:    Mapped[Optional[int]] = mapped_column(Integer,     nullable=True)
    img_height:   Mapped[Optional[int]] = mapped_column(Integer,     nullable=True)
    created_at:   Mapped[datetime]      = mapped_column(DateTime,    default=datetime.utcnow)
    updated_at:   Mapped[datetime]      = mapped_column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)
    deleted_at:   Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None, index=True)

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
    created_at: Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)

    owner:    Mapped["User"]              = relationship(back_populates="folders")
    project:  Mapped[Optional["Project"]] = relationship(back_populates="folders")
    files:    Mapped[list["File"]]        = relationship(back_populates="folder")
    children: Mapped[list["Folder"]]      = relationship(back_populates="parent", cascade="all, delete-orphan")
    parent:   Mapped[Optional["Folder"]]  = relationship(back_populates="children", remote_side="Folder.id")


# ── MindMap（思维画布，暂不开发，预留结构）────────────────────────────────────

class MindMap(Base):
    __tablename__ = "mind_maps"

    id:         Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]          = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title:      Mapped[str]           = mapped_column(String(300))
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    data_json:  Mapped[str]           = mapped_column(Text, default="{}")
    created_at: Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner: Mapped["User"]       = relationship(back_populates="mind_maps")
    files: Mapped[list["File"]] = relationship(back_populates="mind_map")


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
    created_at:  Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow)

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
    created_at: Mapped[datetime]      = mapped_column(DateTime,    default=datetime.utcnow)

    owner: Mapped["User"] = relationship(back_populates="clients")


# ── AI 会话 ───────────────────────────────────────────────────────────────────

class ConversationSession(Base):
    __tablename__ = "conversation_sessions"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title:      Mapped[str]      = mapped_column(String(300), default="新对话")
    summary:    Mapped[str]      = mapped_column(Text, default="")   # 一句话「这段对话聊了啥」，供跨 session 查找/续接（随会话刷新；绑 session、删则同删）
    source:     Mapped[str]      = mapped_column(String(20), default="web")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

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
    created_at:   Mapped[datetime]        = mapped_column(DateTime, default=datetime.utcnow)

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
    created_at: Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)


# ── SearchUsage ───────────────────────────────────────────────────────────────

class SearchUsage(Base):
    """深度研究用量：每次 deep_research（Tavily）记一行，用于每日次数配额统计。
    （web_search 走自建 SearXNG、免费，不计配额。）"""
    __tablename__ = "search_usage"

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    query:      Mapped[str]      = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ── InviteCode ────────────────────────────────────────────────────────────────

class InviteCode(Base):
    __tablename__ = "invite_codes"

    id:         Mapped[int]              = mapped_column(Integer, primary_key=True, autoincrement=True)
    code:       Mapped[str]              = mapped_column(String(32), unique=True, index=True)
    note:       Mapped[Optional[str]]    = mapped_column(String(200), nullable=True)
    used_at:    Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    used_by:    Mapped[Optional[UUID]]   = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime]         = mapped_column(DateTime, default=datetime.utcnow)


# ── AuditLog ──────────────────────────────────────────────────────────────────

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id:          Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    username:    Mapped[str]           = mapped_column(String(100), index=True)
    action:      Mapped[str]           = mapped_column(String(50), index=True)
    description: Mapped[str]           = mapped_column(Text)
    ip:          Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    created_at:  Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)


# ── SystemLog ─────────────────────────────────────────────────────────────────

class SystemLog(Base):
    __tablename__ = "system_logs"

    id:         Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    level:      Mapped[str]           = mapped_column(String(20), index=True)   # ERROR WARNING INFO
    module:     Mapped[str]           = mapped_column(String(200), index=True)
    message:    Mapped[str]           = mapped_column(Text)
    traceback:  Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime]      = mapped_column(DateTime, default=datetime.utcnow, index=True)


# ── FrontendEvent（前端行为埋点）─────────────────────────────────────────────

class FrontendEvent(Base):
    __tablename__ = "frontend_events"

    id:         Mapped[int]                = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]               = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event:      Mapped[str]                = mapped_column(String(64), index=True)   # chat_open / chat_expanded / chat_message
    properties: Mapped[Optional[dict]]     = mapped_column(JSON, nullable=True, default=None)
    created_at: Mapped[datetime]           = mapped_column(DateTime, default=datetime.utcnow, index=True)


# ── Feedback（用户反馈）─────────────────────────────────────────────────────

class Feedback(Base):
    __tablename__ = "feedbacks"

    id:         Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:    Mapped[UUID]           = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    username:   Mapped[str]            = mapped_column(String(64))   # 冗余存，用户删除后仍可读
    category:   Mapped[str]            = mapped_column(String(32), index=True)   # bug / suggestion / other
    content:    Mapped[str]            = mapped_column(Text)
    created_at: Mapped[datetime]       = mapped_column(DateTime, default=datetime.utcnow, index=True)


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
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    created_at:  Mapped[datetime]           = mapped_column(DateTime, default=datetime.utcnow)
    updated_at:  Mapped[datetime]           = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


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
    bubble_expire_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)  # 气泡时限，null=永久
    created_by: Mapped[str]      = mapped_column(String(100), default="admin")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class NotificationRead(Base):
    """按用户记录已读的站内通知（site_notifications.id）。一条记录 = 该用户读过该通知；无记录 = 未读。"""
    __tablename__ = "notification_reads"
    __table_args__ = (UniqueConstraint("user_id", "notification_id", name="uq_notif_read"),)

    id:              Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:         Mapped[UUID]     = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    notification_id: Mapped[int]      = mapped_column(ForeignKey("site_notifications.id", ondelete="CASCADE"), index=True)
    read_at:         Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
