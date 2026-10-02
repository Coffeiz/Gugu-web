"""版本化用户数据归档的可移植记录与 manifest 契约。"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


FORMAT_VERSION = "1.0"
PORTABLE_CATEGORIES = frozenset({
    "account",
    "preferences",
    "projects",
    "clients",
    "files",
    "calendar",
    "mind",
    "skills",
    "feedback",
    "workspaces",
    "scheduled_tasks",
    "conversations",
    "drafts",
    "connections",
    "owner_memory",
    "im_memory",
    "archive_docs",
})
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def validate_archive_path(value: str) -> str:
    """只接受规范的 ZIP 相对路径，避免解包路径穿越及别名覆盖。"""
    if not value or "\\" in value or "\x00" in value:
        raise ValueError("归档路径为空或包含非法字符")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value:
        raise ValueError("归档路径必须是规范的相对路径")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("归档路径包含非法目录段")
    if any(ord(char) < 32 for char in value):
        raise ValueError("归档路径包含控制字符")
    return value


class PortableCategory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    included: bool
    records: int = Field(ge=0)
    bytes: int = Field(ge=0)

    @model_validator(mode="after")
    def excluded_category_is_empty(self) -> "PortableCategory":
        if not self.included and (self.records or self.bytes):
            raise ValueError("未包含的归档类别不能声明记录或字节")
        return self


class PortableArchiveEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    category: str
    size: int = Field(ge=0)
    sha256: str
    records: int | None = Field(default=None, ge=0)

    @field_validator("path")
    @classmethod
    def canonical_relative_path(cls, value: str) -> str:
        return validate_archive_path(value)

    @field_validator("sha256")
    @classmethod
    def valid_sha256(cls, value: str) -> str:
        if not _SHA256_RE.fullmatch(value):
            raise ValueError("sha256 必须是 64 位小写十六进制摘要")
        return value


class PortableArchiveManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format_version: str = FORMAT_VERSION
    origin_id: UUID
    export_id: UUID
    created_at: datetime
    complete: bool
    categories: dict[str, PortableCategory]
    entries: list[PortableArchiveEntry]

    @field_validator("format_version")
    @classmethod
    def supported_format_version(cls, value: str) -> str:
        if value != FORMAT_VERSION:
            raise ValueError("不支持的归档格式版本")
        return value

    @field_validator("created_at")
    @classmethod
    def timezone_aware_timestamp(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("归档时间必须包含时区")
        return value

    @model_validator(mode="after")
    def unique_entry_paths_and_known_categories(self) -> "PortableArchiveManifest":
        paths = [entry.path for entry in self.entries]
        if len(paths) != len(set(paths)):
            raise ValueError("manifest 中归档路径重复")
        unknown = set(self.categories) - PORTABLE_CATEGORIES
        if unknown:
            raise ValueError("manifest 含未知数据类别")
        for entry in self.entries:
            if entry.category not in self.categories:
                raise ValueError("归档条目引用了未声明的类别")
            if not self.categories[entry.category].included:
                raise ValueError("归档条目属于未包含的类别")
        for name, category in self.categories.items():
            category_entries = [entry for entry in self.entries if entry.category == name]
            entry_bytes = sum(entry.size for entry in category_entries)
            entry_records = sum(entry.records or 0 for entry in category_entries)
            if entry_bytes != category.bytes or entry_records != category.records:
                raise ValueError("类别统计与归档条目统计不一致")
        if self.complete and set(self.categories) != PORTABLE_CATEGORIES:
            raise ValueError("完整归档必须显式声明全部可移植类别")
        return self

    def require_replaceable(self) -> None:
        """全量替换只能使用声明了全部类别的完整归档。"""
        if not self.complete or set(self.categories) != PORTABLE_CATEGORIES:
            raise ValueError("全量替换需要完整且声明全部类别的归档")
        excluded = [name for name, category in self.categories.items() if not category.included]
        if excluded:
            raise ValueError("全量替换归档不能裁剪数据类别")


class PortableRelation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relation_type: str = Field(min_length=1, max_length=80)
    target_type: str = Field(min_length=1, max_length=80)
    target_portable_id: str = Field(min_length=1, max_length=200)


class PortableEntityRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_schema: str = Field(min_length=1, max_length=100)
    portable_id: str = Field(min_length=1, max_length=200)
    source_type: str = Field(min_length=1, max_length=80)
    created_at: str | None = None
    updated_at: str | None = None
    deleted_at: str | None = None
    fields: dict[str, Any]
    relations: list[PortableRelation] = Field(default_factory=list)
