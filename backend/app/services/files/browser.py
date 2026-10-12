from datetime import datetime
from typing import Any, Optional
from urllib.parse import unquote, urlsplit

from sqlalchemy import String, case, func, literal, literal_column, select, tuple_, type_coerce
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, Folder, Project
from app.core.ownership import get_owned
from app.search.query import keyword_condition, keyword_score, normalize_queries
from app.services.files.pagination import apply_keyset, decode_cursor, encode_cursor

def file_listing_conditions(
    user_id: int,
    space: Optional[str] = None,
    project_id: Optional[int] = None,
    workspace_directory_id: Optional[int] = None,
    mind_map_id: Optional[int] = None,
    ext: Optional[str] = None,
    query: Optional[str] = None,
) -> list:
    """构造单个逻辑目录的 File 过滤条件，不提前关联展示实体。"""
    conditions = [File.user_id == user_id, File.deleted_at.is_(None)]
    if space:
        conditions.append(File.space == space)
    if workspace_directory_id is not None:
        conditions.append(File.workspace_directory_id == workspace_directory_id)
    if project_id is not None:
        conditions.append(File.project_id == project_id)
    # 文件夹作用域由 list_file_page_rows 的 coalesce(folder_id, 0) key 覆盖；
    # 不再叠加 folder_id = / IS NULL，避免 PostgreSQL generic plan 将两者
    # 错当成独立过滤并 bitmap 扫描整目录。
    if mind_map_id is not None:
        conditions.append(File.mind_map_id == mind_map_id)
    if ext:
        conditions.append(File.ext == ext.upper())
    if query:
        conditions.append(File.display_name.ilike(f"%{query}%"))
    return conditions


def _file_page_sort_column(sort_by: str, *, dialect_name: str, project_id=None, space=None):
    def type_group():
        categories = (
            ("image", ("JPG", "JPEG", "PNG", "GIF", "WEBP", "SVG", "ICO", "BMP", "AVIF", "HEIC", "HEIF", "TIF", "TIFF")),
            ("video", ("MP4", "MOV", "AVI", "MKV", "WEBM", "WMV", "FLV", "M4V")),
            ("audio", ("MP3", "WAV", "FLAC", "AAC", "OGG", "M4A", "WMA", "OPUS")),
            ("sheet", ("XLS", "XLSX", "CSV", "ODS", "NUMBERS")),
            ("slide", ("PPT", "PPTX", "KEY", "ODP")),
            ("archive", ("ZIP", "RAR", "7Z", "TAR", "GZ", "BZ2", "XZ")),
            ("code", ("JS", "TS", "JSX", "TSX", "VUE", "PY", "GO", "RS", "JAVA", "CPP", "C", "CS", "RB", "SWIFT", "PHP", "KT", "DART", "SH", "HTML", "CSS", "SCSS", "LESS", "XML", "JSON", "YAML", "YML", "TOML", "MD", "MDX", "GRAPHQL")),
        )
        if dialect_name == "postgresql":
            return case(*[
                (File.ext.in_([literal_column(f"'{ext}'") for ext in exts]), literal_column(f"'{category}'"))
                for category, exts in categories
            ], else_=literal_column("'doc'"))
        return case(*[(File.ext.in_(exts), category) for category, exts in categories], else_="doc")

    group = type_group()
    columns = {
        "name": (
            File.display_name.collate("gugu_natural_zh")
            if dialect_name == "postgresql"
            else func.lower(File.display_name)
        ),
        "type": type_coerce(group, String()) + (literal_column("':'") if dialect_name == "postgresql" else literal(":")) + func.lower(File.ext),
        "stage": (
            File.id if project_id is not None else
            File.stage_name.collate("gugu_natural_zh") if dialect_name == "postgresql" else
            func.lower(File.stage_name)
        ),
        "createdAt": File.created_at,
        "size": File.size_bytes,
        "id": File.id,
    }
    return columns[sort_by]


