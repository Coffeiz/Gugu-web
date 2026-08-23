"""
Pydantic v2 schemas — alias_generator=to_camel 让 API 返回 camelCase
"""

from __future__ import annotations
from datetime import date, datetime
from typing import Any, Literal, Optional
from uuid import UUID

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from app.core.project_colors import DEFAULT_PROJECT_COLOR, PROJECT_COLOR_PRESETS

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


def _validate_project_date(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        raise ValueError("日期必须是 YYYY-MM-DD 格式")
    try:
        date.fromisoformat(v)
    except ValueError as exc:
        raise ValueError("日期必须是有效日期") from exc
    return v


def _validate_project_color(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    if v not in PROJECT_COLOR_PRESETS:
        raise ValueError("颜色必须是预设色板中的值")
    return v


def _validate_project_stages(stages: Optional[list[dict]]) -> Optional[list[dict]]:
    if stages is None:
        return stages
    keys = set()
    todo_ids = set()
    for stage in stages:
        key = stage.get("key")
        label = stage.get("label")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("阶段 key 不能为空")
        if key in keys:
            raise ValueError("阶段 key 不能重复")
        keys.add(key)
        if not isinstance(label, str) or not label.strip():
            raise ValueError("阶段名称不能为空")
        todos = stage.get("todos", [])
        if not isinstance(todos, list):
            raise ValueError("阶段 todos 必须是列表")
        for todo in todos:
            if not isinstance(todo, dict):
                raise ValueError("待办必须是对象")
            todo_id = todo.get("id")
            if not isinstance(todo_id, str) or not todo_id.strip():
                raise ValueError("待办 id 不能为空")
            if todo_id in todo_ids:
                raise ValueError("待办 id 不能重复")
            todo_ids.add(todo_id)
            if not isinstance(todo.get("text", ""), str):
                raise ValueError("待办内容必须是文本")
            if "done" in todo and not isinstance(todo["done"], bool):
                raise ValueError("待办完成状态必须是布尔值")
    return stages


class ProjectCreate(CamelModel):
    name: str
    client: Optional[str] = None
    status: Literal["pending", "active", "done"] = "pending"
    start_date: Optional[str] = None
    deadline: Optional[str] = None
    color: str = DEFAULT_PROJECT_COLOR
    stages: list[dict] = []
    current_stage: Optional[str] = None
    progress: int = Field(0, ge=0, le=100)

    @field_validator("name")
    @classmethod
    def name_valid(cls, v: str) -> str:
        return _validate_name(v)

    _start_date_valid = field_validator("start_date")(_validate_project_date)
    _deadline_valid = field_validator("deadline")(_validate_project_date)
    _color_valid = field_validator("color")(_validate_project_color)
    _stages_valid = field_validator("stages")(_validate_project_stages)

    @model_validator(mode="after")
    def fields_consistent(self):
        if self.start_date and self.deadline and self.start_date > self.deadline:
            raise ValueError("开始日期不能晚于截止日期")
        stage_keys = {stage["key"] for stage in self.stages}
        if self.current_stage is not None and self.current_stage not in stage_keys:
            raise ValueError("当前阶段必须属于阶段列表")
        return self


class ProjectUpdate(CamelModel):
    name: Optional[str] = None
    client: Optional[str] = None
    status: Optional[Literal["pending", "active", "done"]] = None
    start_date: Optional[str] = None
    deadline: Optional[str] = None
    color: Optional[str] = None
    progress: Optional[int] = Field(None, ge=0, le=100)
    stages: Optional[list[dict]] = None
    current_stage: Optional[str] = None
    archived: Optional[bool] = None
    priority: Optional[Literal["high", "medium", "low"]] = None
    version: Optional[int] = Field(None, ge=1)

    @field_validator("name")
    @classmethod
    def name_valid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_name(v)

    _start_date_valid = field_validator("start_date")(_validate_project_date)
    _deadline_valid = field_validator("deadline")(_validate_project_date)
    _color_valid = field_validator("color")(_validate_project_color)
    _stages_valid = field_validator("stages")(_validate_project_stages)

    @model_validator(mode="after")
    def fields_consistent(self):
        if self.start_date and self.deadline and self.start_date > self.deadline:
            raise ValueError("开始日期不能晚于截止日期")
        if self.stages is not None and self.current_stage is not None:
            if self.current_stage not in {stage["key"] for stage in self.stages}:
                raise ValueError("当前阶段必须属于阶段列表")
        return self


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
    on_conflict: str = "keep_both"
    overwrite_file_id: Optional[int] = None


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
    version: int   # 乐观锁：必传，服务端走原子 UPDATE（WHERE version=…），版本对不上 409（P2.6）

    @field_validator("name")
    @classmethod
    def name_valid(cls, v: str) -> str:
        return _validate_name(v)


class FolderMove(CamelModel):
    parent_id: Optional[int] = None
    project_id: Optional[int] = None
    version: int   # 乐观锁：必传，同 FolderRename（P2.6）


class FolderCopy(CamelModel):
    parent_id: Optional[int] = None
    project_id: Optional[int] = None


class FolderResponse(CamelModel):
    id: int
    project_id: Optional[int]
    parent_id:  Optional[int] = None
    name: str
    file_count: int = 0
    version: int = 1


class TrashFolderResponse(FolderResponse):
    """回收站里的顶层已删文件夹（P2.3）：deleted_at 供前端显示删除时间/30 天过期倒计时。"""
    deleted_at: str


class TrashFolderContentsResponse(CamelModel):
    """回收站顶层文件夹的直属内容，只读查看，不改变整体恢复单元语义。"""
    folders: list[TrashFolderResponse] = Field(default_factory=list)
    files: list[FileResponse] = Field(default_factory=list)


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
    deleted_at: Optional[datetime] = None
    ref_type: Optional[str] = None
    ref_id: Optional[int] = None
    # 项目引用创建时缓存的极简快照（client/status/startDate/deadline/doneAt）：项目被删后
    # ProjectRefCard 拿不到活的 Project 记录，靠这份快照仍能显示客户/日期，不止显示名字和颜色。
    # 只在创建那一刻拍照，之后项目改这些字段不会回填——跟 title/color 快照同一套语义。
    ref_snapshot: Optional[dict] = None


class MindRefSuggestItem(CamelModel):
    """`[[` 补全的候选：type+id 是写进正文的稳定锚点，label 只作展示。"""
    type: str
    id: int
    label: str
    subtitle: Optional[str] = None


# ── 思维面板（P2：画布）──────────────────────────────────────────────────────

class MindCanvasCreate(CamelModel):
    title: str = "未命名画布"
    project_id: Optional[int] = None


class MindCanvasUpdate(CamelModel):
    title: Optional[str] = None
    data: Optional[dict] = None


class MindCanvasResponse(CamelModel):
    id: int
    title: str
    project_id: Optional[int] = None
    data: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class MindCanvasItemCreate(CamelModel):
    node_id: int
    x: float = 0
    y: float = 0
    w: Optional[float] = None
    h: Optional[float] = None
    z: int = 0
    collapsed: bool = False
    data: dict = Field(default_factory=dict)


class MindCanvasNoteCreate(CamelModel):
    title: str = "新便签"
    content_md: str = ""
    color: Optional[str] = None
    x: float = 0
    y: float = 0
    w: Optional[float] = None
    h: Optional[float] = None
    z: int = 0


class MindCanvasNoteUpdate(CamelModel):
    title: Optional[str] = None
    content_md: Optional[str] = None
    color: Optional[str] = None
    version: int


class MindCanvasItemUpdate(CamelModel):
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    z: Optional[int] = None
    collapsed: Optional[bool] = None
    data: Optional[dict] = None


class MindCanvasItemBringToFront(CamelModel):
    x: float
    y: float


class MindCanvasItemResponse(CamelModel):
    id: int
    canvas_id: int
    node_id: int
    x: float
    y: float
    w: Optional[float] = None
    h: Optional[float] = None
    z: int
    collapsed: bool
    data: dict = Field(default_factory=dict)
    # 引用对象的首屏展示快照；活动卡用它避免刷新后逐项请求详情导致二次撑高。
    ref_data: Optional[dict] = None
    node: MindNodeResponse
    created_at: datetime
    updated_at: datetime


class MindRelationCreate(CamelModel):
    src_node_id: int
    dst_node_id: int
    allow_parallel: bool = False


class MindRelationResponse(CamelModel):
    id: int
    src_node_id: int
    dst_node_id: int
    rel_type: str
    origin: str
    status: str
    created_at: datetime
    updated_at: datetime


class MindRefNodeCreate(CamelModel):
    ref_type: str
    ref_id: int


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
    defaultView:       str = "projects"       # 应用打开时的默认入口
    shellEnabled:      bool = False            # 用户级开关，仍受管理员全局开关约束
    showToolInteractions: bool = False        # IM 是否展示工具调用过程；默认关闭

class PreferencesUpdate(CamelModel):
    lastStages:        Optional[list[str]]  = None
    stageTemplates:    Optional[list[dict]] = None
    replyTone:         Optional[str] = None
    replyLength:       Optional[str] = None
    pmStagesExpanded:  Optional[bool] = None
    defaultView:       Optional[str] = None
    shellEnabled:      Optional[bool] = None
    showToolInteractions: Optional[bool] = None


class WorkspaceCreate(CamelModel):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["folder", "project"] = "folder"
    folderId: Optional[int] = None
    projectId: Optional[int] = None
    enabled: bool = True


class WorkspaceResponse(CamelModel):
    id: int
    name: str
    kind: str
    folderId: Optional[int] = None
    projectId: Optional[int] = None
    enabled: bool
    isDefault: bool
    boundSessionCount: int = 0
