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
from mimetypes import guess_extension
from pathlib import PurePosixPath
from urllib.parse import unquote, urlparse

import httpcore
import httpx

from agent.tools.base import BaseSkill, Tool
from app.core.redaction import diag_log, redact
from app.core.url_security import resolve_pinned_ip
from app.services.files.browser import get_user_folder
from app.services.storage.file_service import FileService
from agent.tools.filesystem_policy import write_access_error

_log = logging.getLogger("agent.tools.web")

_MAX_BODY = 4000          # 默认返回字符数（模型可通过 max_chars 参数调整）
_MAX_BODY_HARD = 40000    # 硬上限：即使模型请求更多也不超过此值（~10k tokens，不撑爆上下文）
_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024
_MAX_FILE_DOWNLOAD_BYTES = 50 * 1024 * 1024
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


async def _http_get_one(db, user_id, url: str, max_chars: int):
    """执行一个 URL 请求；批量入口也必须复用这条安全和解析链路。"""
    url = (url or "").strip()
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
                "body": text[:max_chars], "truncated": len(text) > max_chars,
                "total_chars": len(text)}

    if content_type in ("text/html", "application/xhtml+xml") or (not content_type and _looks_like_html(body_text)):
        import trafilatura
        extracted = trafilatura.extract(body_text, include_links=True, output_format="markdown", with_metadata=True)
        if not extracted or len(extracted) < _MIN_EXTRACTED:
            return {"status": status_code, "url": url,
                    "error": "抓到了但没读出正文——可能是空页/错误页，也可能是纯 JS 渲染页面（HTTP 抓不到"
                             "客户端渲染的内容）。先看 status 是否正常；status 正常但读不到正文的话，"
                             "换 web_search/deep_research 查这个主题，或换个来源"}
        return {"status": status_code, "url": url, "content_type": content_type,
                "body": extracted[:max_chars], "truncated": len(extracted) > max_chars,
                "total_chars": len(extracted)}

    body = body_text
    return {
        "status": status_code,
        "url": url,
        "content_type": content_type,
        "body": body[:max_chars],
        "truncated": len(body) > max_chars,
        "total_chars": len(body),
    }


async def _http_get(db, user_id, args: dict):
    """兼容单 URL，并在同一工具调用内并行获取最多 5 个 URL。"""
    req_limit = args.get("max_chars")
    max_chars = _MAX_BODY
    if isinstance(req_limit, int) and req_limit > 0:
        max_chars = min(req_limit, _MAX_BODY_HARD)

    urls = args.get("urls")
    if urls is not None:
        if not isinstance(urls, list) or not urls:
            return {"error": "urls 必须是非空数组"}
        if len(urls) > 5:
            return {"error": "单次最多并行请求 5 个 URL"}
        if any(not isinstance(url, str) or not url.strip() for url in urls):
            return {"error": "urls 中每个元素都必须是非空字符串"}
        results = await asyncio.gather(*(
            _http_get_one(db, user_id, url, max_chars) for url in urls
        ), return_exceptions=True)
        normalized = []
        for result in results:
            if isinstance(result, Exception):
                normalized.append({"error": f"请求失败：{type(result).__name__}"})
            else:
                normalized.append(result)
        return {"results": normalized}

    url = args.get("url")
    if not isinstance(url, str) or not url.strip():
        return {"error": "缺少 url 或 urls"}
    return await _http_get_one(db, user_id, url, max_chars)


def _download_filename(value: str | None, url: str, content_type: str) -> tuple[str, str]:
    """把用户/URL 提供的文件名拆成 FileService 所需的 name + ext。"""
    raw = (value or "").strip()
    if not raw:
        raw = PurePosixPath(unquote(urlparse(url).path)).name
    raw = raw.replace("\\", "/").rstrip("/").split("/")[-1].strip()
    raw = "".join(ch for ch in raw if ch >= " " and ch not in '<>:"|?*')
    if not raw or raw in {".", ".."}:
        raw = "download"

    suffix = PurePosixPath(raw).suffix.lower().lstrip(".")
    if suffix and len(suffix) <= 20 and suffix.replace("-", "").replace("_", "").isalnum():
        return raw[: -len(suffix) - 1] or "download", suffix

    inferred = (guess_extension(content_type, strict=False) or ".bin").lstrip(".")
    return raw, inferred[:20] or "bin"


def _content_disposition_name(value: str | None) -> str | None:
    if not value:
        return None
    # 兼容常见的 filename / filename*=UTF-8'' 两种形式；只取文件名，不信任目录。
    import re
    match = re.search(r"filename\*\s*=\s*[^']*''([^;]+)|filename\s*=\s*\"?([^;\"]+)", value, re.I)
    if not match:
        return None
    return unquote((match.group(1) or match.group(2) or "").strip()) or None


async def _download_bytes(url: str) -> tuple[int, httpx.Headers, bytes] | dict:
    """安全下载文件正文；校验和 socket 连接固定在同一公网 IP。"""
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return {"error": "非法 url"}
    pinned_ip, resolve_error = resolve_pinned_ip(url)
    if not pinned_ip:
        return {"error": resolve_error or "该地址不允许访问"}

    for i in range(len(_HTTP_GET_RETRY_BACKOFF) + 1):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(30.0),
                follow_redirects=False,
                transport=_PinnedHTTPTransport(pinned_ip),
            ) as client:
                async with client.stream("GET", url, headers={"User-Agent": "Gugu-web/1.0"}) as response:
                    length = response.headers.get("content-length")
                    if length and length.isdigit() and int(length) > _MAX_FILE_DOWNLOAD_BYTES:
                        return {"error": f"文件过大，下载上限为 {_MAX_FILE_DOWNLOAD_BYTES // 1024 // 1024}MB"}
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > _MAX_FILE_DOWNLOAD_BYTES:
                            return {"error": f"文件过大，下载上限为 {_MAX_FILE_DOWNLOAD_BYTES // 1024 // 1024}MB"}
                        chunks.append(chunk)
                    return response.status_code, response.headers, b"".join(chunks)
        except _TRANSIENT_HTTPX as e:
            if i >= len(_HTTP_GET_RETRY_BACKOFF):
                diag_log("agent.tools.web.web_download", e)
                return {"error": "下载失败：网络超时或连接失败"}
            await asyncio.sleep(_HTTP_GET_RETRY_BACKOFF[i])
        except Exception as e:
            diag_log("agent.tools.web.web_download", e)
            return {"error": f"下载失败：{type(e).__name__}"}
    return {"error": "下载失败"}


