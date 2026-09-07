"""用户链路的 LLM 用量记账。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class UsageResult:
    """一次调用实际写入账本的输入/输出用量。"""

    tokens_in: int = 0
    tokens_out: int = 0


def _usage_value(value, key: str):
    if isinstance(value, dict):
        return value.get(key, 0) or 0
    return getattr(value, key, 0) or 0


def normalize_anthropic_usage(usage) -> dict[str, int]:
    """把 Anthropic 返回的用量字段归一为账本字段。"""
    return {
        "input": int(_usage_value(usage, "input_tokens") or 0),
        "output": int(_usage_value(usage, "output_tokens") or 0),
        "cache_read": int(_usage_value(usage, "cache_read_input_tokens") or 0),
        "cache_write": int(_usage_value(usage, "cache_creation_input_tokens") or 0),
    }


def normalize_openai_usage(usage) -> dict[str, int]:
    """把 OpenAI 兼容接口的 prompt/cache 字段归一为账本字段。"""
    prompt_tokens = int(_usage_value(usage, "prompt_tokens") or 0)
    cache_read = int(_usage_value(usage, "prompt_cache_hit_tokens") or 0)
    if not cache_read:
        details = _usage_value(usage, "prompt_tokens_details")
        cache_read = int(_usage_value(details, "cached_tokens") or 0)
    return {
        "input": max(0, prompt_tokens - cache_read),
        "output": int(_usage_value(usage, "completion_tokens") or 0),
        "cache_read": cache_read,
        "cache_write": int(_usage_value(usage, "prompt_cache_creation_tokens") or 0),
    }

async def record_usage(
    user_id,
    settings,
    model_cfg,
    *,
    tokens_in: int = 0,
    tokens_out: int = 0,
    cache_read: int = 0,
    cache_write: int = 0,
    session_id: int | None = None,
    tools_used: list[str] | None = None,
    db=None,
) -> UsageResult:
    """把一次实际 provider 调用写入 AgentUsage，并沿用平台配额封顶规则。"""
    tokens_in = max(0, int(tokens_in or 0))
    tokens_out = max(0, int(tokens_out or 0))
    cache_read = max(0, int(cache_read or 0))
    cache_write = max(0, int(cache_write or 0))
    if not any((tokens_in, tokens_out, cache_read, cache_write)):
        return UsageResult()

    from agent import quota
    from app.models import AgentUsage

    async def _record(target_db) -> UsageResult:
        capped_in, capped_out = await quota.cap_usage(
            target_db, user_id, settings, tokens_in, tokens_out,
        )
        # 与 finalize_run 保持一致：平台配额填满后冻结 in/out；BYOK 不封顶。
        # cache 字段仍保留真实 provider 返回值，供 BYOK 趋势图统计。
        if not any((capped_in, capped_out, cache_read, cache_write)):
            return UsageResult()
        target_db.add(AgentUsage(
            user_id=user_id,
            session_id=session_id,
            tokens_in=capped_in,
            tokens_out=capped_out,
            cache_read=cache_read,
            cache_write=cache_write,
            model=str(getattr(model_cfg, "model", "")),
            provider=str(getattr(model_cfg, "provider", "")),
            is_byok=bool(getattr(model_cfg, "is_byok", False)),
            tools_used=tools_used or None,
        ))
        return UsageResult(tokens_in=capped_in, tokens_out=capped_out)

    if db is not None:
        return await _record(db)

    from app.db import session as db_session

    db_session.ensure_engine()
    async with db_session._SessionLocal() as target_db:
        result = await _record(target_db)
        await target_db.commit()
        return result


async def record_current_usage(settings, model_cfg, usage: dict) -> None:
    """记录当前 ContextVar 绑定的用户链路用量；无归属时静默跳过。"""
    from agent.llm import modelctx

    context = modelctx.get_usage_context()
    if context is None:
        return
    await record_usage(
        context.user_id,
        settings,
        model_cfg,
        tokens_in=usage.get("input", 0),
        tokens_out=usage.get("output", 0),
        cache_read=usage.get("cache_read", 0),
        cache_write=usage.get("cache_write", 0),
        session_id=context.session_id,
    )
