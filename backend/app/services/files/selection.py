import io
import zipfile

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import File, Folder
from app.services.storage.trash import move_file_to_trash


async def build_batch_zip(
    db: AsyncSession,
    storage,
    user_id: int,
    file_ids: list[int],
    folder_ids: list[int],
) -> bytes:
    if not file_ids and not folder_ids:
        raise ValueError("未选择文件")

    entries: list[tuple[str, File]] = []
    if file_ids:
        rows = (await db.execute(
            select(File).where(
                File.id.in_(file_ids),
                File.user_id == user_id,
                File.deleted_at.is_(None),
            )
        )).scalars().all()
        for file in rows:
            entries.append((f"{file.display_name}.{file.ext.lower()}", file))

    async def collect_folder(folder_id: int, prefix: str) -> None:
        folder = await get_owned(db, Folder, folder_id, user_id)
        if not folder:
            return
        folder_prefix = f"{prefix}{folder.name}/"
        files = (await db.execute(
            select(File).where(
                File.folder_id == folder_id,
                File.user_id == user_id,
                File.deleted_at.is_(None),
            )
        )).scalars().all()
        for file in files:
            entries.append((f"{folder_prefix}{file.display_name}.{file.ext.lower()}", file))
        children = (await db.execute(
            select(Folder).where(Folder.parent_id == folder_id, Folder.user_id == user_id)
        )).scalars().all()
        for child in children:
            await collect_folder(child.id, folder_prefix)

    for folder_id in folder_ids:
        await collect_folder(folder_id, "")

    if not entries:
        raise FileNotFoundError("未找到可下载的文件")

    buffer = io.BytesIO()
    seen: dict[str, int] = {}
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for archive_path, file in entries:
            if archive_path in seen:
                seen[archive_path] += 1
                stem, extension = archive_path.rsplit(".", 1) if "." in archive_path else (archive_path, "")
                archive_path = f"{stem}_{seen[archive_path]}.{extension}" if extension else f"{stem}_{seen[archive_path]}"
            else:
                seen[archive_path] = 0
            archive.writestr(archive_path, await storage.get(file.storage_key))
    buffer.seek(0)
    return buffer.read()


async def move_files_to_trash(
    db: AsyncSession,
    storage,
    user_id: int,
    file_ids: list[int],
    deleted_at,
) -> list[int]:
    """批量删除文件的跨资源编排，返回实际进入回收站的文件 ID。"""
    if not file_ids:
        return []
    rows = (await db.execute(
        select(File).where(
            File.id.in_(file_ids),
            File.user_id == user_id,
            File.deleted_at.is_(None),
        )
    )).scalars().all()
    for file in rows:
        await move_file_to_trash(storage, file)
        file.deleted_at = deleted_at
    return [file.id for file in rows]


async def move_file_to_trash_by_id(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
    deleted_at,
) -> bool:
    """按归属移动单个文件到回收站，返回是否找到可删除文件。"""
    file = await get_owned(db, File, file_id, user_id)
    if not file or file.deleted_at is not None:
        return False
    await move_file_to_trash(storage, file)
    file.deleted_at = deleted_at
    return True
