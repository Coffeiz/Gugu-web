"""阿里云 OSS 存储后端。

该模块只负责把 StorageBackend 契约映射到 oss2 SDK；是否启用由上层配置决定。
当前默认仍使用 LocalStorageBackend，不在这里处理迁移、双写或 key 策略。
"""

from __future__ import annotations

from app.core.errors import RetryableError
from app.core.redaction import diag_log
from app.services.storage import StorageBackend

import asyncio
import logging

_log = logging.getLogger("app.services.storage.oss")
_OSS_RETRY_BACKOFF = [1, 2, 4]


def _oss_is_transient(error: BaseException) -> bool:
    """只把连接错误和 5xx 视为可重试，4xx/未知异常直接上抛。"""
    import oss2.exceptions as oss_exc

    if isinstance(error, oss_exc.RequestError):
        return True
    if isinstance(error, oss_exc.OssError):
        return getattr(error, "status", 0) >= 500
    return False


async def _oss_retry(where: str, code: str, public_message: str, fn, *args, **kwargs):
    """在线程池中执行 SDK 调用，并对窄白名单内的瞬时错误退避重试。"""
    last: BaseException | None = None
    for index in range(len(_OSS_RETRY_BACKOFF) + 1):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except Exception as error:
            if not _oss_is_transient(error):
                raise
            last = error
            if index >= len(_OSS_RETRY_BACKOFF):
                diag_log(where, error)
                _log.warning("%s 重试 %d 次后仍失败：%s", where, index, type(error).__name__)
                raise RetryableError(code, public_message, cause=error, attempt=index) from error
            _log.info(
                "%s 瞬时错误 %s，%ss 后重试(%d)",
                where,
                type(error).__name__,
                _OSS_RETRY_BACKOFF[index],
                index + 1,
            )
            await asyncio.sleep(_OSS_RETRY_BACKOFF[index])
    if last:
        raise last


class OSSStorageBackend(StorageBackend):

    def __init__(self, cfg):
        import oss2

        auth = oss2.Auth(cfg.oss_access_key_id, cfg.oss_access_key_secret)
        self.bucket = oss2.Bucket(auth, cfg.oss_endpoint, cfg.oss_bucket)
        self.pfx = cfg.oss_prefix

    async def put(self, key: str, data: bytes, mime_type: str | None = None) -> None:
        headers = {"Content-Type": mime_type} if mime_type else {}
        await _oss_retry(
            "storage.oss.put",
            "oss.put_timeout",
            "文件上传失败，请稍后重试",
            self.bucket.put_object,
            self.pfx + key,
            data,
            headers=headers,
        )

    async def get(self, key: str) -> bytes:
        result = await _oss_retry(
            "storage.oss.get",
            "oss.get_timeout",
            "文件读取失败，请稍后重试",
            self.bucket.get_object,
            self.pfx + key,
        )
        return result.read()

    async def delete(self, key: str) -> None:
        await _oss_retry(
            "storage.oss.delete",
            "oss.delete_timeout",
            "文件删除失败，请稍后重试",
            self.bucket.delete_object,
            self.pfx + key,
        )

    async def rename_file(self, old_key: str, new_key: str) -> None:
        await asyncio.to_thread(
            self.bucket.copy_object,
            self.bucket.bucket_name,
            self.pfx + old_key,
            self.pfx + new_key,
        )
        await self.delete(old_key)

    async def move_to_trash(self, old_key: str, trash_key: str) -> str:
        return old_key

    async def restore_from_trash(self, old_key: str, new_key: str) -> str:
        if old_key == new_key:
            return old_key
        await self.rename_file(old_key, new_key)
        return new_key

    async def rename_dir(self, old_prefix: str, new_prefix: str) -> None:
        import oss2

        objects = await asyncio.to_thread(
            list,
            oss2.ObjectIterator(self.bucket, prefix=self.pfx + old_prefix),
        )
        for obj in objects:
            new_key = self.pfx + new_prefix + obj.key[len(self.pfx + old_prefix):]
            await asyncio.to_thread(
                self.bucket.copy_object,
                self.bucket.bucket_name,
                obj.key,
                new_key,
            )
            await asyncio.to_thread(self.bucket.delete_object, obj.key)

    def public_url(self, key: str) -> str:
        return f"https://{self.bucket.bucket_name}.{self.bucket.endpoint}/{self.pfx}{key}"

    def fetch_url(self, key: str) -> str | None:
        try:
            return self.bucket.sign_url("GET", self.pfx + key, 3600)
        except Exception:
            return None

    def presign_put(self, key: str, mime_type: str | None = None, expires: int = 600) -> str:
        headers = {"Content-Type": mime_type} if mime_type else {}
        return self.bucket.sign_url("PUT", self.pfx + key, expires, headers=headers)

    async def exists(self, key: str) -> bool:
        return await _oss_retry(
            "storage.oss.exists",
            "oss.exists_timeout",
            "文件状态查询失败，请稍后重试",
            self.bucket.object_exists,
            self.pfx + key,
        )

    async def list_keys(self) -> list[str]:
        import oss2

        def list_objects():
            prefix_length = len(self.pfx)
            return [
                obj.key[prefix_length:]
                for obj in oss2.ObjectIterator(self.bucket, prefix=self.pfx)
                if not obj.key.endswith("/")
            ]

        return await asyncio.to_thread(list_objects)

    async def delete_prefix(self, prefix: str) -> int:
        import oss2

        if not prefix or not prefix.strip("/ ."):
            raise ValueError("delete_prefix 前缀不能为空/根（防误清整个存储）")

        def delete_objects() -> int:
            keys = [
                obj.key
                for obj in oss2.ObjectIterator(self.bucket, prefix=self.pfx + prefix)
            ]
            for index in range(0, len(keys), 1000):
                self.bucket.batch_delete_objects(keys[index:index + 1000])
            return len(keys)

        return await asyncio.to_thread(delete_objects)
