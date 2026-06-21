"""
SQLAlchemy 2.0 async 模型定义
Files 四空间结构 + 项目内用户文件夹（Folder）。
重建表：DROP SCHEMA public CASCADE; CREATE SCHEMA public; 然后重启后端。
"""

import json
from datetime import datetime
from typing import Optional

from sqlalchemy import String, Integer, Text, DateTime, ForeignKey, Boolean, BigInteger
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


# ── User ─────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id:              Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    username:        Mapped[str]      = mapped_column(String(100), unique=True, index=True)
    email:           Mapped[str]      = mapped_column(String(300), unique=True, index=True)
    hashed_password: Mapped[str]      = mapped_column(String(200))
    is_active:       Mapped[bool]     = mapped_column(Boolean, default=True)
    created_at:      Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

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
    user_id:    Mapped[int]      = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True)
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
    user_id:       Mapped[int]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name:          Mapped[str]           = mapped_column(String(200))
    client:        Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    status:        Mapped[str]           = mapped_column(String(20),  default="pending")
    start_date:    Mapped[Optional[str]] = mapped_column(String(10),  nullable=True)
    deadline:      Mapped[Optional[str]] = mapped_column(String(10),  nullable=True)
    color:         Mapped[str]           = mapped_column(String(300), default="linear-gradient(135deg,#7b7fb2,#c4afc8)")
    progress:      Mapped[int]           = mapped_column(Integer,     default=0)
    stages_json:   Mapped[str]           = mapped_column(Text,        default="[]")
    current_stage: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    notes:         Mapped[str]           = mapped_column(Text,        default="")
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
    user_id:      Mapped[int]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
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
    user_id:    Mapped[int]      = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
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
    user_id:    Mapped[int]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
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
    user_id:     Mapped[int]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title:       Mapped[str]           = mapped_column(String(300))
    date:        Mapped[str]           = mapped_column(String(10))
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
    user_id:    Mapped[int]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
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
    user_id:    Mapped[int]      = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title:      Mapped[str]      = mapped_column(String(300), default="新对话")
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

    id:         Mapped[int]      = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int]      = mapped_column(ForeignKey("conversation_sessions.id", ondelete="CASCADE"), index=True)
    role:       Mapped[str]      = mapped_column(String(20))
    content:    Mapped[str]      = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped["ConversationSession"] = relationship(back_populates="messages")
