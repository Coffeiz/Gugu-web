"""向量 embedding 原语——一层**共享基建**，不只给 pattern 检索用（相处镜片的记忆引用、未来检索排序都会接）。

设计（见 docs/agent/参考/咕咕改进方案-MaiBot借鉴.md 改进一「落地」节）：
- **模型单独 pin、与聊天解耦**：读 `settings.embedding`（独立配置段），不走 pick_model 路由。
- **未配置/未启用 → `embed()` 返回 None**：所有消费方据此**退回词法相关性**（bigram），零副作用。
  这也是"模型待定、先搭框架"阶段的默认状态——地基就位，填一个模型即通。
- **走 OpenAI 兼容 `/embeddings`**：绝大多数厂商（dashscope/openai/minimax…）都提供这个接口。
- **规模**：per-user 几十~几百条 pattern，相似度纯 Python 暴力点积即可，**不需要向量数据库**。
- **换模型语义**：向量带 `model_tag()` 版本戳；换 embedding 模型 → 旧戳失配 = 需重建（pattern 存文本，向量是可重建缓存）。
"""
from __future__ import annotations

import hashlib
import ipaddress
import math
import socket
import time
from types import SimpleNamespace
from urllib.parse import urlparse

from app.core.config import get_settings
from app.core.credentials import normalize_ascii_api_key


def _effective() -> SimpleNamespace:
    """生效配置：用户 BYOK embedding 覆盖 > 平台 settings.embedding。

    覆盖由 app.byok.service.bind_user_embedding 在用户链路 run 开始时绑定；
    BYOK 配置在 resolve 阶段已保证完整（model/base_url 齐备），且视为启用——
    用户自己的 key 不产生平台成本，不受平台 enabled 开关限制。
    multimodal 是百炼专用平台能力，覆盖配置固定为 False（用户配置只走
    OpenAI 兼容 /embeddings 文本接口）。
    """
    e = get_settings().embedding
    try:
        from app.byok.service import effective_embedding_override
        ov = effective_embedding_override()
    except Exception:            # BYOK 模块不可用（如极简部署）时直接用平台配置
        return e
    if ov is None:
        return e
    return SimpleNamespace(
        enabled=True, multimodal=False,
        provider=ov["provider"], base_url=ov["base_url"], model=ov["model"],
        dimensions=ov["dimensions"], api_key=ov["api_key"],
    )


BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
BAILIAN_MULTIMODAL_PATH = "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
QUERY_EMBEDDING_TIMEOUT_SECONDS = 4.0
QUERY_EMBEDDING_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
QUERY_EMBEDDING_CACHE_TTL_SECONDS = 5 * 60
QUERY_EMBEDDING_CACHE_LIMIT = 64
_query_vector_cache: dict[str, tuple[float, list[float]]] = {}


def _is_bailian(provider: str, base_url: str) -> bool:
    """识别百炼及其 DashScope 兼容端点。"""
    provider = (provider or "").strip().lower()
    base_url = (base_url or "").lower()
    return provider in {"bailian", "dashscope", "aliyun"} or "aliyuncs.com" in base_url


def resolve_base_url(provider: str, base_url: str) -> str:
    """返回 embedding API 的 base URL，不包含 `/embeddings`。"""
    if base_url.strip():
        return base_url.strip().rstrip("/")
    if _is_bailian(provider, base_url):
        return BAILIAN_BASE_URL
    return ""


def build_payload(provider: str, base_url: str, model: str, text: str, dimensions: int) -> dict:
    """构造兼容请求体；百炼明确要求浮点向量格式。"""
    payload: dict = {"model": model, "input": text}
    if dimensions:
        payload["dimensions"] = dimensions
    if _is_bailian(provider, base_url):
        payload["encoding_format"] = "float"
    return payload


def _multimodal_url(base_url: str) -> str:
    """把百炼兼容 Base URL 转为多模态 Embedding 专用端点。"""
    base_url = base_url.rstrip("/")
    marker = "/compatible-mode/v1"
    if marker in base_url:
        base_url = base_url.split(marker, 1)[0]
    return base_url + BAILIAN_MULTIMODAL_PATH


