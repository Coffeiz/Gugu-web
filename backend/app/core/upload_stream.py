"""校验 multipart 临时流并计算摘要，不重复复制上传正文。"""
from __future__ import annotations

import hashlib
from fastapi import HTTPException
from starlette.datastructures import UploadFile

_SPOOL_CHUNK = 1024 * 1024
async def spool_upload(file: UploadFile, *, limit: int, status_code: int, message: str):
    """校验原始上传流，返回 (stream, 总字节数, sha256 hex)，流位置在 0。

    multipart 解析器已经把正文写入 UploadFile 的 SpooledTemporaryFile。直接在
    这条流上分块计数和计算摘要，避免把大文件再写一份临时副本；后续存储消费方
    负责 seek(0) 并在用完后关闭 UploadFile。
    """
    stream = file.file
    digest = hashlib.sha256()
    total = 0
    try:
        await file.seek(0)
        while True:
            chunk = await file.read(_SPOOL_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise HTTPException(status_code=status_code, detail=message)
            digest.update(chunk)
    except BaseException:
        await file.close()
        raise
    await file.seek(0)
    return stream, total, digest.hexdigest()
