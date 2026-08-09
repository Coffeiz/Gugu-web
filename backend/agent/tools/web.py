"""web 工具集：http_get —— 给 prompt skills 用的窄口联网取数（GET only）。

安全（防 SSRF 打内网）：
- 解析目标主机的 IP，**拒绝私网 / 环回 / 链路本地 / 多播 / 保留地址**（挡掉 192.168/10/127/169.254 等，
  保护同网段的 Redis/DB 与云元数据 169.254.169.254）；
- **不跟随重定向**（否则公网域可 302 跳内网绕过校验）；
- 响应体截断，避免塞爆上下文。
默认放行所有公网地址；要更严格可在 `_ALLOW_HOSTS` 填正向白名单。

按 Content-Type 分支处理，而不是无脑截断原始响应体：
- `text/html` → trafilatura 提取正文转 markdown（去导航/广告/JS 噪音，顺带带出内联链接方便接力读）；
  提取不出实质内容（返回 None 或过短）大概率是纯 JS 渲染页面，直接告知模型别硬解析、改走搜索；
- `application/pdf` → 复用 `app/core/doctext.py` 现成的 pdftotext 提取（同文件库/聊天附件读 PDF 一套逻辑）；
- 其它（JSON/纯文本等）→ 原样返回，截断防塞爆上下文。
"""
from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlparse

import httpcore
import httpx

from agent.tools.base import BaseSkill, Tool
from app.core.redaction import diag_log, redact
from app.core.url_security import resolve_pinned_ip

_log = logging.getLogger("agent.tools.web")

_MAX_BODY = 4000
_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024
_ALLOW_HOSTS: set[str] = set()   # 非空时只放行这些主机；空 = 放行所有公网
_MIN_EXTRACTED = 100    # trafilatura 提取结果短于此视为「没读到正文」（空页/错误页/纯 JS 渲染）

# P2-b §4-A 标杆模板：GET 天然幂等，瞬时故障（超时/连接错/5xx）安全重试；4xx（如 404/403，
# 服务端明确拒绝）不在白名单内，不重试、直接失败——doc §1 明确「外部依赖返回的 4xx = 可预期
# 或永久，不是可重试」。httpx 对 4xx/5xx 默认不抛异常（要 raise_for_status() 才抛），这里只有
# 网络层错误（超时/连接失败等）才会走到 except，天然已经排除了 4xx。
_HTTP_GET_RETRY_BACKOFF = [1, 2]
# httpx.NetworkError 覆盖 ConnectError 等连接层错误，httpx.TimeoutException 覆盖各类超时，
# RemoteProtocolError 覆盖「连接中途被对端断开/协议错乱」——都是「请求没跑完」的瞬时故障；
# 不含 HTTPStatusError（4xx/5xx 状态码），因为本函数默认不对状态码抛异常（见下方调用处）。
_TRANSIENT_HTTPX = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)


class _PinnedAsyncNetworkBackend(httpcore.AsyncNetworkBackend):
    """把 TCP 连接固定到已通过 URL 安全检查的 IP。

    httpcore 仍然收到原始 hostname，因此 HTTPS 的证书校验和 SNI 不变；只有
    socket 建连目标被替换为已校验的 IP，避免 DNS rebinding 在校验和连接之间生效。
    """

    def __init__(self, ip: str):
        from httpcore._backends.auto import AutoBackend

        self._ip = ip
        self._backend = AutoBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        return await self._backend.connect_tcp(
            self._ip,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        return await self._backend.connect_unix_socket(
            path, timeout=timeout, socket_options=socket_options
        )

    async def sleep(self, seconds):
        return await self._backend.sleep(seconds)


class _PinnedHTTPTransport(httpx.AsyncHTTPTransport):
    """httpx transport：保留 hostname 的 HTTP 语义，固定 socket 目的 IP。"""

    def __init__(self, ip: str):
        super().__init__(trust_env=False)
        previous = self._pool
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=previous._ssl_context,
            max_connections=previous._max_connections,
            max_keepalive_connections=previous._max_keepalive_connections,
            keepalive_expiry=previous._keepalive_expiry,
            http1=previous._http1,
            http2=previous._http2,
            retries=previous._retries,
            network_backend=_PinnedAsyncNetworkBackend(ip),
            socket_options=previous._socket_options,
        )


def _looks_like_html(text: str) -> bool:
    head = text.lstrip()[:100].lower()
    return head.startswith("<!doctype html") or head.startswith("<html")


