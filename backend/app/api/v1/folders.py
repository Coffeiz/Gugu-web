import io
import zipfile
from typing import Literal, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import Folder, Project, User, WorkspaceDirectory  # orm-exempt: 模型引用随本文件遗留查询，Service 收口时一并移除
from app.schemas import FolderCopy, FolderCreate, FolderLocationResponse, FolderMove, FolderRename, FolderResponse, PageResponse, ResolveFolderPathsRequest
from app.core.security import get_current_user, get_client_id
from app.core.ownership import get_owned
from app.core import events
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.files.browser import (
    file_count_for_folder,
    folder_download_rows,
    get_folder_detail_row,
    get_folder_path_rows,
    list_folder_page_rows,
    resolve_existing_folder_paths,
)
from app.services.undo import UndoService
from app.services.undo.files import folder_snapshot, operation_state, ref_for

router = APIRouter(prefix="/folders", tags=["folders"])


@router.get("", response_model=PageResponse[FolderResponse])
@router.get("/page", response_model=PageResponse[FolderResponse], include_in_schema=False)
async def list_folder_page(
    project_id: Optional[int] = None,
    workspace_directory_id: Optional[int] = None,
    parent_id: Optional[int] = None,
    limit: int = Query(default=100, ge=1, le=200),
    cursor: Optional[str] = None,
    sort_by: Literal["name", "type", "stage", "createdAt", "size", "id"] = "createdAt",
    sort_order: Literal["asc", "desc"] = "desc",
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """分页读取当前逻辑目录的直属文件夹；不提供全空间树下载模式。"""
    if project_id is not None:
        proj = await get_owned(db, Project, project_id, current_user.id)
        if not proj or proj.deleted_at is not None:
            raise HTTPException(404, "项目不存在")
    if workspace_directory_id is not None:
        directory = await get_owned(db, WorkspaceDirectory, workspace_directory_id, current_user.id)
        if directory is None or directory.deleted_at is not None:
            raise HTTPException(404, "Workspace 不存在")
    page = await list_folder_page_rows(
        db, current_user.id, limit=limit, cursor=cursor, sort_by=sort_by,
        sort_order=sort_order, project_id=project_id,
        workspace_directory_id=workspace_directory_id, parent_id=parent_id,
    )
    return {
        "items": [FolderResponse(
            id=folder.id, project_id=folder.project_id,
            workspace_directory_id=folder.workspace_directory_id,
            parent_id=folder.parent_id, name=folder.name,
            file_count=file_count, folder_count=folder_count, version=folder.version,
        ) for folder, file_count, folder_count in page["items"]],
        "next_cursor": page["next_cursor"],
        "has_more": page["has_more"],
    }


@router.post("/resolve-paths", response_model=list[FolderResponse])
async def resolve_folder_paths(
    body: ResolveFolderPathsRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """只返回上传批次所请求路径上的已有目录节点。"""
    if body.project_id is not None and body.workspace_directory_id is not None:
        raise HTTPException(422, "项目与 Workspace 目录不能同时指定")
    if body.project_id is not None:
        project = await get_owned(db, Project, body.project_id, current_user.id)
        if project is None or project.deleted_at is not None:
            raise HTTPException(404, "项目不存在")
    if body.workspace_directory_id is not None:
        directory = await get_owned(db, WorkspaceDirectory, body.workspace_directory_id, current_user.id)
        if directory is None or directory.deleted_at is not None:
            raise HTTPException(404, "Workspace 不存在")
    rows = await resolve_existing_folder_paths(
        db, current_user.id, project_id=body.project_id,
        workspace_directory_id=body.workspace_directory_id,
        parent_id=body.parent_id, paths=body.paths,
    )
    return [FolderResponse(
        id=folder.id, project_id=folder.project_id,
        workspace_directory_id=folder.workspace_directory_id,
        parent_id=folder.parent_id, name=folder.name,
    ) for folder in rows]


@router.get("/{fid}", response_model=FolderResponse)
async def get_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await get_folder_detail_row(db, current_user.id, fid)
    if row is None:
        raise HTTPException(404, "文件夹不存在")
    folder, file_count = row
    return FolderResponse(
        id=folder.id, project_id=folder.project_id,
        workspace_directory_id=folder.workspace_directory_id,
        parent_id=folder.parent_id, name=folder.name,
        file_count=file_count, version=folder.version,
    )


@router.get("/{fid}/location", response_model=FolderLocationResponse)
async def get_folder_location(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    path_rows = await get_folder_path_rows(db, current_user.id, fid)
    if path_rows is None:
        raise HTTPException(404, "文件夹位置不存在")
    folder_row = await get_folder_detail_row(db, current_user.id, fid)
    assert folder_row is not None
    folder, file_count = folder_row

    def response(item, count=0):
        return FolderResponse(
            id=item.id, project_id=item.project_id,
            workspace_directory_id=item.workspace_directory_id,
            parent_id=item.parent_id, name=item.name,
            file_count=count, version=item.version,
        )

    return FolderLocationResponse(
        folder=response(folder, file_count),
        ancestors=[response(item) for item in path_rows if item.id != folder.id],
    )


# ── POST /folders ─────────────────────────────────────────────────────────────

@router.post("", response_model=FolderResponse, status_code=201)
async def create_folder(
    body: FolderCreate,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    folder = await FileService(db).create_folder(
        current_user.id, name=body.name, parent_id=body.parent_id, project_id=body.project_id,
        workspace_directory_id=body.workspace_directory_id,
    )   # 校验（项目归属/同名）在 FolderTree，失败抛领域异常 → 全局 handler 映射 404/409
    response = FolderResponse(id=folder.id, project_id=folder.project_id,
                          workspace_directory_id=folder.workspace_directory_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=0,
                          version=folder.version)
    await UndoService.record_forward(
        db, user_id=current_user.id, context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="files", action="create",
        target_refs=[{"kind": "folder", "id": folder.id}], before_state=operation_state({}),
        after_state=operation_state({ref_for("folder", folder.id): folder_snapshot(folder)}),
        base_versions={ref_for("folder", folder.id): {"version": 0}},
    )
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin, operation="create", entity_id=folder.id,
                         event_payload={"kind": "folder", "entity": response.model_dump(mode="json", by_alias=True)})
    return response


# ── GET /folders/{fid}/download ──────────────────────────────────────────────

@router.get("/{fid}/download")
async def download_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    download = await folder_download_rows(db, current_user.id, fid)
    if download is None:
        raise HTTPException(404, "文件夹不存在")
    folder, file_rows = download

    storage = get_storage()
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file, arc_name in file_rows:
            data = await storage.get(file.storage_key)
            zf.writestr(arc_name, data)

    buf.seek(0)
    filename = quote(f"{folder.name}.zip")
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


# ── PATCH /folders/{fid} ──────────────────────────────────────────────────────

@router.patch("/{fid}", response_model=FolderResponse)
async def rename_folder(
    fid: int,
    body: FolderRename,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    previous = await get_owned(db, Folder, fid, current_user.id)
    before = folder_snapshot(previous) if previous else None
    folder = await FileService(db).rename_folder(current_user.id, fid, body.name,
                                                  client_version=body.version)
    cnt = await file_count_for_folder(db, current_user.id, folder.id)
    response = FolderResponse(id=folder.id, project_id=folder.project_id,
                          workspace_directory_id=folder.workspace_directory_id, name=folder.name,
                          file_count=cnt, version=folder.version)
    await UndoService.record_forward(
        db, user_id=current_user.id, context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="files", action="rename",
        target_refs=[{"kind": "folder", "id": folder.id}],
        before_state=operation_state({ref_for("folder", folder.id): before or {}}),
        after_state=operation_state({ref_for("folder", folder.id): folder_snapshot(folder)}),
        base_versions={ref_for("folder", folder.id): {"version": before.get("version", 0) if before else 0}},
    )
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin, operation="update", entity_id=folder.id,
                         event_payload={"kind": "folder", "entity": response.model_dump(mode="json", by_alias=True)})
    return response


# ── PATCH /folders/{fid}/parent ──────────────────────────────────────────────

@router.patch("/{fid}/parent", response_model=FolderResponse)
async def move_folder(
    fid: int,
    body: FolderMove,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    previous = await get_owned(db, Folder, fid, current_user.id)
    before = folder_snapshot(previous) if previous else None
    folder = await FileService(db).move_folder(current_user.id, fid, body.parent_id,
                                               client_version=body.version,
                                               target_project_id=body.project_id,
                                               target_project_set='project_id' in body.model_fields_set,
                                               target_workspace_directory_id=body.workspace_directory_id,
                                               target_workspace_set='workspace_directory_id' in body.model_fields_set)
    # 归属/循环/跨空间校验在 FolderTree、物理归位在 FileService（relocate），失败抛领域异常
    cnt = await file_count_for_folder(db, current_user.id, folder.id)
    response = FolderResponse(id=folder.id, project_id=folder.project_id,
                          workspace_directory_id=folder.workspace_directory_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=cnt,
                          version=folder.version)
    await UndoService.record_forward(
        db, user_id=current_user.id, context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="files", action="move",
        target_refs=[{"kind": "folder", "id": folder.id}],
        before_state=operation_state({ref_for("folder", folder.id): before or {}}),
        after_state=operation_state({ref_for("folder", folder.id): folder_snapshot(folder)}),
        base_versions={ref_for("folder", folder.id): {"version": before.get("version", 0) if before else 0}},
    )
    await db.commit()
    await db.refresh(folder)
    await events.publish(current_user.id, "files", origin=origin, operation="move", entity_id=folder.id,
                         event_payload={"kind": "folder", "entity": response.model_dump(mode="json", by_alias=True)})
    return response


@router.post("/{fid}/copy", response_model=FolderResponse)
async def copy_folder(
    fid: int,
    body: FolderCopy,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
):
    folder = await FileService(db).copy_folder(
        current_user.id, fid, parent_id=body.parent_id, project_id=body.project_id,
        workspace_directory_id=body.workspace_directory_id,
    )
    await db.commit()
    await db.refresh(folder)
    cnt = await file_count_for_folder(db, current_user.id, folder.id)
    response = FolderResponse(id=folder.id, project_id=folder.project_id,
                          workspace_directory_id=folder.workspace_directory_id,
                          parent_id=folder.parent_id, name=folder.name, file_count=cnt,
                          version=folder.version)
    await events.publish(current_user.id, "files", origin=origin, operation="create", entity_id=folder.id,
                         event_payload={"kind": "folder", "entity": response.model_dump(mode="json", by_alias=True)})
    return response


# ── DELETE /folders/{fid} ─────────────────────────────────────────────────────

@router.delete("/{fid}", status_code=204)
async def delete_folder(
    fid: int,
    current_user: User = Depends(get_current_user),
    origin: str | None = Depends(get_client_id),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
):
    # P2.2：软删（不再硬删）——DB 行仍在、deleted_at 非空、子树内当时存活的文件同批软删并
    # 搬物理 trash，30 天内可整体恢复（FileService.restore_folder）。校验失败抛领域异常
    # （NotFound → 全局 handler 映射 404），与旧行为一致。
    previous = await get_owned(db, Folder, fid, current_user.id)
    before = folder_snapshot(previous) if previous else None
    folder = await FileService(db).delete_folder(current_user.id, fid)
    await UndoService.record_forward(
        db, user_id=current_user.id, context_id=request.headers.get("X-Undo-Context-ID") if request else None,
        resource="files", action="delete",
        target_refs=[{"kind": "folder", "id": fid}],
        before_state=operation_state({ref_for("folder", fid): before or {}}),
        after_state=operation_state({ref_for("folder", fid): folder_snapshot(folder)}),
        base_versions={ref_for("folder", fid): {"version": before.get("version", 0) if before else 0}},
    )
    await db.commit()
    # 前端 removeFolder(id) 会本地级联剔除子树文件夹与其中文件，只需给根 folder id
    await events.publish(current_user.id, "files", origin=origin,
                         file_op={"op": "remove", "kind": "folder", "id": fid})
