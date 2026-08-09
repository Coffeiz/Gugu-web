"""删除二次确认 · 保底机制（短时确认凭证）。

不可逆删除工具在执行前调用 `needs_confirmation(args, summary)`：
- 首次调用返回影响范围与短时确认凭证（**不执行删除**）；
- 用户明确同意后，模型带回 `confirm=true + confirm_token` 才放行执行。

凭证绑定用户、影响描述并在五分钟后失效。这样模型不能只凭用户一句「彻底删除」自行
补上 `confirm=true` 绕过「先展示影响，再征得同意」的两步流程。
"""
from __future__ import annotations

from datetime import timedelta
from hashlib import sha256
import json

from jose import JWTError, jwt

from app.core.config import get_settings
from app.core.tz import now_utc


_TOKEN_ROLE = "agent_destructive_confirm"
_TOKEN_TTL_MINUTES = 5

def _truthy(v) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in ("true", "1", "yes"))


def is_confirmed(args: dict) -> bool:
    """本次调用是否带有效 confirm（dispatch 层绊线用，与 needs_confirmation 同一判定口径）。"""
    return _truthy(args.get("confirm"))


def is_block(result) -> bool:
    """判断工具返回是否是 needs_confirmation 的拦截结果（dispatch 层绊线用）。"""
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except Exception:
            return False
    return isinstance(result, dict) and bool(result.get("needs_confirm"))


def _summary_hash(summary: str) -> str:
    return sha256(summary.encode("utf-8")).hexdigest()


def _create_token(user_id, summary: str) -> str:
    return jwt.encode(
        {
            "sub": str(user_id),
            "role": _TOKEN_ROLE,
            "summary": _summary_hash(summary),
            "exp": now_utc() + timedelta(minutes=_TOKEN_TTL_MINUTES),
        },
        get_settings().secret_key,
        algorithm="HS256",
    )


def _has_valid_token(args: dict, user_id, summary: str) -> bool:
    token = args.get("confirm_token")
    if not isinstance(token, str) or not token:
        return False
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=["HS256"])
    except JWTError:
        return False
    return (
        payload.get("role") == _TOKEN_ROLE
        and payload.get("sub") == str(user_id)
        and payload.get("summary") == _summary_hash(summary)
    )


def needs_confirmation(args: dict, summary: str, user_id) -> str | None:
    """返回 None=已确认可执行；否则签发确认凭证并返回需确认结果。"""
    if _truthy(args.get("confirm")) and _has_valid_token(args, user_id, summary):
        return None
    return json.dumps({
        "needs_confirm": True,
        "summary": summary,
        "confirm_token": _create_token(user_id, summary),
        "instruction": "这是不可逆操作。请把上述影响转达用户；待用户明确同意后，带 confirm=true 和本次 confirm_token 再次调用本工具执行。",
    }, ensure_ascii=False)
