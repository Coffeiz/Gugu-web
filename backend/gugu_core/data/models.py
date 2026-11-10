"""项目共享表结构；Web 自行添加用户外键与跨领域关系。"""
from datetime import datetime
from typing import Optional
from uuid import UUID
import json

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from gugu_core.clock import now_utc
from gugu_core.data.types import UtcDateTime
from gugu_core.domain.project_colors import DEFAULT_PROJECT_COLOR


class ProjectColumns:
    """保留 Web 既有列名及默认值，宿主之间不复制业务 schema。"""

    id:            Mapped[int]           = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id:       Mapped[UUID]          = mapped_column(Uuid, index=True)
    name:          Mapped[str]           = mapped_column(String(200))
    summary:       Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)
    client:        Mapped[Optional[str]] = mapped_column("contact_name", String(200), nullable=True)
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
    deleted_at:    Mapped[Optional[datetime]] = mapped_column(UtcDateTime, nullable=True, default=None, index=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    idempotency_fingerprint: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    @property
    def stages(self) -> list:
        return json.loads(self.stages_json)

    @stages.setter
    def stages(self, value: list):
        self.stages_json = json.dumps(value, ensure_ascii=False)


class LocalBase(DeclarativeBase):
    pass


class LocalProject(ProjectColumns, LocalBase):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_projects_user_idempotency_key"),
    )


class RuntimeMetadata(LocalBase):
    """本地身份和 schema 版本，不创建 Web 用户或管理员。"""

    __tablename__ = "core_runtime_meta"
    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[str] = mapped_column(String(100))
