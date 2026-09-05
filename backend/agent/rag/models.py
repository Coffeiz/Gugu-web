"""RAG 的稳定数据契约。

这里的对象只描述可检索文本和权限范围，不携带原始文件、密钥或用户诊断正文。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Scope:
    """索引查询的硬边界；RAG 不负责从业务对象推导权限。"""

    owner_user_id: str
    platform: str = ""
    bot_id: str = ""
    group_id: str = ""
    scope_type: str = "owner"
    scope_id: str = ""

    def key(self) -> str:
        values = (
            self.owner_user_id, self.platform, self.bot_id,
            self.group_id, self.scope_type, self.scope_id,
        )
        return ":".join(str(value or "") for value in values)


@dataclass(frozen=True)
class IndexDocument:
    """统一可检索文档或文档 chunk。"""

    document_id: str
    source_type: str
    source_id: str
    scope: Scope
    title: str
    summary: str
    content: str
    version: str
    chunk_index: int = 0
    chunk_count: int = 1
    parent_document_id: str | None = None
    updated_at: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def chunk_id(self) -> str:
        parent = self.parent_document_id or self.document_id
        return f"{parent}:{self.version}:{self.chunk_index}"

    @property
    def content_hash(self) -> str:
        return content_hash(self.content)

    def identity(self) -> tuple[str, str, str]:
        return self.chunk_id, self.version, self.content_hash

    def as_public_result(self, score: float) -> dict[str, Any]:
        """返回给工具/上下文的最小结构，不暴露内部 scope 元数据。"""
        citation = {
            "source_type": self.source_type,
            "source_id": self.source_id,
            "title": self.title,
            "chunk_id": self.chunk_id,
            "version": self.version,
            "updated_at": self.updated_at,
        }
        result = {
            "source": self.source_type,
            "source_id": self.source_id,
            "title": self.title,
            "summary": self.summary,
            "text": self.content,
            "score": round(float(score), 6),
            "chunk_id": self.chunk_id,
            "version": self.version,
            "document_version": self.version,
            "content_hash": self.content_hash,
            "updated_at": self.updated_at,
            "citation": citation,
        }
        if self.source_type == "knowledge":
            for key in ("confidence", "source_type", "source_ref", "source_label", "topic", "parent_id"):
                if self.metadata.get(key):
                    result[key] = self.metadata[key]
        if self.source_type == "conversation":
            if self.metadata.get("session_id") is not None:
                # conversation 的 source_id 在旧索引中可能是命中消息 ID；
                # 完整读取必须使用明确的父会话 ID，不能让调用方猜语义。
                result["session_id"] = self.metadata["session_id"]
            for key in ("message_id", "role", "session_source", "session_updated_at"):
                if self.metadata.get(key) is not None:
                    result[key] = self.metadata[key]
        return result


@dataclass(frozen=True)
class RecallResult:
    document: IndexDocument
    score: float

    def as_public(self) -> dict[str, Any]:
        return self.document.as_public_result(self.score)


@dataclass(frozen=True)
class RecallCandidate:
    """跨来源召回的统一内部候选契约。

    Phase 1 只负责身份、来源、权限边界和诊断字段；归一化、RRF
    与 confidence 计算在后续阶段统一实现。``raw_score`` 仅保留
    来源内诊断意义，不能被调用方拿来横向比较不同检索器。
    """

    document: IndexDocument
    source_type: str
    source_id: str
    scope: Scope
    content_fingerprint: str
    raw_score: float
    rank: int
    version: str
    parent_document_id: str | None = None
    normalized_score: float = 0.0
    fused_score: float = 0.0
    confidence: float = 0.0
    source_quality: float = 0.0

    @classmethod
    def from_result(cls, result: RecallResult, *, rank: int) -> "RecallCandidate":
        document = result.document
        return cls(
            document=document,
            source_type=document.source_type,
            source_id=document.source_id,
            scope=document.scope,
            content_fingerprint=document.content_hash,
            raw_score=float(result.score),
            rank=max(1, int(rank)),
            version=document.version,
            parent_document_id=document.parent_document_id,
        )

    def as_public(self) -> dict[str, Any]:
        """保留旧 RecallResult 输出形状，同时提供统一诊断分数。"""
        result = RecallResult(self.document, self.raw_score).as_public()
        result["content_fingerprint"] = self.content_fingerprint
        result["rank"] = self.rank
        result["normalized_score"] = round(self.normalized_score, 6)
        result["fused_score"] = round(self.fused_score, 6)
        result["confidence"] = round(self.confidence, 6)
        return result


def stable_version(*parts: object) -> str:
    """从源内容和结构字段生成可重复的版本号。"""
    payload = json.dumps([str(part or "") for part in parts], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
