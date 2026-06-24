"""聊天附件暂存：用户在对话里发给咕咕的文件**先暂存**（不进文件库）。

- 咕咕能「看」：文本类读内容注入上下文；图片给提示（看内容需 vision 模型）。
- 咕咕能「存」：用户说存时，`save_uploaded_file` 工具把暂存字节落成正式文件库记录。

字节走 StorageBackend（key 放 `.chat_staging/` 下），元数据走 Redis（TTL 6h，过期自动失效）。
"""
from __future__ import annotations

import json
import uuid

from app.core.redis import get_redis, get_redis_sync
from app.services.storage import get_storage

# 让 Pillow 能解码 iPhone 的 HEIC/HEIF（缺包则静默跳过，heic 退回不可读）
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

TTL = 6 * 3600          # 暂存 6 小时
_PREFIX = "chatfile:"
MAX_TEXT_INJECT = 32000  # 注入给模型的文本上限（字符）

# 能被咕咕「读内容」的文本类扩展名
TEXT_EXTS = {
    "md", "txt", "json", "csv", "yaml", "yml", "log", "py", "js", "ts", "tsx", "jsx",
    "vue", "html", "css", "scss", "java", "go", "rs", "c", "cpp", "h", "hpp", "sh",
    "sql", "xml", "toml", "ini", "conf", "env", "tex",
}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "tiff", "tif"}

# 能喂给 vision 模型的扩展名。png/jpeg/gif/webp 是 API 原生格式（达标即原样发）；
# heic/bmp/tiff 等先经 Pillow 转码成 JPEG 再发（见 _fit_image_for_vision）。svg 是矢量、Pillow 不解，仍走文字提示。
VISION_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"}
_VISION_PASSTHROUGH = {"png", "jpg", "jpeg", "gif", "webp"}   # API 原生收，达标免重编码
_VISION_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "webp": "image/webp"}
VISION_IMG_MAX = 5 * 1024 * 1024   # 单张图喂模型的字节上限（超了自动降采样压缩，不再直接丢）
VISION_IMG_COUNT = 6               # 单条消息最多带几张图
VISION_MAX_DIM = 2048              # 喂模型前长边降采样到此像素（插画/照片足够清晰，省 token）
VISION_TARGET_BYTES = int(4.5 * 1024 * 1024)  # 压缩目标字节（留 API 余量）


def _key(user_id, attach_id) -> str:
    return f"{_PREFIX}{user_id}:{attach_id}"


def _kind(ext: str) -> str:
    e = (ext or "").lower()
    if e in IMAGE_EXTS:
        return "image"
    if e in TEXT_EXTS:
        return "text"
    from app.core import doctext
    if e in doctext.EXTRACTABLE:   # PDF/docx/xlsx/pptx：能提取文本，按可读处理
        return "text"
    return "binary"


async def stage(user_id, name: str, ext: str, mime: str | None, data: bytes) -> dict:
    """暂存一个上传文件，返回元数据（含 attach_id）。"""
    attach_id = uuid.uuid4().hex[:16]
    ext_l = (ext or "").lower()[:10]
    storage_key = f"{user_id}/.chat_staging/{attach_id}.{ext_l or 'bin'}"
    await get_storage().put(storage_key, data, mime or "application/octet-stream")
    meta = {
        "attach_id": attach_id, "name": name, "ext": ext_l, "mime": mime or "",
        "size": len(data), "storage_key": storage_key, "kind": _kind(ext_l),
    }
    await get_redis().set(_key(user_id, attach_id), json.dumps(meta, ensure_ascii=False), ex=TTL)
    return meta


def stage_sync(user_id, name: str, ext: str, mime: str | None, data: bytes) -> dict:
    """同步暂存（给 IM 网关用）。

    网关 handler 跑在一个**已运行的 asyncio loop** 里（lark SDK），所以不能在当前线程
    new_event_loop().run_until_complete。改为把 async 的 storage.put 丢到**独立线程**用
    asyncio.run 跑（新线程无运行中的 loop，storage 后端不绑定 loop）；元数据用同步 redis
    （避免复用 async 客户端的跨 loop 问题）。
    """
    import asyncio
    import concurrent.futures
    import uuid as _uuid
    attach_id = _uuid.uuid4().hex[:16]
    ext_l = (ext or "").lower()[:10]
    storage_key = f"{user_id}/.chat_staging/{attach_id}.{ext_l or 'bin'}"

    def _put():
        asyncio.run(get_storage().put(storage_key, data, mime or "application/octet-stream"))

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        ex.submit(_put).result()

    meta = {
        "attach_id": attach_id, "name": name, "ext": ext_l, "mime": mime or "",
        "size": len(data), "storage_key": storage_key, "kind": _kind(ext_l),
    }
    get_redis_sync().set(_key(user_id, attach_id), json.dumps(meta, ensure_ascii=False), ex=TTL)
    return meta