async def embed_multimodal(contents: list[dict | str], *, enable_fusion: bool = True) -> list[float] | None:
    """调用百炼多模态 Embedding，返回融合后的单个向量。

    `contents` 的元素使用百炼格式，例如 `{"text": "..."}`、`{"image": "https://..."}`。
    多模态接口只接受公开 URL 或 Base64；文件归属、大小和 URL 安全校验由调用方负责。
    """
    if not contents or not is_enabled():
        return None
    e = get_settings().embedding   # 百炼多模态是平台专用能力，不走 BYOK 覆盖
    if not e.multimodal:
        return None
    base_url = resolve_base_url(e.provider, e.base_url)
    if not _is_bailian(e.provider, base_url):
        return None
    payload: dict = {
        "model": e.model,
        "input": {"contents": contents},
        "parameters": {"output_type": "dense"},
    }
    if e.dimensions:
        payload["parameters"]["dimension"] = e.dimensions
    if enable_fusion:
        payload["parameters"]["enable_fusion"] = True
    try:
        import httpx
        from app.core.retry import llm_provider_timeout
        headers = {"Authorization": f"Bearer {normalize_ascii_api_key(e.api_key, label='Embedding API Key')}"} if e.api_key else {}
        async with httpx.AsyncClient(timeout=llm_provider_timeout()) as client:
            response = await client.post(_multimodal_url(base_url), json=payload, headers=headers)
        if response.status_code != 200:
            print(f"[embedding] 多模态 HTTP {response.status_code}", flush=True)
            return None
        embeddings = response.json().get("output", {}).get("embeddings", [])
        if not embeddings:
            return None
        vector = embeddings[0].get("embedding")
        return vector if isinstance(vector, list) and vector else None
    except Exception as ex:
        print(f"[embedding] 多模态失败: {type(ex).__name__}", flush=True)
        return None


def is_enabled() -> bool:
    """向量检索是否可用：生效配置里 enabled 且 model/base_url 配了。**api_key 可空**——
    自托管 Ollama 等无需鉴权，强求 key 反而逼用户填假值。否则全链路退回词法。"""
    e = _effective()
    return bool(e.enabled and e.model and resolve_base_url(e.provider, e.base_url))


