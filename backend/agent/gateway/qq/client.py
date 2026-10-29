"""QQ Bot API 会话、凭据、token 与请求错误处理。"""
from __future__ import annotations

import asyncio
import logging
import time
import weakref
from typing import Any

import aiohttp

from app.core.redaction import diag_log, diag_log_raw

_log = logging.getLogger("agent.gateway.qq")

_QQ_HTTP_KEEPALIVE_SECONDS = 300.0
_QQ_PREWARM_COOLDOWN_SECONDS = _QQ_HTTP_KEEPALIVE_SECONDS - 30.0

_QQ_HTTP_SESSION: aiohttp.ClientSession | None = None

def _qq_http_trace_config() -> aiohttp.TraceConfig:
    """记录连接复用、DNS 与建连阶段，不把请求参数或正文放入诊断上下文。"""
    config = aiohttp.TraceConfig()

    async def _dns_started(_session, trace_ctx, _params):
        request_ctx = getattr(trace_ctx, "trace_request_ctx", None)
        if isinstance(request_ctx, dict):
            request_ctx["dns_started"] = time.perf_counter()

    async def _dns_finished(_session, trace_ctx, _params):
        request_ctx = getattr(trace_ctx, "trace_request_ctx", None)
        if isinstance(request_ctx, dict) and "dns_started" in request_ctx:
            request_ctx["dns_ms"] = (
                time.perf_counter() - request_ctx.pop("dns_started")
            ) * 1000

    async def _connection_started(_session, trace_ctx, _params):
        request_ctx = getattr(trace_ctx, "trace_request_ctx", None)
        if isinstance(request_ctx, dict):
            request_ctx["connection_started"] = time.perf_counter()

    async def _connection_finished(_session, trace_ctx, _params):
        request_ctx = getattr(trace_ctx, "trace_request_ctx", None)
        if isinstance(request_ctx, dict) and "connection_started" in request_ctx:
            request_ctx["connect_ms"] = (
                time.perf_counter() - request_ctx.pop("connection_started")
            ) * 1000

    async def _mark_connection_reused(_session, trace_ctx, _params):
        request_ctx = getattr(trace_ctx, "trace_request_ctx", None)
        if isinstance(request_ctx, dict):
            request_ctx["connection_reused"] = True

    config.on_dns_resolvehost_start.append(_dns_started)
    config.on_dns_resolvehost_end.append(_dns_finished)
    config.on_connection_create_start.append(_connection_started)
    config.on_connection_create_end.append(_connection_finished)
    config.on_connection_reuseconn.append(_mark_connection_reused)
    return config

async def start_qq_http_session() -> aiohttp.ClientSession:
    """为当前进程的 asyncio loop 创建 QQ REST 连接池。"""
    global _QQ_HTTP_SESSION
    if _QQ_HTTP_SESSION is None or _QQ_HTTP_SESSION.closed:
        connector = aiohttp.TCPConnector(
            keepalive_timeout=_QQ_HTTP_KEEPALIVE_SECONDS,
            limit=0,
            limit_per_host=64,
        )
        _QQ_HTTP_SESSION = aiohttp.ClientSession(
            connector=connector,
            trace_configs=[_qq_http_trace_config()],
        )
    return _QQ_HTTP_SESSION

async def close_qq_http_session() -> None:
    """关闭当前进程持有的 QQ REST 连接池。"""
    global _QQ_HTTP_SESSION
    session, _QQ_HTTP_SESSION = _QQ_HTTP_SESSION, None
    if session is not None and not session.closed:
        await session.close()

async def _get_qq_http_session() -> aiohttp.ClientSession:
    return await start_qq_http_session()

def _qq_endpoint_kind(path: str) -> str:
    """把接口路径归类，避免日志暴露路径中的用户或消息标识。"""
    normalized = path.lower()
    if "stream_messages" in normalized:
        return "stream_message"
    if "/messages" in normalized:
        return "message"
    if "/files" in normalized:
        return "file"
    if "keyboard" in normalized:
        return "interaction"
    if normalized.endswith("/gateway"):
        return "gateway"
    return "other"

