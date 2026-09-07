"""Provider reasoning state 的 run 生命周期协调器。

核心循环只知道 provider driver 和结构化回调，不直接依赖数据库或某一家协议。
该协调器负责在 run 开始加载、在每轮暂存最新状态、成功结束后提交；失败、取消、
压缩和状态冲突均不会把未完成的 provider payload 写进持久化状态。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable
from uuid import uuid4

from agent.context.reasoning_state import (
    ProviderStateEnvelope,
    ReasoningPersistencePolicy,
    model_state_fingerprints,
)
from app.core.redaction import diag_log
from app.core.tz import now_utc
from app.services import provider_reasoning_state


@dataclass
class _Snapshot:
    kind: str
    payload: Any
    summary: dict[str, int | float | bool | str]
    round_id: str | None


def _block_count(summary: dict[str, Any]) -> int:
    return int(summary.get("state_block_count", summary.get("block_count", 0)) or 0)


class ReasoningStateCoordinator:
    """把 provider-specific state 接到一次 LLM run 的边界。"""

    def __init__(self, *, user_id: Any, session_id: int | None,
                 model_cfg: Any, policy: ReasoningPersistencePolicy,
                 session_factory: Callable[[], Any] | None):
        self.user_id = user_id
        self.session_id = session_id
        self.model_cfg = model_cfg
        self.policy = policy
        self.session_factory = session_factory
        self.provider = "unknown"
        self.api_format = "unknown"
        self.config_digest = ""
        self.reasoning_config_digest = ""
        self.expected_version = 0
        self.sequence = 0
        self.source_run_id = f"reasoning-{uuid4().hex[:20]}"
        self.latest: _Snapshot | None = None
        self.unavailable_reason: str | None = None
        self._prepared_once = False
        self._diagnostic = {
            "schema_version": 1,
            "phase": "created",
            "reasoning_persistence": self.policy.mode,
            "state_status": (
                "disabled" if self.policy.mode == "off"
                else "summary_only" if self.policy.mode == "summary" else "miss"
            ),
            "continuation_attempted": False,
            "continuation_reused": False,
            "continuation_unavailable": False,
            "state_provider": "unknown",
            "state_api_format": "unknown",
            "state_model": str(getattr(self.model_cfg, "model", "") or ""),
            "state_kind": "",
            "state_block_count": 0,
            "state_size": 0,
            "state_version": 0,
            "sequence": 0,
            "state_digest": "",
            "invalidated_reason": None,
            "unavailable_reason": None,
        }

    def diagnostics(self) -> dict[str, Any]:
        """返回只含 LoopScope 安全标量的当前状态摘要。"""
        return dict(self._diagnostic)

    def _publish_diagnostics(self, phase: str) -> None:
        self._diagnostic.update({
            "phase": phase,
            "state_provider": self.provider,
            "state_api_format": self.api_format,
            "state_model": str(getattr(self.model_cfg, "model", "") or ""),
            "continuation_unavailable": bool(self.unavailable_reason),
            "unavailable_reason": self.unavailable_reason,
            "sequence": self.sequence,
        })
        try:
            from agent.runtime.loopscope_trace.state import record_reasoning_state_diagnostics
            record_reasoning_state_diagnostics(self._diagnostic)
        except Exception:
            pass

    def _mark_unavailable(self, reason: str, *, invalidated_reason: str | None = None,
                          status: str = "unavailable") -> None:
        self.unavailable_reason = reason
        self._diagnostic.update({
            "state_status": status,
            "unavailable_reason": reason,
            "invalidated_reason": invalidated_reason,
        })

    async def prepared(self, driver: Any, ctx: Any) -> None:
        if self._prepared_once:
            if self.latest is not None:
                restore = getattr(driver, "restore_provider_state", None)
                if callable(restore):
                    restore(ctx, self.latest.payload)
            return
        self._prepared_once = True
        from agent import providers
        self.provider = str(providers.adapter_for(self.model_cfg).name or "unknown")
        self.api_format = str(getattr(driver, "api_format", "unknown"))
        self._diagnostic.update({
            "state_provider": self.provider,
            "state_api_format": self.api_format,
        })
        tool_digest = str(getattr(ctx, "tool_state_digest", "") or "")
        self.config_digest, self.reasoning_config_digest = model_state_fingerprints(
            self.model_cfg, provider=self.provider, api_format=self.api_format,
            tool_digest=tool_digest,
        )
        if not self.policy.can_resume:
            self._publish_diagnostics("prepared")
            return
        self._diagnostic["continuation_attempted"] = True
        if self.session_id is None or self.session_factory is None:
            self._mark_unavailable("missing_session")
            self._publish_diagnostics("prepared")
            return
        if not getattr(driver, "continuation_available", False):
            self._mark_unavailable("continuation_unavailable")
            self._publish_diagnostics("prepared")
            return
        async with self.session_factory() as db:
            lookup = await provider_reasoning_state.load_state(
                db, user_id=self.user_id, session_id=self.session_id, policy=self.policy,
                provider=self.provider, api_format=self.api_format,
                model_id=str(getattr(self.model_cfg, "model", "") or ""),
                config_digest=self.config_digest,
                reasoning_config_digest=self.reasoning_config_digest,
            )
            self.expected_version = lookup.expected_version
            if lookup.envelope is None:
                reason = lookup.unavailable_reason
                if reason == "expired":
                    self._mark_unavailable(reason, invalidated_reason=reason, status="expired")
                elif reason:
                    self._mark_unavailable(reason, invalidated_reason=reason)
                else:
                    self._diagnostic.update({
                        "state_status": "miss",
                        "unavailable_reason": None,
                        "invalidated_reason": None,
                    })
                await db.commit()
                self._publish_diagnostics("prepared")
                return
            restore = getattr(driver, "restore_provider_state", None)
            if not callable(restore) or not restore(ctx, lookup.envelope.payload):
                self._mark_unavailable("continuation_unavailable", invalidated_reason="state_corrupt")
                await provider_reasoning_state.invalidate_state(
                    db, user_id=self.user_id, session_id=self.session_id,
                    reason="state_corrupt", expected_version=self.expected_version,
                )
            else:
                summary = lookup.envelope.state_summary
                self._diagnostic.update({
                    "state_status": "reused",
                    "continuation_reused": True,
                    "state_kind": lookup.envelope.state_kind,
                    "state_block_count": _block_count(summary),
                    "state_size": lookup.envelope.payload_size,
                    "state_version": lookup.envelope.version,
                    "state_digest": lookup.envelope.payload_digest,
                    "unavailable_reason": None,
                    "invalidated_reason": None,
                })
            await db.commit()
            self._publish_diagnostics("prepared")

    async def round_finished(self, driver: Any, ctx: Any, result: Any, round_id: str) -> None:
        if self.policy.mode == "off":
            return
        extract = getattr(driver, "extract_provider_state", None)
        if not callable(extract):
            return
        try:
            state = extract(result)
        except Exception as exc:
            diag_log("agent.reasoning_state.extract", exc)
            self.unavailable_reason = "state_corrupt"
            return
        if not state:
            return
        self.sequence += 1
        self.latest = _Snapshot(
            kind=str(state.get("state_kind") or "provider_state"),
            payload=state.get("payload"),
            summary=dict(state.get("summary") or {}),
            round_id=round_id,
        )
        self._diagnostic.update({
            "state_status": "unavailable" if self.unavailable_reason else "captured",
            "state_kind": self.latest.kind,
            "state_block_count": _block_count(self.latest.summary),
            "unavailable_reason": self.unavailable_reason,
        })
        self._publish_diagnostics("round_finished")

    async def completed(self) -> None:
        if self.session_id is None or self.session_factory is None or self.latest is None:
            self._publish_diagnostics("completed")
            return
        snapshot = self.latest
        if self.policy.mode == "summary":
            payload = dict(snapshot.summary)
            kind = "summary"
        elif self.policy.can_commit_provider_payload:
            payload = snapshot.payload
            kind = snapshot.kind
        else:
            return
        try:
            expires_at = now_utc() + timedelta(hours=24)
            envelope = ProviderStateEnvelope.from_payload(
                owner_user_id=self.user_id, session_id=self.session_id,
                provider=self.provider, api_format=self.api_format,
                model_id=str(getattr(self.model_cfg, "model", "") or ""),
                reasoning_persistence=self.policy.mode,
                config_digest=self.config_digest,
                reasoning_config_digest=self.reasoning_config_digest,
                source_run_id=self.source_run_id,
                source_round_id=snapshot.round_id,
                sequence=self.sequence, state_kind=kind, payload=payload,
                expires_at=expires_at, state_summary=snapshot.summary,
            )
            self._diagnostic.update({
                "state_kind": kind,
                "state_block_count": _block_count(snapshot.summary),
                "state_size": envelope.payload_size,
                "state_version": envelope.version,
                "state_digest": envelope.payload_digest,
            })
            async with self.session_factory() as db:
                await provider_reasoning_state.commit_state(
                    db, user_id=self.user_id, session_id=self.session_id,
                    envelope=envelope, expected_version=self.expected_version,
                )
                await db.commit()
            self._diagnostic["state_status"] = "committed"
            self._publish_diagnostics("completed")
        except provider_reasoning_state.ProviderStateConflict as exc:
            self._mark_unavailable("concurrency_conflict", invalidated_reason="concurrency_conflict")
            diag_log("agent.reasoning_state.commit_conflict", exc)
            self._publish_diagnostics("completed")
        except Exception as exc:
            self._mark_unavailable("commit_failed")
            diag_log("agent.reasoning_state.commit", exc)
            self._publish_diagnostics("completed")

    async def failed(self, reason: str = "provider_rejected") -> None:
        self.latest = None
        self._mark_unavailable(
            reason,
            invalidated_reason=reason,
            status="provider_rejected" if reason == "provider_rejected" else "unavailable",
        )
        if self.session_id is None or self.session_factory is None:
            self._publish_diagnostics("failed")
            return
        try:
            async with self.session_factory() as db:
                await provider_reasoning_state.invalidate_state(
                    db, user_id=self.user_id, session_id=self.session_id,
                    reason=reason,
                )
                from sqlalchemy import select
                row = (await db.execute(select(provider_reasoning_state.ProviderReasoningState).where(
                    provider_reasoning_state.ProviderReasoningState.user_id == self.user_id,
                    provider_reasoning_state.ProviderReasoningState.session_id == self.session_id,
                ))).scalar_one_or_none()
                self.expected_version = int(getattr(row, "version", 0) or 0)
                await db.commit()
        except Exception as exc:
            diag_log("agent.reasoning_state.invalidate", exc)
        self._publish_diagnostics("failed")

    async def boundary_changed(self, reason: str) -> None:
        self.latest = None
        self._mark_unavailable(reason, invalidated_reason=reason)
        if self.session_id is None or self.session_factory is None:
            self._publish_diagnostics("boundary_changed")
            return
        try:
            async with self.session_factory() as db:
                await provider_reasoning_state.invalidate_state(
                    db, user_id=self.user_id, session_id=self.session_id,
                    reason=reason,
                )
                await db.commit()
        except Exception as exc:
            diag_log("agent.reasoning_state.boundary", exc)
        self._publish_diagnostics("boundary_changed")
