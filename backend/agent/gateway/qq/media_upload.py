"""QQ 富媒体统一使用 QQ SDK 协议分块上传。"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from urllib.parse import urlsplit

import aiohttp

from .client import _get_qq_http_session, _qq_request

_log = logging.getLogger("agent.gateway.qq")

QQ_UPLOAD_TIMEOUT_SECONDS = 300
_MD5_10M_SIZE = 10_002_432
_MAX_CHUNK_CONCURRENCY = 10


async def upload_qq_media(
    channel_id: str,
    target: str,
    openid: str,
    file_type: int,
    data: bytes,
    *,
    file_name: str,
) -> dict:
    """上传 QQ 富媒体并返回上传接口响应；不会发送群/私聊消息。"""
    started = time.perf_counter()
    strategy = "chunked"
    try:
        async with asyncio.timeout(QQ_UPLOAD_TIMEOUT_SECONDS):
            result = await _upload_chunked(
                channel_id, target, openid, file_type, data, file_name,
            )
    except TimeoutError:
        _log.warning(
            "[qq-upload] strategy=%s bytes=%d result=timeout elapsed_s=%.1f",
            strategy, len(data), time.perf_counter() - started,
        )
        # 上传请求超时后远端结果未知，不能盲目重传同一非幂等请求。
        raise TimeoutError("QQ 富媒体上传超过 5 分钟，服务端结果未知") from None

    _log.info(
        "[qq-upload] strategy=%s bytes=%d result=complete elapsed_s=%.1f",
        strategy, len(data), time.perf_counter() - started,
    )
    return result if isinstance(result, dict) else {}


async def _upload_chunked(
    channel_id: str,
    target: str,
    openid: str,
    file_type: int,
    data: bytes,
    file_name: str,
) -> dict:
    path = f"/v2/{target}/{openid}"
    md5 = hashlib.md5(data, usedforsecurity=False).hexdigest()
    sha1 = hashlib.sha1(data, usedforsecurity=False).hexdigest()
    md5_10m = hashlib.md5(data[:_MD5_10M_SIZE], usedforsecurity=False).hexdigest()
    prepare = await _qq_request(
        channel_id,
        "POST",
        f"{path}/upload_prepare",
        json_body={
            "file_type": file_type,
            "file_name": file_name,
            "file_size": len(data),
            "md5": md5,
            "sha1": sha1,
            "md5_10m": md5_10m,
        },
        timeout_seconds=QQ_UPLOAD_TIMEOUT_SECONDS,
    )
    if not isinstance(prepare, dict):
        raise RuntimeError("QQ 分块上传初始化响应无效")
    upload_id = prepare.get("upload_id")
    block_size = prepare.get("block_size")
    parts = prepare.get("parts")
    if not isinstance(upload_id, str) or not upload_id:
        raise RuntimeError("QQ 分块上传初始化缺少 upload_id")
    block_size = _positive_int(block_size)
    if block_size is None or not isinstance(parts, list) or not parts:
        raise RuntimeError("QQ 分块上传初始化参数无效")

    expected_part_count = (len(data) + block_size - 1) // block_size
    if len(parts) != expected_part_count:
        raise RuntimeError("QQ 分块上传分片数量与文件大小不匹配")
    indices = [part.get("index") if isinstance(part, dict) else None for part in parts]
    if sorted(indices) != list(range(1, expected_part_count + 1)):
        raise RuntimeError("QQ 分块上传分片序号不连续")

    upload_config = prepare.get("upload_config")
    advertised_concurrency = (
        upload_config.get("concurrency") if isinstance(upload_config, dict)
        else prepare.get("concurrency")
    )
    concurrency = min(
        advertised_concurrency if isinstance(advertised_concurrency, int) and advertised_concurrency > 0 else 1,
        _MAX_CHUNK_CONCURRENCY,
    )
    semaphore = asyncio.Semaphore(concurrency)
    session = await _get_qq_http_session()

    async def upload_part(part: dict) -> None:
        index = part.get("index")
        presigned_url = part.get("presigned_url")
        if not isinstance(index, int) or index < 1 or not isinstance(presigned_url, str):
            raise RuntimeError("QQ 分块上传地址无效")
        try:
            parsed_url = urlsplit(presigned_url)
        except ValueError as error:
            raise RuntimeError("QQ 分块上传地址无效") from error
        host = (parsed_url.hostname or "").lower()
        if (
            parsed_url.scheme != "https"
            or not host
            or parsed_url.username is not None
            or parsed_url.password is not None
            or not (host == "myqcloud.com" or host.endswith(".myqcloud.com"))
        ):
            raise RuntimeError("QQ 分块上传地址不属于受支持的腾讯 COS 域名")
        offset = (index - 1) * block_size
        chunk = data[offset:offset + block_size]
        if not chunk:
            raise RuntimeError("QQ 分块上传数据为空")
        part_md5 = hashlib.md5(chunk, usedforsecurity=False).hexdigest()
        async with semaphore:
            async with session.put(
                presigned_url,
                data=chunk,
                timeout=aiohttp.ClientTimeout(total=QQ_UPLOAD_TIMEOUT_SECONDS),
                allow_redirects=False,
            ) as response:
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f"QQ 分片存储返回 HTTP {response.status}")
            await _qq_request(
                channel_id,
                "POST",
                f"{path}/upload_part_finish",
                json_body={
                    "upload_id": upload_id,
                    "part_index": index,
                    "block_size": len(chunk),
                    "md5": part_md5,
                },
                timeout_seconds=QQ_UPLOAD_TIMEOUT_SECONDS,
            )

    await asyncio.gather(*(upload_part(part) for part in parts))
    complete = await _qq_request(
        channel_id,
        "POST",
        f"{path}/files",
        json_body={"upload_id": upload_id},
        timeout_seconds=QQ_UPLOAD_TIMEOUT_SECONDS,
    )
    if not isinstance(complete, dict) or not complete.get("file_info"):
        raise RuntimeError("QQ 分块上传完成响应缺少 file_info")
    return complete


def _positive_int(value: object) -> int | None:
    """QQ 的 upload_prepare 可能把数值字段序列化为十进制字符串。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdecimal():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None