async def _http_get(db, user_id, args: dict):
    url = (args.get("url") or "").strip()
    if not url:
        return {"error": "缺少 url"}
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return {"error": "非法 url"}
    if _ALLOW_HOSTS and p.hostname not in _ALLOW_HOSTS:
        return {"error": "该地址不允许访问（仅放行公网地址）"}
    pinned_ip, resolve_error = resolve_pinned_ip(url)
    if not pinned_ip:
        return {"error": resolve_error or "该地址不允许访问（仅放行公网地址）"}
    r = None
    for i in range(len(_HTTP_GET_RETRY_BACKOFF) + 1):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(15.0),
                follow_redirects=False,
                transport=_PinnedHTTPTransport(pinned_ip),
            ) as c:
                async with c.stream("GET", url, headers={"User-Agent": "curl/8"}) as response:
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        remaining = _MAX_DOWNLOAD_BYTES - total
                        if len(chunk) > remaining:
                            chunks.append(chunk[:remaining])
                            total = _MAX_DOWNLOAD_BYTES + 1
                            break
                        chunks.append(chunk)
                        total += len(chunk)
                    if total > _MAX_DOWNLOAD_BYTES:
                        return {"error": f"响应内容过大，已停止读取（上限 {_MAX_DOWNLOAD_BYTES // 1024 // 1024}MB）"}
                    r = (response.status_code, response.headers, b"".join(chunks), response.encoding)
            break
        except _TRANSIENT_HTTPX as e:
            if i >= len(_HTTP_GET_RETRY_BACKOFF):
                diag_log("agent.tools.web.http_get", e)   # 原始 → 受限诊断出口
                _log.warning("http_get 重试 %d 次后仍失败：%s", i, type(e).__name__)
                return {"error": f"请求失败：{type(e).__name__}（已重试仍超时/连接失败）"}
            await asyncio.sleep(_HTTP_GET_RETRY_BACKOFF[i])
        except Exception as e:
            # 非瞬时/未知错误（如 URL 解析异常等）：不重试，直接失败。类型名不含上游响应体，
            # 无需 redact（P2-b §5：不能拼进异常消息的是「上游原始响应体」，type(e).__name__
            # 是我们自己代码里的异常类型名，不是外部内容）。
            return {"error": f"请求失败：{type(e).__name__}"}

    status_code, headers, raw_body, encoding = r
    content_type = (headers.get("content-type") or "").split(";")[0].strip().lower()
    body_text = raw_body.decode(encoding or "utf-8", errors="replace")

    if content_type == "application/pdf":
        from app.core import doctext
        try:
            text = await doctext.extract_text(raw_body, "pdf")
        except Exception as e:
            # P2-b §5：不能把上游/内部异常原文直接拼进外发文案。原始进受限诊断出口，
            # 外发只给脱敏摘要（类型名 + redact 过的消息）。
            diag_log("agent.tools.web.http_get.pdf_extract", e)
            return {"error": redact(f"PDF 提取失败：{type(e).__name__}: {e}")}
        return {"status": status_code, "url": url, "content_type": content_type,
                "body": text[:_MAX_BODY], "truncated": len(text) > _MAX_BODY}

    if content_type in ("text/html", "application/xhtml+xml") or (not content_type and _looks_like_html(body_text)):
        import trafilatura
        extracted = trafilatura.extract(body_text, include_links=True, output_format="markdown", with_metadata=True)
        if not extracted or len(extracted) < _MIN_EXTRACTED:
            return {"status": status_code, "url": url,
                    "error": "抓到了但没读出正文——可能是空页/错误页，也可能是纯 JS 渲染页面（HTTP 抓不到"
                             "客户端渲染的内容）。先看 status 是否正常；status 正常但读不到正文的话，"
                             "换 web_search/deep_research 查这个主题，或换个来源"}
        return {"status": status_code, "url": url, "content_type": content_type,
                "body": extracted[:_MAX_BODY], "truncated": len(extracted) > _MAX_BODY}

    body = body_text
    return {
        "status": status_code,
        "url": url,
        "content_type": content_type,
        "body": body[:_MAX_BODY],
        "truncated": len(body) > _MAX_BODY,
    }


class WebSkill(BaseSkill):
    name = "web"
    tools = [
        Tool(
            name="http_get",
            label="联网取数 / 读网页",
            description="对指定 URL 发 GET 请求（仅公网、不跟随重定向）。网页（text/html）自动提取正文转 "
                        "markdown（去导航/广告/JS 噪音，带内联链接——想接着读某条链接就再调一次 http_get 传"
                        "那个 URL，不用重新搜）；PDF 自动提取文字；其它（JSON/纯文本等）原样返回，内容截断。"
                        "读不出正文（返回 error 提示可能是 JS 渲染页面）就换 web_search/deep_research。"
                        "也供天气等技能取实时数据用——通常由 use_skill 拉到的技能说明里指示你调用。",
            input_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "完整 URL，如 https://wttr.in/Beijing?format=3"},
                },
                "required": ["url"],
            },
            handler=_http_get,
        ),
    ]


WebSkill().register()