def _file_scope_key_column():
    """用非空 scope key 统一 personal/project/workspace/mind 的索引前缀。"""
    return func.coalesce(
        File.project_id, File.workspace_directory_id, File.mind_map_id, literal_column("0"),
    )


def _cursor_sort_value(sort_by: str, value: Any, *, project_id=None):
    if sort_by == "createdAt":
        return datetime.fromisoformat(value)
    if sort_by == "stage" and project_id is not None:
        return int(value)
    if sort_by in {"size", "id"}:
        return int(value)
    return str(value)


async def list_file_page_rows(
    db: AsyncSession,
    user_id,
    *,
    limit: int,
    cursor: str | None,
    sort_by: str,
    sort_order: str,
    space: Optional[str] = None,
    project_id: Optional[int] = None,
    folder_id: Optional[int] = None,
    workspace_directory_id: Optional[int] = None,
    mind_map_id: Optional[int] = None,
    ext: Optional[str] = None,
    query: Optional[str] = None,
):
    scope = {
        "resource": "files",
        "space": space,
        "project_id": project_id,
        "folder_id": folder_id,
        "workspace_directory_id": workspace_directory_id,
        "mind_map_id": mind_map_id,
        "ext": ext.upper() if ext else None,
        "q": query,
        "sort_by": sort_by,
        "sort_order": sort_order,
    }
    if sort_by == "stage" and project_id is None and space not in {"personal", "workspace"}:
        from fastapi import HTTPException

        raise HTTPException(status_code=422, detail="阶段排序需要指定项目，或使用个人/Workspace 空间")
    if not space:
        from fastapi import HTTPException

        raise HTTPException(status_code=422, detail="文件分页必须指定空间")
    if space == "project" and project_id is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=422, detail="项目文件分页必须指定项目")
    sort_column = _file_page_sort_column(
        sort_by, dialect_name=db.get_bind().dialect.name, project_id=project_id, space=space,
    )
    filters = file_listing_conditions(
        user_id, space=space, project_id=project_id,
        workspace_directory_id=workspace_directory_id, mind_map_id=mind_map_id,
        ext=ext, query=query,
    )
    scope_id = project_id or workspace_directory_id or mind_map_id or 0
    folder_key = folder_id or 0
    filters.extend((
        _file_scope_key_column() == scope_id,
        func.coalesce(File.folder_id, literal_column("0")) == folder_key,
    ))
    boundary = decode_cursor(cursor, user_id=user_id, scope=scope)
    page_stmt = select(File.id, sort_column.label("page_sort")).where(*filters)
    if boundary:
        page_stmt = apply_keyset(
            page_stmt, model=File, sort_column=sort_column,
            sort_value=_cursor_sort_value(sort_by, boundary[0], project_id=project_id),
            entity_id=boundary[1], direction=sort_order,
        )
    order = sort_column.asc() if sort_order == "asc" else sort_column.desc()
    id_order = File.id.asc() if sort_order == "asc" else File.id.desc()
    page_rows = (await db.execute(
        page_stmt.order_by(order, id_order).limit(limit + 1)
    )).all()
    has_more = len(page_rows) > limit
    page_rows = page_rows[:limit]
    if page_rows:
        page_ids = [row.id for row in page_rows]
        details = (await db.execute(
            select(File, Project.name, Project.color, Folder.name)
            .outerjoin(Project, Project.id == File.project_id)
            .outerjoin(Folder, Folder.id == File.folder_id)
            # page_ids 已由上面的用户/目录条件查询确定；详情查询只重复验证所有权和
            # 存活状态，避免优化器为作用域过滤扫描整目录的排序索引。
            .where(
                File.id.in_(page_ids),
                File.user_id == user_id,
                File.deleted_at.is_(None),
            )
        )).all()
        detail_by_id = {row[0].id: row for row in details}
        items = [
            (*detail_by_id[row.id], row.page_sort)
            for row in page_rows if row.id in detail_by_id
        ]
    else:
        items = []
    next_cursor = None
    if has_more and items:
        last = page_rows[-1]
        next_cursor = encode_cursor(
            user_id=user_id, scope=scope, sort_value=last.page_sort, entity_id=last.id,
        )
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}


