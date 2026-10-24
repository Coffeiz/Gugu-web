"""按路径准备视频，共用 Provider 规格并缓存用户隔离的原文件上传引用。"""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import asyncio
import hashlib
import json

from agent.media.budget import VIDEO_MEMORY_BUDGET

UPLOAD_CACHE_TTL = 6 * 3600  # 小于 Provider 的七天留存，不延长远端文件生命周期。


def file_digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


async def prepare_video_path(path, mime: str, name: str, model_cfg, *, user_id=None,
                             storage_key=None, probe=None, max_source_bytes=None) -> dict:
    from agent import providers
    from agent.media import gates, video
    from agent.media.constants import VIDEO_MMFILE_PURPOSE
    from app.core.redis import get_redis

    path = Path(path)
    stat = await asyncio.to_thread(path.stat)
    size = stat.st_size
    video.validate_video_source(size, mime, model_cfg)
    if max_source_bytes is not None and size > max_source_bytes:
        raise ValueError("本批次剩余容量不足，未读取该视频")
    limits = gates.media_limits_for(model_cfg)
    if probe is None and (limits.transcode_video or limits.max_duration_s is not None):
        probe = await video.probe_video_path(path)
    video.check_video_duration((probe or {}).get("duration"), model_cfg)
    upload = (limits.prefer_file_upload and not limits.transcode_video
              and gates.video_transport_for(model_cfg) == "anthropic" and size > limits.base64_max)
    async with VIDEO_MEMORY_BUDGET.reserve(2 * 1024 * 1024 if upload else size * 4):
        if not upload:
            raw = await asyncio.to_thread(path.read_bytes)
            return await video.prepare_video_media(raw, mime, name, model_cfg,
                storage_key=storage_key, user_id=user_id, duration=(probe or {}).get("duration"), probe=probe)
        identity = await asyncio.to_thread(file_digest, path)
        # API Key 仅参与不可逆身份摘要；不进入缓存值、日志或诊断正文。
        config = {key: getattr(model_cfg, key, "") for key in ("provider", "model", "base_url", "api_key")}
        scope = sha256(json.dumps([str(user_id), config, identity], sort_keys=True).encode()).hexdigest()
        cache_key = "media:video-upload:" + scope
        redis = get_redis()
        fid = None
        if user_id is not None:
            try:
                fid = await redis.get(cache_key)
            except Exception:
                pass  # 引用缓存不可用不改变传输策略，仍然流式上传。
        uploaded = not fid
        if uploaded:
            fid = await providers.adapter_for(model_cfg).upload_media_path(
                path, name, model_cfg, mime=mime, purpose=VIDEO_MMFILE_PURPOSE)
            if not fid:
                raise ValueError("这条视频上传失败（服务端暂不可用），没法直接看")
        after = await asyncio.to_thread(path.stat)
        if (after.st_size, after.st_mtime_ns, after.st_ino) != (stat.st_size, stat.st_mtime_ns, stat.st_ino):
            raise ValueError("视频在读取期间发生变化，请重试")
        if uploaded and user_id is not None:
            try:
                await redis.set(cache_key, fid, ex=UPLOAD_CACHE_TTL)
            except Exception:
                pass
        return {"type": "video", "mode": "mm_file", "mime": mime, "file_id": fid}
