import asyncio
import io
import os
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from zipfile import BadZipFile, ZipFile
from xml.etree import ElementTree

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.ownership import get_owned
from app.models import File
from app.services.storage import get_storage


THUMB_SIZE_MAP = {"tiny": (20, 75), "card": (192, 82)}
THUMB_SEM = asyncio.Semaphore(max(1, (os.cpu_count() or 2) - 1))
XLSX_PREVIEW_CACHE_MAX = 4
XLSX_PREVIEW_CACHE_MAX_BYTES = 128 * 1024 * 1024
XLSX_PREVIEW_MAX_FILE_BYTES = 256 * 1024 * 1024
XLSX_PREVIEW_MAX_ENTRIES = 20_000
XLSX_PREVIEW_MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024
XLSX_PREVIEW_MAX_ENTRY_UNCOMPRESSED = 128 * 1024 * 1024
XLSX_PREVIEW_MAX_XML_BYTES = 64 * 1024 * 1024
XLSX_PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024
XLSX_PREVIEW_MAX_COMPRESSION_RATIO = 100
XLSX_PREVIEW_MAX_ROWS = 500
XLSX_PREVIEW_MAX_COLS = 60
_XLSX_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
@dataclass
class XlsxPreviewCacheEntry:
    raw: bytes
    sheets: list[dict[str, list[dict[str, object]]]]
    sheet_data: list[dict[str, object]]
    image_paths: dict[int, tuple[str, str]]
    size_bytes: int


_XLSX_PREVIEW_CACHE: OrderedDict[tuple[int, int], XlsxPreviewCacheEntry] = OrderedDict()
_XLSX_PREVIEW_LOCK = asyncio.Lock()
_XLSX_PREVIEW_INFLIGHT: dict[tuple[int, int], asyncio.Task[XlsxPreviewCacheEntry]] = {}
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


class PreviewError(ValueError):
    """文件预览的可预期业务错误。"""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _xlsx_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xlsx_resolve_path(base: str, target: str) -> str:
    parts: list[str] = []
    for part in f"{base}/{target}".split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def _xlsx_attr(element: ElementTree.Element, local_name: str) -> str | None:
    return next((value for key, value in element.attrib.items()
                 if _xlsx_local_name(key) == local_name), None)


def _validate_xlsx_archive(archive: ZipFile, raw_size: int) -> None:
    """在任何 XML 或图片解压前拒绝超出预览预算的压缩包。"""
    if raw_size > XLSX_PREVIEW_MAX_FILE_BYTES:
        raise PreviewError(413, "XLSX 文件超过预览大小限制")
    infos = archive.infolist()
    if len(infos) > XLSX_PREVIEW_MAX_ENTRIES:
        raise PreviewError(413, "XLSX 文件条目数量超过预览限制")
    total_uncompressed = 0
    seen_names: set[str] = set()
    for info in infos:
        if info.filename in seen_names:
            raise PreviewError(400, "XLSX 文件包含重复压缩条目")
        seen_names.add(info.filename)
        if info.file_size > XLSX_PREVIEW_MAX_ENTRY_UNCOMPRESSED:
            raise PreviewError(413, "XLSX 压缩条目超过预览大小限制")
        total_uncompressed += info.file_size
        if total_uncompressed > XLSX_PREVIEW_MAX_TOTAL_UNCOMPRESSED:
            raise PreviewError(413, "XLSX 解压总大小超过预览限制")
        if info.compress_size and info.file_size / info.compress_size > XLSX_PREVIEW_MAX_COMPRESSION_RATIO:
            raise PreviewError(413, "XLSX 压缩比超过预览安全限制")
        if info.filename.startswith("xl/media/") and info.file_size > XLSX_PREVIEW_MAX_IMAGE_BYTES:
            raise PreviewError(413, "XLSX 图片超过预览大小限制")


def _read_xlsx_entry(archive: ZipFile, name: str, *, xml: bool = True) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError as error:
        raise PreviewError(400, "XLSX 文件结构不完整") from error
    if xml and info.file_size > XLSX_PREVIEW_MAX_XML_BYTES:
        raise PreviewError(413, "XLSX XML 内容超过预览限制")
    try:
        return archive.read(name)
    except (BadZipFile, KeyError) as error:
        raise PreviewError(400, "XLSX 文件内容损坏") from error


