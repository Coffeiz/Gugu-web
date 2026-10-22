"""视频处理：探测 / 转码 / 缓存，以及把视频转成模型能收的媒体描述与内容块。

这是视频理解能力唯一的一份决策逻辑：聊天附件（`agent/chat/attachments.py`）和
文件库 read_file（`agent/tools/media_reader.py`）都必须调用这里，不能各自维护
一份阈值判断——「视频怎么才算能被模型看到」只应该有一处真相来源。

厂商专属的动作（文件上传）不在本模块：通用层只决定"这里需要走文件上传"，
具体怎么传由 Provider 自己实现（`ProviderAdapter.upload_media_file`）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json

from app.core import redis as redis_module
from app.services import storage as storage_service

from . import gates
from .constants import VIDEO_MMFILE_PURPOSE

# 视频转码并发上限：ffmpeg CPU/内存密集，避免多人同时上传视频打满机器
VIDEO_TRANSCODE_SEMAPHORE = asyncio.Semaphore(2)

# ── 视频转码结果缓存（PRD-STORAGE-1 Phase B）─────────────────────────────────
# cache_key 由 storage_key + 转码 profile + CACHE_VERSION 一起派生（不能只用
# storage_key——同一份源文件换一个 model_cfg，分辨率/码率上限不同，转码产物不
# 一样；以后调整 ffmpeg 参数，改 CACHE_VERSION 让所有旧缓存自然失效）。缓存路径
# 由 cache_key 确定性推导，不经过 Redis 查找；Redis 只存一个"最近是否仍活跃"的
# marker，随时全部丢失也不影响正确性（marker 不在了，`prepare_video_media` 就
# 当没缓存，重新转码——缓存该有的性质：可以随时全丢，不影响业务 correctness）。
VIDEO_CACHE_VERSION = "video-v1"
VIDEO_CACHE_ALIVE_TTL = 7 * 24 * 3600   # 对齐普通附件 TTL，不新增一个自定义常量


def validate_video_source(size: int, mime: str, model_cfg=None) -> None:
    """按当前 Provider 的媒体策略预检视频大小与类型。

    调用方应在读取完整文件前用存储元数据预检；`prepare_video_media` 还会用实际
    字节数再次校验，避免元数据与读取结果不一致时绕过限制。
    """
    limits = gates.media_limits_for(model_cfg)
    if size > limits.video_source_max_bytes:
        max_mb = limits.video_source_max_bytes // 1_000_000
        raise ValueError(f"这条视频超过 Provider 单文件上限（{max_mb}MB），未发送给 Provider")

    normalized_mime = (mime or "").split(";", 1)[0].strip().lower()
    allowed_mimes = {item.split(";", 1)[0].strip().lower() for item in limits.video_mimes}
    if not normalized_mime.startswith("video/"):
        raise ValueError("附件类型不是受支持的视频，未发送给 Provider")
    if allowed_mimes and normalized_mime not in allowed_mimes:
        raise ValueError(f"当前 Provider 不支持视频格式 {normalized_mime}，未发送给 Provider")


def check_video_duration(duration: float | None, model_cfg=None) -> None:
    """按 Provider 规格校验视频时长；超限抛 `ValueError`（消息可直接展示给用户）。

    这是**读字节之前**就该过的闸门：调用方先探到时长、再过这一关，就不用为了
    拒绝一个注定被拒的视频先把整份读进内存（235MB 的视频 = 读一遍 + 落一份临时
    文件，才换来一句"太长了"）。跟 `validate_video_source`（大小/类型闸门）是同一
    层级的**读前拦截**，两者的顺序无关——谁先拦下都行。

    fail-closed：确认不了时长（探测失败/两层都没带 duration）按"超限"处理直接
    拒绝，不当成"没超限"放行——硬限制在探测失败时变成开着口子是错的方向。
    """
    limits = gates.media_limits_for(model_cfg)
    if limits.max_duration_s is None:
        return
    if not duration:
        raise ValueError("无法确认视频时长，未发送给 Provider")
    over_duration = duration >= limits.max_duration_s if limits.duration_limit_inclusive \
        else duration > limits.max_duration_s
    if over_duration:
        relation = "达到或超过" if limits.duration_limit_inclusive else "超过"
        raise ValueError(
            f"这条视频时长 {duration:g} 秒，{relation} Provider 的 "
            f"{limits.max_duration_s} 秒上限，未发送给 Provider"
        )


async def probe_video(raw: bytes) -> dict | None:
    """用 ffprobe 读视频分辨率/码率/时长。返回 {width, height, bit_rate, duration, codec}，失败 None。

    这是**字节版**探测：必须先把字节落成临时文件才能喂给 ffprobe——等于多写一份
    N 字节、再多读一遍。能拿到存储路径时优先用 `probe_video_at()`（按路径探测，
    不落盘不整读）。

    ffprobe 是同步子进程，用 `asyncio.to_thread` 丢到线程池跑，避免阻塞事件循环。
    `duration`：不少容器（尤其某些 mov/mp4 变体）把它记在 format 层、流层压根没有
    这个字段，反过来也有流层带、format 层缺失的情况——只信任其中一层都可能漏读。
    所以 ffprobe 命令同时问 `format=duration` 和 `stream=...,duration`，取两者中
    **较大**的那个（`max`，不是 `or`）：时长限制应该按更长
    的估计值判断，用 `or`（谁先非零就用谁）会在某一层数据不完整、另一层是真实
    更长时长时误判成"没超"，放过一个实际超限的视频（code review 指出）。两层
    都缺失时返回 `duration=0`——调用方（`prepare_video_media`）对"确认不了时长"
    按 fail-closed 处理（直接拒绝，不当成"没超限"放行）。"""
    import tempfile as _tf
    with _tf.NamedTemporaryFile(suffix=".bin", delete=False) as f:
        f.write(raw)
        tmp = f.name
    try:
        return await asyncio.to_thread(_ffprobe_info, tmp)
    finally:
        try:
            import os
            os.unlink(tmp)
        except Exception:
            pass


def _ffprobe_info(path: str) -> dict | None:
    """对**文件路径**跑 ffprobe，解析出 {codec,width,height,bit_rate,duration}；失败 None。

    ffprobe 对文件是按需 seek 的（mp4 的 moov 在文件头或文件尾都能定位到），
    IO 量是 KB 级而不是视频体积级——这就是「按路径探测」比「落临时文件探测」省的
    那一整份 N 字节写+读。
    """
    import json as _json
    import subprocess
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "format=duration:stream=codec_name,width,height,bit_rate,duration",
             "-of", "json", path],
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
            # 秒；两层都问过，取较长的那个——时长硬限制应该按更长的估计值判断，
            # 用 or（谁先非零就用谁）会在 stream 层元数据
            # 不完整（比如只有 10 秒）而 format 层是真实的 125 秒时误判成"没超"，
            # 放过一个实际超限的视频（code review 指出）。
            "duration": max(stream_duration, format_duration),
        }
    except Exception:
        return None


async def probe_video_at(storage_key: str) -> dict | None:
    """按**存储路径**探测视频信息——不落临时文件、不把整段视频读进内存。

    ffprobe 对文件按需 seek，IO 量是 KB 级；这是「读字节之前就能判时长」的关键：
    调用方能在 `get()` 之前先过时长闸门，超限的视频根本不会被读进内存、更不会
    被落一份临时文件。

    只有本地后端有可读路径；对象存储（OSS）没有本地副本 → 返回 None，调用方
    回退到字节探测（行为与优化前一致，只是没有提速）。
    """
    try:
        from app.services.storage import get_storage
        if not storage_key:
            return None
        path = get_storage().local_path(storage_key)
    except Exception:
        return None
    if path is None:
        return None
    try:
        if not path.is_file():
            return None
    except OSError:
        return None
    return await asyncio.to_thread(_ffprobe_info, str(path))


async def probe_video_for(raw: bytes, storage_key: str | None = None) -> dict | None:
    """探测视频信息：优先按存储路径（省一整份写+读），回退到字节探测。

    回退只在对象存储、或本地文件已被移走时发生——那时"没有本地路径可探"，
    只能把字节落成临时文件再探（与优化前行为一致）。
    """
    if storage_key:
        info = await probe_video_at(storage_key)
        if info is not None:
            return info
    return await probe_video(raw)


async def compress_video(raw: bytes, probe: dict | None = None,
                         limits=None) -> bytes | None:
    """按 Provider 策略转码视频，返回新字节；失败 None。音频保留 aac 96k。

    是否缩分辨率**由调用方传入的 `probe` 显式决定**，不依赖 ffmpeg `scale` 滤镜
    "decrease"语义本身去保证不放大——只有 `probe` 里的长边超过当前 Provider
    的分辨率限制时才拼 `-vf scale=...`；未超限的视频完全不传
    `-vf`，ffmpeg 原样保留输入分辨率，只重新编码降码率（code review 指出：单靠
    "decrease 只缩不放"这个隐式语义不够可靠/可验证，必须由调用方基于真实探测结果
    显式决定要不要缩，行为才是可断言、不依赖 ffmpeg 版本细节的）。`probe` 为
    `None` 或探测不到分辨率时，同样不缩（保守：探测不到就不擅自改分辨率）。

    ffmpeg 是同步子进程且 CPU/内存密集，用 `asyncio.to_thread` 丢线程池 + 全局 semaphore
    限制并发，避免阻塞事件循环、避免多人同时转码打满机器。"""
    import subprocess
    import tempfile as _tf

    from agent.providers.media import MediaLimits

    limits = limits or MediaLimits()
    w, h = (probe or {}).get("width") or 0, (probe or {}).get("height") or 0
    needs_downscale = max(w, h) > limits.compress_max_dim
    vf_args = []
    if needs_downscale:
        # 只有真的超过 1080p 才缩：force_original_aspect_ratio=decrease 保证竖屏也压长边，
        # 输出宽高取偶数。
        vf_args = ["-vf", f"scale={limits.compress_max_dim}:{limits.compress_max_dim}:"
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
                 "-b:v", limits.compress_bitrate, "-c:a", "aac", "-b:a", "96k",
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


def should_compress_video(probe: dict | None, size: int = 0,
                          limits=None, mime: str = "") -> bool:
    """是否需要转码：源文件超过当前 Provider 的 mm_file 上限，或画质/码率超过策略。

    源文件超过当前 Provider 的最终文件上限（压缩可能把体积压下来，所以超过它不能
    直接拒绝，得先试一次转码）、分辨率超过策略上限、
    码率超过策略阈值，任一满足即转码。

    `size` 检查跟 `probe` 是否可用无关——即使 ffprobe 失败拿不到分辨率/码率，只要
    原始文件超过当前 Provider 的 mm_file 上限，仍然必须尝试转码（不转码最终注定会
    因为 payload 超限被拒绝，转码不试白不试）。`size` 默认 0 保持向后兼容（旧调用点
    不传时只看 probe，行为不变）。"""
    from agent.providers.media import MediaLimits

    limits = limits or MediaLimits()
    if not limits.transcode_video:
        return False
    if mime.lower() in limits.transcode_video_mimes:
        return True
    if size > limits.max_size_bytes:
        return True
    if not probe:
        return False
    w, h = probe.get("width") or 0, probe.get("height") or 0
    if max(w, h) > limits.compress_max_dim:
        return True
    bit_rate = probe.get("bit_rate") or 0
    if bit_rate > limits.compress_trigger_bitrate:
        return True
    return False


def video_transcode_profile(model_cfg) -> dict:
    """从 model_cfg 派生影响转码结果的关键字段。"""
    limits = gates.media_limits_for(model_cfg)
    return {
        "provider": getattr(model_cfg, "provider", "") if model_cfg is not None else "default",
        "limits": {
            "max_source_bytes": limits.video_source_max_bytes,
            "max_duration_s": limits.max_duration_s,
            "duration_limit_inclusive": limits.duration_limit_inclusive,
            "max_size_bytes": limits.max_size_bytes,
            "compress_max_dim": limits.compress_max_dim,
            "compress_bitrate": limits.compress_bitrate,
            "compress_trigger_bitrate": limits.compress_trigger_bitrate,
            "transcode_video_mimes": sorted(limits.transcode_video_mimes),
            "base64_max": limits.base64_max,
        },
    }


def video_cache_key(storage_key: str, profile: dict) -> str:
    payload = json.dumps(
        {"storage_key": storage_key, "profile": profile, "version": VIDEO_CACHE_VERSION},
        sort_keys=True, ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def video_cache_path(user_id, cache_key: str) -> str:
    return f"{user_id}/.video_cache/{cache_key}.mp4"


def video_cache_alive_key(user_id, cache_key: str) -> str:
    return f"video_cache_alive:{user_id}:{cache_key}"


async def video_cache_try_read(cache_path: str, alive_key: str) -> bytes | None:
    """命中就顺带刷新 alive marker——**必须用 `SET ... EX` 整体重设，不能用
    `EXPIRE`**：Redis 整体丢失过之后 marker 这个 key 根本不存在，对不存在的
    key 调 `EXPIRE` 是空操作、不会创建 key，会导致"缓存文件明明刚被命中读取，
    marker 却依然不存在，下一轮安全网还是把它当孤儿清掉"这种违背自愈设计的 bug。"""
    try:
        data = await storage_service.get_storage().get(cache_path)
    except Exception:
        return None
    if not data:
        return None
    try:
        await redis_module.get_redis().set(alive_key, "1", ex=VIDEO_CACHE_ALIVE_TTL)
    except Exception:
        pass
    from app.core.redaction import diag_log_raw
    diag_log_raw("agent.media.video_cache_hit", f"cache_path={cache_path}")
    return data