def query_settings() -> dict | None:
    """返回本轮 query embedding 的短生命周期配置，供 owner-bound RAG runtime 使用。

    Python 仍是凭据解密、BYOK 绑定和配置授权边界；实际 HTTP 请求由 RAG runtime facade 执行。
    调用方不得记录或持久化返回值；api_key 只保留在当前进程内存。
    文档/Memory 向量写入继续复用本模块的 ``embed`` 原语。
    """
    e = _effective()
    base_url = resolve_base_url(e.provider, e.base_url)
    if not (e.enabled and e.model and base_url):
        return None
    try:
        api_key = normalize_ascii_api_key(e.api_key, label="Embedding API Key")
    except ValueError:
        return None
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    from app.core.url_security import resolve_pinned_ip

    pinned_ip, _ = resolve_pinned_ip(base_url)
    if not pinned_ip and str(e.provider or "").strip().lower() in {"local", "ollama"}:
        # Local inference explicitly permits loopback/LAN endpoints; still resolve once and
        # pin the actual socket destination so the HTTP client does not resolve a second time.
        try:
            addresses = socket.getaddrinfo(
                parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
            resolved = [ipaddress.ip_address(item[4][0]) for item in addresses]
            resolved.sort(key=lambda address: 0 if address.version == 4 else 1)
            pinned_ip = str(resolved[0]) if resolved else None
        except (OSError, ValueError):
            pinned_ip = None
    if not pinned_ip:
        # 无法证明目的地安全时不把 API key 交给 worker，退化为词法检索。
        return None
    return {
        "provider": str(e.provider or ""),
        "base_url": base_url,
        "pinned_ip": pinned_ip,
        "model": str(e.model),
        "dimensions": int(e.dimensions or 0),
        "api_key": api_key,
        "multimodal": bool(e.multimodal),
    }


async def embed_query(text: str, *, settings: dict | None = None) -> dict:
    """安全地生成 RAG query 向量，返回受控结果，不暴露凭据或上游正文。

    默认配置解析、owner/BYOK 绑定和 DNS pin 沿用 ``query_settings``；调用方也可传入
    本轮已校验的配置快照，避免配置在准备与查询之间变化。HTTP 在 Python 侧执行，
    使 RAG 引擎无需接触网络细节。缓存键只保留 SHA-256，不保存明文 query。
    """
    normalized = str(text or "").strip()
    if not normalized:
        return {"vector": [], "outcome": "invalid_config"}
    resolved_settings = settings if settings is not None else query_settings()
    if resolved_settings is None:
        return {"vector": [], "outcome": "invalid_config"}
    request = _query_embedding_request(resolved_settings, normalized)
    if request is None:
        return {"vector": [], "outcome": "invalid_config"}
    try:
        key = hashlib.sha256((
            f"{resolved_settings['provider']}\n{resolved_settings['model']}\n"
            f"{resolved_settings['dimensions']}\n{normalized}"
        ).encode("utf-8")).hexdigest()
    except (KeyError, TypeError, ValueError):
        return {"vector": [], "outcome": "invalid_config"}
    now = time.monotonic()
    cached = _query_vector_cache.get(key)
    if cached is not None and now - cached[0] < QUERY_EMBEDDING_CACHE_TTL_SECONDS:
        return {"vector": list(cached[1]), "outcome": "success"}
    if cached is not None:
        _query_vector_cache.pop(key, None)

    url, payload, vector_path = request
    # TS http.request 不声明压缩编码；明确要求 identity，避免 HTTPX 默认协商
    # gzip 后改变与 TS 一致的 wire-byte 上限/JSON 解析语义。
    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "accept-encoding": "identity",
    }
    if resolved_settings["api_key"]:
        headers["authorization"] = f"Bearer {resolved_settings['api_key']}"
    import httpx
    from app.core.pinned_http import PinnedHTTPTransport
    try:
        async with httpx.AsyncClient(
            timeout=QUERY_EMBEDDING_TIMEOUT_SECONDS,
            follow_redirects=False,
            trust_env=False,
            transport=PinnedHTTPTransport(str(resolved_settings["pinned_ip"])),
        ) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                if 300 <= response.status_code < 400:
                    return {"vector": [], "outcome": "http_error", "http_status": response.status_code}
                if response.status_code != 200:
                    return {"vector": [], "outcome": "http_error", "http_status": response.status_code}
                body = bytearray()
                # TS worker 按原始 HTTP body 计数并 JSON.parse，不会透明解压；
                # 这里也读取 wire bytes，避免压缩响应改变大小上限或解析结果。
                async for chunk in response.aiter_raw():
                    body.extend(chunk)
                    if len(body) > QUERY_EMBEDDING_MAX_RESPONSE_BYTES:
                        return {"vector": [], "outcome": "response_too_large", "http_status": 200}
        import json
        try:
            parsed = json.loads(body)
        except (UnicodeDecodeError, ValueError):
            return {"vector": [], "outcome": "invalid_response", "http_status": 200}
        vector = _extract_query_vector(parsed, vector_path)
        if vector is None:
            return {"vector": [], "outcome": "invalid_response", "http_status": 200}
        if len(_query_vector_cache) >= QUERY_EMBEDDING_CACHE_LIMIT:
            oldest = min(_query_vector_cache, key=lambda item: _query_vector_cache[item][0])
            _query_vector_cache.pop(oldest, None)
        _query_vector_cache[key] = (time.monotonic(), vector)
        return {"vector": vector, "outcome": "success", "http_status": 200}
    except (httpx.TimeoutException, TimeoutError):
        return {"vector": [], "outcome": "timeout"}
    except Exception:
        return {"vector": [], "outcome": "network_error"}


