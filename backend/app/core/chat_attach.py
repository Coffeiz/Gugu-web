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


async def resolve_for_message(user_id, attach_ids: list, base_message: str) -> tuple[str, list]:
    """把附件解析成：① 注入给模型的增广文本（文本读内容、图片/二进制给提示）
    ② 给前端气泡的附件卡片列表。失效/过期的 attach_id 跳过。"""
    if not attach_ids:
        return base_message, []
    parts = [base_message] if base_message else []
    cards = []
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
            parts.append(f"\n\n📎 用户上传了图片{tag}。当前模型看不到图像内容；"
                         f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
        else:
            parts.append(f"\n\n📎 用户上传了文件{tag}，二进制内容读不了；"
                         f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
    return "".join(parts), cards