async def get_file_detail_row(db: AsyncSession, user_id, file_id: int):
    """读取单个存活文件及其项目/文件夹展示信息。"""
    return (await db.execute(
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(
            File.id == file_id,
            File.user_id == user_id,
            File.deleted_at.is_(None),
        )
    )).first()


async def get_folder_path_rows(db: AsyncSession, user_id, folder_id: int, *, expected_scope=None):
    """按 ID 有界读取祖先链；越权、软删除、跨 scope 或循环均失败关闭。"""
    folder = await get_owned(db, Folder, folder_id, user_id)
    if folder is None or folder.deleted_at is not None:
        return None
    scope = (folder.project_id, folder.workspace_directory_id)
    if expected_scope is not None and scope != expected_scope:
        return None
    rows = [folder]
    seen = {folder.id}
    parent_id = folder.parent_id
    for _ in range(64):
        if parent_id is None:
            return list(reversed(rows))
        if parent_id in seen:
            return None
        parent = await get_owned(db, Folder, parent_id, user_id)
        if parent is None or parent.deleted_at is not None:
            return None
        if (parent.project_id, parent.workspace_directory_id) != scope:
            return None
        seen.add(parent.id)
        rows.append(parent)
        parent_id = parent.parent_id
    if parent_id is not None:
        return None
    return list(reversed(rows))


async def get_folder_detail_row(db: AsyncSession, user_id, folder_id: int):
    folder = await get_owned(db, Folder, folder_id, user_id)
    if folder is None or folder.deleted_at is not None:
        return None
    count = await file_count_for_folder(db, user_id, folder.id)
    return folder, count


def _relative_path_parts(path: str) -> list[str] | None:
    parsed = urlsplit(unquote(path))
    logical_path = parsed.path
    if (parsed.scheme or parsed.netloc or logical_path.startswith(("/", "\\"))
            or "\\" in logical_path or "\x00" in logical_path):
        return None
    parts = [part for part in logical_path.split("/") if part not in {"", "."}]
    return parts or None


async def _resolve_relative_parent_path(db: AsyncSession, user_id, source_file: File,
                                       folder_path: list[Folder], parts: list[str]):
    current_path = list(folder_path)
    for part in parts[:-1]:
        if part == "..":
            if not current_path:
                return None
            current_path.pop()
            continue
        parent_id = current_path[-1].id if current_path else None
        folder = (await db.execute(select(Folder).where(
            Folder.user_id == user_id,
            Folder.deleted_at.is_(None),
            Folder.parent_id == parent_id if parent_id is not None else Folder.parent_id.is_(None),
            Folder.project_id == source_file.project_id if source_file.project_id is not None else Folder.project_id.is_(None),
            Folder.workspace_directory_id == source_file.workspace_directory_id if source_file.workspace_directory_id is not None else Folder.workspace_directory_id.is_(None),
            Folder.name == part,
        ).limit(1))).scalar_one_or_none()
        if folder is None:
            return None
        current_path.append(folder)
    return current_path


async def _find_relative_file(db: AsyncSession, user_id, source_file: File,
                              current_path: list[Folder], basename: str):
    if basename == "..":
        return None
    parent_id = current_path[-1].id if current_path else None
    stem, dot, extension = basename.rpartition(".")
    if dot and stem:
        name_condition = (File.display_name == stem) & (File.ext == extension.upper())
    else:
        name_condition = (File.display_name == basename) & (File.ext == "")
    return (await db.execute(
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(
            File.user_id == user_id,
            File.deleted_at.is_(None),
            File.space == source_file.space,
            File.project_id == source_file.project_id if source_file.project_id is not None else File.project_id.is_(None),
            File.workspace_directory_id == source_file.workspace_directory_id if source_file.workspace_directory_id is not None else File.workspace_directory_id.is_(None),
            File.mind_map_id == source_file.mind_map_id if source_file.mind_map_id is not None else File.mind_map_id.is_(None),
            File.folder_id == parent_id if parent_id is not None else File.folder_id.is_(None),
            name_condition,
        ).limit(1)
    )).first()