async def get_meta(user_id, attach_id: str) -> dict | None:
    try:
        raw = await get_redis().get(_key(user_id, attach_id))
        return json.loads(raw) if raw else None
    except Exception:
        return None


async def list_staged(user_id) -> list[dict]:
    """该用户当前所有未过期的暂存附件 meta，按剩余 TTL 降序（越新越靠前）。"""
    r = get_redis()
    prefix = f"{_PREFIX}{user_id}:"
    out = []
    async for k in r.scan_iter(match=f"{prefix}*", count=200):
        ks = k if isinstance(k, str) else k.decode()
        try:
            raw = await r.get(ks)
            if not raw:
                continue
            meta = json.loads(raw)
            meta["_ttl"] = await r.ttl(ks)
            out.append(meta)
        except Exception:
            continue
    out.sort(key=lambda m: m.get("_ttl", 0), reverse=True)
    return out


async def resolve_attach(user_id, attach_id: str) -> tuple[dict | None, str]:
    """容错解析附件，返回 (meta|None, note)。
    LLM 抄 16 位 hex 的 attach_id 经常抄错/截断，别动不动报"过期"：
    精确命中 → 前缀/子串唯一命中 → 退到最近上传的一个。全空才算真过期。"""
    aid = (attach_id or "").strip()
    if aid:
        meta = await get_meta(user_id, aid)
        if meta:
            return meta, ""
    staged = await list_staged(user_id)
    if not staged:
        return None, ""
    if aid:
        hit = [m for m in staged if aid in m["attach_id"] or m["attach_id"] in aid]
        if len(hit) == 1:
            return hit[0], "（按最接近的附件匹配）"
    return staged[0], "（没对上 attach_id，用了你最近上传的那个附件）"


async def read_bytes(meta: dict) -> bytes:
    return await get_storage().get(meta["storage_key"])


async def read_text(meta: dict) -> str:
    """读文本内容（文本类直接 decode；PDF/Office 走 doctext 提取）。截断到 MAX_TEXT_INJECT。失败返回空串。"""
    try:
        from app.core import doctext
        raw = await read_bytes(meta)
        return (await doctext.extract_text(raw, meta.get("ext", "")))[:MAX_TEXT_INJECT]
    except Exception:
        return ""


def _vision_enabled() -> bool:
    """当前激活模型是否支持多模态（后台探测/手动设的 ai.vision）。"""
    try:
        from app.core.config import get_settings
        return bool(get_settings().ai.vision)
    except Exception:
        return False


def _fit_image_for_vision(raw: bytes, ext: str):
    """把图调整到适合喂 vision 模型的体积/尺寸，返回 (bytes, media_type)；失败返回 None。

    只作用于「喂给模型的副本」——存进文件库 / storage 的原图不受影响。
    - 体积 ≤ 上限且长边 ≤ VISION_MAX_DIM → 原样用（不重编码，保真省 CPU）
    - 超体积或超大尺寸 → 等比降采样到长边 VISION_MAX_DIM，再逐级降质重压成 JPEG 压到目标内
    （插画常见 >5MB，此前会被直接丢成「看不到」——本函数把它救回来）
    """
    media = _VISION_MIME.get(ext, "image/jpeg")
    passthrough = ext in _VISION_PASSTHROUGH   # 非原生格式（heic/bmp/tiff…）一律重编码成 JPEG
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


def vision_ready() -> bool:
    """vision 开 **且** 当前 provider 走 Anthropic 块格式——只有这样才能在 tool_result 里塞图片块
    （OpenAI 路工具结果只能是纯文本）。read_file 看图据此决定能否把库里的图喂给模型。"""
    try:
        from app.core.config import get_settings
        s = get_settings()
        anthropic = (s.ai.provider == "minimax") or ("anthropic" in (s.ai.base_url or "").lower())
        return bool(s.ai.vision) and anthropic
    except Exception:
        return False