async def compress_video_cached(raw: bytes, probe: dict | None, storage_key: str | None,
                                user_id, model_cfg) -> bytes | None:
    """`compress_video` 的缓存包装：`storage_key`/`user_id` 都给了才启用缓存
    （聊天附件路径的 `attach_id` 每次不同，天然没有稳定 key，直接走原始转码，
    不接缓存）。命中直接返回；未命中时用 `video_cache_lock:{cache_key}` 做
    single-flight（同一视频被多个并发请求同时未命中时只真正转码一次），加锁后
    double-check 再读一次缓存（防止等锁期间前一个请求已经转码完）。"""
    limits = gates.media_limits_for(model_cfg)
    if not storage_key or not user_id:
        return await compress_video(raw, probe, limits)

    profile = video_transcode_profile(model_cfg)
    cache_key = video_cache_key(storage_key, profile)
    cache_path = video_cache_path(user_id, cache_key)
    alive_key = video_cache_alive_key(user_id, cache_key)

    cached = await video_cache_try_read(cache_path, alive_key)
    if cached is not None:
        return cached

    lock = redis_module.get_redis().lock(f"video_cache_lock:{cache_key}", timeout=200)
    got_lock = False
    try:
        got_lock = await lock.acquire(blocking=True, blocking_timeout=180)
    except Exception:
        got_lock = False
    try:
        if got_lock:
            cached = await video_cache_try_read(cache_path, alive_key)
            if cached is not None:
                return cached
        compressed = await compress_video(raw, probe, limits)
        if compressed is not None:
            try:
                await storage_service.get_storage().put(cache_path, compressed, "video/mp4")
                await redis_module.get_redis().set(alive_key, "1", ex=VIDEO_CACHE_ALIVE_TTL)
            except Exception:
                pass   # 缓存写入失败不影响本次转码结果的正常返回，只是下次不会命中
        return compressed
    finally:
        if got_lock:
            try:
                await lock.release()
            except Exception:
                pass


