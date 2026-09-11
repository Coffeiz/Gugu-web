"""文件工具包：导出文件、文件夹、定位和传输工具，并注册 FilesSkill。"""

from app.services.storage import get_storage

from .locations import (
    _bound_workspace_target, _coerce_loc, _folder_by_name,
    _location_receipt, _norm_target, _resolve_create_location, _resolve_file,
    _resolve_key, _target_loc,
)
from .documents import (
    TEXT_EXTS, READ_MAX_BYTES, _DOC_MIME, _DOC_EXT, _DOC_EXT_ALIASES,
    _CREATE_NAME_EXT_RE, _CREATE_SPACES, _CREATE_BINARY_EXTS,
    _is_text_file_record, _split_create_name, _strip_ext, _resolve_file,
    _list_files, _read_file, _edit_one, _edit_file, _create_file,
    _save_one_attach, _save_uploaded_file, _rename_one, _rename_file,
    _delete_file, _copy_file, FilesSkill,
)
from .folders import (
    _as_dict, _descendant_folder_ids, _resolve_target, _move_one,
    _move_folder, _move_items, _create_folder, _list_folders,
    _find_folder, _rename_folder, _delete_folder,
)
from .transfer import (
    _normalize_send_path, _stage_send_path, _send_file_from_url as _transfer_send_file_from_url,
    _send_file, _present_file, _list_recent_attachments, inspect_image_url,
    _build_pinned_request, _url_is_safe, _SEND_URL_MAX_BYTES, _SEND_URL_IMAGE_EXT,
)


async def _send_file_from_url(user_id, url: str, title: str, *, stage: bool = True):
    """兼容旧导入，并保留测试/调用方替换 files._build_pinned_request 的行为。"""
    from . import transfer as file_transfer
    file_transfer._build_pinned_request = _build_pinned_request
    return await file_transfer._send_file_from_url(user_id, url, title, stage=stage)


FilesSkill().register()
