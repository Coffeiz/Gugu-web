import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass
class StorageObjectInfo:
    """对象元信息（P1.1；对账/迁移校验用）。"""
    size: int
    mtime: float | None = None      # epoch 秒；对象存储可能无 → None
    checksum: str | None = None     # etag/md5，Local 暂不算

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

    async def move_to_trash(self, old_key: str, trash_key: str) -> str:
        """将对象放入回收站，返回删除/恢复流程应继续使用的 key。"""
        await self.rename_file(old_key, trash_key)
        return trash_key

    async def restore_from_trash(self, old_key: str, new_key: str) -> str:
        """从回收站恢复对象，返回恢复后的 key。"""
        await self.rename_file(old_key, new_key)
        return new_key

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

    # ── 复制 / 元信息（P1.1；迁移与对账基元，有默认实现）─────────────────────────
    async def copy(self, src_key: str, dst_key: str) -> None:
        """复制单个对象。默认 get+put；有原生 copy 的后端（OSS）可覆盖优化。"""
        data = await self.get(src_key)
        await self.put(dst_key, data)

    async def stat(self, key: str) -> "StorageObjectInfo | None":
        """对象元信息（size/mtime/checksum）；不存在→None。默认 exists+get（低效，迁移校验用；
        Local/OSS 各自覆盖成高效实现）。"""
        if not await self.exists(key):
            return None
        return StorageObjectInfo(size=len(await self.get(key)))

    # ── 文件夹生命周期钩子（P1.1）──────────────────────────────────────────────
    # Local 真 mkdir/mv/rm/清祖先；**对象存储无「空目录」概念、目录由 key 隐含 → 默认 no-op**，
    # 因此 FileService 直接调这些钩子、不写 `if isinstance(storage, Local)`（物理动作由 backend 自决）。
    async def ensure_folder(self, path: str) -> None:
        """物化一个（可能为空的）文件夹目录（root 相对，含 uid 前缀）。默认 no-op。"""
        return None

    async def move_folder(self, old_path: str, new_path: str) -> None:
        """移动/改名一个文件夹目录骨架。默认 no-op（对象存储随文件 key 搬）。"""
        return None

    async def remove_folder(self, path: str) -> None:
        """移除一个文件夹目录（其下文件应已被调用方搬走/删除）。默认 no-op。"""
        return None

    async def remove_empty_ancestors(self, key: str) -> None:
        """删除/移动某 key 后，自底向上清理因此变空的父目录（治孤儿空目录）。默认 no-op。"""
        return None


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

    async def list_dirs(self, prefix: str = "") -> list[str]:
        """列出 prefix 下所有子目录 key（root 相对，posix；不含 prefix 自身）。folder_doctor 对账用。"""
        def _walk():
            base = self.root / prefix if prefix else self.root
            if not base.is_dir():
                return []
            return [p.relative_to(self.root).as_posix()
                    for p in base.rglob("*") if p.is_dir()]
        return await asyncio.to_thread(_walk)

    async def dir_has_files(self, path: str) -> bool:
        """该目录子树内是否有文件（对账判断孤儿空目录用）。"""
        def _chk():
            d = self.root / path
            return d.is_dir() and any(p.is_file() for p in d.rglob("*"))
        return await asyncio.to_thread(_chk)

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

    # ── P1.1 文件夹生命周期钩子 + stat/copy（真实文件系统实现）───────────────────
    async def copy(self, src_key: str, dst_key: str) -> None:
        import shutil

        def _cp():
            dst = self.root / dst_key
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.root / src_key, dst)
        await asyncio.to_thread(_cp)

    async def stat(self, key: str) -> StorageObjectInfo | None:
        def _st():
            p = self.root / key
            if not p.is_file():
                return None
            s = p.stat()
            return StorageObjectInfo(size=s.st_size, mtime=s.st_mtime)
        return await asyncio.to_thread(_st)

    async def ensure_folder(self, path: str) -> None:
        def _mk():
            (self.root / path).mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(_mk)

    async def move_folder(self, old_path: str, new_path: str) -> None:
        def _mv():
            old = self.root / old_path
            new = self.root / new_path
            if old.is_dir():
                new.parent.mkdir(parents=True, exist_ok=True)
                old.rename(new)
        await asyncio.to_thread(_mv)

    async def remove_folder(self, path: str) -> None:
        """仅当子树内无文件时移除**该目录本身**（文件应已被搬走）——防误删数据。
        **不清祖先**：父目录可能是仍存活的空文件夹（P1.2 物化的空夹须持久），清了会造成
        DB 有夹、盘上没夹（重现 123）。孤儿祖先由文件夹级 remove_folder / 对账工具处理。"""
        import shutil

        def _rm():
            d = self.root / path
            if not d.is_dir():
                return
            if any(p.is_file() for p in d.rglob("*")):
                return              # 还有文件残留，保守不删
            shutil.rmtree(d, ignore_errors=True)
        await asyncio.to_thread(_rm)

    async def remove_empty_ancestors(self, key: str) -> None:
        def _prune():
            p = (self.root / key).parent
            while p != self.root and self.root in p.parents:
                if p.is_dir():
                    try:
                        p.rmdir()      # 仅空目录成功；非空 → 停止上溯
                    except OSError:
                        break
                # 目录已不存在（可能被 delete 先清过一层）→ 继续向上，不中断
                p = p.parent
        await asyncio.to_thread(_prune)


from app.services.storage.backends.oss import OSSStorageBackend

def get_storage() -> StorageBackend:
    """每次调用重新读取 settings，Admin 切换 backend 后下一请求立即生效。"""
    from app.core.config import get_settings
    cfg = get_settings()
    if cfg.storage.backend == "oss":
        return OSSStorageBackend(cfg.storage)
    return LocalStorageBackend(Path(cfg.storage.local_path))