def _extract_xlsx_preview_sync(raw: bytes) -> tuple[list[dict[str, list[dict[str, object]]]], dict[int, tuple[str, str]]]:
    """读取 XLSX 图片位置元数据，不解压图片正文。

    XLSX 是 ZIP + XML 格式；这里使用 Python 标准库解析，避免把压缩包和
    图片解压工作放到浏览器，也避免前端依赖 jszip。图片正文由单图接口按需解压。
    """
    mime_by_ext = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
        "svg": "image/svg+xml",
    }
    try:
        archive = ZipFile(io.BytesIO(raw))
    except BadZipFile as error:
        raise PreviewError(400, "不是有效的 XLSX 文件") from error

    with archive:
        _validate_xlsx_archive(archive, len(raw))
        workbook = ElementTree.fromstring(_read_xlsx_entry(archive, "xl/workbook.xml"))
        workbook_rels = ElementTree.fromstring(_read_xlsx_entry(archive, "xl/_rels/workbook.xml.rels"))
        rel_targets = {
            relationship.attrib.get("Id", ""): relationship.attrib.get("Target", "")
            for relationship in workbook_rels
            if _xlsx_local_name(relationship.tag) == "Relationship"
        }
        result: list[dict[str, list[dict[str, object]]]] = []
        image_paths: dict[int, tuple[str, str]] = {}
        next_image_id = 0
        sheets = [element for element in workbook.iter() if _xlsx_local_name(element.tag) == "sheet"]
        for sheet in sheets:
            workbook_rel_id = _xlsx_attr(sheet, "id")
            target = rel_targets.get(workbook_rel_id or "")
            if not target:
                result.append({})
                continue
            sheet_path = _xlsx_resolve_path("xl", target)
            sheet_root = ElementTree.fromstring(_read_xlsx_entry(archive, sheet_path))
            drawing = next((element for element in sheet_root.iter()
                            if _xlsx_local_name(element.tag) == "drawing"), None)
            if drawing is None:
                result.append({})
                continue
            drawing_rel_id = _xlsx_attr(drawing, "id")
            sheet_dir = sheet_path.rsplit("/", 1)[0]
            sheet_name = sheet_path.rsplit("/", 1)[1]
            rels_path = f"{sheet_dir}/_rels/{sheet_name}.rels"
            drawing_rels = ElementTree.fromstring(_read_xlsx_entry(archive, rels_path))
            drawing_targets = {
                relationship.attrib.get("Id", ""): relationship.attrib.get("Target", "")
                for relationship in drawing_rels
                if _xlsx_local_name(relationship.tag) == "Relationship"
            }
            drawing_target = drawing_targets.get(drawing_rel_id or "")
            if not drawing_target:
                result.append({})
                continue
            drawing_path = _xlsx_resolve_path(sheet_dir, drawing_target)
            drawing_root = ElementTree.fromstring(_read_xlsx_entry(archive, drawing_path))
            drawing_dir = drawing_path.rsplit("/", 1)[0]
            drawing_name = drawing_path.rsplit("/", 1)[1]
            drawing_rels_path = f"{drawing_dir}/_rels/{drawing_name}.rels"
            drawing_rels_root = ElementTree.fromstring(_read_xlsx_entry(archive, drawing_rels_path))
            media_targets = {
                relationship.attrib.get("Id", ""): relationship.attrib.get("Target", "")
                for relationship in drawing_rels_root
                if _xlsx_local_name(relationship.tag) == "Relationship"
            }
            sheet_images: dict[str, list[dict[str, object]]] = {}
            anchors = [element for element in drawing_root.iter()
                       if _xlsx_local_name(element.tag) in {"oneCellAnchor", "twoCellAnchor"}]
            for anchor in anchors:
                from_node = next((element for element in anchor.iter()
                                  if _xlsx_local_name(element.tag) == "from"), None)
                pic = next((element for element in anchor.iter()
                            if _xlsx_local_name(element.tag) == "pic"), None)
                blip = next((element for element in pic.iter()
                             if _xlsx_local_name(element.tag) == "blip"), None) if pic is not None else None
                embed = _xlsx_attr(blip, "embed") if blip is not None else None
                media_target = media_targets.get(embed or "")
                if from_node is None or not media_target:
                    continue
                row_node = next((element for element in from_node.iter()
                                 if _xlsx_local_name(element.tag) == "row"), None)
                col_node = next((element for element in from_node.iter()
                                 if _xlsx_local_name(element.tag) == "col"), None)
                if row_node is None or col_node is None:
                    continue
                try:
                    row = int(row_node.text or "-1")
                    col = int(col_node.text or "-1")
                except ValueError:
                    continue
                if row < 0 or col < 0 or row >= XLSX_PREVIEW_MAX_ROWS or col >= XLSX_PREVIEW_MAX_COLS:
                    continue
                media_path = _xlsx_resolve_path(drawing_dir, media_target)
                if media_path not in archive.namelist():
                    continue
                extension = media_path.rsplit(".", 1)[-1].lower()
                mime = mime_by_ext.get(extension, "application/octet-stream")
                image: dict[str, object] = {
                    "id": next_image_id,
                }
                image_paths[next_image_id] = (media_path, mime)
                next_image_id += 1
                extent = next((element for element in anchor.iter()
                               if _xlsx_local_name(element.tag) == "ext"), None)
                if extent is not None:
                    try:
                        width = int(int(extent.attrib.get("cx", "0")) / 9525)
                        height = int(int(extent.attrib.get("cy", "0")) / 9525)
                        if width > 0:
                            image["width"] = width
                        if height > 0:
                            image["height"] = height
                    except ValueError:
                        pass
                key = f"{row}:{col}"
                sheet_images.setdefault(key, []).append(image)
            result.append(sheet_images)
        return result, image_paths


