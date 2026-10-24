"""图片处理：把原图压到适合模型输入的体积/尺寸，并封成内容块。

只作用于「喂给模型的副本」——存进文件库 / storage 的原图不受影响。
"""
from __future__ import annotations

from app.core.chat_attach.file_types import IMAGE_EXTS

from . import gates
from .constants import VISION_IMG_MAX, VISION_MAX_DIM, VISION_MIME, VISION_PASSTHROUGH, VISION_TARGET_BYTES


def fit_image(raw: bytes, ext: str, *, model_cfg=None):
    """把图调整到适合模型输入的体积/尺寸，返回 (bytes, media_type)；失败返回 None。

    - 共享默认策略：小图原样用，超限图片压缩副本
    - Provider 声明原图直传时：保留支持格式的原始字节和分辨率，只执行 Provider 官方单图字节校验
    （插画常见 >5MB，此前会被直接丢成「看不到」——本函数把它救回来）
    """
    media = VISION_MIME.get(ext, "image/jpeg")
    passthrough = ext in VISION_PASSTHROUGH   # 非原生格式（heic/bmp/tiff…）一律重编码成 JPEG
    limits = gates.media_limits_for(model_cfg)
    if limits.preserve_image_source:
        # MiniMax 原生支持格式按原始字节和分辨率直传；尺寸与格式限制只采用
        # Provider 明确公布的单图上限，不叠加通用缩放和压缩策略。
        if (ext not in limits.image_extensions or media not in limits.image_mimes
                or (limits.image_max_bytes is not None and len(raw) > limits.image_max_bytes)):
            return None
        return raw, media
    try:
        import io
        from PIL import Image
    except Exception:
        # Pillow 不可用：原生格式且体积合规就原样发，否则放弃
        return (raw, media) if (passthrough and len(raw) <= VISION_IMG_MAX) else None

    try:
        with Image.open(io.BytesIO(raw)) as im:
            if passthrough and len(raw) <= VISION_IMG_MAX and max(im.size) <= VISION_MAX_DIM:
                return raw, media   # 原生格式 + 已达标，原样用

            # 透明通道铺白底再转 RGB（JPEG 不支持 alpha）
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                im = Image.alpha_composite(bg, im).convert("RGB")
            elif im.mode != "RGB":
                im = im.convert("RGB")

            w, h = im.size
            scale = VISION_MAX_DIM / max(w, h)
            if scale < 1:
                im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))))

            buf = io.BytesIO()
            for q in (85, 75, 65, 55, 45):
                buf.seek(0); buf.truncate(0)
                im.save(buf, format="JPEG", quality=q, optimize=True)
                if buf.tell() <= VISION_TARGET_BYTES:
                    break
            return buf.getvalue(), "image/jpeg"
    except Exception:
        return None


def image_ready(model_cfg=None) -> bool:
    """当前实际运行模型已开启视觉能力。

    工具结果内部仍使用统一的 Anthropic 图片块；OpenAI 兼容驱动会在发送前
    转成 ``image_url``。后台探测/手动开关是显式能力声明，不能再被静态
    Provider 能力表反向否决。

    工具 handler 通常不会显式收到 model_cfg，因此默认优先读取本轮
    ``modelctx`` 绑定的实际模型；只有没有运行上下文时才回退到全局配置。
    不能直接只读 ``settings.ai``，否则用户 BYOK/pool 选中的视觉模型会被误判。
    """
    try:
        from app.core.config import get_settings
        s = get_settings()
        if model_cfg is None:
            from agent.llm import modelctx
            model_cfg = modelctx.get_model_cfg()
        ai = model_cfg or s.ai
        return gates.image_enabled(ai)
    except Exception:
        return False


def image_block(raw: bytes, ext: str, model_cfg=None):
    """把图压好封成 Anthropic image 内容块 {"type":"image",...}；不支持/失败返回 None。"""
    if (ext or "").lower() not in IMAGE_EXTS:
        return None
    fitted = fit_image(raw, (ext or "").lower(), model_cfg=model_cfg)
    if not fitted:
        return None
    import base64
    data, media = fitted
    return {"type": "image", "source": {
        "type": "base64", "media_type": media, "data": base64.b64encode(data).decode()}}


def strip_image_for_history(content):
    """持久化前把 tool_result 里的图片块换成占位文字。

    图片 base64 很大，若原样存进对话历史，会撑大 DB 且每轮都重新喂给模型（token 爆炸）。
    历史里留个占位即可——模型要再看会重新调 read_file。"""
    def _strip(value):
        if isinstance(value, list):
            return [_strip(item) for item in value]
        if isinstance(value, dict):
            value_type = value.get("type")
            if value_type in ("image", "video", "audio"):
                label = {"image": "图片", "video": "视频", "audio": "音频"}[value_type]
                return {"type": "text", "text": f"[{label}已查看]"}
            # OpenAI image_url 的 data URL 也不能落入历史；远程 URL 可以保留为引用。
            if value_type == "image_url":
                image_url = value.get("image_url")
                url = image_url.get("url") if isinstance(image_url, dict) else image_url
                if isinstance(url, str) and url.startswith("data:"):
                    return {"type": "text", "text": "[图片已查看]"}
            return {key: _strip(item) for key, item in value.items()}
        return value

    return _strip(content)
