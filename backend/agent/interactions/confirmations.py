"""面向用户的确认交互。

删除等不可逆工具的确认属于交互协议的一部分：先展示影响范围，再等待用户明确同意。
授权记录只存在服务端（Redis，带 TTL），模型不携带、不复述任何凭证：

1. 工具调用未命中授权 → 返回 waiting_confirmation，内含服务端签发的短确认码；
2. 用户在网页/IM/终端点击确认 → 交互服务用确认码兑换授权（写入 Redis）；
3. 模型直接重新调用同一工具 → 命中授权，服务端自动注入 confirm 后放行。

``agent.security.confirm`` 仅作为旧导入路径的兼容入口。
"""

from __future__ import annotations

from hashlib import sha256
import json
import secrets

from app.core.redis import get_redis_sync


_TOKEN_TTL_MINUTES = 5
_GRANT_PREFIX = "agent:confirm-grant"
_REQ_PREFIX = "agent:confirm-req"
_CODE_PREFIX = "agent:confirm-code"


def _truthy(value) -> bool:
    return value is True or (
        isinstance(value, str) and value.strip().lower() in ("true", "1", "yes")
    )


def is_confirmed(args: dict) -> bool:
    """本次调用是否带有效 confirm（授权命中时由服务端注入）。"""
    return _truthy(args.get("confirm"))


def confirmation_payload(value: object) -> dict | None:
    """从工具返回值中提取统一的待确认载荷。

    工具可以直接返回 ``needs_confirm`` 的 JSON，也可能为了保留错误协议
    把它包在 ``error`` 字段中（Shell 就是这种情况）。所有确认门消费者都必须
    通过这里识别，避免某个包装层改变后只修到其中一条链路。
    """
    candidates: list[object] = [value]
    if isinstance(value, dict):
        candidates.append(value.get("error"))
    for candidate in candidates:
        if isinstance(candidate, str):
            try:
                candidate = json.loads(candidate)
            except (TypeError, ValueError):
                continue
        if not isinstance(candidate, dict):
            continue
        if candidate.get("needs_confirm") or candidate.get("status") == "waiting_confirmation":
            return candidate
    return None


def normalize_confirmation_result(value: object) -> object:
    """将任意包装形式标准化为顶层确认载荷。

    仅保留外层非 ``error`` 字段作为兼容元数据；确认协议字段由内层载荷覆盖。
    这样工具可以继续携带审计用的私有字段，但模型、轨迹和交互桥看到的确认
    结构始终一致。
    """
    payload = confirmation_payload(value)
    if payload is None:
        return value
    if isinstance(value, dict):
        outer = {key: item for key, item in value.items() if key != "error"}
        return {**outer, **payload}
    return payload


def is_block(result) -> bool:
    """判断工具返回是否是确认拦截结果。"""
    return confirmation_payload(result) is not None


def _summary_hash(summary: str) -> str:
    return sha256(summary.encode("utf-8")).hexdigest()


def _identity_hash(identity: str | None) -> str:
    return sha256((identity or "").encode("utf-8")).hexdigest()


def _grant_key(user_id, summary: str, identity: str | None) -> str:
    return f"{_GRANT_PREFIX}:{user_id}:{_summary_hash(summary)}:{_identity_hash(identity)}"


def _check_grant(user_id, summary: str, identity: str | None) -> bool:
    try:
        return bool(get_redis_sync().exists(_grant_key(user_id, summary, identity)))
    except Exception:
        return False


def grant_confirmation(user_id, summary: str, identity: str | None = None,
                       *, ttl_minutes: int = _TOKEN_TTL_MINUTES) -> bool:
    """直接写入一条授权（供测试或服务端流程使用）。"""
    try:
        get_redis_sync().setex(
            _grant_key(user_id, summary, identity), max(1, int(ttl_minutes)) * 60, "1",
        )
        return True
    except Exception:
        return False


