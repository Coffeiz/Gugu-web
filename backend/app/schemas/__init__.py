"""
Pydantic v2 schemas — alias_generator=to_camel 让 API 返回 camelCase
"""

from __future__ import annotations
import re
from typing import Optional, Any
from pydantic import BaseModel, ConfigDict, EmailStr, field_validator
from pydantic.alias_generators import to_camel

_INVALID_NAME_RE = re.compile(r'[\\/:*?"<>|]')


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


# ── Auth ──────────────────────────────────────────────────────────────────────

class UserRegister(CamelModel):
    username: str
    email: EmailStr
    password: str


class UserLogin(CamelModel):
    username: str
    password: str


class UserResponse(CamelModel):
    id: int
    username: str
    email: str
    is_active: bool


class TokenResponse(CamelModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


# ── Project ───────────────────────────────────────────────────────────────────

def _validate_name(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("名称不能为空")
    if _INVALID_NAME_RE.search(v):
        raise ValueError('名称不能包含以下字符：\\ / : * ? " < > |')
    return v


class ProjectCreate(CamelModel):
    name: str
    client: Optional[str] = None
    status: str = "pending"
    start_date: Optional[str] = None
    deadline: Optional[str] = None
    color: str = "linear-gradient(135deg,#7b7fb2,#c4afc8)"
    stages: list[dict] = []
    current_stage: Optional[str] = None
    notes: str = ""
    progress: int = 0

    @field_validator("name")
    @classmethod
    def name_valid(cls, v: str) -> str:
        return _validate_name(v)


class ProjectUpdate(CamelModel):
    name: Optional[str] = None
    client: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[str] = None
    deadline: Optional[str] = None
    color: Optional[str] = None
    progress: Optional[int] = None
    stages: Optional[list[dict]] = None
    current_stage: Optional[str] = None
    notes: Optional[str] = None
    archived: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def name_valid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_name(v)


class ProjectResponse(CamelModel):
    id: int
    name: str
    client: Optional[str]
    status: str
    start_date: Optional[str]
    deadline: Optional[str]
    color: str
    progress: int
    stages: list[dict]
    current_stage: Optional[str]
    notes: str
    archived: bool = False
    done_at: Optional[str] = None
    updated_at: Optional[str] = None
    created_at: str = ""
    file_count: int = 0


# ── File ──────────────────────────────────────────────────────────────────────

class FileResponse(CamelModel):
    id: int
    display_name: str
    ext: str
    space: str
    project_id: Optional[int]
    project_name: Optional[str]
    project_color: Optional[str]
    stage_name: str
    folder_id: Optional[int]
    folder_name: Optional[str]
    mind_map_id: Optional[int]
    size: str
    size_bytes: int
    mime_type: Optional[str]
    created_at: str
    deleted_at: Optional[str] = None


class BatchDeleteBody(CamelModel):
    ids: list[int]


class FileUpdate(CamelModel):
    display_name: Optional[str] = None
    stage_name: Optional[str] = None
    folder_id: Optional[int] = None

    @field_validator("display_name")
    @classmethod
    def name_valid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_name(v)


# ── Folder ────────────────────────────────────────────────────────────────────

class FolderCreate(CamelModel):
    project_id: Optional[int] = None
    name: str

    @field_validator("name")
    @classmethod
    def name_valid(cls, v: str) -> str:
        return _validate_name(v)


class FolderRename(CamelModel):
    name: str

    @field_validator("name")
    @classmethod
    def name_valid(cls, v: str) -> str:
        return _validate_name(v)


class FolderResponse(CamelModel):
    id: int
    project_id: Optional[int]
    name: str
    file_count: int = 0


# ── File Tree ─────────────────────────────────────────────────────────────────

class ProjectTreeEntry(CamelModel):
    id: int
    name: str
    color: str
    total_count: int


class FileTreeResponse(CamelModel):
    projects: list[ProjectTreeEntry]
    personal_count: int


# ── CalendarEvent ─────────────────────────────────────────────────────────────

class EventCreate(CamelModel):
    title: str
    date: str
    type: str = "event"
    client: Optional[str] = None
    project_id: Optional[int] = None
    description: Optional[str] = None


class EventUpdate(CamelModel):
    title: Optional[str] = None
    date: Optional[str] = None
    type: Optional[str] = None
    client: Optional[str] = None
    project_id: Optional[int] = None
    description: Optional[str] = None


class EventResponse(CamelModel):
    id: int
    title: str
    date: str
    type: str
    client: Optional[str]
    project_id: Optional[int]
    description: Optional[str] = None


# ── Client ────────────────────────────────────────────────────────────────────

class ClientCreate(CamelModel):
    name: str
    contact: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    notes: str = ""


class ClientResponse(CamelModel):
    id: int
    name: str
    contact: Optional[str]
    email: Optional[str]
    phone: Optional[str]
    notes: str