async def _upload_via_provider(raw: bytes, name: str, mime: str, model_cfg) -> str | None:
    """把视频交给当前 Provider 上传，返回 file_id；失败/不支持返回 None。

    上传是厂商专属行为——通用媒体层只决定"这里需要走文件上传"，具体怎么传由
    Provider 自己实现（`ProviderAdapter.upload_media_file`）。没有声明文件上传
    通道的 Provider 走不到这条分支。
    """
    from agent import providers
    adapter = providers.adapter_for(model_cfg)
    return await adapter.upload_media_file(raw, name, model_cfg, mime=mime, purpose=VIDEO_MMFILE_PURPOSE)


async def prepare_video_media(raw: bytes, mime: str, name: str, model_cfg,
                              *, storage_key: str | None = None, user_id=None,
                              duration: float | None = None, probe: dict | None = None) -> dict:
    """把视频原始字节按 provider 能力转成可以直接塞进 `media` 列表的视频块描述
    （交给 `build_user_content`/`video_media_to_anthropic_block` 再转成各 provider
    的最终 content block）。

    这是视频理解能力唯一的一份决策逻辑：`resolve_for_message`（聊天附件）和
    `agent/tools/media_reader.py` 的 `read_video`（文件库 read_file 读视频）都必须
    调用这里，不能各自维护一份阈值判断——「视频怎么才算能被模型看到」只应该有
    一处真相来源。

    ① 源文件处理上限和时长上限由 Provider 的 `MediaLimits` 决定；未声明专属策略
       的 Provider 使用 `ProviderAdapter` 中的默认值，保留旧行为。
    ② 若 Provider 开启转码，自动转码触发由同一份 Provider 策略决定——源文件
       超过 mm_file 上限、分辨率或码率超出策略时才转码；关闭转码且未声明时长
       限制的 Provider（MiniMax M3）不运行 ffprobe，直接保留原视频。
       转码目标分辨率只降不升——`compress_video` 由这里传入 `probe`，只有探测到
       长边超过策略分辨率限制才会拼 `-vf scale=...`，未超限的视频完全
       不传缩放滤镜，ffmpeg 原样保留输入分辨率（不依赖 ffmpeg `scale` 滤镜
       "decrease 只缩不放"这个隐式语义，由调用方基于真实探测结果显式决定）。
       **转码失败（`compress_video` 返回 `None`）直接拒绝，不能静默改用未转码
       的原始视频**——比如一个 2K/30MB 视频按规则必须先降到 1080p 才能给模型看，
       如果转码失败却把原始 2K 字节直接拿去 base64，会违反"超 1080p 必须先压"
       这条规则却完全没有任何提示（code review 指出的真实风险）。
    ③ 最终 payload 判断——转码后（或直接使用原始字节）按 Provider 策略
       选择 base64、mm_file 或拒绝；
       mm_file 上传失败也明确拒绝——**不回退 base64**（base64 注定超过
       MiniMax 上限，回退只会生成超大字符串浪费内存再失败）。
    非 MiniMax（OpenAI 兼容媒体块，如 mimo）：过完①之后不做②③的探测/转码/
    mm_file，仅 ≤`MEDIA_RAW_MAX` 走 base64，否则拒绝——这条路径没有转码能力，
    "先试着压一压"这件事对它没有意义。

    失败（超限/转码失败/上传失败）统一抛 `ValueError`，消息可以直接展示给用户；
    调用方负责捕获并决定怎么呈现（聊天附件退化成文字提示，read_file 直接把
    消息当工具错误返回）。

    `storage_key`/`user_id`（PRD-STORAGE-1 Phase B，可选）：都传了才启用转码结果
    缓存——同一份需要转码的视频反复被读，跳过重复的 ffmpeg 转码；聊天附件路径的
    `attach_id` 每次不同，天然没有稳定 key，不传即可。

    `duration`/`probe`（可选）：调用方**在读字节之前**已经探到时长时传进来，
    这里就不重复探测——既省掉一次 ffprobe，也避免"读完 235MB 才知道这视频超限"。
    `duration` 已知但 `probe` 没给时，只要 Provider 开了转码策略仍然要探（转码决策
    需要分辨率/码率）；`duration` 和 `probe` 都给了则完全不探测。
    """
    size = len(raw)
    limits = gates.media_limits_for(model_cfg)
    validate_video_source(size, mime, model_cfg)
    # 需要探测的两种情况：① Provider 开了转码策略（要分辨率/码率决定是否转码）；
    # ② Provider 有时长上限但调用方没给出时长（要靠探测才知道能不能发）。
    # 探测优先走**存储路径**（ffprobe 按需 seek，不落临时文件、不整读视频），
    # 没有本地路径（对象存储）才回退到"把字节落成临时文件再探"。
    need_probe = limits.transcode_video or (limits.max_duration_s is not None and duration is None)
    if probe is None and need_probe:
        probe = await probe_video_for(raw, storage_key)
    probe = probe or {}
    if duration is None:
        duration = probe.get("duration") or 0
    # 时长上限和边界语义由 Provider 策略决定；"确认不了时长"不能当成"没超限"放行——
    # ffprobe 失败、或者 stream/format 两层都没带 duration 字段时，duration 会是 0，
    # 如果直接拿 0 去跟策略上限比较就会误判成"远没超限"而放行，等于让硬限制在探测
    # 失败时变成开着口子（code review 指出：fail-open 的方向错了，应该 fail-closed）。
    if limits.max_duration_s is not None:
        check_video_duration(duration, model_cfg)

    transport = gates.video_transport_for(model_cfg) if model_cfg is not None else "none"
    if transport == "anthropic":
        payload, payload_mime, payload_name = raw, mime, name
        if should_compress_video(probe, size, limits, mime):
            compressed = await compress_video_cached(raw, probe, storage_key, user_id, model_cfg)
            if not compressed:
                raise ValueError("这条视频转码失败，没法直接看")
            payload, payload_mime = compressed, "video/mp4"
            payload_name = f"{name.rsplit('.', 1)[0]}.mp4" if "." in name else f"{name}.mp4"
        if len(payload) <= limits.base64_max:
            import base64
            return {"type": "video", "mode": "base64", "mime": payload_mime,
                    "b64": base64.b64encode(payload).decode()}
        if len(payload) <= limits.max_size_bytes:
            fid = await _upload_via_provider(payload, payload_name, payload_mime, model_cfg)
            if not fid:
                raise ValueError("这条视频上传失败（服务端暂不可用），没法直接看")
            return {"type": "video", "mode": "mm_file", "mime": payload_mime, "file_id": fid}
        max_mb = limits.max_size_bytes // 1_000_000
        raise ValueError(f"这条视频太大（超过 {max_mb}MB 上限），没法直接看")
    if size > limits.inline_max_bytes:
        raise ValueError("这条视频太大（超过上限），没法直接看")
    import base64
    return {"type": "video", "mode": "base64", "mime": mime, "b64": base64.b64encode(raw).decode()}