async def _find_relative_folder(db: AsyncSession, user_id, source_file: File,
                                current_path: list[Folder], basename: str):
    if basename in {"", ".", ".."}:
        return None
    parent_id = current_path[-1].id if current_path else None
    return (await db.execute(select(Folder).where(
        Folder.user_id == user_id,
        Folder.deleted_at.is_(None),
        Folder.project_id == source_file.project_id if source_file.project_id is not None else Folder.project_id.is_(None),
        Folder.workspace_directory_id == source_file.workspace_directory_id
        if source_file.workspace_directory_id is not None else Folder.workspace_directory_id.is_(None),
        Folder.parent_id == parent_id if parent_id is not None else Folder.parent_id.is_(None),
        Folder.name == basename,
    ).limit(1))).scalar_one_or_none()


async def resolve_relative_file_paths(db: AsyncSession, user_id, source_file_id: int, paths: list[str]):
    """在来源文件的逻辑 scope 内解析有限数量的相对文件路径。"""
    source = await get_file_detail_row(db, user_id, source_file_id)
    if source is None:
        return None
    source_file = source[0]
    folder_path = []
    if source_file.folder_id is not None:
        folder_path = await get_folder_path_rows(
            db, user_id, source_file.folder_id,
            expected_scope=(source_file.project_id, source_file.workspace_directory_id),
        )
        if folder_path is None:
            return None

    resolved = []
    for original_path in paths:
        parts = _relative_path_parts(original_path)
        if parts is None:
            resolved.append((original_path, None, None))
            continue
        current_path = await _resolve_relative_parent_path(
            db, user_id, source_file, folder_path, parts,
        )
        target = (
            await _find_relative_file(db, user_id, source_file, current_path, parts[-1])
            if current_path is not None else None
        )
        folder = None
        if target is None and current_path is not None:
            folder = await _find_relative_folder(db, user_id, source_file, current_path, parts[-1])
        resolved.append((original_path, target, folder))
    return resolved


async def get_file_summary(db: AsyncSession, user_id: int, recent_limit: int):
    """读取有限的最近文件，不为看板统计扫描整份文件库。"""
    recent_rows = (await db.execute(
        select(File, Project.name, Project.color, Folder.name)
        .outerjoin(Project, Project.id == File.project_id)
        .outerjoin(Folder, Folder.id == File.folder_id)
        .where(File.user_id == user_id, File.deleted_at.is_(None))
        .order_by(File.id.desc())
        .limit(recent_limit)
    )).all()
    return recent_rows


async def count_personal_library_items(db: AsyncSession, user_id: int) -> int:
    """统计个人空间全部活动文件与文件夹，返回卡片需要的总项数。"""
    file_count = await db.scalar(
        select(func.count(File.id)).where(
            File.user_id == user_id,
            File.space == "personal",
            _file_scope_key_column() == 0,
            func.coalesce(File.folder_id, literal_column("0")) == 0,
            File.deleted_at.is_(None),
        )
    )
    folder_count = await db.scalar(
        select(func.count(Folder.id)).where(
            Folder.user_id == user_id,
            Folder.project_id.is_(None),
            Folder.workspace_directory_id.is_(None),
            func.coalesce(Folder.project_id, Folder.workspace_directory_id, literal_column("0")) == 0,
            func.coalesce(Folder.parent_id, literal_column("0")) == 0,
            Folder.deleted_at.is_(None),
        )
    )
    return int(file_count or 0) + int(folder_count or 0)


async def get_storage_usage(db: AsyncSession, user_id: int) -> int:
    """返回用户当前配额口径的实际用量。"""
    from app.services.storage.quota_ledger import measure_user_storage_usage

    return await measure_user_storage_usage(db, user_id)


