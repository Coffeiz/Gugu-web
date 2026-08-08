"""聊天附件暂存：用户在对话里发给咕咕的文件**先暂存**（不进文件库）。

- 咕咕能「看」：文本类读内容注入上下文；图片给提示（看内容需 vision 模型）。
- 咕咕能「存」：用户说存时，`save_uploaded_file` 工具把暂存字节落成正式文件库记录。

字节走 StorageBackend（key 放 `.chat_staging/` 下），元数据走 Redis（TTL 7天，过期自动失效）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid

from app.core.redis import get_redis, get_redis_sync
from app.services.storage import get_storage

# 视频转码并发上限：ffmpeg CPU/内存密集，避免多人同时上传视频打满机器
VIDEO_TRANSCODE_SEMAPHORE = asyncio.Semaphore(2)

# 让 Pillow 能解码 iPhone 的 HEIC/HEIF（缺包则静默跳过，heic 退回不可读）
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

TTL = 7 * 24 * 3600     # 普通附件暂存 7 天
TTL_VOICE = 7 * 24 * 3600    # 语音条暂存 7 天（与普通附件统一）
_PREFIX = "chatfile:"
_QQ_FACE_CACHE_PREFIX = "chatface:v2:"
MAX_TEXT_INJECT = 32000  # 注入给模型的文本上限（字符）

# 能被咕咕「读内容」的文本类扩展名
TEXT_EXTS = {
    "md", "txt", "json", "csv", "yaml", "yml", "log", "py", "js", "ts", "tsx", "jsx",
    "vue", "html", "css", "scss", "java", "go", "rs", "c", "cpp", "h", "hpp", "sh",
    "sql", "xml", "toml", "ini", "conf", "env", "tex",
}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "tiff", "tif"}
# 音 / 视频理解：MiMo 使用 OpenAI 扩展块，MiniMax M3 使用 Anthropic 原生 video 块。
AUDIO_EXTS = {"mp3", "wav", "flac", "m4a", "ogg"}              # mimo 原生收，免转
VIDEO_EXTS = {"mp4", "mov", "avi", "wmv", "mkv"}
# 非 mimo 原生的音频（IM 语音 / 浏览器录音常见）：算「音频」但要先转 mp3 才能喂 mimo（需服务器装 ffmpeg）
TRANSCODE_AUDIO_EXTS = {"amr", "silk", "sil", "slk", "opus", "aac", "wma", "webm", "3gp", "3gpp"}
MEDIA_RAW_MAX = 36 * 1024 * 1024   # 原始字节上限：base64 后约 <50MB（mimo base64 限制）
_MEDIA_MIME = {
    "mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "m4a": "audio/mp4", "ogg": "audio/ogg",
    "mp4": "video/mp4", "mov": "video/quicktime", "avi": "video/x-msvideo", "wmv": "video/x-ms-wmv",
    "mkv": "video/x-matroska",
}

# ── 视频压缩 / mm_file 传输（MiniMax M3 大视频）──────────────────────────────
# 三个不同的"上限"概念，容易混：
#   ① 源视频处理上限（VIDEO_SOURCE_MAX/VIDEO_DURATION_MAX_SECONDS）：服务器愿不愿意
#      尝试处理——超过直接拒绝，连 ffprobe/转码都不跑，避免对明显超出产品范围的
#      视频（几 GB、10 分钟）做无意义的昂贵转码。
#   ② 自动转码触发条件（VIDEO_MMFILE_MAX/VIDEO_COMPRESS_TRIGGER_BITRATE/
#      VIDEO_COMPRESS_MAX_DIM 任一超出）：原始文件 >90MB 时**不能直接拒绝**，
#      因为压缩可能把体积压下来——90MB 在这里的含义是"最终交给模型的 payload
#      上限"，不是"源文件上限"，两者是两回事。
#   ③ 最终 payload 大小规则（VIDEO_BASE64_MAX/VIDEO_MMFILE_MAX）：转码（或未触发
#      转码时的原始字节）之后，≤45MB base64、(45MB,90MB] mm_file、>90MB 才真正拒绝。
# 实测边界：base64 硬限制 = 原始 ≤50MB（52,428,800 字节）；mm_file 约 100MB
# （98MB 稳成、99MB 稳败）。45MB 对 base64 留 5MB 余量；mm_file 上限取 90MB
# 留安全余量避开 100MB 附近非确定性。
VIDEO_SOURCE_MAX = 500 * 1024 * 1024        # ① 源文件处理上限：超过直接拒绝，不转码
VIDEO_DURATION_MAX_SECONDS = 120            # ① 源视频时长上限：超过直接拒绝，不转码
VIDEO_COMPRESS_MAX_DIM = 1920          # 压缩目标长边（1080p）——只降不升，见 _compress_video
VIDEO_COMPRESS_BITRATE = "5M"          # 压缩目标码率
VIDEO_COMPRESS_TRIGGER_BITRATE = 16 * 1024 * 1024   # ② 触发转码的码率阈值（16Mbps）
VIDEO_BASE64_MAX = 45 * 1024 * 1024    # ③ 走 base64 的最终 payload 上限（留 5MB 余量）
VIDEO_MMFILE_MAX = 90 * 1024 * 1024    # ②③ 触发转码的源文件大小阈值，同时也是③走 mm_file 的最终 payload 上限（留安全余量）
VIDEO_MMFILE_PURPOSE = "video_understanding"   # Files API 上传 purpose

# 能喂给 vision 模型的扩展名。png/jpeg/gif/webp 是 API 原生格式（达标即原样发）；
# heic/bmp/tiff 等先经 Pillow 转码成 JPEG 再发（见 _fit_image_for_vision）。svg 是矢量、Pillow 不解，仍走文字提示。
VISION_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"}
_VISION_PASSTHROUGH = {"png", "jpg", "jpeg", "gif", "webp"}   # API 原生收，达标免重编码
_VISION_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "webp": "image/webp"}
VISION_IMG_MAX = 5 * 1024 * 1024   # 单张图喂模型的字节上限（超了自动降采样压缩，不再直接丢）
VISION_IMG_COUNT = 6               # 单条消息最多带几张图
VISION_MAX_DIM = 3840              # 喂模型前长边降采样到此像素，保留高分辨率细节
VISION_TARGET_BYTES = 8 * 1024 * 1024  # 压缩目标字节（留 API 余量）


def _key(user_id, attach_id) -> str:
    return f"{_PREFIX}{user_id}:{attach_id}"


def _qq_face_cache_key(user_id, face_type: str, face_id: str) -> str:
    token = hashlib.sha256(f"{face_type}:{face_id}".encode("utf-8")).hexdigest()
    return f"{_QQ_FACE_CACHE_PREFIX}{user_id}:{token}"


async def get_qq_face_cached(user_id, face_type: str, face_id: str) -> dict | None:
    """返回仍有效的 QQ 表情暂存元数据，避免同一表情重复下载。"""
    if not str(face_id or "").strip():
        return None
    attach_id = await get_redis().get(_qq_face_cache_key(user_id, str(face_type), str(face_id)))
    if not attach_id:
        return None
    return await get_meta(user_id, attach_id.decode() if isinstance(attach_id, bytes) else str(attach_id))


async def set_qq_face_cached(user_id, face_type: str, face_id: str, attach_id: str) -> None:
    if str(face_id or "").strip() and attach_id:
        await get_redis().set(
            _qq_face_cache_key(user_id, str(face_type), str(face_id)),
            attach_id,
            ex=TTL,
        )


def _kind(ext: str) -> str:
    e = (ext or "").lower()
    if e in IMAGE_EXTS:
        return "image"
    if e in AUDIO_EXTS or e in TRANSCODE_AUDIO_EXTS:
        return "audio"
    if e in VIDEO_EXTS:
        return "video"
    if e in TEXT_EXTS:
        return "text"
    from app.core import doctext
    if e in doctext.EXTRACTABLE:   # PDF/docx/xlsx/pptx：能提取文本，按可读处理
        return "text"
    return "binary"


def _model_attachment_name(meta: dict) -> str:
    """给模型看的附件名：隐藏平台生成的长随机文件名，保留用户自定义文件名。"""
    if meta.get("qq_face"):
        return "QQ表情"
    name = str(meta.get("name") or "附件")
    if re.fullmatch(r"[0-9a-fA-F]{24,}", name):
        return {
            "image": "图片",
            "audio": "音频",
            "video": "视频",
            "voice": "语音",
            "text": "文本文件",
        }.get(meta.get("kind"), "文件")
    ext = str(meta.get("ext") or "").lower()
    return f"{name}.{ext}" if ext else name


def _probe_image_size(data: bytes, ext: str) -> tuple[int | None, int | None]:
    """探真实像素尺寸（与 files.py 上传时同一套逻辑）：SVG 是矢量、Pillow 读不出「像素」尺寸，跳过；
    失败也别报错——没探到就是 None，前端退回旧的占位图估算兜底。"""
    if (ext or "").lower() == "svg":
        return None, None
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(data))
        w, h = img.size
        img.close()
        return w, h
    except Exception:
        return None, None


def _current_platform(explicit: str | None) -> str | None:
    """暂存项打上「来自哪个渠道」标签：网关（qq/feishu/wechat）在收到消息、队列还没派发给
    worker 前就调用 stage，此时 imctx 还没 set，必须显式传 platform；其余在 agent 工具/请求
    处理过程中调用的（如生图/网络图暂存），走 imctx 自动识别当前所在的 IM 对话（web 路径不
    set imctx，识别不到即 None，等同网页上传）。用途：resolve_attach 按渠道收窄候选，避免
    「同一用户在别的渠道/网页留下的旧附件」被这边的模糊匹配误取（见 resolve_attach 文档字符串）。"""
    if explicit:
        return explicit
    try:
        from agent import imctx
        ctx = imctx.get_im()
        return ctx.get("platform") if ctx else None
    except Exception:
        return None


async def stage(user_id, name: str, ext: str, mime: str | None, data: bytes,
                *, kind: str | None = None, ttl: int = TTL,
                subdir: str = ".chat_staging", extra: dict | None = None,
                platform: str | None = None) -> dict:
    """暂存一个上传文件，返回元数据（含 attach_id）。
    语音条走 kind='voice' / ttl=TTL_VOICE / subdir='.voice'（见 stage_voice）。
    图片顺带探真实像素尺寸（img_width/img_height）：前端预览窗口据此直接定尺，不用再靠缩略图猜。
    `platform`：附件来自哪个渠道（qq/feishu/wechat/web），不传则按 imctx 自动识别，见 _current_platform。"""
    attach_id = uuid.uuid4().hex[:16]
    ext_l = (ext or "").lower()[:10]
    storage_key = f"{user_id}/{subdir}/{attach_id}.{ext_l or 'bin'}"
    await get_storage().put(storage_key, data, mime or "application/octet-stream")
    meta = {
        "attach_id": attach_id, "name": name, "ext": ext_l, "mime": mime or "",
        "size": len(data), "storage_key": storage_key, "kind": kind or _kind(ext_l),
        "platform": _current_platform(platform),
    }
    if meta["kind"] == "image":
        img_w, img_h = _probe_image_size(data, ext_l)
        meta["img_width"], meta["img_height"] = img_w, img_h
    if extra:
        meta.update(extra)
    await get_redis().set(_key(user_id, attach_id), json.dumps(meta, ensure_ascii=False), ex=ttl)
    return meta


async def stage_voice(user_id, name: str, ext: str, mime: str | None, data: bytes,
                      duration: float | None = None, platform: str | None = None) -> dict:
    """语音消息（IM 语音 / 网页录音）：独立 .voice/ 存储 + 30 天留存 + kind='voice' + 时长。"""
    return await stage(user_id, name, ext, mime, data, kind="voice", ttl=TTL_VOICE,
                       subdir=".voice", extra={"duration": duration} if duration is not None else None,
                       platform=platform)


def stage_voice_sync(user_id, name: str, ext: str, mime: str | None, data: bytes,
                     duration: float | None = None, platform: str | None = None) -> dict:
    return stage_sync(user_id, name, ext, mime, data, kind="voice", ttl=TTL_VOICE,
                      subdir=".voice", extra={"duration": duration} if duration is not None else None,
                      platform=platform)


def stage_sync(user_id, name: str, ext: str, mime: str | None, data: bytes,
               *, kind: str | None = None, ttl: int = TTL,
               subdir: str = ".chat_staging", extra: dict | None = None,
               platform: str | None = None) -> dict:
    """同步暂存（给 IM 网关用）。

    网关 handler 跑在一个**已运行的 asyncio loop** 里（lark SDK），所以不能在当前线程
    new_event_loop().run_until_complete。改为把 async 的 storage.put 丢到**独立线程**用
    asyncio.run 跑（新线程无运行中的 loop，storage 后端不绑定 loop）；元数据用同步 redis
    （避免复用 async 客户端的跨 loop 问题）。
    `platform`：附件来自哪个渠道，网关调用时必须显式传（此时 imctx 还没 set，见 _current_platform）。
    """
    import asyncio
    import concurrent.futures
    import uuid as _uuid
    attach_id = _uuid.uuid4().hex[:16]
    ext_l = (ext or "").lower()[:10]
    storage_key = f"{user_id}/{subdir}/{attach_id}.{ext_l or 'bin'}"

    def _put():
        asyncio.run(get_storage().put(storage_key, data, mime or "application/octet-stream"))

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        ex.submit(_put).result()

    meta = {
        "attach_id": attach_id, "name": name, "ext": ext_l, "mime": mime or "",
        "size": len(data), "storage_key": storage_key, "kind": kind or _kind(ext_l),
        "platform": _current_platform(platform),
    }
    if meta["kind"] == "image":
        img_w, img_h = _probe_image_size(data, ext_l)
        meta["img_width"], meta["img_height"] = img_w, img_h
    if extra:
        meta.update(extra)
    get_redis_sync().set(_key(user_id, attach_id), json.dumps(meta, ensure_ascii=False), ex=ttl)
    return meta


async def get_meta(user_id, attach_id: str) -> dict | None:
    try:
        raw = await get_redis().get(_key(user_id, attach_id))
        return json.loads(raw) if raw else None
    except Exception:
        return None


async def get_meta_many(user_id, attach_ids: list[str]) -> dict[str, dict]:
    """一次读取多个暂存附件的元数据，返回 attach_id 到 meta 的映射。"""
    if not user_id or not attach_ids:
        return {}
    unique_ids = list(dict.fromkeys(str(attach_id) for attach_id in attach_ids if attach_id))
    if not unique_ids:
        return {}
    try:
        raw_items = await get_redis().mget([_key(user_id, attach_id) for attach_id in unique_ids])
        result = {}
        for attach_id, raw in zip(unique_ids, raw_items):
            if not raw:
                continue
            if isinstance(raw, bytes):
                raw = raw.decode()
            result[attach_id] = json.loads(raw)
        return result
    except Exception:
        return {}


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


async def clear_staged(user_id) -> int:
    """删除该用户所有未过期的暂存附件（字节 + Redis 元数据），返回删除数量。"""
    from app.services.storage import get_storage
    r = get_redis()
    storage = get_storage()
    prefix = f"{_PREFIX}{user_id}:"
    keys, deleted = [], 0
    async for k in r.scan_iter(match=f"{prefix}*", count=200):
        keys.append(k if isinstance(k, str) else k.decode())
    for k in keys:
        try:
            raw = await r.get(k)
            if raw:
                meta = json.loads(raw)
                try:
                    await storage.delete(meta["storage_key"])
                except Exception:
                    pass
            await r.delete(k)
            deleted += 1
        except Exception:
            pass
    return deleted


async def resolve_attach(user_id, attach_id: str) -> tuple[dict | None, str]:
    """容错解析附件，返回 (meta|None, note)。
    LLM 抄 16 位 hex 的 attach_id 经常抄错/截断，别动不动报"过期"：
    精确命中 → 前缀/子串唯一命中 → 无歧义时退到最近上传的一个。全空才算真过期。

    暂存池按 user_id 全局共享（不分渠道），同一用户可能同时绑定 QQ/飞书/微信/网页——先按「当前
    所在渠道」（imctx，见 _current_platform）收窄候选，避免把另一个渠道、甚至更早不相关对话里
    还没保存的旧附件当成这次要存的（同渠道内互相干扰的可能性也不小，但至少不会跨渠道串）。

    「无歧义」= 收窄后只剩一个附件，或类型全一致（如连发的都是图片）——这两种情况瞎猜大概率对。
    类型不一（比如同时有图片和语音）时**不再盲目取「最新」那个**：曾有真实事故——QQ 连发 4 张图
    后跟了句语音，指令那轮因防抖拆轮没带上图片 attach_id，工具退到「最近暂存」时抓到了更晚落地
    的语音、把语音当图片存进了文件库。改为返回歧义候选列表，让调用方/模型明确指定。"""
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

    pool = staged
    cur_platform = _current_platform(None)
    if cur_platform:
        same_ch = [m for m in staged if m.get("platform") == cur_platform]
        if same_ch:   # 同渠道有候选才收窄；没有则说明这渠道确实没暂存过（如刚绑定），退回全池
            pool = same_ch

    kinds = {m.get("kind") for m in pool}
    if len(pool) == 1 or len(kinds) == 1:
        return pool[0], "（没对上 attach_id，用了你最近上传的那个附件）"
    cands = "、".join(f"{_model_attachment_name(m)}（{m['kind']}，attach_id={m['attach_id']}）" for m in pool[:8])
    return None, f"当前暂存了多个不同类型的附件，无法安全猜测该存哪个，请明确指定 attach_id。候选：{cands}"


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


def _video_enabled(model_cfg=None) -> bool:
    """视频理解是否开启：主模型 vision_video 开，且走 OpenAI 兼容媒体块（mimo / 百炼 qwen 等）。
    MiniMax M3 走 Anthropic 原生 video 块，单独由 _minimax_video_enabled 判定。"""
    try:
        from agent.llm_select import use_anthropic_for
        if model_cfg is not None:
            if not getattr(model_cfg, "vision_video", False):
                return False
            return (not use_anthropic_for(model_cfg)) or _minimax_video_enabled(model_cfg)
        from app.core.config import get_settings
        ai = get_settings().ai
        if not getattr(ai, "vision_video", False):
            return False
        return (not use_anthropic_for(ai)) or _minimax_video_enabled(ai)
    except Exception:
        return False


def _audio_enabled(model_cfg=None) -> bool:
    """音频理解是否开启：主模型 vision_audio 开，且走 OpenAI 兼容 input_audio 块。
    独立语音识别模型（ASR 转写）由 _voice_recognition_enabled 单独判定，两者解耦。"""
    try:
        if model_cfg is not None:
            from agent.llm_select import use_anthropic_for
            if not getattr(model_cfg, "vision_audio", False):
                return False
            return not use_anthropic_for(model_cfg)
        from app.core.config import get_settings
        from agent.llm_select import use_anthropic_for
        ai = get_settings().ai
        if not getattr(ai, "vision_audio", False):
            return False
        return not use_anthropic_for(ai)
    except Exception:
        return False


def _minimax_video_enabled(model_cfg) -> bool:
    """MiniMax 仅 M3 消息通道支持视频 content block。"""
    provider = (getattr(model_cfg, "provider", "") or "").lower()
    model = (getattr(model_cfg, "model", "") or "").lower()
    base_url = (getattr(model_cfg, "base_url", "") or "").lower()
    return (provider == "minimax" or "minimaxi.com" in base_url) and "m3" in model


# ── 视频探测 / 压缩 / mm_file 上传 ───────────────────────────────────────────
# 设计：
#   1) ffprobe 探真实分辨率/码率（ffmpeg 已在 devserver 装好；生产部署需前置依赖）
#   2) 分辨率 >1080p 或码率 >16Mbps → ffmpeg 转 1080p 5M h264（统一喂模型）
#   3) 压缩后 ≤45MB → base64 内联；>45MB 且 ≤90MB → 上传 Files API 拿 mm_file://{fid}；
#      >90MB 明确拒绝，不回退 base64（base64 注定超 MiniMax 上限，回退只会浪费内存再失败）
#   4) 非 MiniMax 走 OpenAI 兼容块（mimo 等），与现状一致，不变
async def _probe_video(raw: bytes) -> dict | None:
    """用 ffprobe 读视频分辨率/码率/时长。返回 {width, height, bit_rate, duration, codec}，失败 None。

    ffprobe 是同步子进程，用 `asyncio.to_thread` 丢到线程池跑，避免阻塞事件循环。
    `duration`：优先取视频流本身的 `duration`，但不少容器（尤其某些 mov/mp4 变体）
    只把 `duration` 记在 format 层、流层压根没有这个字段——只读 stream 会让这些
    视频的探测结果变成 0 秒，`>=120 秒直接拒绝`这条规则形同虚设（code review
    发现）。所以 ffprobe 命令同时问 `format=duration` 和 `stream=...,duration`，
    流层缺失时退回 format 层；两层都缺失才是真的 0（调用方按"探测不到就不因为
    时长拒绝"处理，不因为 ffprobe 偶发失败误伤正常视频——但两个数据源都问过了，
    不是只信一个容易漏读的字段）。"""
    import json as _json
    import subprocess
    import tempfile as _tf
    with _tf.NamedTemporaryFile(suffix=".bin", delete=False) as f:
        f.write(raw)
        tmp = f.name
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "format=duration:stream=codec_name,width,height,bit_rate,duration",
             "-of", "json", tmp],
            capture_output=True, text=True, timeout=10,
        )
        if proc.returncode != 0:
            return None
        data = _json.loads(proc.stdout)
        info = data.get("streams", [{}])[0]
        stream_duration = float(info.get("duration") or 0)
        format_duration = float((data.get("format") or {}).get("duration") or 0)
        return {
            "codec": info.get("codec_name"),
            "width": int(info.get("width") or 0),
            "height": int(info.get("height") or 0),
            "bit_rate": int(info.get("bit_rate") or 0),  # 0 = 容器未带（如 mov 有时）
            "duration": stream_duration or format_duration,  # 秒；流层缺失退回 format 层
        }
    except Exception:
        return None
    finally:
        try:
            import os
            os.unlink(tmp)
        except Exception:
            pass


async def _compress_video(raw: bytes, probe: dict | None = None) -> bytes | None:
    """用 ffmpeg 转码成 h264 5Mbps，返回新字节；失败 None。音频保留 aac 96k。

    是否缩分辨率**由调用方传入的 `probe` 显式决定**，不依赖 ffmpeg `scale` 滤镜
    "decrease" 语义本身去保证不放大——只有 `probe` 里的长边确实 >1080p 时才拼
    `-vf scale=...`；≤1080p（比如因为文件体积过大触发转码的 720p 视频）完全不传
    `-vf`，ffmpeg 原样保留输入分辨率，只重新编码降码率（code review 指出：单靠
    "decrease 只缩不放"这个隐式语义不够可靠/可验证，必须由调用方基于真实探测结果
    显式决定要不要缩，行为才是可断言、不依赖 ffmpeg 版本细节的）。`probe` 为
    `None` 或探测不到分辨率时，同样不缩（保守：探测不到就不擅自改分辨率）。

    ffmpeg 是同步子进程且 CPU/内存密集，用 `asyncio.to_thread` 丢线程池 + 全局 semaphore
    限制并发，避免阻塞事件循环、避免多人同时转码打满机器。"""
    import subprocess
    import tempfile as _tf

    w, h = (probe or {}).get("width") or 0, (probe or {}).get("height") or 0
    needs_downscale = max(w, h) > VIDEO_COMPRESS_MAX_DIM
    vf_args = []
    if needs_downscale:
        # 只有真的超过 1080p 才缩：force_original_aspect_ratio=decrease 保证竖屏也压长边，
        # 输出宽高取偶数。
        vf_args = ["-vf", f"scale={VIDEO_COMPRESS_MAX_DIM}:{VIDEO_COMPRESS_MAX_DIM}:"
                           f"force_original_aspect_ratio=decrease,"
                           f"scale=trunc(iw/2)*2:trunc(ih/2)*2"]

    with _tf.NamedTemporaryFile(suffix=".bin", delete=False) as inp:
        inp.write(raw)
        inp_path = inp.name
    out_path = inp_path + ".out.mp4"
    try:
        async with VIDEO_TRANSCODE_SEMAPHORE:
            # -b:v 5M 控制平均码率；不显式 -maxrate，留点高峰
            proc = await asyncio.to_thread(
                subprocess.run,
                ["ffmpeg", "-y", "-i", inp_path,
                 *vf_args,
                 "-c:v", "libx264", "-preset", "fast",
                 "-b:v", VIDEO_COMPRESS_BITRATE, "-c:a", "aac", "-b:a", "96k",
                 "-movflags", "+faststart", out_path],
                capture_output=True, timeout=180,
            )
        if proc.returncode != 0:
            return None
        with open(out_path, "rb") as f:
            return f.read()
    except Exception:
        return None
    finally:
        for p in (inp_path, out_path):
            try:
                import os
                os.unlink(p)
            except Exception:
                pass


def _should_compress_video(probe: dict | None, size: int = 0) -> bool:
    """是否需要转码：源文件 >90MB（`VIDEO_MMFILE_MAX`，最终 payload 上限，压缩可能把
    体积压下来，所以超过它不能直接拒绝，得先试一次转码）、分辨率 >1080p、码率
    >16Mbps，任一满足即转码。

    `size` 检查跟 `probe` 是否可用无关——即使 ffprobe 失败拿不到分辨率/码率，只要
    原始文件超过 `VIDEO_MMFILE_MAX`，仍然必须尝试转码（不转码这个视频最终注定会
    因为 payload 超限被拒绝，转码不试白不试）。`size` 默认 0 保持向后兼容（旧调用点
    不传时只看 probe，行为不变）。"""
    if size > VIDEO_MMFILE_MAX:
        return True
    if not probe:
        return False
    w, h = probe.get("width") or 0, probe.get("height") or 0
    if max(w, h) > VIDEO_COMPRESS_MAX_DIM:
        return True
    bit_rate = probe.get("bit_rate") or 0
    if bit_rate > VIDEO_COMPRESS_TRIGGER_BITRATE:
        return True
    return False


async def _upload_video_mmfile(raw: bytes, name: str, model_cfg) -> str | None:
    """把视频上传到 MiniMax Files API，返回 file_id；失败 None。

    上传端点从 model_cfg.base_url 推 host（https://host/v1/files/upload），
    仅 MiniMax 走这条路；其它 provider 上游不识别 mm_file://，调用方需先判 _minimax_video_enabled。
    失败时用 `diag_log` 记录脱敏信息（HTTP 状态码 / 异常类型），不写文件名/内容。"""
    import httpx
    from app.core.redaction import diag_log_raw
    api_key = (getattr(model_cfg, "api_key", "") or "").strip()
    base_url = (getattr(model_cfg, "base_url", "") or "").rstrip("/")
    if not api_key or not base_url:
        diag_log_raw("chat_attach.upload_mmfile", "缺少 api_key 或 base_url，跳过上传")
        return None
    # https://api.minimaxi.com/anthropic → https://api.minimaxi.com
    from urllib.parse import urlparse
    parsed = urlparse(base_url)
    upload_base = f"{parsed.scheme}://{parsed.netloc}"
    upload_url = f"{upload_base}/v1/files/upload"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=180.0, write=30.0, pool=5.0)) as client:
            r = await client.post(
                upload_url,
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": (name, raw, "video/mp4")},
                data={"purpose": VIDEO_MMFILE_PURPOSE},
            )
        if r.status_code != 200:
            diag_log_raw("chat_attach.upload_mmfile", f"上传失败 status={r.status_code}")
            return None
        import json as _json
        data = r.json()
        file_obj = data.get("file") or {}
        fid = file_obj.get("file_id")
        if not fid:
            diag_log_raw("chat_attach.upload_mmfile", "上传成功但响应缺 file_id")
        return str(fid) if fid else None
    except Exception as e:
        diag_log_raw("chat_attach.upload_mmfile", f"上传异常 type={type(e).__name__}")
        return None


async def prepare_video_media(raw: bytes, mime: str, name: str, model_cfg) -> dict:
    """把视频原始字节按 provider 能力转成可以直接塞进 `media` 列表的视频块描述
    （交给 `build_user_content`/`video_media_to_anthropic_block` 再转成各 provider
    的最终 content block）。

    这是视频理解能力唯一的一份决策逻辑：`resolve_for_message`（聊天附件）和
    `agent/tools/file_readers.py` 的 `read_video`（文件库 read_file 读视频）都必须
    调用这里，不能各自维护一份阈值判断——「视频怎么才算能被模型看到」只应该有
    一处真相来源。

    ① 源文件处理上限（对所有 provider 统一生效，不只 MiniMax）——原始字节
       >`VIDEO_SOURCE_MAX`（500MB）或时长 >=`VIDEO_DURATION_MAX_SECONDS`
       （120 秒）直接拒绝，不跑 ffprobe/转码，避免对明显超出产品范围的视频做
       无意义的昂贵处理。这是"服务器愿不愿意尝试处理"这一层的产品限制，跟
       provider 是谁无关，所以放在 provider 分支之前统一判断（code review
       指出：如果只在 MiniMax 分支里判断，非 MiniMax provider 就完全不受这条
       限制约束，跟"这是全视频产品限制"的定位矛盾）。
    ② 自动转码触发（仅 MiniMax M3，见 `_should_compress_video`）——源文件
       >`VIDEO_MMFILE_MAX`（90MB）或分辨率 >1080p 或码率 >16Mbps，任一满足就
       转码；**源文件 >90MB 不能直接拒绝**——90MB 是最终 payload 上限不是源
       文件上限，压缩可能把体积压下来（比如 186MB/1080p/12Mbps 因为文件本身
       >90MB 仍要转码一次，压完可能只有 70MB）。转码目标分辨率只降不升——
       `_compress_video` 由这里传入 `probe`，只有真的探测到长边 >1080p 才会
       拼 `-vf scale=...`，≤1080p（比如因体积过大触发转码的 720p 视频）完全
       不传缩放滤镜，ffmpeg 原样保留输入分辨率（不依赖 ffmpeg `scale` 滤镜
       "decrease 只缩不放"这个隐式语义，由调用方基于真实探测结果显式决定）。
       **转码失败（`_compress_video` 返回 `None`）直接拒绝，不能静默改用未转码
       的原始视频**——比如一个 2K/30MB 视频按规则必须先降到 1080p 才能给模型看，
       如果转码失败却把原始 2K 字节直接拿去 base64，会违反"超 1080p 必须先压"
       这条规则却完全没有任何提示（code review 指出的真实风险）。
    ③ 最终 payload 判断（仅 MiniMax M3）——转码后（或未触发转码时的原始字节）
       ≤`VIDEO_BASE64_MAX` 走 base64，(`VIDEO_BASE64_MAX`, `VIDEO_MMFILE_MAX`]
       走 mm_file（Files API 上传），超过 `VIDEO_MMFILE_MAX` 才真正拒绝；
       mm_file 上传失败也明确拒绝——**不回退 base64**（base64 注定超过
       MiniMax 上限，回退只会生成超大字符串浪费内存再失败）。
    非 MiniMax（OpenAI 兼容媒体块，如 mimo）：过完①之后不做②③的探测/转码/
    mm_file，仅 ≤`MEDIA_RAW_MAX` 走 base64，否则拒绝——这条路径没有转码能力，
    "先试着压一压"这件事对它没有意义。

    失败（超限/转码失败/上传失败）统一抛 `ValueError`，消息可以直接展示给用户；
    调用方负责捕获并决定怎么呈现（聊天附件退化成文字提示，read_file 直接把
    消息当工具错误返回）。
    """
    size = len(raw)
    if size > VIDEO_SOURCE_MAX:
        raise ValueError("这条视频太大（超过 500MB 处理上限），没法直接看")
    probe = await _probe_video(raw)
    duration = (probe or {}).get("duration") or 0
    if duration >= VIDEO_DURATION_MAX_SECONDS:
        raise ValueError("这条视频太长（超过 120 秒上限），没法直接看")

    minimax = _minimax_video_enabled(model_cfg) if model_cfg is not None else False
    if minimax:
        payload, payload_mime = raw, mime
        if _should_compress_video(probe, size):
            compressed = await _compress_video(raw, probe)
            if not compressed:
                raise ValueError("这条视频转码失败，没法直接看")
            payload, payload_mime = compressed, "video/mp4"
        if len(payload) <= VIDEO_BASE64_MAX:
            import base64
            return {"type": "video", "mode": "base64", "mime": payload_mime,
                    "b64": base64.b64encode(payload).decode()}
        if len(payload) <= VIDEO_MMFILE_MAX:
            fid = await _upload_video_mmfile(payload, name, model_cfg)
            if not fid:
                raise ValueError("这条视频上传失败（服务端暂不可用），没法直接看")
            return {"type": "video", "mode": "mm_file", "mime": payload_mime, "file_id": fid}
        raise ValueError("这条视频太大（超过 90MB 上限），没法直接看")
    if size > MEDIA_RAW_MAX:
        raise ValueError("这条视频太大（超过上限），没法直接看")
    import base64
    return {"type": "video", "mode": "base64", "mime": mime, "b64": base64.b64encode(raw).decode()}


def video_media_to_anthropic_block(m: dict) -> dict | None:
    """把 `prepare_video_media()` 返回的视频媒体项转成 Anthropic 原生 video content
    block；数据缺失（mm_file 没有 file_id、base64 没有 b64）返回 None，调用方按
    各自场景决定跳过还是报错——这里跟 `build_user_content` 的 Anthropic 视频分支
    是同一份转换逻辑，只有这一处，不重复实现。"""
    if m.get("mode") == "mm_file" and m.get("file_id"):
        return {"type": "video", "source": {"type": "url", "url": f"mm_file://{m['file_id']}"}, "fps": 1}
    if m.get("b64"):
        return {"type": "video", "source": {"type": "base64", "media_type": m["mime"], "data": m["b64"]}}
    return None


def _voice_recognition_enabled() -> bool:
    """是否配了独立「语音识别模型」（settings.voice）。配了就该为音频/语音构建 media base64
    交给 agent.voice.transcribe 转写——**不管主模型支不支持音视频**（解耦的关键）。"""
    try:
        from app.core.config import get_settings
        from agent import voice as _voice
        return _voice.is_configured(get_settings())
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
        if isinstance(blk, dict) and blk.get("type") in ("image", "video"):
            label = "图片" if blk.get("type") == "image" else "视频"
            out.append({"type": "text", "text": f"[{label}已查看]"})
        else:
            out.append(blk)
    return out


async def resolve_for_message(user_id, attach_ids: list, base_message: str, *, model_cfg=None) -> tuple[str, list, list, list]:
    """把附件解析成：① 注入给模型的增广文本（文本读内容、图片/二进制给提示）
    ② 给前端气泡的附件卡片列表 ③ 图片块列表（仅 vision 模型，喂给模型「看」）。
    失效/过期的 attach_id 跳过。

    `model_cfg`：**这轮真正要跑的模型**（IM 走 pick_model 选 pool/router，可能 ≠ 顶层 ai）。
    传了就按它判 vision / media，避免「门控用静态 ai、实跑用别的模型」→ 喂图却看不了 / 不喂却能看
    的不一致（图时好时坏的根因）。没传则退回顶层 settings.ai（web 路一直用激活模型，一致）。"""
    if not attach_ids:
        return base_message, [], [], []
    if model_cfg is not None:
        vision = bool(getattr(model_cfg, "vision", False))
        video_ok = _video_enabled(model_cfg)
        audio_ok = _audio_enabled(model_cfg)
    else:
        vision = _vision_enabled()
        video_ok = _video_enabled()
        audio_ok = _audio_enabled()
    voice_ok = _voice_recognition_enabled()   # 配了独立语音识别模型 → 音频/语音也构建 media 交 transcribe
    parts = [base_message] if base_message else []
    cards = []
    images: list = []   # [{media_type, b64}]，仅 vision 时填
    media: list = []    # [{type:'audio'|'video', mime, b64}]，仅对应维度开启时填
    for aid in attach_ids:
        meta = await get_meta(user_id, aid)
        if not meta:
            continue
        cards.append({
            "attach_id": meta["attach_id"], "name": meta["name"], "ext": meta["ext"],
            "size_bytes": meta["size"], "kind": meta["kind"], "upload": True,
            "mime": meta.get("mime"),
            "qq_face": bool(meta.get("qq_face")),
            "quoted": bool(meta.get("quoted")),
            "duration": meta.get("duration"),   # 语音条用：前端显示时长 + 渲染成播放条
            "img_width": meta.get("img_width"), "img_height": meta.get("img_height"),
        })
        fname = _model_attachment_name(meta)
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
                        data, img_media_type = fitted   # 别用 `media`——那是音视频列表，会被覆盖成字符串 → aug_media 变 str → transcribe 崩
                        images.append({"media_type": img_media_type,
                                       "b64": base64.b64encode(data).decode()})
                        parts.append(f"\n\n📎 用户上传了图片{tag}（见随附图像）；"
                                     f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
                        continue
                except Exception:
                    pass   # 读图/压缩失败 → 退回文字提示
            if not vision:
                # 没有任何能看图的模型 → **当普通文件处理**：正常收下、按需保存，
                # 别向用户抱怨「看不了图 / 看不到内容」（那样体验很差，用户只是想发个文件）。
                parts.append(f"\n\n📎 用户发来图片{tag}（图片文件；当前没有能看图的模型，"
                             f"**就当普通文件正常处理**——别说「看不了图 / 看不到内容」，正常回应；"
                             f"用户要存就 save_uploaded_file(attach_id) 存进文件库）。")
            else:
                # vision 开着但这张没喂成（格式不支持 / 读图失败）
                parts.append(f"\n\n📎 用户上传了图片{tag}（这张没法直接看：格式不支持）；"
                             f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
        elif meta["kind"] in ("audio", "video", "voice"):
            is_voice = meta["kind"] == "voice"
            is_video = meta["kind"] == "video"
            noun = "语音" if is_voice else ("视频" if is_video else "音频")
            ext = (meta.get("ext") or "").lower()
            native = ext in (VIDEO_EXTS if is_video else AUDIO_EXTS)   # 语音转码后是 mp3，按音频判原生
            # 能喂 base64 给模型的条件：① 主模型对应维度开启（视频→vision_video，音频→vision_audio，
            # 走 OpenAI 兼容媒体块 / MiniMax M3 原生块）；② 配了独立语音识别模型（仅音频/语音，
            # 交 transcribe 转文字）。视频仍只走 ①（ASR 听不了画面）。
            can_feed = (video_ok if is_video else audio_ok) or (voice_ok and not is_video)
            # 格式：配了语音识别模型时音频/语音**不必原生**——voice.transcribe 会用 ffmpeg 把任意格式
            # （webm/amr/mp4…）转 wav 再送。网页 Chrome 录的就是 webm，过去卡在这。视频无转写仍需原生交 mimo。
            fmt_ok = native or (voice_ok and not is_video)
            why = None
            if can_feed and fmt_ok:
                try:
                    import base64
                    mime = _MEDIA_MIME.get(ext, meta.get("mime") or "application/octet-stream")
                    # 视频源文件上限用暂存元数据里已有的 meta["size"]（跟 read_file 那边用
                    # storage.stat() 是同一个思路）在读字节之前就拒绝，不要为了一个注定要
                    # 拒绝的 500MB+ 视频先把整个文件读进内存（code review 指出）。
                    if is_video and meta["size"] > VIDEO_SOURCE_MAX:
                        raise ValueError("这条视频太大（超过 500MB 处理上限），没法直接看")
                    raw = await read_bytes(meta)
                    if is_video:
                        # 视频决策（压缩阈值/base64 vs mm_file/大小上限）全部在 prepare_video_media
                        # 里——read_file 读文件库视频（file_readers.py 的 read_video）复用同一份逻辑，
                        # 这里不重复维护一套阈值判断。
                        video_cfg = model_cfg
                        if video_cfg is None:
                            try:
                                from app.core.config import get_settings
                                video_cfg = get_settings().ai
                            except Exception:
                                video_cfg = None
                        media.append(await prepare_video_media(
                            raw, mime, meta.get("name") or "video.mp4", video_cfg,
                        ))
                    else:
                        # 音频/语音：保持旧行为，仅 ≤36MB 走 base64
                        if meta["size"] > MEDIA_RAW_MAX:
                            raise ValueError("这条音频太大（超过上限），没法直接听")
                        media.append({"type": "audio", "mode": "base64", "mime": mime,
                                      "b64": base64.b64encode(raw).decode()})
                    if is_voice:
                        # 语音是「对话里说的话」，不是要存的文件——明确叫咕咕直接听内容回应，别问存不存。
                        parts.append(f"\n\n🎤 用户给你发来一条语音{tag}（已随附）。请**直接听里面说了什么并自然回应**——"
                                     f"这是对话内容，不是文件，别问「要不要保存」这类话。")
                    else:
                        parts.append(f"\n\n📎 用户上传了{noun}{tag}（已随附{noun}，你可直接听/看内容）；"
                                     f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
                    continue
                except ValueError as e:
                    # 视频超限 / mm_file 上传失败：明确拒绝，给出具体原因
                    why = str(e)
                except Exception:
                    pass   # 读取/编码失败 → 退文字提示
            if not can_feed:
                why = f"没法处理{noun}（需主模型开启对应多模态维度，或在后台配「语音识别模型」）"
            elif not fmt_ok:
                why = f"这条{noun}是 {ext or '未知'} 格式、得先转成 mp3 才能听——服务器没装 ffmpeg 转不了（装上 ffmpeg 即可听内容）"
            elif why is None:
                why = f"这条{noun}太大（超过上限），没法直接听/看"
            tail = "" if is_voice else "；若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。"
            parts.append(f"\n\n📎 用户发来{noun}{tag}。{why}。{tail}")
        else:
            parts.append(f"\n\n📎 用户上传了文件{tag}，二进制内容读不了；"
                         f"若用户要保存，调用 save_uploaded_file(attach_id) 存进文件库。")
    return "".join(parts), cards, images, media


def build_user_content(text: str, images: list, use_anthropic: bool, media: list | None = None):
    """把增广文本 + 图片块（+ mimo 音视频块）拼成发给模型的 user content。
    无图无媒体 → 纯字符串（与旧行为一致）；否则 → 内容块列表（按 provider 格式）。
    `media`（音/视频）在 OpenAI 路使用 MiMo 扩展块，在 Anthropic 路使用 MiniMax 原生块。"""
    media = media or []
    if not images and not media:
        return text
    if use_anthropic:
        parts = [{"type": "text", "text": text}] if text else []
        for im in images:
            parts.append({"type": "image", "source": {
                "type": "base64", "media_type": im["media_type"], "data": im["b64"]}})
        for m in media:
            if m["type"] == "video":
                block = video_media_to_anthropic_block(m)
                if block:
                    parts.append(block)
                # 两者都缺（数据异常）→ 跳过该块，不崩
        return parts
    parts = [{"type": "text", "text": text}] if text else []
    for im in images:
        parts.append({"type": "image_url", "image_url": {
            "url": f"data:{im['media_type']};base64,{im['b64']}"}})
    for m in media:
        data_url = f"data:{m['mime']};base64,{m['b64']}"
        if m["type"] == "audio":
            parts.append({"type": "input_audio", "input_audio": {"data": data_url}})
        else:  # video
            parts.append({"type": "video_url", "video_url": {"url": data_url},
                          "fps": 2, "media_resolution": "default"})
    return parts