def video_media_to_anthropic_block(m: dict) -> dict | None:
    """把 `prepare_video_media()` 返回的视频媒体项转成 Anthropic 原生 video content
    block；数据缺失（mm_file 没有 file_id、base64 没有 b64）返回 None，调用方按
    各自场景决定跳过还是报错——这里跟 `build_user_content` 的 Anthropic 视频分支
    是同一份转换逻辑，只有这一处，不重复实现。"""
    if m.get("mode") == "mm_file" and m.get("file_id"):
        return {"type": "video", "source": {
            "type": "url", "url": f"mm_file://{m['file_id']}", "fps": 1,
        }}
    if m.get("b64"):
        return {"type": "video", "source": {
            "type": "base64", "media_type": m["mime"], "data": m["b64"], "fps": 1,
        }}
    return None


def video_media_to_openai_block(m: dict) -> dict | None:
    """把视频媒体项转成 OpenAI Chat Completions 的 video_url 内容块。"""
    if m.get("b64"):
        mime = m.get("mime") or "video/mp4"
        return {"type": "video_url", "video_url": {
            "url": f"data:{mime};base64,{m['b64']}"},
            "fps": 2, "media_resolution": "default"}
    return None


def media_item_to_content_block(m: dict, *, use_anthropic: bool) -> dict | None:
    """按当前 provider 协议把聊天/文件库音视频媒体描述转成内容块。"""
    if m.get("type") == "video":
        return (video_media_to_anthropic_block(m) if use_anthropic
                else video_media_to_openai_block(m))
    if m.get("type") == "audio" and not use_anthropic and m.get("b64"):
        mime = m.get("mime") or "audio/mpeg"
        return {"type": "input_audio", "input_audio": {
            "data": f"data:{mime};base64,{m['b64']}"}}
    return None