def revoke_confirmation(user_id, summary: str, identity: str | None = None) -> bool:
    """撤销确认授权并清理同一范围的待确认请求。"""
    try:
        r = get_redis_sync()
        req_key = f"{_REQ_PREFIX}:{user_id}:{_summary_hash(summary)}:{_identity_hash(identity)}"
        code = r.get(req_key)
        keys = [_grant_key(user_id, summary, identity), req_key]
        if code:
            keys.append(f"{_CODE_PREFIX}:{user_id}:{code}")
        r.delete(*keys)
        return True
    except Exception:
        return False


def redeem_confirmation(user_id, code: str) -> int | None:
    """用短确认码兑换授权。成功返回授权有效期（分钟），码无效/过期返回 None。"""
    code = str(code or "").strip()
    if not code:
        return None
    try:
        r = get_redis_sync()
        raw = r.get(f"{_CODE_PREFIX}:{user_id}:{code}")
        if not raw:
            return None
        record = json.loads(raw)
        ttl = int(record.get("ttl_minutes") or _TOKEN_TTL_MINUTES)
        summary_hash = record.get("s")
        identity_hash = record.get("i")
        if not summary_hash:
            return None
        r.setex(
            f"{_GRANT_PREFIX}:{user_id}:{summary_hash}:{identity_hash or ''}",
            ttl * 60, "1",
        )
        # 确认码一次性：兑换后作废码与请求记录。
        r.delete(f"{_CODE_PREFIX}:{user_id}:{code}")
        return ttl
    except Exception:
        return None


def _create_pending(user_id, summary: str, identity: str | None,
                    ttl_minutes: int) -> str | None:
    """登记一条待确认请求并返回短确认码；同一请求重复拦截时复用同一码。"""
    try:
        r = get_redis_sync()
        req_key = f"{_REQ_PREFIX}:{user_id}:{_summary_hash(summary)}:{_identity_hash(identity)}"
        code = r.get(req_key)
        if code:
            return code
        code = secrets.token_hex(6)
        record = json.dumps(
            {"s": _summary_hash(summary), "i": _identity_hash(identity),
             "ttl_minutes": ttl_minutes},
            ensure_ascii=False,
        )
        ttl_seconds = max(1, int(ttl_minutes)) * 60
        r.setex(req_key, ttl_seconds, code)
        r.setex(f"{_CODE_PREFIX}:{user_id}:{code}", ttl_seconds, record)
        return code
    except Exception:
        return None


def needs_confirmation(
    args: dict,
    summary: str,
    user_id,
    *,
    identity: str | None = None,
    ttl_minutes: int = _TOKEN_TTL_MINUTES,
    instruction: str | None = None,
) -> str | None:
    """返回 None=已确认可执行（授权命中时自动注入 confirm）；否则返回需确认结果。

    授权按（用户, 摘要, 身份范围）记录：同一能力范围内后续调用无需重复确认，
    直到授权过期。确认码只用于网页/IM/终端把"用户已同意"传达回服务端，
    不参与模型上下文校验。
    """
    if _check_grant(user_id, summary, identity):
        args["confirm"] = True
        return None
    code = _create_pending(user_id, summary, identity, ttl_minutes)
    payload = {
        "status": "waiting_confirmation",
        "needs_confirm": True,
        "summary": summary,
        "instruction": instruction or (
            "这是不可逆操作。请把上述影响转达用户；用户在界面点击确认后，"
            "直接重新调用本工具即可，无需携带任何确认凭证。"
        ),
        **({"authorization_ttl_minutes": ttl_minutes} if ttl_minutes != _TOKEN_TTL_MINUTES else {}),
    }
    if code is None:
        # Redis 不可用时保持 fail-closed：不能无授权放行破坏性操作。
        payload["status"] = "confirmation_unavailable"
        payload["error"] = "确认服务暂不可用，请稍后重试。"
    else:
        payload["confirm_code"] = code
    return json.dumps(payload, ensure_ascii=False)


__all__ = [
    "confirmation_payload", "is_block", "is_confirmed", "needs_confirmation",
    "normalize_confirmation_result",
    "grant_confirmation", "revoke_confirmation", "redeem_confirmation",
]
