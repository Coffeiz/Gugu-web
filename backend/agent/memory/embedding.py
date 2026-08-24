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

import math

from app.core.config import get_settings


BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
BAILIAN_MULTIMODAL_PATH = "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"


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
    e = get_settings().embedding
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
        headers = {"Authorization": f"Bearer {e.api_key}"} if e.api_key else {}
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
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
    """向量检索是否可用：enabled 且 model/base_url 配了。**api_key 可空**——自托管 Ollama
    等无需鉴权，强求 key 反而逼用户填假值。否则全链路退回词法。"""
    e = get_settings().embedding
    return bool(e.enabled and e.model and resolve_base_url(e.provider, e.base_url))


def model_tag() -> str:
    """当前 embedding 模型的版本戳，写进向量缓存用于换模型时的失配检测。"""
    e = get_settings().embedding
    return f"{e.provider or '?'}:{e.model}:{e.dimensions or 'default'}"


async def embed(text: str) -> list[float] | None:
    """把一段文本 embed 成向量。未启用/未配置/任何失败 → None（调用方据此退回词法，绝不抛）。"""
    if not is_enabled():
        return None
    text = (text or "").strip()
    if not text:
        return None
    e = get_settings().embedding
    base_url = resolve_base_url(e.provider, e.base_url)
    # 百炼的多模态模型不支持 OpenAI 兼容的 /embeddings 文本接口；文本内容
    # 仍可通过多模态 endpoint 的 text content 生成同一模型空间的向量。
    if e.multimodal and _is_bailian(e.provider, base_url):
        return await embed_multimodal([{"text": text}], enable_fusion=False)
    payload = build_payload(e.provider, base_url, e.model, text, e.dimensions)
    try:
        import httpx
        url = base_url + "/embeddings"
        # key 为空就不发 Authorization 头（Ollama 无需鉴权；空 key 拼 "Bearer " 是非法 header）
        headers = {"Authorization": f"Bearer {e.api_key}"} if e.api_key else {}
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as c:
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
