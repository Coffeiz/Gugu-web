"""McpToolManager：按 (user, server) 的工具缓存、dispatch 路由、退避与失效。

设计要点（PRD-MCP-1 §3.1）：
- 不进主 SkillRegistry 快照：MCP 工具按用户动态，manager 持有 per-(user, server)
  的 Tool 列表，在轮次组装与 dispatch 两处汇入；主 registry 语义零改动。
- 执行契约与 builtin 同一条：IM 权限、schema 归一化+校验、确认门、错误脱敏、
  轨迹记录全部复用既有模块，不为 MCP 开第二条路径。
- 单 server 故障只影响自己：连接失败累计进入退避（阈值内不再外呼、工具从声明
  摘除并返回结构化错误）；退避结束自动恢复。配置变更/停用/删除立即失效缓存。
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from uuid import UUID

import sqlalchemy as sa

from app.core.redaction import diag_log, redact as sanitize_error
from agent.interactions.confirmations import (
    needs_confirmation,
    target_confirmation_identity,
)
from agent.mcp.client import McpClient
from agent.mcp.models import McpServerConfig, McpToolMeta, SCOPE_USER
from agent.mcp.schema_adapter import (
    build_mcp_tool,
    description_short_of,
    prefixed_tool_name,
    sanitize_input_schema,
    validate_input_schema,
)
from agent.tools.base import Tool, _log_traj
from agent.tools.tool_contract import (
    build_validator,
    enrich_tool_error,
    invalid_input_payload,
    normalize_input_by_schema,
    validate_input,
)

_log = logging.getLogger("agent.mcp")

# MCP 工具结果进上下文前的文本预算（外部 server 内容不可信长度）
_MAX_RESULT_CHARS = 20000
_BACKOFF_STATE = "backoff"
_ERROR_STATE = "error"
_OK_STATE = "ok"
_CALL_FAIL_KINDS = ("timeout", "network", "http")


@dataclass
class _ServerRuntime:
    """单个 (user, server) 的进程内运行时状态（失败状态也落盘，退避才能跨调用生效）。"""

    config: McpServerConfig
    tools: dict[str, Tool] = field(default_factory=dict)          # prefixed → Tool
    metas: dict[str, McpToolMeta] = field(default_factory=dict)   # prefixed → meta（含原始名）
    state: str = _OK_STATE
    last_error: str | None = None
    consecutive_failures: int = 0
    backoff_until: float = 0.0

    def in_backoff(self) -> bool:
        return time.monotonic() < self.backoff_until

    def effective_state(self) -> str:
        return _BACKOFF_STATE if self.in_backoff() else self.state


class McpToolManager:
    """按用户维护 MCP 工具的装载、缓存与执行。"""

    def __init__(self):
        self._runtimes: dict[tuple[UUID, UUID], _ServerRuntime] = {}

    # ── 声明侧：轮次组装时按用户合并 ──

    async def list_user_tools(self, user_id) -> list[Tool]:
        """返回当前用户所有启用 server 的 MCP Tool（mcp.enabled 关闭时为空）。"""
        from app.core.config import get_settings

        settings = get_settings()
        if not settings.mcp.enabled:
            return []

        tools: list[Tool] = []
        seen_names: set[str] = set()
        budget = settings.mcp.max_tools_per_user
        async for config in self._iter_enabled_configs(user_id):
            runtime = await self._ensure_runtime(settings, config)
            if runtime is None or runtime.in_backoff():
                continue
            for name, tool in runtime.tools.items():
                if len(tools) >= budget:
                    _log.warning("用户 %s 的 MCP 工具总量达到上限 %d，多余工具未声明",
                                 str(user_id)[:8], budget)
                    return tools
                if name in seen_names:
                    continue
                seen_names.add(name)
                tools.append(tool)
        return tools

    def get_tool(self, user_id, tool_name: str) -> Tool | None:
        """返回当前用户已声明的 MCP Tool；跨用户不可见（缓存键含 user）。"""
        for runtime in self._runtimes_for_user(user_id):
            tool = runtime.tools.get(tool_name)
            if tool is not None:
                return tool
        return None

    # ── 执行侧：dispatch 按 source=mcp 路由到这里 ──

    async def dispatch(self, user_id, tool_name: str, args: Any) -> tuple[str, None]:
        """执行一个 mcp_* 工具调用，返回 (JSON 字符串, None)，与 registry.dispatch 同形。"""
        t0 = time.monotonic()
        tool = self.get_tool(user_id, tool_name)
        runtime = self._runtime_for_tool(user_id, tool_name)
        if tool is None or runtime is None:
            # 未声明：可能被配置变更/退避摘除，按未知工具结构化返回。
            payload = enrich_tool_error(tool_name, {"error": f"未知工具: {tool_name}"})
            _log_traj(tool_name, user_id, args, False, "mcp:未知工具", t0)
            return json.dumps(payload, ensure_ascii=False), None

        meta = runtime.metas[tool_name]
        config = runtime.config
        from agent.im import imctx
        from agent.im.permissions import can_use_tool

        current_im = imctx.get_im()
        allowed_tool_names = current_im.get("allowed_tool_names") if current_im else None
        if not can_use_tool(tool_name, allowed_tool_names):
            payload = enrich_tool_error(tool_name, {"error": "当前群聊身份没有使用该工具的权限"})
            _log_traj(tool_name, user_id, args, False, "mcp:无群聊权限", t0)
            return json.dumps(payload, ensure_ascii=False), None

        # 与 builtin 相同的 schema 归一化 + 本地校验；失败不发出任何网络请求（FR-MCP-3）
        if not isinstance(args, dict):
            payload = invalid_input_payload(
                tool_name, [{"path": "$", "rule": "type", "message": "工具输入必须是 object"}],
                schema=tool.input_schema,
            )
            _log_traj(tool_name, user_id, args, False, "mcp:tool_input_invalid:type", t0)
            return json.dumps(payload, ensure_ascii=False), None
        args, _ = normalize_input_by_schema(tool.input_schema, args)
        if tool._input_validator is None:
            tool._input_validator = build_validator(tool.input_schema)
        issues = validate_input(tool._input_validator, args)
        if issues:
            payload = invalid_input_payload(tool_name, issues, schema=tool.input_schema)
            _log_traj(tool_name, user_id, args, False,
                      f"mcp:tool_input_invalid:{issues[0].get('rule', 'invalid')}", t0)
            return json.dumps(payload, ensure_ascii=False), None

        # 确认门：confirm_all 的 server 全部工具进既有确认门，摘要含 server 名与工具名；
        # 定时任务等无人值守场景没有授权则永远停在确认，天然不可用（FR-MCP-3）。
        if config.confirm_required and not self._automation_authorized(tool_name):
            summary = f"调用 MCP 工具 [{config.name}] {meta.tool_name}"
            identity = target_confirmation_identity(
                "mcp.call", {"server": [str(config.id)], "tool": [tool_name]},
            )
            gate = needs_confirmation(args, summary, user_id, identity=identity)
            if gate is not None:
                _log_traj(tool_name, user_id, args, False, "mcp:等待确认", t0)
                return gate, None

        result = await self._call_server(runtime, config, tool_name, args)
        if "error" in result:
            _log_traj(tool_name, user_id, args, False, f"mcp:{result['error'][:80]}", t0)
            payload = enrich_tool_error(tool_name, {"error": result["error"]})
            return json.dumps(payload, ensure_ascii=False), None

        text = self._extract_text(result)
        _log_traj(tool_name, user_id, args, True, "", t0)
        return json.dumps({"result": text}, ensure_ascii=False), None

    # ── 生命周期：缓存与失效（FR-MCP-5） ──

    def invalidate_server(self, user_id, server_id) -> None:
        """用户保存配置/停用/删除某 server 后清掉它的工具缓存。"""
        self._runtimes.pop((self._user_key(user_id), _as_uuid(server_id)), None)

    def invalidate_user(self, user_id) -> None:
        user_key = self._user_key(user_id)
        for key in [k for k in self._runtimes if k[0] == user_key]:
            self._runtimes.pop(key, None)

    def server_states(self, user_id) -> list[dict]:
        """设置页连接状态：正常/错误/退避中 + 载入的工具数（FR-MCP-6）。"""
        out = []
        user_key = self._user_key(user_id)
        for (uid, sid), runtime in self._runtimes.items():
            if uid != user_key:
                continue
            state = runtime.effective_state()
            out.append({
                "server_id": str(sid),
                "state": state,
                "tool_count": len(runtime.tools) if state != _BACKOFF_STATE else 0,
                "last_error": sanitize_error(runtime.last_error) if runtime.last_error else None,
            })
        return out

    # ── 内部 ──

    @staticmethod
    def _automation_authorized(tool_name: str) -> bool:
        from agent.tools.base import automation_tool_allowed

        return automation_tool_allowed(tool_name)

    @staticmethod
    def _user_key(user_id) -> UUID:
        import uuid as _uuid

        if isinstance(user_id, str):
            try:
                return _uuid.UUID(user_id)
            except (ValueError, AttributeError):
                pass
        return user_id

    def _runtimes_for_user(self, user_id) -> list[_ServerRuntime]:
        user_key = self._user_key(user_id)
        return [r for (uid, _sid), r in self._runtimes.items() if uid == user_key]

    def _runtime_for_tool(self, user_id, tool_name: str) -> _ServerRuntime | None:
        for runtime in self._runtimes_for_user(user_id):
            if tool_name in runtime.tools:
                return runtime
        return None

    async def _iter_enabled_configs(self, user_id):
        """读该用户启用中的 server 配置（scope=user，按创建顺序）。"""
        from app.db import session as db_session
        from app.models import UserMcpServer

        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            rows = (await db.execute(
                sa.select(UserMcpServer).where(
                    UserMcpServer.user_id == self._user_key(user_id),
                    UserMcpServer.scope == SCOPE_USER,
                    UserMcpServer.enabled.is_(True),
                ).order_by(UserMcpServer.created_at)
            )).scalars().all()
        for row in rows:
            yield self._config_from_row(row)

    @staticmethod
    def _config_from_row(row) -> McpServerConfig:
        from app.byok.crypto import decrypt_envelope

        headers: dict[str, str] = {}
        if row.encrypted_headers:
            try:
                raw = decrypt_envelope(
                    row.encrypted_headers, row.headers_nonce, row.encrypted_headers_key,
                    key_version=row.headers_key_version,
                )
                decoded = json.loads(raw)
                if isinstance(decoded, dict):
                    headers = {str(k): str(v) for k, v in decoded.items()}
            except Exception as exc:      # 解密失败按无凭据处理，让连接自然失败并诊断
                diag_log("agent.mcp.manager.decrypt_headers", exc)
        return McpServerConfig(
            id=row.id, user_id=row.user_id, name=row.name, transport=row.transport,
            endpoint=row.endpoint, headers=headers, enabled=row.enabled,
            confirm_mode=row.confirm_mode, timeout_seconds=row.timeout_seconds,
            tool_allowlist=list(row.tool_allowlist or []), scope=row.scope,
        )

    async def _ensure_runtime(self, settings, config: McpServerConfig) -> _ServerRuntime | None:
        """惰性装载：配置未变且已装载/退避中直接用缓存；否则重拉 tools/list。"""
        key = (self._user_key(config.user_id), config.id)
        runtime = self._runtimes.get(key)
        if runtime is not None:
            if runtime.in_backoff():
                return runtime
            if runtime.config == config and runtime.tools:
                return runtime
        return await self._load_runtime(settings, config)

    async def _load_runtime(self, settings, config: McpServerConfig) -> _ServerRuntime | None:
        """拉 tools/list 构建工具集；失败状态也落缓存（退避/计数才能跨调用生效）。"""
        key = (self._user_key(config.user_id), config.id)
        runtime = self._runtimes.get(key) or _ServerRuntime(config=config)
        runtime.config = config
        runtime.tools.clear()
        runtime.metas.clear()

        client = McpClient(
            config.endpoint, headers=config.headers,
            timeout_seconds=float(config.timeout_seconds or settings.mcp.default_timeout_seconds),
        )
        listing = await client.list_tools()
        if "error" in listing:
            self._record_failure(key, runtime, listing["error"], listing.get("error_kind", "protocol"))
            self._runtimes[key] = runtime
            return runtime if runtime.tools else None

        allowlist = set(config.tool_allowlist or [])
        used_names: set[str] = set()
        skipped: list[str] = []
        for raw in listing.get("tools") or []:
            if len(runtime.tools) >= settings.mcp.max_tools_per_server:
                _log.warning("MCP server [%s] 工具数达到上限 %d，其余拒载",
                             config.name, settings.mcp.max_tools_per_server)
                break
            tool_name = str(raw.get("name") or "")
            prefixed = prefixed_tool_name(config.name, tool_name)
            reason = validate_input_schema(raw.get("inputSchema"))
            if reason is not None:
                skipped.append(f"{tool_name}: {reason}")
                continue
            if prefixed is None:
                skipped.append(f"{tool_name}: 工具名非法")
                continue
            from agent.tools import registry as tool_registry
            if tool_registry.snapshot().get(prefixed) is not None:
                skipped.append(f"{tool_name}: 与内置工具重名")
                continue
            if prefixed in used_names:
                skipped.append(f"{tool_name}: 与其他工具重名")
                continue
            if allowlist and tool_name not in allowlist:
                continue     # 白名单外静默不载（用户显式选择的裁剪）
            used_names.add(prefixed)
            meta = McpToolMeta(
                server_id=config.id, server_name=config.name, tool_name=tool_name,
                prefixed_name=prefixed,
                description_short=description_short_of(raw.get("description")),
                input_schema=raw.get("inputSchema"),
            )
            runtime.metas[prefixed] = meta
            runtime.tools[prefixed] = build_mcp_tool(
                meta, self._make_handler(config.id, meta),
            )
        if skipped:
            _log.info("MCP server [%s] 拒载 %d 个工具：%s",
                      config.name, len(skipped), "; ".join(skipped[:8]))

        runtime.state = _OK_STATE
        runtime.consecutive_failures = 0
        runtime.last_error = None
        self._runtimes[key] = runtime
        return runtime

    def _make_handler(self, server_id: UUID, meta: McpToolMeta):
        """Tool.handler（async (db, user_id, args)）：走同一条 dispatch 契约。"""
        async def _handler(_db, user_id, args):
            result, _artifact = await self.dispatch(user_id, meta.prefixed_name, args)
            try:
                return json.loads(result)
            except (TypeError, ValueError):
                return {"error": "MCP 调用返回了无法解析的结果"}

        return _handler

    async def _call_server(self, runtime: _ServerRuntime, config: McpServerConfig,
                           prefixed_name: str, args: dict) -> dict:
        """真正外呼 tools/call；连接类失败累计进入退避（FR-MCP-5）。"""
        from app.core.config import get_settings

        settings = get_settings()
        meta = runtime.metas.get(prefixed_name)
        if meta is None:
            return {"error": "该 MCP 工具已不存在（server 工具列表变化），请重新发送消息"}
        key = (self._user_key(config.user_id), config.id)
        client = McpClient(
            config.endpoint, headers=config.headers,
            timeout_seconds=float(config.timeout_seconds or settings.mcp.default_timeout_seconds),
        )
        raw = await client.call_tool(meta.tool_name, args)
        if "error" in raw:
            self._record_failure(key, runtime, raw["error"], raw.get("error_kind", "protocol"))
            return raw
        self._record_success(key, runtime)
        if raw.get("isError"):
            text = self._extract_text(raw)
            return {"error": (text or "MCP 工具执行失败")[:2000]}
        return raw

    def _record_success(self, key, runtime: _ServerRuntime) -> None:
        runtime.state = _OK_STATE
        runtime.consecutive_failures = 0
        runtime.last_error = None

    def _record_failure(self, key, runtime: _ServerRuntime, message: str, kind: str) -> None:
        from app.core.config import get_settings

        settings = get_settings()
        runtime.last_error = message
        if kind in _CALL_FAIL_KINDS:
            runtime.consecutive_failures += 1
            if runtime.consecutive_failures >= settings.mcp.failure_threshold:
                runtime.state = _BACKOFF_STATE
                runtime.backoff_until = time.monotonic() + settings.mcp.backoff_seconds
                runtime.tools = {}     # 退避期间从声明中摘除
                _log.warning(
                    "MCP server [%s] 连续失败 %d 次，进入 %ds 退避",
                    runtime.config.name, runtime.consecutive_failures, settings.mcp.backoff_seconds,
                )
            else:
                runtime.state = _ERROR_STATE
        else:
            runtime.state = _ERROR_STATE

    @staticmethod
    def _extract_text(result: dict) -> str:
        """把 MCP content 数组拼成模型可读文本，按结果预算截断。"""
        parts: list[str] = []
        for block in result.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, dict):
                parts.append(json.dumps(block, ensure_ascii=False))
        text = "\n".join(p for p in parts if p)
        if len(text) > _MAX_RESULT_CHARS:
            text = text[:_MAX_RESULT_CHARS] + "\n…（结果过长已截断）"
        return text


def _as_uuid(value) -> UUID:
    import uuid as _uuid

    if isinstance(value, str):
        return _uuid.UUID(value)
    return value


mcp_manager = McpToolManager()