def _extract_xlsx_sheet_data_sync(raw: bytes) -> list[dict[str, object]]:
    """读取表格正文的轻量结构，避免把整个 XLSX 下载到浏览器再解析。"""
    try:
        archive = ZipFile(io.BytesIO(raw))
    except BadZipFile as error:
        raise PreviewError(400, "不是有效的 XLSX 文件") from error

    def text_of(element: ElementTree.Element) -> str:
        return ''.join(element.itertext())

    with archive:
        _validate_xlsx_archive(archive, len(raw))
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ElementTree.fromstring(_read_xlsx_entry(archive, "xl/sharedStrings.xml"))
            shared_strings = [text_of(item) for item in shared_root
                              if _xlsx_local_name(item.tag) == "si"]
        workbook = ElementTree.fromstring(_read_xlsx_entry(archive, "xl/workbook.xml"))
        workbook_rels = ElementTree.fromstring(_read_xlsx_entry(archive, "xl/_rels/workbook.xml.rels"))
        rel_targets = {
            relationship.attrib.get("Id", ""): relationship.attrib.get("Target", "")
            for relationship in workbook_rels
            if _xlsx_local_name(relationship.tag) == "Relationship"
        }
        result: list[dict[str, object]] = []
        for sheet in [element for element in workbook.iter() if _xlsx_local_name(element.tag) == "sheet"]:
            sheet_name = sheet.attrib.get("name") or "工作表"
            target = rel_targets.get(_xlsx_attr(sheet, "id") or "")
            if not target:
                result.append({"name": sheet_name, "cells": {}, "merges": [], "rowHeights": {}, "colWidths": {}, "rows": 0, "cols": 0})
                continue
            sheet_path = _xlsx_resolve_path("xl", target)
            root = ElementTree.fromstring(_read_xlsx_entry(archive, sheet_path))
            cells: dict[str, str] = {}
            row_heights: dict[str, int] = {}
            col_widths: dict[str, int] = {}
            max_row = 0
            max_col = 0
            for row in root.iter():
                if _xlsx_local_name(row.tag) == "row":
                    row_number = int(row.attrib.get("r", "0") or 0)
                    if 0 < row_number <= XLSX_PREVIEW_MAX_ROWS and row.attrib.get("ht"):
                        try:
                            row_heights[str(row_number - 1)] = round(float(row.attrib["ht"]) * 1.333)
                        except ValueError:
                            pass
                elif _xlsx_local_name(row.tag) == "col":
                    try:
                        start = int(row.attrib.get("min", "1"))
                        end = int(row.attrib.get("max", str(start)))
                        width = round(float(row.attrib.get("width", "10")) * 8 + 16)
                        for column in range(max(0, start - 1), min(XLSX_PREVIEW_MAX_COLS, end)):
                            col_widths[str(column)] = max(72, width)
                    except ValueError:
                        pass
            for cell in root.iter():
                if _xlsx_local_name(cell.tag) != "c":
                    continue
                ref = cell.attrib.get("r")
                if not ref:
                    continue
                try:
                    column_text = ''.join(char for char in ref if char.isalpha())
                    row_number = int(''.join(char for char in ref if char.isdigit()))
                    column_number = 0
                    for char in column_text.upper():
                        column_number = column_number * 26 + ord(char) - 64
                    if row_number > XLSX_PREVIEW_MAX_ROWS or column_number > XLSX_PREVIEW_MAX_COLS:
                        continue
                except ValueError:
                    continue
                value_node = next((child for child in cell if _xlsx_local_name(child.tag) in {"v", "is"}), None)
                value = "" if value_node is None else text_of(value_node)
                cell_type = cell.attrib.get("t")
                if cell_type == "s":
                    try:
                        value = shared_strings[int(value)]
                    except (ValueError, IndexError):
                        value = ""
                elif cell_type == "inlineStr":
                    value = text_of(value_node) if value_node is not None else ""
                cells[ref] = value
                max_row = max(max_row, row_number)
                max_col = max(max_col, column_number)
            merges: list[dict[str, int]] = []
            for merge in root.iter():
                if _xlsx_local_name(merge.tag) != "mergeCell":
                    continue
                ref = merge.attrib.get("ref", "")
                if ":" not in ref:
                    continue
                start, end = ref.split(":", 1)
                def decode(cell_ref: str) -> tuple[int, int]:
                    letters = ''.join(char for char in cell_ref if char.isalpha()).upper()
                    number = int(''.join(char for char in cell_ref if char.isdigit()))
                    column = 0
                    for char in letters:
                        column = column * 26 + ord(char) - 64
                    return number - 1, column - 1
                start_row, start_col = decode(start)
                end_row, end_col = decode(end)
                if start_row < XLSX_PREVIEW_MAX_ROWS and start_col < XLSX_PREVIEW_MAX_COLS:
                    merges.append({"s": start_row, "c": start_col,
                                   "e": min(end_row, XLSX_PREVIEW_MAX_ROWS - 1),
                                   "d": min(end_col, XLSX_PREVIEW_MAX_COLS - 1)})
                    max_row = max(max_row, min(end_row + 1, XLSX_PREVIEW_MAX_ROWS))
                    max_col = max(max_col, min(end_col + 1, XLSX_PREVIEW_MAX_COLS))
            result.append({"name": sheet_name, "cells": cells, "merges": merges, "rowHeights": row_heights,
                           "colWidths": col_widths, "rows": min(max_row, XLSX_PREVIEW_MAX_ROWS),
                           "cols": min(max_col, XLSX_PREVIEW_MAX_COLS)})
        return result


