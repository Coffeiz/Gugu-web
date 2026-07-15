import re

from app.models import File
from app.schemas import FileResponse


def color_value(raw: str | None) -> str | None:
    if not raw:
        return None
    match = re.search(r'#[0-9a-fA-F]{3,6}', raw)
    return match.group(0) if match else raw


def to_file_response(
    file: File,
    project_name: str | None = None,
    project_color: str | None = None,
    folder_name: str | None = None,
) -> FileResponse:
    return FileResponse(
        id=file.id,
        display_name=file.display_name,
        ext=file.ext,
        space=file.space,
        project_id=file.project_id,
        project_name=project_name,
        project_color=project_color,
        stage_name=file.stage_name,
        folder_id=file.folder_id,
        folder_name=folder_name,
        mind_map_id=file.mind_map_id,
        size=file.size,
        size_bytes=file.size_bytes,
        mime_type=file.mime_type,
        created_at=file.created_at.strftime("%Y-%m-%d"),
        deleted_at=file.deleted_at.strftime("%Y-%m-%dT%H:%M:%S") if file.deleted_at else None,
        img_width=file.img_width,
        img_height=file.img_height,
    )
