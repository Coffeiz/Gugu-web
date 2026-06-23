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

TTL = 6 * 3600          # 暂存 6 小时
_PREFIX = "chatfile:"
MAX_TEXT_INJECT = 32000  # 注入给模型的文本上限（字符）

# 能被咕咕「读内容」的文本类扩展名
TEXT_EXTS = {
    "md", "txt", "json", "csv", "yaml", "yml", "log", "py", "js", "ts", "tsx", "jsx",
    "vue", "html", "css", "scss", "java", "go", "rs", "c", "cpp", "h", "hpp", "sh",
    "sql", "xml", "toml", "ini", "conf", "env", "tex",
}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"}

# 能作为「图片块」喂给 vision 模型的扩展名（主流 vision API 都收 png/jpeg/gif/webp；
# bmp/svg 不通用，仍走文字提示）。每张原图上限、单条消息最多张数——挡住超大图把上下文撑爆。
VISION_EXTS = {"png", "jpg", "jpeg", "gif", "webp"}
_VISION_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "webp": "image/webp"}
VISION_IMG_MAX = 5 * 1024 * 1024   # 单张原图字节上限
VISION_IMG_COUNT = 6               # 单条消息最多带几张图


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
            # vision 模型 + 受支持格式 + 体积合规 + 没超张数 → 作为图片块让模型真看
            if (vision and ext in VISION_EXTS and meta["size"] <= VISION_IMG_MAX
                    and len(images) < VISION_IMG_COUNT):
                try:
                    import base64
                    raw = await read_bytes(meta)
                    images.append({"media_type": _VISION_MIME.get(ext, "image/png"),
                                   "b64": base64.b64encode(raw).decode()})
                    parts.append(f"\n\n📎 用户上传了图片{tag}（见随附图像）；"
                                 f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
                    continue
                except Exception:
                    pass   # 读图失败 → 退回文字提示
            why = "当前模型看不到图像内容" if not vision else "这张图没法直接看（格式/体积不支持）"
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
