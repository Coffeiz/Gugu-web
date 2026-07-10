"""
Pydantic v2 schemas — alias_generator=to_camel 让 API 返回 camelCase
"""

from __future__ import annotations
import re
from datetime import datetime
from typing import Optional, Any
from uuid import UUID
from pydantic import BaseModel, ConfigDict, field_validator
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
    email: str
    password: str
    invite_code: str


class UserLogin(CamelModel):
    username: str
    password: str


class ForgotPassword(CamelModel):
    email: str


class ResetPassword(CamelModel):
    token: str
    new_password: str


class UserResponse(CamelModel):
    id: UUID
    username: str
    display_name: Optional[str] = None
    email: str
    is_active: bool
    avatar_url: Optional[str] = None
    created_at: str = ""
    im_channels: list[str] = []
    timezone: Optional[str] = None   # IANA 时区；前端据此判断是否需要探测并回写

    @field_validator('created_at', mode='before')
    @classmethod
    def fmt_date(cls, v):
        if v is None:
            return ""
        if hasattr(v, 'strftime'):
            return v.strftime('%Y-%m-%d')
        return str(v)

    @classmethod
    def from_user(cls, user) -> "UserResponse":
        # 头像 URL 路径固定（按 user.id），换头像后字符串不变 → 前端 :src 不刷新、浏览器命中缓存。
        # 用头像文件 mtime 作版本号挂 ?v=，换图即变 URL，迫使前端重渲染 + 浏览器重取
        avatar_url = None
        if user.avatar:
            avatar_url = f"/api/v1/auth/avatar/{user.id}"
            try:
                from pathlib import Path as _Path
                from app.core.config import get_settings
                p = _Path(get_settings().storage.local_path) / user.avatar
                avatar_url += f"?v={p.stat().st_mtime_ns}"
            except Exception:
                pass
        data = {
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "email": user.email,
            "is_active": user.is_active,
            "created_at": user.created_at,
            "avatar_url": avatar_url,
            "im_channels": getattr(user, "_im_channels", []),
            "timezone": getattr(user, "timezone", None),
        }
        return cls.model_validate(data)


class UpdateProfile(CamelModel):
    display_name: Optional[str] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None
    timezone: Optional[str] = None   # IANA 时区（前端首登探测 Intl…timeZone 回写）；"" 清空


class DeleteAccount(CamelModel):
    password: str


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
    archived: Optional[bool] = None
    priority: Optional[str] = None
    version: Optional[int] = None

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
    archived: bool = False
    priority: Optional[str] = None
    version: int = 1
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
    img_width: Optional[int] = None
    img_height: Optional[int] = None


class BatchDeleteBody(CamelModel):
    ids: list[int]

class BatchDownloadBody(CamelModel):
    ids: list[int] = []
    folder_ids: list[int] = []

class FileCopyBody(CamelModel):
    folder_id:  Optional[int] = None
    project_id: Optional[int] = None


class FileUpdate(CamelModel):
    display_name: Optional[str] = None
    stage_name: Optional[str] = None
    folder_id: Optional[int] = None
    project_id: Optional[int] = None

    @field_validator("display_name")
    @classmethod
    def name_valid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_name(v)


# ── Folder ────────────────────────────────────────────────────────────────────

class FolderCreate(CamelModel):
    project_id: Optional[int] = None
    parent_id:  Optional[int] = None
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


class FolderMove(CamelModel):
    parent_id: Optional[int] = None


class FolderResponse(CamelModel):
    id: int
    project_id: Optional[int]
    parent_id:  Optional[int] = None
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

# ── 思维面板（P1：记录/便签）──────────────────────────────────────────────────

class MindNoteCreate(CamelModel):
    content_md: str = ""
    title: Optional[str] = None
    color: Optional[str] = None
    # 面向用户的「发生/记录时间」，可回填过去（补录昨天的想法 / 导入旧内容）；不传取当前
    captured_at: Optional[datetime] = None


class MindNoteUpdate(CamelModel):
    content_md: Optional[str] = None
    title: Optional[str] = None
    color: Optional[str] = None
    captured_at: Optional[datetime] = None
    # 乐观锁：必传。服务端走原子 UPDATE（WHERE version=…），版本对不上直接 409
    version: int


class MindNodeResponse(CamelModel):
    id: int
    kind: str
    title: Optional[str] = None
    content_md: str = ""
    color: Optional[str] = None
    captured_at: datetime
    version: int
    created_at: datetime
    updated_at: datetime


class MindRefSuggestItem(CamelModel):
    """`[[` 补全的候选：type+id 是写进正文的稳定锚点，label 只作展示。"""
    type: str
    id: int
    label: str
    subtitle: Optional[str] = None


class EventCreate(CamelModel):
    title: str
    date: str
    time: Optional[str] = None       # 开始时间 HH:MM，可选
    end_time: Optional[str] = None   # 结束时间 HH:MM，可选
    type: str = "event"
    client: Optional[str] = None
    project_id: Optional[int] = None
    description: Optional[str] = None


class EventUpdate(CamelModel):
    title: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    end_time: Optional[str] = None
    type: Optional[str] = None
    client: Optional[str] = None
    project_id: Optional[int] = None
    description: Optional[str] = None
    version: Optional[int] = None


class EventResponse(CamelModel):
    id: int
    title: str
    date: str
    time: Optional[str] = None
    end_time: Optional[str] = None
    type: str
    client: Optional[str]
    project_id: Optional[int]
    description: Optional[str] = None
    version: int = 1


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


# ── UserPreferences ───────────────────────────────────────────────────────────

class PreferencesResponse(CamelModel):
    lastStages:        list[str] = []
    stageTemplates:    list[dict] = []
    replyTone:         Optional[str] = None   # natural / formal / lively
    replyLength:       Optional[str] = None   # medium / short / detailed
    pmStagesExpanded:  bool = False            # 项目编辑卡：阶段区展开(50/50) 版面记忆

class PreferencesUpdate(CamelModel):
    lastStages:        Optional[list[str]]  = None
    stageTemplates:    Optional[list[dict]] = None
    replyTone:         Optional[str] = None
    replyLength:       Optional[str] = None
    pmStagesExpanded:  Optional[bool] = None