VISION_READ_MAX = 30 * 1024 * 1024   # read_file 看图时从存储拉取的硬上限（压缩前），挡住超大文件


def vision_block(raw: bytes, ext: str):
    """把图压好封成 Anthropic image 内容块 {"type":"image",...}；不支持/失败返回 None。"""
    if (ext or "").lower() not in VISION_EXTS:
        return None
    fitted = _fit_image_for_vision(raw, (ext or "").lower())
    if not fitted:
        return None
    import base64
    data, media = fitted
    return {"type": "image", "source": {
        "type": "base64", "media_type": media, "data": base64.b64encode(data).decode()}}


def strip_vision_for_history(content):
    """持久化前把 tool_result 里的图片块换成占位文字。

    图片 base64 很大，若原样存进对话历史，会撑大 DB 且每轮都重新喂给模型（token 爆炸）。
    历史里留个占位即可——模型要再看会重新调 read_file。"""
    if not isinstance(content, list):
        return content
    out = []
    for blk in content:
        if isinstance(blk, dict) and blk.get("type") == "image":
            out.append({"type": "text", "text": "[图片已查看]"})
        else:
            out.append(blk)
    return out


async def resolve_for_message(user_id, attach_ids: list, base_message: str) -> tuple[str, list, list]:
    """把附件解析成：① 注入给模型的增广文本（文本读内容、图片/二进制给提示）
    ② 给前端气泡的附件卡片列表 ③ 图片块列表（仅 vision 模型，喂给模型「看」）。
    失效/过期的 attach_id 跳过。"""
    if not attach_ids:
        return base_message, [], []
    vision = _vision_enabled()
    parts = [base_message] if base_message else []
    cards = []
    images: list = []   # [{media_type, b64}]，仅 vision 时填
    for aid in attach_ids:
        meta = await get_meta(user_id, aid)
        if not meta:
            continue
        cards.append({
            "attach_id": meta["attach_id"], "name": meta["name"], "ext": meta["ext"],
            "size_bytes": meta["size"], "kind": meta["kind"], "upload": True,
        })
        fname = f"{meta['name']}.{meta['ext']}" if meta["ext"] else meta["name"]
        tag = f"《{fname}》(attach_id={meta['attach_id']})"
        if meta["kind"] == "text":
            parts.append(f"\n\n📎 用户上传的文件{tag}，内容如下：\n```\n{await read_text(meta)}\n```")
        elif meta["kind"] == "image":
            ext = (meta.get("ext") or "").lower()
            # vision 模型 + 受支持格式 + 没超张数 → 喂给模型真看（超体积/超大尺寸自动压缩）
            if vision and ext in VISION_EXTS and len(images) < VISION_IMG_COUNT:
                try:
                    import base64
                    raw = await read_bytes(meta)
                    fitted = _fit_image_for_vision(raw, ext)
                    if fitted:
                        data, media = fitted
                        images.append({"media_type": media,
                                       "b64": base64.b64encode(data).decode()})
                        parts.append(f"\n\n📎 用户上传了图片{tag}（见随附图像）；"
                                     f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
                        continue
                except Exception:
                    pass   # 读图/压缩失败 → 退回文字提示
            why = "当前模型看不到图像内容" if not vision else "这张图没法直接看（格式不支持）"
            parts.append(f"\n\n📎 用户上传了图片{tag}。{why}；"
                         f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
        else:
            parts.append(f"\n\n📎 用户上传了文件{tag}，二进制内容读不了；"
                         f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
    return "".join(parts), cards, images


def build_user_content(text: str, images: list, use_anthropic: bool):
    """把增广文本 + 图片块拼成发给模型的 user content。
    无图 → 纯字符串（与旧行为一致）；有图 → 内容块列表（按 provider 格式）。"""
    if not images:
        return text
    if use_anthropic:
        parts = [{"type": "text", "text": text}] if text else []
        for im in images:
            parts.append({"type": "image", "source": {
                "type": "base64", "media_type": im["media_type"], "data": im["b64"]}})
        return parts
    parts = [{"type": "text", "text": text}] if text else []
    for im in images:
        parts.append({"type": "image_url", "image_url": {
            "url": f"data:{im['media_type']};base64,{im['b64']}"}})
    return parts
