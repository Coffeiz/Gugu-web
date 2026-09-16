"""用户 MCP server 配置（PRD-MCP-1 FR-MCP-1）。

凭据（请求头）以 BYOK 同一套平台主密钥信封加密落库（encrypt_envelope/decrypt_envelope），
编辑接口按当前配置回显明文供用户修改，但数据库仍不保存明文。user_id 可空是 scope=platform 的预留位（NULL=平台级，本期不写入）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.tz import now_utc
from app.db.types import UtcDateTime
from app.db.base import Base
from uuid6 import uuid7


class UserMcpServer(Base):
    """用户自带的 MCP server 配置。"""

    __tablename__ = "user_mcp_servers"
    # 名称在 (user, scope) 内唯一；scope=platform 时 user_id 为 NULL，
    # Postgres 的唯一约束不约束 NULL 行——平台级唯一性留到选型定案后补部分索引。
    __table_args__ = (
        UniqueConstraint("user_id", "scope", "name", name="uq_user_mcp_servers_scope_name"),
    )

    id:              Mapped[UUID]           = mapped_column(Uuid, primary_key=True, default=uuid7)
    user_id:         Mapped[Optional[UUID]] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True,
    )
    scope:           Mapped[str]            = mapped_column(String(16), default="user", server_default="user")
    name:            Mapped[str]            = mapped_column(String(64))
    transport:       Mapped[str]            = mapped_column(String(16), default="http", server_default="http")
    endpoint:        Mapped[str]            = mapped_column(String(1000))
    # HTTP endpoint 可能包含服务商 Key；只在服务端运行时解密，接口不回显明文。
    encrypted_endpoint: Mapped[str]      = mapped_column(Text, default="")
    endpoint_nonce:     Mapped[str]      = mapped_column(String(64), default="")
    encrypted_endpoint_key: Mapped[str] = mapped_column(Text, default="")
    endpoint_key_version: Mapped[int]    = mapped_column(Integer, default=1)
    command:         Mapped[str]            = mapped_column(String(1000), default="")
    # 凭据整体 JSON 序列化后信封加密（三件套同 UserProviderCredential 口径）
    auth_mode:             Mapped[str]            = mapped_column(String(16), default="headers", server_default="headers")
    encrypted_headers:       Mapped[str]            = mapped_column(Text, default="")
    headers_nonce:           Mapped[str]            = mapped_column(String(64), default="")
    encrypted_headers_key:   Mapped[str]            = mapped_column(Text, default="")
    headers_key_version:     Mapped[int]            = mapped_column(Integer, default=1)
    encrypted_query_params:  Mapped[str]            = mapped_column(Text, default="")
    query_params_nonce:      Mapped[str]            = mapped_column(String(64), default="")
    encrypted_query_params_key: Mapped[str]        = mapped_column(Text, default="")
    query_params_key_version: Mapped[int]          = mapped_column(Integer, default=1)
    # 新的统一凭据槽位协议；旧 headers/query 字段仅供迁移期读取。
    credential_slots: Mapped[list] = mapped_column(JSON, default=list)
    encrypted_credentials: Mapped[str] = mapped_column(Text, default="")
    credentials_nonce: Mapped[str] = mapped_column(String(64), default="")
    encrypted_credentials_key: Mapped[str] = mapped_column(Text, default="")
    credentials_key_version: Mapped[int] = mapped_column(Integer, default=1)
    enabled:         Mapped[bool]           = mapped_column(Boolean, default=True)
    confirm_mode:    Mapped[str]            = mapped_column(String(16), default="confirm_all", server_default="confirm_all")
    timeout_seconds: Mapped[int]            = mapped_column(Integer, default=30)
    tool_allowlist:  Mapped[list]           = mapped_column(JSON, default=list)
    created_at:      Mapped[datetime]       = mapped_column(UtcDateTime, default=now_utc)
    updated_at:      Mapped[datetime]       = mapped_column(UtcDateTime, default=now_utc, onupdate=now_utc)
