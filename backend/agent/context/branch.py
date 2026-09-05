"""反思与压缩共用的 ContextBranch 执行入口。"""
from __future__ import annotations

import hashlib
import logging
from typing import Any

from .assembler import assemble_branch_user_input
from .branch_types import BranchInput, BranchPolicy, BranchResult
from . import provider_runner
from app.core.redaction import diag_log

logger = logging.getLogger(__name__)


def _fingerprint(value: object) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


class ContextBranch:
    """统一执行 provider 分支，不持有任何跨请求状态。"""

    async def run(
        self,
        branch_input: BranchInput,
        policy: BranchPolicy,
        settings,
        *,
        runner=None,
    ) -> BranchResult:
        if branch_input.session_id is not None:
            # 分支输入与主会话历史不是同一条 provider response chain；有明确会话
            # 边界时先让主状态失效，避免分支结果完成后继续复用旧 chain。
            if branch_input.scope_owner_id is not None:
                try:
                    from app.db import session as db_session
                    from app.services.provider_reasoning_state import invalidate_state
                    db_session.ensure_engine()
                    async with db_session._SessionLocal() as db:
                        await invalidate_state(
                            db, user_id=branch_input.scope_owner_id,
                            session_id=branch_input.session_id, reason="branch_changed",
                        )
                        await db.commit()
                except Exception as exc:
                    diag_log("agent.context.branch.state_boundary", exc)
        user = assemble_branch_user_input(branch_input)
        input_fp = _fingerprint(f"{branch_input.stable_system}\n{user}")
        attempts = 0
        output: Any = None
        reason = "provider_error"
        validated_ok = False
        error_type = "-"
        error_status = "-"
        for attempts in range(1, max(0, policy.max_retries) + 2):
            call_failed = False
            try:
                if policy.output_mode == "text":
                    call = runner or provider_runner.complete_text
                    output = await call(
                        branch_input.stable_system, user, settings, policy.max_tokens)
                    ok = bool(str(output or "").strip())
                else:
                    call = runner or provider_runner.complete_json
                    output = await call(
                        branch_input.stable_system, user, settings,
                        max_tokens=policy.max_tokens,
                        thinking=policy.thinking,
                    )
                    ok = isinstance(output, dict) and bool(output)
            except Exception as exc:
                output = None
                ok = False
                call_failed = True
                reason = "provider_error"
                error_type = type(exc).__name__
                response = getattr(exc, "response", None)
                status = getattr(exc, "status_code", None) or getattr(response, "status_code", None)
                error_status = str(status) if isinstance(status, int) else "-"
                diag_log("agent.context.branch.provider", exc)
            validated_ok = ok
            if ok:
                reason = "completed"
                break
            if not call_failed:
                reason = (
                    "output_empty"
                    if output is None or output == "" or output == {}
                    else "schema_invalid"
                )

        output_fp = _fingerprint(output) if output else None
        result = BranchResult(
            ok=validated_ok,
            output=output if validated_ok else None,
            return_reason=reason,
            attempts=attempts,
            input_fingerprint=input_fp,
            output_fingerprint=output_fp,
            metadata={
                "branch": policy.name,
                "scope": branch_input.scope,
                "scope_revision": branch_input.scope_revision,
                "session_id": branch_input.session_id,
                "run_id": branch_input.run_id,
            },
        )
        logger.info(
            "[context-branch] branch=%s scope=%s scope_revision=%s session_id=%s attempts=%d ok=%s reason=%s error_type=%s error_status=%s input_fp=%s output_fp=%s",
            policy.name,
            branch_input.scope or "-",
            branch_input.scope_revision or "-",
            branch_input.session_id,
            result.attempts,
            result.ok,
            result.return_reason,
            error_type,
            error_status,
            result.input_fingerprint,
            result.output_fingerprint or "-",
        )
        return result


__all__ = ["ContextBranch", "BranchInput", "BranchPolicy", "BranchResult"]
