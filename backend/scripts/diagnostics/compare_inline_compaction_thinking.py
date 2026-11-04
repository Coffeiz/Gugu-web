#!/usr/bin/env python3
"""隔离复现真实 QQ run 的 thinking 压缩前缀 A/B；只输出用量与结构统计。"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace


def ratio(usage):
    if not isinstance(usage, dict):
        return None
    fresh = int(usage.get("input") or usage.get("fresh_input_tokens") or 0)
    cached = int(usage.get("cache_read") or usage.get("cache_read_tokens") or 0)
    written = int(usage.get("cache_write") or usage.get("cache_write_tokens") or 0)
    total = fresh + cached + written
    return {
        "fresh_input": fresh,
        "cache_read": cached,
        "cache_write": written,
        "total_input": total,
        "cache_ratio_pct": round(cached / total * 100, 4) if total else None,
    }


async def main(session_id: int, *, allow_config_fingerprint_mismatch: bool):
    from sqlalchemy import select
    from app.core.config import get_settings
    from app.db import session as db_session
    from app.models import ConversationSession, ProviderReasoningState
    from app.byok.crypto import decrypt_envelope
    from agent import providers
    from agent.context import compaction, session_history, session_snapshot
    from agent.context.assembly.area import MessageArea
    from agent.context.history import build_history_parts
    from agent.context.provider_history import render_anthropic_message_roles
    from agent.context.reasoning_state import model_state_fingerprints
    from agent.llm.llm_select import resolve_run_config_for_user, use_anthropic_for
    from agent.llm import modelctx
    from agent.loop_drivers import _restore_anthropic_history_thinking
    from agent.tools import registry

    settings = get_settings()
    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id)
        if session is None or str(session.source or "").lower() != "qq":
            raise RuntimeError("目标会话不存在或不是 QQ 会话")
        run_config = await resolve_run_config_for_user(settings, db, session.user_id, None)
        ai = run_config.model
        if not use_anthropic_for(ai) or str(ai.provider).lower() != "minimax":
            raise RuntimeError("目标会话当前模型不是 MiniMax Anthropic 路由")
        snapshot = dict(session.session_context or {})
        system_prompt = str(snapshot.get("system_prompt") or "")
        if not system_prompt:
            raise RuntimeError("目标会话缺少冻结 system prompt")
        history = await session_history.load_session_history(
            db, session_id, session_snapshot.history_baseline(session),
        )
        state = (await db.execute(
            select(ProviderReasoningState).where(
                ProviderReasoningState.user_id == session.user_id,
                ProviderReasoningState.session_id == session_id,
                ProviderReasoningState.status == "active",
            )
        )).scalar_one_or_none()
        if state is None or state.expires_at <= datetime.now(timezone.utc):
            raise RuntimeError("没有可复用的有效 reasoning continuation")
        tools = registry.anthropic_schemas(["call_tool", "use_skill", "ask_user"])
        adapter = providers.adapter_for(ai)
        provider = str(adapter.name or "")
        tool_digest = hashlib.sha256(json.dumps(
            tools, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")).hexdigest()[:16]
        config_digest, reasoning_config_digest = model_state_fingerprints(
            ai, provider=provider, api_format="anthropic", tool_digest=tool_digest,
        )
        mismatches = [name for name, ok in (
            ("provider", state.provider == provider),
            ("api_format", state.api_format == "anthropic"),
            ("model", state.model_id == str(ai.model)),
            ("reasoning_config", state.reasoning_config_digest == reasoning_config_digest),
            ("persistence", state.reasoning_persistence == "continuation"),
        ) if not ok]
        if mismatches:
            raise RuntimeError("续接状态身份不匹配: " + ",".join(mismatches))
        config_fingerprint_matches = state.config_digest == config_digest
        if not config_fingerprint_matches and not allow_config_fingerprint_mismatch:
            raise RuntimeError(
                "当前模型配置指纹与历史续接状态不同；仅在明确接受该限制时使用"
                " --allow-config-fingerprint-mismatch"
            )
        payload_text = decrypt_envelope(
            state.encrypted_payload, state.payload_nonce, state.encrypted_data_key,
            key_version=state.key_version,
        )
        state_payload = json.loads(payload_text)
        state_version = int(state.version)
        state_block_count = int((state.state_summary or {}).get("state_block_count", 0) or 0)
        user_tz = session_snapshot.snapshot_context(session).get("user_tz")
        request = SimpleNamespace(
            source=session.source, chat_id=session.chat_id,
            platform_user_id=session.platform_user_id,
            message="诊断请求", quoted_text=None,
        )

    modelctx.mark_user_scope()
    modelctx.set_model_cfg(ai)
    history_parts = build_history_parts(
        history, request, use_anthropic=True, user_tz=user_tz, strip_thinking=True,
    )
    snapshot_context = str(snapshot.get("snapshot_context") or snapshot.get("dynamic_context") or "")
    messages = ([session_snapshot.snapshot_message(snapshot_context)] if snapshot_context else []) + history_parts
    area = MessageArea.from_canonical_messages(
        messages,
        fixed_prefix_size=1 if snapshot_context else 0,
        render_options={"api_format": "anthropic"},
    )
    prompt = "这是一次隔离的压缩前缀诊断预热。请只回复：预热完成。"
    area.set_dynamic_tail([{"role": "user", "content": prompt}])
    projection = render_anthropic_message_roles(area.provider_projection(), adapter)
    wire = projection.to_messages()
    thinking_by_tool = state_payload.get("history_thinking_by_tool_id") or {}
    _restore_anthropic_history_thinking(wire, thinking_by_tool)
    tail_blocks = state_payload.get("tail_blocks") or []
    if tail_blocks:
        insert_at = projection.conversation_count
        if insert_at and wire[insert_at - 1].get("role") == "user":
            insert_at -= 1
        wire.insert(insert_at, {"role": "assistant", "content": copy.deepcopy(tail_blocks)})
    projection = projection.with_messages(wire)
    area.last_provider_projection = projection

    from agent.context import provider_runner
    warm_history = projection.with_messages(projection.conversation, dynamic_tail_size=0)

    from agent.context.branch import ContextBranch
    original_run = ContextBranch.run
    active_arm = {"name": ""}
    arm_results = {
        "A_canonical": {"warmup": None, "compression": []},
        "B_wire_projection": {"warmup": None, "compression": []},
    }

    async def tracked_run(self, branch_input, policy, branch_settings, *, runner=None):
        result = await original_run(
            self, branch_input, policy, branch_settings, runner=runner,
        )
        usage = ratio(result.provider_usage)
        arm_results[active_arm["name"]]["compression"].append({
            "ok": bool(result.ok),
            "reason": str(result.return_reason),
            "attempts": int(result.attempts),
            "usage": usage,
        })
        return result

    ContextBranch.run = tracked_run
    try:
        for label, keep_projection in (("A_canonical", False), ("B_wire_projection", True)):
            active_arm["name"] = label
            arm_system = (
                system_prompt
                + "\n\n[缓存 A/B 隔离标记："
                + uuid.uuid4().hex[:16]
                + "]"
            )
            warm_usage = []
            await provider_runner.complete_messages(
                arm_system, warm_history, prompt, settings,
                max_tokens=16, tools=tools, usage_sink=warm_usage,
            )
            arm_results[label]["warmup"] = ratio(
                warm_usage[-1] if warm_usage else None,
            )
            test_area = copy.deepcopy(area)
            if not keep_projection:
                test_area.last_provider_projection = None
            result = await compaction.compact_context(
                test_area,
                session_id=None,
                fixed_prefix_size=test_area.fixed_prefix_size,
                model_cfg=ai,
                system_text=arm_system,
                branch_tools=tools,
            )
            arm_results[label]["compression"].append({
                "compaction_changed": bool(result.changed),
                "compaction_reason": str(result.return_reason),
            })
    finally:
        ContextBranch.run = original_run

    print(json.dumps({
        "source": "qq",
        "provider": provider,
        "model": str(ai.model),
        "api_format": "anthropic",
        "history_rows": len(history),
        "provider_messages": projection.conversation_count,
        "restored_state_blocks": state_block_count,
        "tool_count": len(tools),
        "wire_digest": projection.wire_digest,
        "arms": arm_results,
        "business_writeback": False,
        "usage_context_bound": modelctx.get_usage_context() is not None,
        "tools_dispatched": False,
        "provider_state_version_read": state_version,
        "state_config_fingerprint_matches": config_fingerprint_matches,
    }, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", type=int, required=True)
    parser.add_argument("--allow-real-llm", action="store_true")
    parser.add_argument(
        "--allow-config-fingerprint-mismatch",
        action="store_true",
        help="仅用于隔离历史回放，允许同模型 reasoning 状态的 cache 配置指纹不同",
    )
    args = parser.parse_args()
    if not args.allow_real_llm:
        parser.error("真实模型请求必须显式传入 --allow-real-llm")
    asyncio.run(main(
        args.session_id,
        allow_config_fingerprint_mismatch=args.allow_config_fingerprint_mismatch,
    ))
