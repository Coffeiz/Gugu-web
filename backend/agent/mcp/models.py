"""MCP 数据模型：server 配置快照与工具元数据。

与 ORM 解耦：manager/adapter 只认这里的数据类，DB 行在 API/manager 边界转换。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

SCOPE_USER = "user"
SCOPE_PLATFORM = "platform"     # 仅预留：本期不写入、不做 UI
TRANSPORT_HTTP = "http"
CONFIRM_ALL = "confirm_all"
CONFIRM_AUTO = "auto"

TOOL_NAME_PREFIX = "mcp_"
MCP_PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "gugu-web", "version": "1.0"}


@dataclass
class McpServerConfig:
    """一条用户 MCP server 配置（凭据已解密，仅存在于请求运行时）。"""

    id: UUID
    user_id: UUID | None                 # None=平台级（本期不写入，预留）
    name: str                            # scope 内唯一，作命名空间
    transport: str = TRANSPORT_HTTP      # Phase 1 仅 http；Phase 2 增 stdio
    endpoint: str = ""
    command: str = ""
    credential_slots: list[dict[str, str]] = field(default_factory=list)
    credential_values: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    confirm_mode: str = CONFIRM_ALL
    timeout_seconds: int = 30
    tool_allowlist: list[str] = field(default_factory=list)   # 空=全部工具
    scope: str = SCOPE_USER
    # 数据库配置版本。多 worker 进程各自持有缓存，配置更新时间用于发现其他
    # worker 已经保存过的新配置并丢弃旧的成功/失败运行时。
    updated_at: datetime | None = None

    @property
    def confirm_required(self) -> bool:
        return self.confirm_mode == CONFIRM_ALL


@dataclass
class McpToolMeta:
    """一个从 server 载入并包装完成的 MCP 工具。"""

    server_id: UUID
    server_name: str
    tool_name: str            # server 侧原始名
    prefixed_name: str        # mcp_<server>_<tool>
    description_short: str
    input_schema: dict
    # MCP server 原始描述：仅用于发给 Provider，不进入能力目录/RAG 摘要。
    provider_description: str = ""