_QQ_API_BASE = "https://api.sgroup.qq.com"

_QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com"

_QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

def _qq_api_base(sandbox: bool) -> str:
    return _QQ_SANDBOX_API_BASE if sandbox else _QQ_API_BASE

async def _qq_access_token(app_id: str, secret: str) -> str:
    started = time.perf_counter()
    try:
        sess = await _get_qq_http_session()
        async with sess.post(
            _QQ_TOKEN_URL,
            json={"appId": app_id, "clientSecret": secret},
            headers={"Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()
    except Exception as exc:
        _log.info(
            "[qq-http] method=POST endpoint=access_token result=%s request_ms=%.1f",
            type(exc).__name__, (time.perf_counter() - started) * 1000,
        )
        raise
    _log.info(
        "[qq-http] method=POST endpoint=access_token status=%s request_ms=%.1f",
        resp.status, (time.perf_counter() - started) * 1000,
    )
    token = data.get("access_token", "")
    if not token:
        # 上游响应体可能回显请求里的 appId/secret 片段，绝不能拼进异常消息（P2-b §5）；
        # 原始体只进受限诊断出口，异常消息只给通用文案。
        diag_log_raw("agent.gateway.qq._qq_access_token", f"data={data}")
        raise RuntimeError("QQ access_token 获取失败（响应缺 access_token 字段）")
    return token

async def _qq_access_token_with_ttl(app_id: str, secret: str) -> tuple[str, int]:
    started = time.perf_counter()
    try:
        sess = await _get_qq_http_session()
        async with sess.post(
            _QQ_TOKEN_URL,
            json={"appId": app_id, "clientSecret": secret},
            headers={"Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()
    except Exception as exc:
        _log.info(
            "[qq-http] method=POST endpoint=access_token result=%s request_ms=%.1f",
            type(exc).__name__, (time.perf_counter() - started) * 1000,
        )
        raise
    _log.info(
        "[qq-http] method=POST endpoint=access_token status=%s request_ms=%.1f",
        resp.status, (time.perf_counter() - started) * 1000,
    )
    token = data.get("access_token", "")
    if not token:
        diag_log_raw("agent.gateway.qq._qq_access_token_with_ttl", f"data={data}")
        raise RuntimeError("QQ access_token 获取失败（响应缺 access_token 字段）")
    return token, int(data.get("expires_in") or 0)

async def _qq_gateway_url(token: str, sandbox: bool) -> str:
    started = time.perf_counter()
    try:
        sess = await _get_qq_http_session()
        async with sess.get(
            f"{_qq_api_base(sandbox)}/gateway",
            headers={"Authorization": f"QQBot {token}"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            data = await resp.json()
    except Exception as exc:
        _log.info(
            "[qq-http] method=GET endpoint=gateway result=%s request_ms=%.1f",
            type(exc).__name__, (time.perf_counter() - started) * 1000,
        )
        raise
    _log.info(
        "[qq-http] method=GET endpoint=gateway status=%s request_ms=%.1f",
        resp.status, (time.perf_counter() - started) * 1000,
    )
    url = data.get("url", "")
    if not url:
        diag_log_raw("agent.gateway.qq._qq_gateway_url", f"data={data}")
        raise RuntimeError("QQ gateway 获取失败（响应缺 url 字段）")
    return url

_QQ_TOKEN_SAFETY_MARGIN = 60   # 提前 60s 判过期，避免请求发出瞬间 token 恰好过期

_send_tokens: dict = {}   # channel_id -> {"token", "base", "expires_at"}
_send_token_locks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_qq_api_last_activity: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_qq_prewarm_tasks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_qq_prewarm_locks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _loop_channel_lock(lock_registry: weakref.WeakKeyDictionary, key: str) -> asyncio.Lock:
    """按事件循环隔离协程锁，避免测试或重启后的新 loop 复用旧 loop 锁。"""
    loop = asyncio.get_running_loop()
    locks = lock_registry.get(loop)
    if locks is None:
        locks = {}
        lock_registry[loop] = locks
    lock = locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        locks[key] = lock
    return lock


def _loop_state(registry: weakref.WeakKeyDictionary) -> dict:
    loop = asyncio.get_running_loop()
    state = registry.get(loop)
    if state is None:
        state = {}
        registry[loop] = state
    return state

async def _creds_by_id(bot_id: str) -> tuple[str, str, bool]:
    """worker 端：按 user_bots.id 取 (app_id, app_secret, sandbox)。"""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()
    from app.models import UserBot
    async with _sess._SessionLocal() as db:
        b = await db.get(UserBot, int(bot_id))
        if not b:
            return "", "", False
        return b.app_id, b.app_secret, b.sandbox

async def _send_token(channel_id: str) -> tuple[str, str]:
    """返回 (access_token, api_base)，按 channel_id 缓存，过期前自动刷新。"""
    cached = _send_tokens.get(channel_id)
    if cached and time.time() < cached["expires_at"] - _QQ_TOKEN_SAFETY_MARGIN:
        return cached["token"], cached["base"]
    async with _loop_channel_lock(_send_token_locks, channel_id):
        cached = _send_tokens.get(channel_id)
        if cached and time.time() < cached["expires_at"] - _QQ_TOKEN_SAFETY_MARGIN:
            return cached["token"], cached["base"]
        app_id, secret, sandbox = await _creds_by_id(channel_id)
        if not app_id:
            raise RuntimeError(f"user_bot {channel_id} 不存在或无凭据")
        token, expires_in = await _qq_access_token_with_ttl(app_id, secret)
        base = _qq_api_base(sandbox)
        _send_tokens[channel_id] = {
            "token": token,
            "base": base,
            "expires_at": time.time() + expires_in,
        }
        return token, base


async def _prewarm_qq_outbound(channel_id: str) -> None:
    """刷新可用 token，并在连接池可能已空闲过期时预建 QQ API 连接。"""
    try:
        token, base = await _send_token(channel_id)
        now = time.monotonic()
        activity = _loop_state(_qq_api_last_activity)
        if now - activity.get(base, 0.0) < _QQ_PREWARM_COOLDOWN_SECONDS:
            return
        async with _loop_channel_lock(_qq_prewarm_locks, base):
            now = time.monotonic()
            if now - activity.get(base, 0.0) < _QQ_PREWARM_COOLDOWN_SECONDS:
                return
            session = await _get_qq_http_session()
            started = time.perf_counter()
            request_trace = {"connection_reused": False}
            try:
                async with session.get(
                    f"{base}/gateway",
                    headers={"Authorization": f"QQBot {token}"},
                    timeout=aiohttp.ClientTimeout(total=15),
                    trace_request_ctx=request_trace,
                ) as response:
                    # 消费响应体以便 aiohttp 复用连接；gateway JSON 不需要在预热中解析。
                    await response.read()
                    status = response.status
            finally:
                activity[base] = time.monotonic()
            _log.info(
                "[qq-http] endpoint=prewarm_gateway status=%s request_ms=%.1f "
                "dns_ms=%s connect_setup_ms=%s reused=%s",
                status,
                (time.perf_counter() - started) * 1000,
                f"{request_trace['dns_ms']:.1f}" if "dns_ms" in request_trace else "-",
                f"{request_trace['connect_ms']:.1f}" if "connect_ms" in request_trace else "-",
                request_trace["connection_reused"],
            )
    except Exception as exc:
        # 预热失败不能影响当前 Agent run；错误只记录异常类型，不带请求内容。
        _log.info("[qq-http] endpoint=prewarm result=%s", type(exc).__name__)


def schedule_qq_outbound_prewarm(channel_id: str) -> None:
    """异步安排 QQ 出站预热，同一 loop/bot 至多保留一个在途任务。"""
    if not channel_id:
        return
    tasks = _loop_state(_qq_prewarm_tasks)
    current = tasks.get(channel_id)
    if current is not None and not current.done():
        return
    task = asyncio.create_task(_prewarm_qq_outbound(channel_id))
    tasks[channel_id] = task

    def _forget(done_task: asyncio.Task) -> None:
        if tasks.get(channel_id) is done_task:
            tasks.pop(channel_id, None)

    task.add_done_callback(_forget)

class QQStreamFinalizationError(RuntimeError):
    """已有可见正文的流未获关闭确认，不能作为成功交付处理。"""


class QQStreamDeliveryError(QQStreamFinalizationError):
    """流虽已关闭，但正文未完整交付；沿用流失败路径，不报告发送成功。"""


class QQAPIError(Exception):
    """QQ Bot API 返回非 2xx。status 是 HTTP 状态码，供上层判定瞬时/永久（P2-b §1/§6）；
    body 是原始响应体，只用于内部判定（如 markdown 权限被拒的错误码）和受限诊断出口，
    **绝不**直接拼进 str(exc)——上游响应体可能回显请求内容，不能原样进可见日志/外发文案（§5）。"""

    def __init__(self, method: str, path: str, status: int, body: Any):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        super().__init__(f"QQ API {method} {path} 失败 status={status}")

def _qq_error_summary(exc: BaseException) -> dict[str, object]:
    """提取 QQ 错误的结构化诊断字段，不把请求正文写进普通日志。"""
    if not isinstance(exc, QQAPIError):
        return {}
    body = exc.body
    if not isinstance(body, dict):
        return {"status": exc.status, "body_type": type(body).__name__}
    summary: dict[str, object] = {"status": exc.status}
    for key in ("code", "err_code", "message", "msg"):
        value = body.get(key)
        if isinstance(value, (str, int, float, bool)):
            summary[key] = value
    return summary

def _qq_is_transient(exc: BaseException) -> bool:
    """判定失败是否值得重试：真正瞬时的（超时/连接错/5xx/429）才重试；401 也算——
    换新 token 重发是既有的、安全的做法（旧 token 从未被 QQ 处理成功，重发不会重复），
    `_qq_request` 内部已对 401 做一次透明重试，这里放行是给外层（token 缓存已失效、
    换个全新请求）再兜一次。其余 4xx（参数错/内容被拒等）是永久错误，重试不会变成功，
    只会白白重复发送（§1/§6）。"""
    if isinstance(exc, (asyncio.TimeoutError, aiohttp.ClientConnectionError, aiohttp.ServerTimeoutError)):
        return True
    if isinstance(exc, QQAPIError):
        return exc.status >= 500 or exc.status in (401, 429)
    # 兼容非 QQAPIError 的 401 语义（如更底层就失败、还没走到 _qq_request 状态码分支）
    s = str(exc)
    return "status=401" in s or "code: 401" in s

async def _qq_request(channel_id: str, method: str, path: str, *,
                      json_body: dict | None = None, retry_on_401: bool = True):
    """raw HTTP 调 QQ Bot API；401 时清缓存重取 token 重试一次（幂等：读token+重发同一请求，
    未产生额外副作用，安全）。其余非 2xx 抛 QQAPIError，由调用方按 _qq_is_transient 判定是否重试。"""
    auth_started = time.perf_counter()
    from agent.runtime import trace
    trace_id = trace.get_trace()
    try:
        token, base = await _send_token(channel_id)
    except Exception as exc:
        _log.info(
            "[qq-http] trace=%s method=%s endpoint=%s result=auth_%s auth_ms=%.1f "
            "stream_state=%s stream_index=%s stream_id_sent=%s content_len=%s content_fp=%s",
            trace_id or "-", method, _qq_endpoint_kind(path), type(exc).__name__,
            (time.perf_counter() - auth_started) * 1000,
            *_stream_request_metadata(json_body),
        )
        raise
    auth_ms = (time.perf_counter() - auth_started) * 1000
    session = await _get_qq_http_session()
    request_trace = {"connection_reused": False}
    request_started = time.perf_counter()
    try:
        async with session.request(
            method, f"{base}{path}", json=json_body,
            headers={"Authorization": f"QQBot {token}", "Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=20),
            trace_request_ctx=request_trace,
        ) as resp:
            status = resp.status
            try:
                data = await resp.json(content_type=None)
            except Exception:
                # 响应体不是合法 JSON（QQ 偶尔回纯文本错误页）：退化取文本，不影响 status 判定，
                # 广吞合理——这里只是"尽量拿到点诊断信息"，拿不到也不影响后面的状态码分支。
                data = await resp.text()
    except Exception as exc:
        _loop_state(_qq_api_last_activity)[base] = time.monotonic()
        _log.info(
            "[qq-http] trace=%s method=%s endpoint=%s result=%s auth_ms=%.1f request_ms=%.1f "
            "dns_ms=%s connect_setup_ms=%s reused=%s stream_state=%s stream_index=%s "
            "stream_id_sent=%s content_len=%s content_fp=%s",
            trace_id or "-", method, _qq_endpoint_kind(path), type(exc).__name__, auth_ms,
            (time.perf_counter() - request_started) * 1000,
            f"{request_trace['dns_ms']:.1f}" if "dns_ms" in request_trace else "-",
            f"{request_trace['connect_ms']:.1f}" if "connect_ms" in request_trace else "-",
            request_trace["connection_reused"],
            *_stream_request_metadata(json_body),
        )
        raise
    request_ms = (time.perf_counter() - request_started) * 1000
    _loop_state(_qq_api_last_activity)[base] = time.monotonic()
    _log.info(
        "[qq-http] trace=%s method=%s endpoint=%s status=%s auth_ms=%.1f request_ms=%.1f "
        "dns_ms=%s connect_setup_ms=%s reused=%s stream_state=%s stream_index=%s "
        "stream_id_sent=%s content_len=%s content_fp=%s response_stream_id=%s response_code=%s",
        trace_id or "-", method, _qq_endpoint_kind(path), status, auth_ms, request_ms,
        f"{request_trace['dns_ms']:.1f}" if "dns_ms" in request_trace else "-",
        f"{request_trace['connect_ms']:.1f}" if "connect_ms" in request_trace else "-",
        request_trace["connection_reused"],
        *_stream_request_metadata(json_body),
        *_stream_response_metadata(data, json_body),
    )
    if status in (200, 201, 204):
        return data
    if status == 401 and retry_on_401:
        # 并发请求可能已经换好新 token；只清理本请求实际使用的旧 token。
        current = _send_tokens.get(channel_id)
        if current is not None and current.get("token") == token:
            _send_tokens.pop(channel_id, None)
        return await _qq_request(channel_id, method, path, json_body=json_body, retry_on_401=False)
    diag_log_raw("agent.gateway.qq._qq_request",
                  f"{method} {path} status={status} body={data}")
    raise QQAPIError(method, path, status, data)


def _stream_request_metadata(json_body: dict | None) -> tuple[object, ...]:
    """只提取流帧的无正文摘要；普通 QQ 请求使用短横线占位。"""
    from agent.security.logsafe import fingerprint

    if not isinstance(json_body, dict) or "input_state" not in json_body:
        return "-", "-", "-", "-", "-"
    content = json_body.get("content_raw")
    content = content if isinstance(content, str) else ""
    return (
        json_body.get("input_state", "-"),
        json_body.get("index", "-"),
        bool(json_body.get("stream_msg_id")),
        len(content),
        fingerprint(content),
    )


def _stream_response_metadata(data: Any, json_body: dict | None) -> tuple[object, object]:
    if not isinstance(json_body, dict) or "input_state" not in json_body:
        return "-", "-"
    if not isinstance(data, dict):
        return False, "-"
    code = data.get("code", data.get("err_code", "-"))
    if not isinstance(code, (int, str)) or not str(code).isdigit():
        code = "-"
    return bool(data.get("stream_msg_id") or data.get("id")), code
