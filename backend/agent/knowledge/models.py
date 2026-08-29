"""Knowledge 主数据契约。"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Literal


KnowledgeSourceType = Literal["user", "file", "web", "derived", "conversation"]
KnowledgeConfidence = Literal["confirmed", "probable", "unverified", "conflict"]


@dataclass(frozen=True)
class KnowledgeScope:
    type: str = "owner"
    owner_user_id: str = ""
    platform: str = ""
    bot_id: str = ""
    group_id: str = ""
    scope_id: str = ""
    project_id: str = ""

    def key(self) -> str:
        return ":".join((self.owner_user_id, self.platform, self.bot_id,
                          self.group_id, self.type, self.scope_id, self.project_id))


@dataclass(frozen=True)
class KnowledgeSource:
    type: KnowledgeSourceType
    ref: str = ""
    label: str = ""
    checked_at: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class KnowledgeEntry:
    id: str
    title: str
    content: str
    topic: str
    scope: KnowledgeScope
    source: KnowledgeSource
    confidence: KnowledgeConfidence = "confirmed"
    version: int = 1
    parent_id: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    active: bool = True
    history: list[dict] = field(default_factory=list)

    @classmethod
    def create(
        cls,
        *,
        title: str,
        content: str,
        topic: str = "",
        scope: KnowledgeScope,
        source: KnowledgeSource,
        confidence: KnowledgeConfidence = "confirmed",
        parent_id: str | None = None,
    ) -> "KnowledgeEntry":
        now = time.time()
        return cls(
            id=f"knowledge-{uuid.uuid4().hex}", title=title.strip(),
            content=content.strip(), topic=topic.strip(), scope=scope,
            source=source, confidence=confidence, parent_id=parent_id,
            created_at=now, updated_at=now,
        )

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict) -> "KnowledgeEntry":
        scope = KnowledgeScope(**(raw.get("scope") or {}))
        source = KnowledgeSource(**(raw.get("source") or {}))
        return cls(
            id=str(raw["id"]), title=str(raw.get("title") or ""),
            content=str(raw.get("content") or ""), topic=str(raw.get("topic") or ""),
            scope=scope, source=source,
            confidence=str(raw.get("confidence") or "confirmed"),  # type: ignore[arg-type]
            version=max(1, int(raw.get("version") or 1)),
            parent_id=raw.get("parent_id"),
            created_at=float(raw.get("created_at") or time.time()),
            updated_at=float(raw.get("updated_at") or time.time()),
            active=bool(raw.get("active", True)),
            history=list(raw.get("history") or []),
        )