async def _web_download(db, user_id, args: dict):
    """下载公网文件并保存到文件库；不把下载内容注入上下文。"""
    url = args.get("url")
    if not isinstance(url, str) or not url.strip():
        return {"error": "缺少 url"}

    space = args.get("space")
    project_id = args.get("project_id")
    folder_id = args.get("folder_id")
    try:
        project_id = int(project_id) if project_id not in (None, "") else None
        folder_id = int(folder_id) if folder_id not in (None, "") else None
    except (TypeError, ValueError):
        return {"error": "project_id 和 folder_id 必须是整数"}
    if space not in (None, "project", "mind", "asset", "personal"):
        return {"error": "space 必须是 project/mind/asset/personal 之一"}
    if space == "personal" and project_id is not None:
        return {"error": "space=personal 不能同时指定 project_id"}
    if project_id is not None:
        if space not in (None, "project"):
            return {"error": "project_id 只能用于 project 空间"}
        space = "project"
    if space == "project" and project_id is None:
        return {"error": "space=project 时必须指定 project_id"}

    if folder_id is not None:
        folder = await get_user_folder(db, user_id, folder_id)
        if not folder or folder.deleted_at is not None:
            return {"error": "目标文件夹不存在，或已被移入回收站"}
        inferred_project_id = folder.project_id
        inferred_space = "project" if inferred_project_id is not None else "personal"
        if project_id is not None and project_id != inferred_project_id:
            return {"error": "folder_id 不属于指定的 project_id"}
        if space is not None and space != inferred_space:
            return {"error": "folder_id 不属于指定的 space"}
        project_id = inferred_project_id
        space = inferred_space
    else:
        space = space or ("project" if project_id is not None else "personal")

    # 下载会落入文件库，必须在发起公网请求前复用文件工具的统一写权限策略。
    # 这样未授权的 personal/project 目标不会先下载再在持久化阶段才失败。
    access_error = await write_access_error(
        db, user_id, space=space, project_id=project_id, folder_id=folder_id,
    )
    if access_error:
        return {"error": access_error}

    normalized_url = url.strip()
    if not normalized_url.startswith(("http://", "https://")):
        normalized_url = "https://" + normalized_url
    downloaded = await _download_bytes(normalized_url)
    if isinstance(downloaded, dict):
        return downloaded
    status, headers, data = downloaded
    if status < 200 or status >= 300:
        return {"error": f"下载失败：远端返回 HTTP {status}"}
    content_type = (headers.get("content-type") or "application/octet-stream").split(";", 1)[0].strip().lower()
    name, ext = _download_filename(
        args.get("name") or _content_disposition_name(headers.get("content-disposition")),
        normalized_url,
        content_type,
    )
    try:
        result = await FileService(db).create_file(
            user_id,
            space=space,
            project_id=project_id if space == "project" else None,
            folder_id=folder_id,
            stage_name="",
            mind_map_id=None,
            display_name=name,
            ext=ext,
            mime_type=content_type,
            data=data,
            ledger_operation="web_download",
        )
        await db.commit()
    except Exception as e:
        await db.rollback()
        diag_log("agent.tools.web.web_download.persist", e)
        return {"error": "下载成功但保存到文件库失败，请稍后重试"}
    db_file = result.file
    return {
        "success": True,
        "file_id": db_file.id,
        "name": f"{db_file.display_name}.{db_file.ext}",
        "size": db_file.size,
        "size_bytes": db_file.size_bytes,
        "mime_type": db_file.mime_type,
        "space": db_file.space,
        "project_id": db_file.project_id,
        "folder_id": db_file.folder_id,
        "source_url": normalized_url,
    }


class WebSkill(BaseSkill):
    name = "web"
    tools = [
        Tool(
            name="http_get",
            label="联网取数 / 读网页",
            description_short='读取公网 URL 正文。',
            description="读取公网 URL；HTML/PDF 提取正文，可并行多个 URL，不跟随重定向。",
            input_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "urls": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1},
                        "minItems": 1,
                        "maxItems": 5,
                        "uniqueItems": True,
                    },
                    "max_chars": {"type": "integer"},
                },
                "anyOf": [
                    {"required": ["url"], "not": {"required": ["urls"]}},
                    {"required": ["urls"], "not": {"required": ["url"]}},
                ],
            },
            handler=_http_get,
        ),
        Tool(
            name="web_download",
            label="下载到文件库",
            description_short='下载公网文件到文件库；默认保存到个人文件库。',
            description="按用户提供的公网 URL 下载或导入文件；不用于读取网页或发送已有文件。",
            input_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "minLength": 1},
                    "name": {"type": ["string", "null"]},
                    "space": {"type": ["string", "null"], "enum": ["project", "mind", "asset", "personal", None]},
                    "project_id": {"type": ["integer", "null"]},
                    "folder_id": {"type": ["integer", "null"]},
                },
                "required": ["url"],
                "additionalProperties": False,
            },
            handler=_web_download,
            mutates=True,
        ),
    ]


WebSkill().register()