async def read_xlsx_preview(storage, *, storage_key: str, file_id: int, version: int) -> XlsxPreviewCacheEntry:
    cache_key = (file_id, version)
    async with _XLSX_PREVIEW_LOCK:
        cached = _XLSX_PREVIEW_CACHE.get(cache_key)
        if cached is not None:
            _XLSX_PREVIEW_CACHE.move_to_end(cache_key)
            return cached
        task = _XLSX_PREVIEW_INFLIGHT.get(cache_key)
        if task is None:
            task = asyncio.create_task(_load_xlsx_preview(
                storage, storage_key=storage_key, file_id=file_id, version=version,
            ))
            _XLSX_PREVIEW_INFLIGHT[cache_key] = task
    try:
        return await task
    finally:
        if task.done():
            async with _XLSX_PREVIEW_LOCK:
                if _XLSX_PREVIEW_INFLIGHT.get(cache_key) is task:
                    _XLSX_PREVIEW_INFLIGHT.pop(cache_key, None)


async def _load_xlsx_preview(storage, *, storage_key: str, file_id: int, version: int) -> XlsxPreviewCacheEntry:
    stat = getattr(storage, "stat", None)
    if callable(stat):
        metadata = await stat(storage_key)
        if metadata is not None and metadata.size > XLSX_PREVIEW_MAX_FILE_BYTES:
            raise PreviewError(413, "XLSX 文件超过预览大小限制")
    raw = await storage.get(storage_key)
    if len(raw) > XLSX_PREVIEW_MAX_FILE_BYTES:
        raise PreviewError(413, "XLSX 文件超过预览大小限制")
    (sheets, image_paths), sheet_data = await asyncio.gather(
        asyncio.to_thread(_extract_xlsx_preview_sync, raw),
        asyncio.to_thread(_extract_xlsx_sheet_data_sync, raw),
    )
    extracted = XlsxPreviewCacheEntry(
        raw=raw, sheets=sheets, sheet_data=sheet_data, image_paths=image_paths, size_bytes=len(raw),
    )
    async with _XLSX_PREVIEW_LOCK:
        _XLSX_PREVIEW_CACHE[(file_id, version)] = extracted
        _XLSX_PREVIEW_CACHE.move_to_end((file_id, version))
        total_bytes = sum(item.size_bytes for item in _XLSX_PREVIEW_CACHE.values())
        while len(_XLSX_PREVIEW_CACHE) > XLSX_PREVIEW_CACHE_MAX or total_bytes > XLSX_PREVIEW_CACHE_MAX_BYTES:
            _key, removed = _XLSX_PREVIEW_CACHE.popitem(last=False)
            total_bytes -= removed.size_bytes
    return extracted


