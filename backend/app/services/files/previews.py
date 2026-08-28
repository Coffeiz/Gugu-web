import asyncio
import os
import shutil
import tempfile
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.ownership import get_owned
from app.models import File
from app.services.storage import get_storage


THUMB_SIZE_MAP = {"tiny": (20, 75), "card": (192, 82)}
THUMB_SEM = asyncio.Semaphore(max(1, (os.cpu_count() or 2) - 1))
OFFICE_EXTS = frozenset({"DOC", "DOCX", "XLS", "XLSX", "PPT", "PPTX"})
IMAGE_MIMES = frozenset({
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "image/avif", "image/bmp", "image/svg+xml", "image/heic", "image/heif",
})
_DETECTED_IMAGE_MIMES = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "GIF": "image/gif",
    "WEBP": "image/webp",
    "AVIF": "image/avif",
    "BMP": "image/bmp",
    "HEIC": "image/heic",
    "HEIF": "image/heif",
}
GENERIC_IMAGE_MIMES = frozenset({"", "application/octet-stream", "binary/octet-stream"})
_PDF_CACHE: dict[str, bytes] = {}


class PreviewError(ValueError):
    """文件预览的可预期业务错误。"""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def resolve_image_mime(raw: bytes, declared_mime: str | None) -> str | None:
    """为旧上传记录从图片内容推断缺失或泛化的 MIME 类型。"""
    declared = (declared_mime or "").lower().strip()
    if declared == "image/jpg":
        declared = "image/jpeg"
    if declared in IMAGE_MIMES:
        return declared
    if declared not in GENERIC_IMAGE_MIMES:
        return None
    try:
        from io import BytesIO
        from PIL import Image

        with Image.open(BytesIO(raw)) as image:
            return _DETECTED_IMAGE_MIMES.get(str(image.format or "").upper())
    except Exception:
        return None


def read_image_dimensions(raw: bytes, mime_type: str | None) -> tuple[int | None, int | None]:
    """读取图片尺寸；无法解析时返回空尺寸，不影响文件上传。"""
    if not mime_type or mime_type.lower() not in IMAGE_MIMES or mime_type.lower() == "image/svg+xml":
        return None, None
    try:
        from io import BytesIO
        from PIL import Image

        with Image.open(BytesIO(raw)) as image:
            return image.size
    except Exception:
        return None, None


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


async def read_file_thumbnail(
    storage,
    *,
    storage_key: str,
    file_id: int,
    mime_type: str,
    size: str,
) -> tuple[bytes, str]:
    """读取并渲染文件缩略图；存储不存在由调用方映射为 HTTP 404。"""
    raw = await storage.get(storage_key)
    mime = resolve_image_mime(raw, mime_type)
    if mime is None:
        raise PreviewError(415, "不是图片文件")
    if size == "full" or mime == "image/svg+xml":
        return raw, mime
    return await render_thumbnail(raw, file_id, size, mime)


async def office_to_pdf(data: bytes, extension: str) -> bytes:
    tmpdir = Path(tempfile.mkdtemp())
    try:
        source = tmpdir / f"input.{extension.lower()}"
        source.write_bytes(data)
        # 将 LibreOffice 用户配置放进本次临时目录，兼容 systemd 的只读 HOME，并隔离并发转换。
        process = await asyncio.create_subprocess_exec(
            "libreoffice", "--headless",
            f"-env:UserInstallation=file://{tmpdir}/loprofile",
            "--convert-to", "pdf",
            "--outdir", str(tmpdir), str(source),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), timeout=120)
        except asyncio.TimeoutError:
            process.kill()
            raise
        if process.returncode != 0:
            raise RuntimeError(f"转换失败：{stderr.decode(errors='replace')[:200]}")
        pdf = tmpdir / "input.pdf"
        if not pdf.exists():
            raise RuntimeError("转换结果为空")
        return pdf.read_bytes()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def render_cached_pdf(raw: bytes, *, cache_key: str, extension: str) -> bytes:
    """转换并缓存 Office/PDF 预览；缓存键由路由按文件版本构造。"""
    cached = _PDF_CACHE.get(cache_key)
    if cached is not None:
        return cached
    if len(_PDF_CACHE) > 50:
        _PDF_CACHE.clear()
    rendered = await office_to_pdf(raw, extension)
    _PDF_CACHE[cache_key] = rendered
    return rendered


async def read_pdf_preview(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
) -> bytes:
    """读取当前用户 Office 文件并生成带版本缓存的 PDF 预览。"""
    file = await get_owned(db, File, file_id, user_id)
    if file is None or file.deleted_at is not None:
        raise PreviewError(404, "文件不存在")
    if file.ext.upper() not in OFFICE_EXTS:
        raise PreviewError(400, "不支持的格式")

    raw = await storage.get(file.storage_key)
    try:
        return await render_cached_pdf(
            raw,
            cache_key=f"{file_id}:{file.updated_at.isoformat()}",
            extension=file.ext,
        )
    except asyncio.TimeoutError as error:
        raise PreviewError(422, "文档转换超时") from error
    except RuntimeError as error:
        raise PreviewError(422, str(error)) from error
