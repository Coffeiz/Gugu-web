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


def is_enabled() -> bool:
    """向量检索是否可用：enabled 且 model/base_url 配了。**api_key 可空**——自托管 Ollama
    等无需鉴权，强求 key 反而逼用户填假值。否则全链路退回词法。"""
    e = get_settings().embedding
    return bool(e.enabled and e.model and e.base_url)


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
    payload: dict = {"model": e.model, "input": text}
    if e.dimensions:
        payload["dimensions"] = e.dimensions
    try:
        import httpx
        url = e.base_url.rstrip("/") + "/embeddings"
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
