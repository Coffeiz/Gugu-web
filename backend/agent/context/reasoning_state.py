"""跨 Provider 推理状态的通用策略、信封和指纹边界。

这里故意不放 OpenAI/Anthropic 的 wire 字段。Provider 专属 payload 只能由状态
存储服务和对应 Adapter 处理，不能进入 canonical history、普通日志或渠道消息。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
from typing import Any, Literal, Mapping

from app.core.tz import now_utc


ReasoningPersistenceMode = Literal["off", "summary", "continuation"]
REASONING_PERSISTENCE_MODES: frozenset[str] = frozenset(
    {"off", "summary", "continuation"}
)
PROVIDER_STATE_VERSION = 1
MAX_PROVIDER_STATE_PAYLOAD_BYTES = 8 * 1024 * 1024

# 失效原因是内部结构化诊断码，不应直接拼接 provider 返回文本。
INVALIDATION_REASONS: frozenset[str] = frozenset(
    {
        "disabled",
        "summary_only",
        "expired",
        "provider_changed",
        "api_format_changed",
        "model_changed",
        "config_changed",
        "reasoning_config_changed",
        "mode_changed",
        "session_deleted",
        "owner_mismatch",
        "concurrency_conflict",
        "state_corrupt",
        "baseline_changed",
        "branch_changed",
        "provider_rejected",
        "manual",
    }
)


def stable_json(value: Any) -> str:
    """生成稳定 JSON；不接受 NaN，避免指纹在不同运行时不一致。"""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def fingerprint(value: Any) -> str:
    """对调用方提供的安全元数据生成不可逆 SHA-256 指纹。"""
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def configuration_fingerprint(values: Mapping[str, Any]) -> str:
    """对不含凭据和用户正文的模型配置生成指纹。"""
    return fingerprint(dict(values))


def model_state_fingerprints(ai: Any, *, provider: str, api_format: str,
                             tool_digest: str = "") -> tuple[str, str]:
    """生成 provider state 使用的模型/推理配置指纹。

    这里仅允许稳定的模型配置标量进入指纹；API key、base URL、提示词和工具参数
    都不进入，避免把凭据或用户正文旁路写入状态元数据。工具 Schema 的摘要由调用方
    先脱敏计算后传入。
    """
    model_config = {
        "provider": str(provider),
        "api_format": str(api_format),
        "model": str(getattr(ai, "model", "") or ""),
        "context_tokens": int(getattr(ai, "context_tokens", 0) or 0),
        "max_tokens": int(getattr(ai, "max_tokens", 0) or 0),
        "temperature": getattr(ai, "temperature", None),
        "tool_digest": str(tool_digest or ""),
    }
    reasoning_config = {
        "thinking": getattr(ai, "thinking", None),
        "reasoning_effort": getattr(ai, "reasoning_effort", None),
        "thinking_budget": getattr(ai, "thinking_budget", None),
        "store": bool(getattr(ai, "store", True)),
        "include_encrypted_reasoning": getattr(ai, "include_encrypted_reasoning", None),
    }
    return configuration_fingerprint(model_config), configuration_fingerprint(reasoning_config)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass(frozen=True, slots=True)
class ReasoningPersistencePolicy:
    """Run 开始时固定的模型级策略；不携带任何 Provider wire 字段。"""

    mode: ReasoningPersistenceMode = "off"
    effective_at_run_start: bool = True

    def __post_init__(self) -> None:
        if self.mode not in REASONING_PERSISTENCE_MODES:
            raise ValueError("无效的推理状态持久化策略")

    @classmethod
    def from_value(cls, value: Any) -> "ReasoningPersistencePolicy":
        if value is None:
            return cls(mode="off")
        if not isinstance(value, str):
            raise ValueError("推理状态持久化策略必须是字符串")
        mode = value.strip().lower()
        if mode not in REASONING_PERSISTENCE_MODES:
            raise ValueError("无效的推理状态持久化策略")
        return cls(mode=mode)  # type: ignore[arg-type]

    @property
    def can_resume(self) -> bool:
        return self.mode == "continuation"

    @property
    def can_commit_provider_payload(self) -> bool:
        return self.mode == "continuation"


def _safe_summary(value: Mapping[str, Any] | None) -> dict[str, int | float | bool | str]:
    """只保留有限诊断标量，避免摘要字段成为正文旁路。"""
    if not value:
        return {}
    result: dict[str, int | float | bool | str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or len(key) > 64:
            raise ValueError("状态摘要键无效")
        if isinstance(item, bool) or isinstance(item, int) or (
            isinstance(item, float) and math.isfinite(item)
        ):
            result[key] = item
        elif (
            isinstance(item, str)
            and len(item) <= 128
            and (key == "status" or key.endswith(("_digest", "_fingerprint")))
        ):
            result[key] = item
        else:
            raise ValueError("状态摘要只能包含受限标量")
    return result


@dataclass(frozen=True, slots=True)
class ProviderStateEnvelope:
    """Provider state 的通用元数据和受保护 payload。

    ``payload`` 仅供内部 Adapter 使用，repr 和默认 metadata 都不会包含它。
    """

    version: int
    owner_user_id: str
    session_id: int
    provider: str
    api_format: str
    model_id: str
    reasoning_persistence: ReasoningPersistenceMode
    config_digest: str
    reasoning_config_digest: str
    source_run_id: str
    source_round_id: str | None
    sequence: int
    state_kind: str
    payload: Any = field(repr=False)
    payload_digest: str
    payload_size: int
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime
    state_summary: dict[str, int | float | bool | str] = field(default_factory=dict)

    @classmethod
    def from_payload(
        cls,
        *,
        owner_user_id: Any,
        session_id: int,
        provider: str,
        api_format: str,
        model_id: str,
        reasoning_persistence: ReasoningPersistenceMode,
        config_digest: str,
        reasoning_config_digest: str,
        source_run_id: str,
        source_round_id: str | None,
        sequence: int,
        state_kind: str,
        payload: Any,
        expires_at: datetime,
        created_at: datetime | None = None,
        last_used_at: datetime | None = None,
        state_summary: Mapping[str, Any] | None = None,
        version: int = PROVIDER_STATE_VERSION,
    ) -> "ProviderStateEnvelope":
        if version != PROVIDER_STATE_VERSION:
            raise ValueError("不支持的 provider state 版本")
        if session_id <= 0 or sequence < 0:
            raise ValueError("状态会话或序号无效")
        required = {
            "provider": provider,
            "api_format": api_format,
            "model_id": model_id,
            "config_digest": config_digest,
            "reasoning_config_digest": reasoning_config_digest,
            "source_run_id": source_run_id,
            "state_kind": state_kind,
        }
        if any(not isinstance(value, str) or not value for value in required.values()):
            raise ValueError("状态信封元数据不完整")
        owner = str(owner_user_id) if owner_user_id is not None else ""
        if not owner:
            raise ValueError("状态信封缺少 owner")
        if reasoning_persistence not in REASONING_PERSISTENCE_MODES:
            raise ValueError("无效的推理状态持久化策略")
        payload_json = stable_json(payload)
        payload_bytes = len(payload_json.encode("utf-8"))
        if payload_bytes > MAX_PROVIDER_STATE_PAYLOAD_BYTES:
            raise ValueError("provider state 超出大小限制")
        created = _as_utc(created_at or now_utc())
        last_used = _as_utc(last_used_at or created)
        expires = _as_utc(expires_at)
        if expires <= created:
            raise ValueError("provider state 过期时间必须晚于创建时间")
        return cls(
            version=version,
            owner_user_id=owner,
            session_id=session_id,
            provider=provider,
            api_format=api_format,
            model_id=model_id,
            reasoning_persistence=reasoning_persistence,
            config_digest=config_digest,
            reasoning_config_digest=reasoning_config_digest,
            source_run_id=source_run_id,
            source_round_id=source_round_id,
            sequence=sequence,
            state_kind=state_kind,
            payload=payload,
            payload_digest=fingerprint(payload),
            payload_size=payload_bytes,
            created_at=created,
            last_used_at=last_used,
            expires_at=expires,
            state_summary=_safe_summary(state_summary),
        )

    def payload_json(self) -> str:
        return stable_json(self.payload)

    def metadata(self) -> dict[str, Any]:
        """返回可用于诊断/测试的元数据，永不包含 payload。"""
        return {
            "version": self.version,
            "owner_user_id": self.owner_user_id,
            "session_id": self.session_id,
            "provider": self.provider,
            "api_format": self.api_format,
            "model_id": self.model_id,
            "reasoning_persistence": self.reasoning_persistence,
            "config_digest": self.config_digest,
            "reasoning_config_digest": self.reasoning_config_digest,
            "source_run_id": self.source_run_id,
            "source_round_id": self.source_round_id,
            "sequence": self.sequence,
            "state_kind": self.state_kind,
            "payload_digest": self.payload_digest,
            "payload_size": self.payload_size,
            "created_at": self.created_at.isoformat(),
            "last_used_at": self.last_used_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "state_summary": dict(self.state_summary),
        }