def _query_embedding_request(settings: dict, text: str) -> tuple[str, dict, str] | None:
    """按 TS query-embedding worker 的规则生成请求，不携带任何额外字段。"""
    try:
        base_url_text = str(settings["base_url"]).strip()
        model = settings["model"]
        base_url = urlparse(base_url_text)
        if (base_url.scheme not in {"http", "https"} or not base_url.hostname
                or base_url.username or base_url.password or base_url.query or base_url.fragment
                or not isinstance(model, str) or not model.strip()
                or not ipaddress.ip_address(settings["pinned_ip"])
                or any(not 0x20 <= ord(char) <= 0x7E for char in settings["api_key"])):
            return None
        root = base_url_text.rstrip("/")
        if settings["multimodal"] and _is_bailian(settings["provider"], root):
            marker = "/compatible-mode/v1"
            if marker in root:
                root = root.split(marker, 1)[0]
            return (
                root + BAILIAN_MULTIMODAL_PATH,
                {"model": model, "input": {"contents": [{"text": text}]},
                 "parameters": {"output_type": "dense",
                                **({"dimension": settings["dimensions"]}
                                   if settings["dimensions"] > 0 else {}),
                                "enable_fusion": False}},
                "bailian",
            )
        payload: dict = {"model": model, "input": text}
        if settings["dimensions"] > 0:
            payload["dimensions"] = settings["dimensions"]
        if _is_bailian(settings["provider"], root):
            payload["encoding_format"] = "float"
        return root + "/embeddings", payload, "openai"
    except (KeyError, TypeError, ValueError):
        return None


def _extract_query_vector(body: object, vector_path: str) -> list[float] | None:
    if not isinstance(body, dict):
        return None
    if vector_path == "bailian":
        output = body.get("output")
        embeddings = output.get("embeddings") if isinstance(output, dict) else None
    else:
        embeddings = body.get("data")
    if not isinstance(embeddings, list) or not embeddings or not isinstance(embeddings[0], dict):
        return None
    raw = embeddings[0].get("embedding")
    if (not isinstance(raw, list) or not raw
            or any(not isinstance(value, (int, float)) or isinstance(value, bool)
                   or not math.isfinite(value) for value in raw)):
        return None
    return [float(value) for value in raw]


def model_tag() -> str:
    """生效 embedding 模型的版本戳，写进向量缓存用于换模型时的失配检测。

    用户 BYOK 生效时用用户的 provider/model/dimensions：切换凭据（含清空回平台）
    后 tag 失配，向量缓存按既有机制自动重建；解析结果与平台一致时 tag 相同，
    已有向量继续复用。
    """
    e = _effective()
    return f"{e.provider or '?'}:{e.model}:{e.dimensions or 'default'}"


async def embed(text: str) -> list[float] | None:
    """把一段文本 embed 成向量。未启用/未配置/任何失败 → None（调用方据此退回词法，绝不抛）。"""
    if not is_enabled():
        return None
    text = (text or "").strip()
    if not text:
        return None
    e = _effective()
    base_url = resolve_base_url(e.provider, e.base_url)
    # 百炼的多模态模型不支持 OpenAI 兼容的 /embeddings 文本接口；文本内容
    # 仍可通过多模态 endpoint 的 text content 生成同一模型空间的向量。
    if e.multimodal and _is_bailian(e.provider, base_url):
        return await embed_multimodal([{"text": text}], enable_fusion=False)
    payload = build_payload(e.provider, base_url, e.model, text, e.dimensions)
    try:
        import httpx
        from app.core.retry import llm_provider_timeout
        url = base_url + "/embeddings"
        # key 为空就不发 Authorization 头（Ollama 无需鉴权；空 key 拼 "Bearer " 是非法 header）
        headers = {"Authorization": f"Bearer {normalize_ascii_api_key(e.api_key, label='Embedding API Key')}"} if e.api_key else {}
        async with httpx.AsyncClient(timeout=llm_provider_timeout()) as c:
            r = await c.post(url, json=payload, headers=headers)
        if r.status_code != 200:
            print(f"[embedding] HTTP {r.status_code}", flush=True)
            return None
        vec = r.json()["data"][0]["embedding"]
        return vec if isinstance(vec, list) and vec else None
    except Exception as ex:
        print(f"[embedding] 失败: {type(ex).__name__}", flush=True)
        return None


def cosine(a: list[float], b: list[float]) -> float:
    """余弦相似度。维度不匹配（换过模型的脏数据）或零向量 → 0.0（视为不相关，安全退化）。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)
