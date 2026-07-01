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

    def fetch_url(self, key: str) -> str | None:
        """返回一个**外部第三方可直接 HTTP 抓取**的临时 URL（如给 QQ 富媒体 url 模式用）。
        本地存储没有公网地址 → None（调用方退回 base64 上传）。"""
        return None

    @abstractmethod
    async def exists(self, key: str) -> bool:
        """物理对象是否存在（对账用）"""

    @abstractmethod
    async def list_keys(self) -> list[str]:
        """列出存储里所有对象 key（对账用；含 .agent/.chat_staging 等内部 key，由调用方过滤）"""

    @abstractmethod
    async def delete_prefix(self, prefix: str) -> int:
        """删除该前缀下**所有**对象（账户注销清数据用），返回删除数量。

        前缀必须非空（如 f"{user_id}/"）——空/根前缀直接抛 ValueError，防止把整个存储清了。
        """


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

    async def exists(self, key: str) -> bool:
        return (self.root / key).is_file()

    async def list_keys(self) -> list[str]:
        import asyncio

        def _walk():
            if not self.root.exists():
                return []
            return [p.relative_to(self.root).as_posix()
                    for p in self.root.rglob("*") if p.is_file()]
        return await asyncio.to_thread(_walk)

    async def delete_prefix(self, prefix: str) -> int:
        import asyncio
        import shutil
        if not prefix or not prefix.strip("/ ."):
            raise ValueError("delete_prefix 前缀不能为空/根（防误清整个存储）")
        target = (self.root / prefix.strip("/")).resolve()
        root = self.root.resolve()
        if target == root or root not in target.parents:
            raise ValueError("delete_prefix 目标越出存储根目录")

        def _rm() -> int:
            if not target.exists():
                return 0
            n = sum(1 for p in target.rglob("*") if p.is_file())
            shutil.rmtree(target, ignore_errors=True)
            return n
        return await asyncio.to_thread(_rm)


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

    def fetch_url(self, key: str) -> str | None:
        # 签名 URL：私有 bucket 也能抓、限时 1h（QQ 抓取是即时的，够用）
        try:
            return self.bucket.sign_url("GET", self.pfx + key, 3600)
        except Exception:
            return None

    def presign_put(self, key: str, mime_type: str | None = None, expires: int = 600) -> str:
        """返回有效期 expires 秒的 OSS presigned PUT URL，供浏览器直传。"""
        headers = {"Content-Type": mime_type} if mime_type else {}
        return self.bucket.sign_url("PUT", self.pfx + key, expires, headers=headers)

    async def exists(self, key: str) -> bool:
        import asyncio
        return await asyncio.to_thread(self.bucket.object_exists, self.pfx + key)

    async def list_keys(self) -> list[str]:
        import asyncio, oss2
        def _list():
            n = len(self.pfx)
            return [obj.key[n:] for obj in oss2.ObjectIterator(self.bucket, prefix=self.pfx)
                    if not obj.key.endswith("/")]
        return await asyncio.to_thread(_list)

    async def delete_prefix(self, prefix: str) -> int:
        import asyncio, oss2
        if not prefix or not prefix.strip("/ ."):
            raise ValueError("delete_prefix 前缀不能为空/根（防误清整个存储）")

        def _rm() -> int:
            keys = [obj.key for obj in oss2.ObjectIterator(self.bucket, prefix=self.pfx + prefix)]
            for i in range(0, len(keys), 1000):   # batch_delete 单次上限 1000
                self.bucket.batch_delete_objects(keys[i:i + 1000])
            return len(keys)
        return await asyncio.to_thread(_rm)


def get_storage() -> StorageBackend:
    """每次调用重新读取 settings，Admin 切换 backend 后下一请求立即生效。"""
    from app.core.config import get_settings
    cfg = get_settings()
    if cfg.storage.backend == "oss":
        return OSSStorageBackend(cfg.storage)
    return LocalStorageBackend(Path(cfg.storage.local_path))