async def folder_download_rows(db: AsyncSession, user_id: int, folder_id: int):
    """读取当前用户文件夹下载所需的文件行及其归档路径。"""
    from app.core.ownership import get_owned

    folder = await get_owned(db, Folder, folder_id, user_id)
    if not folder or folder.deleted_at is not None:
        return None

    rows = []
    queue = [(folder.id, folder.name)]
    while queue:
        current_id, path_prefix = queue.pop(0)
        files = (await db.execute(
            select(File).where(
                File.folder_id == current_id,
                File.user_id == user_id,
                File.deleted_at.is_(None),
            )
        )).scalars().all()
        rows.extend((file, f"{path_prefix}/{file.display_name}.{file.ext.lower()}") for file in files)

        subfolders = (await db.execute(
            select(Folder).where(
                Folder.parent_id == current_id,
                Folder.user_id == user_id,
                Folder.deleted_at.is_(None),
            )
        )).scalars().all()
        queue.extend((sub.id, f"{path_prefix}/{sub.name}") for sub in subfolders)
    return folder, rows


def _user_files_stmt(
    user_id,
    *, space=None, project_id=None, folder_id=None,
    workspace_directory_id=None, ext=None, queries=None, mode=None,
    root_only: bool = False,
):
    """构造 list_dir 共用的存活文件过滤条件（搜索与计数必须同口径）。"""
    stmt = select(File).where(File.user_id == user_id, File.deleted_at.is_(None))
    if space:
        stmt = stmt.where(File.space == space)
    if project_id is not None:
        stmt = stmt.where(File.project_id == project_id)
    if folder_id is not None:
        stmt = stmt.where(File.folder_id == folder_id)
    elif root_only:
        stmt = stmt.where(File.folder_id.is_(None))
    if workspace_directory_id is not None:
        stmt = stmt.where(File.workspace_directory_id == workspace_directory_id)
    if ext:
        stmt = stmt.where(File.ext == ext.lower().lstrip("."))
    normalized = normalize_queries(queries=queries)
    if normalized:
        stmt = stmt.where(keyword_condition([File.display_name], normalized, mode))
    return stmt


async def search_user_files(
    db: AsyncSession,
    user_id,
    *,
    space=None,
    project_id=None,
    folder_id=None,
    workspace_directory_id=None,
    ext=None,
    queries=None,
    mode=None,
    root_only: bool = False,
    limit=100,
    offset=0,
    sort="updated",
):
    """查询 Agent 文件工具使用的当前用户存活文件。

    sort="name" 用于分页遍历：名字序在翻页期间稳定，不会因文件被改动而漏/重；
    sort="updated"（默认）保持旧行为——最近改动的文件排最前。
    """
    stmt = _user_files_stmt(
        user_id, space=space, project_id=project_id, folder_id=folder_id,
        workspace_directory_id=workspace_directory_id, ext=ext,
        queries=queries, mode=mode,
        root_only=root_only,
    )
    if sort == "name":
        # 名字升序 + id 兜底：分页遍历时顺序稳定，同名文件（不同 ext/space）也不漏重
        order = (File.display_name.asc(), File.ext.asc(), File.id.asc())
    else:
        order = (File.updated_at.desc(), File.id.desc())
    return (await db.execute(
        stmt.order_by(*order).offset(offset).limit(limit)
    )).scalars().all()


