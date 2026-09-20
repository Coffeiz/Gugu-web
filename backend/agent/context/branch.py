"""反思与压缩共用的 ContextBranch 执行入口。"""
from __future__ import annotations

import hashlib
import logging
from typing import Any

from .assembler import assemble_branch_user_input
from .branch_types import BranchInput, BranchPolicy, BranchResult
from . import provider_runner
from app.core.redaction import diag_log
from app.core.retry import BRANCH_RETRY

logger = logging.getLogger(__name__)


def _fingerprint(value: object) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


def _log_run_id(value: str | None) -> str:
    """限制日志关联 ID 字符，避免意外换行注入或无限长字段。"""
    if not value:
        return "-"
    safe = "".join(
        char if char.isascii() and (char.isalnum() or char in "_.:-") else "_"
        for char in value
    )
    return safe[:120] or "-"


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
        user = assemble_branch_user_input(branch_input)
        input_fp = _fingerprint(f"{branch_input.stable_system}\n{user}")
        # 分支调用的用量按场景落库（reflection/compaction/knowledge）：
        # 临时改写 usage context 的 scenario，分支退出后还原，主链路仍是 chat。
        from agent.llm import modelctx as _modelctx
        _prev_usage_ctx = _modelctx.get_usage_context()
        if _prev_usage_ctx is not None and _prev_usage_ctx.scenario != policy.name:
            _modelctx.set_usage_context(
                _prev_usage_ctx.user_id, _prev_usage_ctx.session_id, scenario=policy.name)
        attempts = 0
        output: Any = None
        reason = "provider_error"
        validated_ok = False
        error_type = "-"
        error_status = "-"
        # append_reuse 的实际缓存观测（PRD-LLM-27 §6.7）：provider 归一化 usage
        # 经旁路收集，成功后喂 cache_capability 纯观测记账（白名单已废止，观测
        # 只记录不拦截）；不改返回契约。
        usage_sink: list = []
        try:
            for attempts in range(1, max(0, policy.max_retries) + 2):
                if attempts > 1:
                    # 尝试之间按共享节奏（BRANCH_RETRY）歇一下：此前零间隔连发，
                    # 上游过载时两次尝试都打在同一个尖峰上（2026-09-18 529 实测）
                    await BRANCH_RETRY.pause()
                call_failed = False
                try:
                    if branch_input.history_messages and runner is None:
                        # 追加式：canonical 消息序列原样发送，user 只是末尾追加的指令。
                        output = await provider_runner.complete_messages(
                            branch_input.stable_system,
                            list(branch_input.history_messages),
                            user, settings,
                            max_tokens=policy.max_tokens,
                            json_mode=policy.output_mode != "text",
                            tools=list(branch_input.tools) or None,
                            usage_sink=usage_sink,
                        )
                        ok = bool(str(output or "").strip()) and (
                            not isinstance(output, dict) or bool(output))
                    elif policy.output_mode == "text":
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
                    run_id = _log_run_id(branch_input.run_id)
                    diag_log(
                        "agent.context.branch.provider "
                        f"branch={policy.name} run_id={run_id} "
                        f"attempt={attempts} status={error_status}",
                        exc,
                    )
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
        finally:
            if _prev_usage_ctx is not None and _prev_usage_ctx.scenario != policy.name:
                _modelctx.set_usage_context(
                    _prev_usage_ctx.user_id, _prev_usage_ctx.session_id,
                    scenario=_prev_usage_ctx.scenario)

        output_fp = _fingerprint(output) if output else None
        if branch_input.branch_mode == "append_reuse" and usage_sink:
            usage = usage_sink[-1]
            try:
                from agent.llm.modelctx import effective_ai
                from .cache_capability import record_reuse_outcome

                record_reuse_outcome(effective_ai(settings),
                                     cache_hit=bool(usage.get("cache_read")))
            except Exception:
                pass
        result = BranchResult(
            ok=validated_ok,
            output=output if validated_ok else None,
            return_reason=reason,
            attempts=attempts,
            input_fingerprint=input_fp,
            output_fingerprint=output_fp,
            provider_usage=(usage_sink[-1] if usage_sink else None),
            metadata={
                "branch": policy.name,
                "branch_mode": branch_input.branch_mode,
                "scope": branch_input.scope,
                "scope_revision": branch_input.scope_revision,
                "session_id": branch_input.session_id,
                "run_id": branch_input.run_id,
            },
        )
        if result.return_reason == "provider_error":
            run_id = _log_run_id(branch_input.run_id)
            logger.warning(
                "[context-branch-provider-failed] branch=%s run_id=%s attempts=%d "
                "error_type=%s error_status=%s input_fp=%s",
                policy.name,
                run_id,
                result.attempts,
                error_type,
                error_status,
                result.input_fingerprint,
            )
        logger.info(
            "[context-branch] branch=%s mode=%s scope=%s scope_revision=%s session_id=%s attempts=%d ok=%s reason=%s error_type=%s error_status=%s input_fp=%s output_fp=%s",
            policy.name,
            branch_input.branch_mode,
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
