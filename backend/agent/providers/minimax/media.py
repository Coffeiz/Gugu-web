"""MiniMax 模型原生多模态能力与 Provider 官方输入规格。"""
from __future__ import annotations

from ..base import ResponsesInputCapabilities, configured_responses_input_capabilities
from ..media import DEFAULT_MEDIA_LIMITS, MediaLimits


M3_MEDIA_LIMITS = MediaLimits(
    # 官方 Files API 单文件上限 512 MB；按十进制字节计，不附加 Gugu 的缩放、
    # 转码或 90 MiB 载荷限制。小文件走 Anthropic base64，大文件原样上传。
    video_source_max_bytes=512_000_000,
    # 视频时长上限 = MiniMax 单条视频的官方硬限 1800 秒。超过这个数上游直接
    # 400（"video's duration is bigger than 1800 seconds", 2013）——是硬拒绝，
    # 不是降级、不是超时，所以应用侧必须自己先判：超了就返回失败的 tool result，
    # 不让上游去拒（上游那句 2013 在错误呈现层会被压成「请求参数错误」，
    # 真正能指导用户的信息会丢）。
    # 边界语义跟上游一致：上游拒的是 "bigger than 1800"（严格大于），所以这里用
    # 非包含边界——正好 1800 秒放行，不误拒上游能收的视频。
    max_duration_s=1800,
    duration_limit_inclusive=False,
    max_size_bytes=512_000_000,
    image_max_bytes=10_000_000,
    image_mimes=frozenset({"image/jpeg", "image/png", "image/gif", "image/webp"}),
    image_extensions=frozenset({"jpg", "jpeg", "png", "gif", "webp"}),
    preserve_image_source=True,
    transcode_video=False,
    video_mimes=frozenset({
        "video/mp4", "video/x-msvideo", "video/quicktime", "video/x-matroska",
    }),
    base64_max=45 * 1024 * 1024,
)


def supports_image_model(model: str = "") -> bool:
    """MiniMax M3 系列支持原生图像输入。"""
    return (model or "").lower().startswith("minimax-m3")


def supports_video_model(model: str = "") -> bool:
    """MiniMax M3 系列支持原生视频输入。"""
    return "m3" in (model or "").lower()


def media_limits(model: str = "") -> MediaLimits:
    """返回指定 MiniMax 模型的媒体规格；M3 显式声明视频输入策略。"""
    if supports_video_model(model):
        return M3_MEDIA_LIMITS
    return DEFAULT_MEDIA_LIMITS


def responses_input_capabilities(ai) -> ResponsesInputCapabilities:
    """MiniMax Responses 输入能力；目前不声明原生音频或视频输入格式。"""
    return configured_responses_input_capabilities(ai)


async def upload_video_file(raw: bytes, name: str, *, mime: str, purpose: str,
                            api_key: str, base_url: str) -> str | None:
    """把视频上传到 MiniMax Files API，返回 file_id；失败 None。

    上传端点从 base_url 推 host（https://host/v1/files/upload）——这是 MiniMax
    专属的文件通道，其它 Provider 上游不识别 mm_file://，不会走到这里。
    失败时用 `diag_log` 记录脱敏信息（HTTP 状态码 / 异常类型），不写文件名/内容。
    """
    import httpx
    from app.core.redaction import diag_log_raw

    api_key = (api_key or "").strip()
    base_url = (base_url or "").rstrip("/")
    if not api_key or not base_url:
        diag_log_raw("minimax.media.upload_video_file", "缺少 api_key 或 base_url，跳过上传")
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
                files={"file": (name, raw, mime or "application/octet-stream")},
                data={"purpose": purpose},
            )
        if r.status_code != 200:
            diag_log_raw("minimax.media.upload_video_file", f"上传失败 status={r.status_code}")
            return None
        import json as _json
        data = r.json()
        file_obj = data.get("file") or {}
        fid = file_obj.get("file_id")
        if not fid:
            diag_log_raw("minimax.media.upload_video_file", "上传成功但响应缺 file_id")
        return str(fid) if fid else None
    except Exception as e:
        diag_log_raw("minimax.media.upload_video_file", f"上传异常 type={type(e).__name__}")
        return None