async def count_user_files(
    db: AsyncSession,
    user_id,
    *,
    space=None,
    project_id=None,
    folder_id=None,
    workspace_directory_id=None,
    ext=None,
    queries=None,
    mode=None,
    root_only: bool = False,
):
    """与 search_user_files 完全同口径的总数（不含 limit）。

    list_dir 靠它区分「就这么多」和「被 limit 截断」——没有这个数，
    模型拿小 limit 的前 N 条会当成全量下结论（真实漏判案例：根目录清理时
    两条排在截断线外的文件被当成不存在）。
    """
    from sqlalchemy import func
    stmt = _user_files_stmt(
        user_id, space=space, project_id=project_id, folder_id=folder_id,
        workspace_directory_id=workspace_directory_id, ext=ext,
        queries=queries, mode=mode,
        root_only=root_only,
    )
    return (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()


async def count_file_rows_for_user(db: AsyncSession, user_id) -> int:
    """统计某用户所有 File 行，包含软删除项，用于存储完整性核对。"""
    return int((await db.execute(
        select(func.count(File.id)).where(File.user_id == user_id)
    )).scalar_one())


async def get_user_file(db: AsyncSession, user_id, file_id):
    """读取当前用户的存活文件。"""
    file = await get_owned(db, File, file_id, user_id)
    return file if file and file.deleted_at is None else None


async def get_user_folder(db: AsyncSession, user_id, folder_id):
    """读取当前用户的文件夹。"""
    return await get_owned(db, Folder, folder_id, user_id)


async def find_user_files_by_name(
    db: AsyncSession, user_id, base_name: str, *,
    space=None, project_id=None, folder_id=None, workspace_directory_id=None, root=False,
):
    """按文件名查找当前用户存活文件，精确结果优先。"""
    base_stmt = select(File).where(File.user_id == user_id, File.deleted_at.is_(None))
    if space:
        base_stmt = base_stmt.where(File.space == space)
    if workspace_directory_id is not None:
        base_stmt = base_stmt.where(File.workspace_directory_id == workspace_directory_id)
    if project_id is not None:
        base_stmt = base_stmt.where(File.project_id == project_id)
    if folder_id is not None:
        base_stmt = base_stmt.where(File.folder_id == folder_id)
    elif root:
        base_stmt = base_stmt.where(File.folder_id.is_(None))
    rows = (await db.execute(base_stmt.where(File.display_name == base_name))).scalars().all()
    if not rows:
        rows = (await db.execute(
            base_stmt.where(File.display_name.ilike(f"%{base_name}%"))
        )).scalars().all()
    return rows


async def find_user_folders_by_name(
    db: AsyncSession, user_id, name: str, *, space=None, project_id=None,
    workspace_directory_id=None,
):
    """按名称查找当前用户文件夹；调用方负责处理重名提示。"""
    stmt = select(Folder).where(Folder.user_id == user_id, Folder.name == name)
    if space == "project":
        stmt = stmt.where(
            Folder.project_id == project_id
            if project_id is not None else Folder.project_id.is_not(None)
        )
    elif space == "workspace":
        stmt = stmt.where(Folder.project_id.is_(None))
        if workspace_directory_id is not None:
            stmt = stmt.where(Folder.workspace_directory_id == workspace_directory_id)
        else:
            stmt = stmt.where(Folder.workspace_directory_id.is_not(None))
    elif space in {"personal", "mind", "asset"}:
        stmt = stmt.where(
            Folder.project_id.is_(None),
            Folder.workspace_directory_id.is_(None),
        )
    return (await db.execute(stmt)).scalars().all()


async def list_user_folders(
    db: AsyncSession, user_id, *, project_id=None, parent_id=None,
    workspace_directory_id=None, space=None, filter_parent: bool = False,
):
    """查询当前用户存活文件夹；filter_parent 可将 parent_id=None 明确解释为根目录。"""
    stmt = select(Folder).where(
        Folder.user_id == user_id,
        Folder.deleted_at.is_(None),
    )
    if space == "project" or project_id is not None:
        stmt = stmt.where(
            Folder.project_id == project_id
            if project_id is not None else Folder.project_id.is_not(None)
        )
    elif space == "workspace":
        stmt = stmt.where(Folder.project_id.is_(None))
        if workspace_directory_id is not None:
            stmt = stmt.where(Folder.workspace_directory_id == workspace_directory_id)
        else:
            stmt = stmt.where(Folder.workspace_directory_id.is_not(None))
    elif space in {"personal", "mind", "asset"}:
        stmt = stmt.where(
            Folder.project_id.is_(None),
            Folder.workspace_directory_id.is_(None),
        )
    elif workspace_directory_id is not None:
        stmt = stmt.where(Folder.workspace_directory_id == workspace_directory_id)
    if filter_parent or parent_id is not None:
        stmt = stmt.where(Folder.parent_id == parent_id)
    return (await db.execute(stmt)).scalars().all()


def _folder_primary_rank(query: str):
    normalized = query.lower()
    return case(
        (func.lower(Folder.name) == normalized, 0),
        (func.lower(Folder.name).like(f"{normalized}%"), 1),
        else_=2,
    )


async def search_user_folders(db, user_id, queries, mode, primary_query: str, limit: int):
    """按关键词相关度查询当前用户未删除的文件夹。"""
    columns = [Folder.name]
    return (await db.execute(
        select(Folder).where(
            Folder.user_id == user_id,
            Folder.deleted_at.is_(None),
            keyword_condition(columns, queries, mode),
        ).order_by(
            keyword_score(columns, queries).desc(),
            _folder_primary_rank(primary_query),
            Folder.created_at.desc(),
        ).limit(limit)
    )).scalars().all()


async def resolve_existing_folder_paths(
    db: AsyncSession,
    user_id,
    *,
    project_id: int | None,
    workspace_directory_id: int | None,
    parent_id: int | None,
    paths: list[str],
) -> list[Folder]:
    """只读取上传批次实际涉及的目录前缀，不枚举整个空间目录树。"""
    from urllib.parse import unquote

    if project_id is not None and workspace_directory_id is not None:
        return []
    base = None
    if parent_id is not None:
        base = await get_owned(db, Folder, parent_id, user_id)
        if (base is None or base.deleted_at is not None
                or base.project_id != project_id
                or base.workspace_directory_id != workspace_directory_id):
            return []

    resolved = {path: [part for part in unquote(path).split("/") if part not in {"", "."}]
                for path in paths}
    if any(not parts or len(parts) > 64
           or any(part in {".."} or "\\" in part or "\x00" in part for part in parts)
           for parts in resolved.values()):
        return []
    states: dict[str, int | None] = {"": parent_id}
    found: dict[int, Folder] = {}
    max_depth = max((len(parts) for parts in resolved.values()), default=0)
    for depth in range(max_depth):
        pairs = {
            ((states[prefix] or 0), parts[depth])
            for parts in resolved.values()
            if len(parts) > depth
            for prefix in ["/".join(parts[:depth])]
            if prefix in states
        }
        if not pairs:
            break
        stmt = select(Folder).where(
            Folder.user_id == user_id,
            Folder.deleted_at.is_(None),
            Folder.project_id == project_id if project_id is not None else Folder.project_id.is_(None),
            Folder.workspace_directory_id == workspace_directory_id
            if workspace_directory_id is not None else Folder.workspace_directory_id.is_(None),
            tuple_(func.coalesce(Folder.parent_id, literal_column("0")), Folder.name).in_(pairs),
        ).limit(256)
        rows = (await db.execute(stmt)).scalars().all()
        by_pair = {(folder.parent_id or 0, folder.name): folder for folder in rows}
        next_states: dict[str, int] = {}
        for parts in resolved.values():
            if len(parts) <= depth:
                continue
            prefix = "/".join(parts[:depth])
            if prefix not in states:
                continue
            parent = states[prefix]
            folder = by_pair.get((parent or 0, parts[depth]))
            if folder is None:
                continue
            found[folder.id] = folder
            next_states["/".join(parts[:depth + 1])] = folder.id
        states = next_states
        if not states:
            break
    return list(found.values())


async def list_folder_page_rows(
    db: AsyncSession,
    user_id,
    *,
    limit: int,
    cursor: str | None,
    sort_by: str,
    sort_order: str,
    project_id=None,
    workspace_directory_id=None,
    parent_id=None,
):
    """读取单个逻辑目录中的有限直属文件夹页及其直属文件计数。"""
    scope = {
        "resource": "folders",
        "project_id": project_id,
        "workspace_directory_id": workspace_directory_id,
        "parent_id": parent_id,
        "sort_by": sort_by,
        "sort_order": sort_order,
    }
    if sort_by in {"name", "type"}:
        sort_column = (
            Folder.name.collate("gugu_natural_zh")
            if db.get_bind().dialect.name == "postgresql"
            else func.lower(Folder.name)
        )
    else:
        # 当前前端没有给 Folder 提供 createdAt/size/stage sorters，这些排序按 id 兜底。
        sort_column = Folder.id
    scope_key = project_id or workspace_directory_id or 0
    stmt = select(Folder).where(
        Folder.user_id == user_id,
        Folder.deleted_at.is_(None),
        Folder.project_id == project_id if project_id is not None else Folder.project_id.is_(None),
        Folder.workspace_directory_id == workspace_directory_id if workspace_directory_id is not None else Folder.workspace_directory_id.is_(None),
        Folder.parent_id == parent_id if parent_id is not None else Folder.parent_id.is_(None),
        func.coalesce(Folder.project_id, Folder.workspace_directory_id, literal_column("0")) == scope_key,
        func.coalesce(Folder.parent_id, literal_column("0")) == (parent_id or 0),
    )
    boundary = decode_cursor(cursor, user_id=user_id, scope=scope)
    if boundary:
        sort_value: Any = boundary[0]
        if sort_by not in {"name", "type"}:
            sort_value = int(sort_value)
        stmt = apply_keyset(
            stmt, model=Folder, sort_column=sort_column,
            sort_value=sort_value, entity_id=boundary[1], direction=sort_order,
        )
    ordering = sort_column.asc() if sort_order == "asc" else sort_column.desc()
    id_order = Folder.id.asc() if sort_order == "asc" else Folder.id.desc()
    folders = (await db.execute(stmt.order_by(ordering, id_order).limit(limit + 1))).scalars().all()
    has_more = len(folders) > limit
    items = folders[:limit]
    counts = await file_counts_for_folders(db, user_id, [folder.id for folder in items])
    next_cursor = None
    if has_more and items:
        next_cursor = encode_cursor(
            user_id=user_id,
            scope=scope,
            sort_value=(
                (
                    str(items[-1].name)
                    if db.get_bind().dialect.name == "postgresql"
                    else str(items[-1].name).lower()
                ) if sort_by in {"name", "type"} else items[-1].id
            ),
            entity_id=items[-1].id,
        )
    return {"items": [(folder, counts.get(folder.id, 0)) for folder in items],
            "next_cursor": next_cursor, "has_more": has_more}


async def file_count_for_folder(db: AsyncSession, user_id, folder_id: int) -> int:
    """统计当前用户文件夹直属存活文件数。"""
    return (await db.execute(
        select(func.count()).select_from(File).where(
            File.user_id == user_id,
            File.folder_id == folder_id,
            File.deleted_at.is_(None),
        )
    )).scalar_one()


async def file_counts_for_folders(db: AsyncSession, user_id, folder_ids: list[int]) -> dict[int, int]:
    """批量统计当前用户各文件夹的直属存活文件数。"""
    if not folder_ids:
        return {}
    rows = await db.execute(
        select(File.folder_id, func.count()).where(
            File.user_id == user_id,
            File.folder_id.in_(folder_ids),
            File.deleted_at.is_(None),
        ).group_by(File.folder_id)
    )
    return dict(rows.all())


async def descendant_folder_ids(db: AsyncSession, user_id, root_id: int) -> list[int]:
    """按归属查询文件夹子树 ID。"""
    ids = [root_id]
    frontier = [root_id]
    while frontier:
        rows = (await db.execute(
            select(Folder.id).where(
                Folder.user_id == user_id,
                Folder.parent_id.in_(frontier),
            )
        )).scalars().all()
        fresh = [item for item in rows if item not in ids]
        ids.extend(fresh)
        frontier = fresh
    return ids
