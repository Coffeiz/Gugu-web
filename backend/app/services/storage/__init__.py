from abc import ABC, abstractmethod
from pathlib import Path


class StorageBackend(ABC):

    @abstractmethod
    async def put(self, key: str, data: bytes, mime_type: str | None = None) -> None:
        """写入文件"""

    @abstractmethod
    async def get(self, key: str) -> bytes:
        """读取文件内容"""

    @abstractmethod
    async def delete(self, key: str) -> None:
        """删除文件，不存在时静默忽略"""

    @abstractmethod
    async def rename_file(self, old_key: str, new_key: str) -> None:
        """移动/重命名单个文件"""

    @abstractmethod
    async def rename_dir(self, old_prefix: str, new_prefix: str) -> None:
        """重命名目录前缀（项目改名时用）"""

    @abstractmethod
    def public_url(self, key: str) -> str:
        """返回可访问的 URL"""


class LocalStorageBackend(StorageBackend):

    def __init__(self, root: Path):
        self.root = root

    async def put(self, key: str, data: bytes, mime_type: str | None = None) -> None:
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    async def get(self, key: str) -> bytes:
        return (self.root / key).read_bytes()

    async def delete(self, key: str) -> None:
        path = self.root / key
        path.unlink(missing_ok=True)
        try:
            parent = path.parent
            if parent != self.root and parent.exists():
                parent.rmdir()  # 只有空目录才会成功，非空静默忽略
        except OSError:
            pass

    async def rename_file(self, old_key: str, new_key: str) -> None:
        old = self.root / old_key
        new = self.root / new_key
        new.parent.mkdir(parents=True, exist_ok=True)
        old.rename(new)

    async def rename_dir(self, old_prefix: str, new_prefix: str) -> None:
        old = self.root / old_prefix
        new = self.root / new_prefix
        if old.exists():
            new.parent.mkdir(parents=True, exist_ok=True)
            old.rename(new)

    def public_url(self, key: str) -> str:
        return f"/uploads/{key}"


class OSSStorageBackend(StorageBackend):

    def __init__(self, cfg):
        import oss2
        auth = oss2.Auth(cfg.oss_access_key_id, cfg.oss_access_key_secret)
        self.bucket = oss2.Bucket(auth, cfg.oss_endpoint, cfg.oss_bucket)
        self.pfx = cfg.oss_prefix

    async def put(self, key: str, data: bytes, mime_type: str | None = None) -> None:
        import asyncio
        headers = {"Content-Type": mime_type} if mime_type else {}
        await asyncio.to_thread(
            self.bucket.put_object, self.pfx + key, data, headers=headers
        )

    async def get(self, key: str) -> bytes:
        import asyncio
        result = await asyncio.to_thread(self.bucket.get_object, self.pfx + key)
        return result.read()

    async def delete(self, key: str) -> None:
        import asyncio
        await asyncio.to_thread(self.bucket.delete_object, self.pfx + key)

    async def rename_file(self, old_key: str, new_key: str) -> None:
        import asyncio
        await asyncio.to_thread(
            self.bucket.copy_object,
            self.bucket.bucket_name, self.pfx + old_key, self.pfx + new_key,
        )
        await self.delete(old_key)

    async def rename_dir(self, old_prefix: str, new_prefix: str) -> None:
        import asyncio, oss2
        objs = await asyncio.to_thread(
            list, oss2.ObjectIterator(self.bucket, prefix=self.pfx + old_prefix)
        )
        for obj in objs:
            new_key = self.pfx + new_prefix + obj.key[len(self.pfx + old_prefix):]
            await asyncio.to_thread(
                self.bucket.copy_object, self.bucket.bucket_name, obj.key, new_key
            )
            await asyncio.to_thread(self.bucket.delete_object, obj.key)

    def public_url(self, key: str) -> str:
        return f"https://{self.bucket.bucket_name}.{self.bucket.endpoint}/{self.pfx}{key}"


def get_storage() -> StorageBackend:
    """每次调用重新读取 settings，Admin 切换 backend 后下一请求立即生效。"""
    from app.core.config import get_settings
    cfg = get_settings()
    if cfg.storage.backend == "oss":
        return OSSStorageBackend(cfg.storage)
    return LocalStorageBackend(Path(cfg.storage.local_path))
