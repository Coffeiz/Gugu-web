"""上传请求体的分块收流：内存峰值与单文件上限解耦。

端点把 UploadFile 按 1MB 分块读进 SpooledTemporaryFile（小文件驻内存、
大文件自动滚盘到系统临时目录），边收边计数并算 sha256；超过 limit 立刻
抛 HTTPException，不再把整个请求体 materialize 成单个 bytes 对象。
"""
from __future__ import annotations

import hashlib
import tempfile

from fastapi import HTTPException
from starlette.datastructures import UploadFile

_SPOOL_CHUNK = 1024 * 1024
_SPOOL_RAM_MAX = 8 * 1024 * 1024


async def spool_upload(file: UploadFile, *, limit: int, status_code: int, message: str):
    """分块收流，返回 (spool, 总字节数, sha256 hex)；spool 位置在 0。

    超限或读流异常时 spool 已关闭。后续消费方（storage.put_stream / stage_stream）
    负责 seek(0) 并在用完后 close。
    """
    spool = tempfile.SpooledTemporaryFile(max_size=_SPOOL_RAM_MAX)
    digest = hashlib.sha256()
    total = 0
    try:
        while True:
            chunk = await file.read(_SPOOL_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise HTTPException(status_code=status_code, detail=message)
            digest.update(chunk)
            spool.write(chunk)
    except BaseException:
        spool.close()
        raise
    spool.seek(0)
    return spool, total, digest.hexdigest()