async def read_xlsx_preview_image(
    storage,
    *,
    storage_key: str,
    file_id: int,
    version: int,
    image_id: int,
) -> tuple[bytes, str]:
    entry = await read_xlsx_preview(storage, storage_key=storage_key, file_id=file_id, version=version)
    target = entry.image_paths.get(image_id)
    if target is None:
        raise PreviewError(404, "图片不存在")
    path, mime = target
    try:
        content = await asyncio.to_thread(lambda: ZipFile(io.BytesIO(entry.raw)).read(path))
    except (BadZipFile, KeyError) as error:
        raise PreviewError(404, "图片不存在") from error
    return content, mime


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


def read_image_dimensions(raw, mime_type: str | None) -> tuple[int | None, int | None]:
    """读取图片尺寸；无法解析时返回空尺寸，不影响文件上传。

    raw 可以是字节，也可以是可 seek 的文件对象——Pillow 只读 header 就能
    拿到尺寸；mime 是用户可控输入，不能为探宽高把整包拉进内存。
    """
    if not mime_type or mime_type.lower() not in IMAGE_MIMES or mime_type.lower() == "image/svg+xml":
        return None, None
    try:
        from io import BytesIO
        from PIL import Image

        if isinstance(raw, (bytes, bytearray)):
            source = BytesIO(raw)
        else:
            source = raw
            source.seek(0)
        with Image.open(source) as image:
            return image.size
    except Exception:
        return None, None


def thumb_dir() -> Path:
    path = Path(get_settings().storage.local_path) / ".thumbs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def thumb_path(file_id: int, size: str) -> Path:
    return thumb_dir() / f"{file_id}_{size}.webp"


def delete_thumb_cache(file_id: int, storage_root: Path | None = None) -> None:
    # 对账时传入实际扫描根对应的 storage root，测试和多实例运行不会误删默认配置目录。
    directory = (storage_root / ".thumbs") if storage_root is not None else thumb_dir()
    for size in ("tiny", "card"):
        for extension in (".webp", ".jpg"):
            path = directory / f"{file_id}_{size}{extension}"
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
