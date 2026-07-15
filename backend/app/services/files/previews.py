import asyncio
import os
from pathlib import Path

from app.core.config import get_settings
from app.services.storage import get_storage


THUMB_SIZE_MAP = {"tiny": (20, 75), "card": (192, 82)}
THUMB_SEM = asyncio.Semaphore(max(1, (os.cpu_count() or 2) - 1))


def thumb_dir() -> Path:
    path = Path(get_settings().storage.local_path) / ".thumbs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def thumb_path(file_id: int, size: str) -> Path:
    return thumb_dir() / f"{file_id}_{size}.webp"


def delete_thumb_cache(file_id: int) -> None:
    for size in ("tiny", "card"):
        for extension in (".webp", ".jpg"):
            path = thumb_dir() / f"{file_id}_{size}{extension}"
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                pass


def generate_thumbs_sync(raw: bytes, file_id: int, sizes: tuple = ("tiny",)) -> None:
    """生成指定尺寸的 WebP 缩略图并写入磁盘缓存。在线程中运行。"""
    from PIL import Image
    import io

    directory = thumb_dir()
    image = Image.open(io.BytesIO(raw))
    try:
        biggest = max(THUMB_SIZE_MAP[size][0] for size in sizes)
        image.draft(None, (biggest, biggest))
    except Exception:
        pass
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA") if "transparency" in image.info else image.convert("RGB")
    for size_name in sizes:
        max_px, quality = THUMB_SIZE_MAP[size_name]
        output = image.copy()
        output.thumbnail((max_px, max_px), Image.LANCZOS)
        buffer = io.BytesIO()
        output.save(buffer, format="WEBP", quality=quality)
        (directory / f"{file_id}_{size_name}.webp").write_bytes(buffer.getvalue())


def generate_thumb_jpeg_fallback(raw: bytes, size: str) -> bytes | None:
    """WebP 生成失败时的降级：输出缩小的 JPEG，避免返回原始大图。"""
    from PIL import Image
    import io

    try:
        image = Image.open(io.BytesIO(raw))
        max_px, _ = THUMB_SIZE_MAP.get(size, (192, 82))
        try:
            image.draft(None, (max_px, max_px))
        except Exception:
            pass
        if hasattr(image, "n_frames") and image.n_frames > 1:
            image.seek(0)
        image = image.convert("RGB")
        image.thumbnail((max_px, max_px), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=80)
        return buffer.getvalue()
    except Exception:
        return None


async def pregenerate_thumb(storage_key: str, file_id: int) -> None:
    try:
        raw = await get_storage().get(storage_key)
        async with THUMB_SEM:
            await asyncio.to_thread(generate_thumbs_sync, raw, file_id)
    except Exception:
        pass


async def render_thumbnail(raw: bytes, file_id: int, size: str, fallback_mime: str) -> tuple[bytes, str]:
    cache_path = thumb_path(file_id, size)
    if cache_path.exists():
        cache_path.touch()
        return cache_path.read_bytes(), "image/webp"

    try:
        async with THUMB_SEM:
            await asyncio.to_thread(generate_thumbs_sync, raw, file_id, (size,))
        if cache_path.exists():
            return cache_path.read_bytes(), "image/webp"
    except Exception as error:
        import traceback
        print(f"[缩略图] WebP 生成失败 fid={file_id} size={size}: {error}\n{traceback.format_exc()}")

    try:
        async with THUMB_SEM:
            jpeg_bytes = await asyncio.to_thread(generate_thumb_jpeg_fallback, raw, size)
        if jpeg_bytes:
            return jpeg_bytes, "image/jpeg"
    except Exception:
        pass
    return raw, fallback_mime
