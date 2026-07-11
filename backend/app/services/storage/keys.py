"""文件存储 key / 路径构建——纯路径逻辑，从 app/api/v1/files.py 原样迁出（P2④-③ 第三刀）。

只搬「与授权、删除无关」的 key 构建 + 冲突改名：_safe_name / _build_key / _resolve_conflict。
files.py、trash.py、agent/tools/files.py 三处共享（各改 import 指向这里），行为逐字不变。
授权(get_owned)、删除/回收站路径(_to_trash_key/_move_to_trash)、_find_conflict(DB 查询)
均不在此、保持原位。
"""
import re

_INVALID_RE = re.compile(r'[\\/:*?"<>|]')


def _safe_name(name: str) -> str:
    return _INVALID_RE.sub("_", name)


def _build_key(uid: int, space: str, display_name: str, ext: str,
               project_name: str = "", project_id: int = 0,
               project_year: str = "", project_month: str = "",
               folder_name: str = "", mind_map_title: str = "", mind_map_id: int = 0) -> str:
    fname = f"{_safe_name(display_name)}.{ext.lower()}"
    if space == "project":
        proj_dir = f"{_safe_name(project_name)} #{project_id}"
        date_path = f"{project_year}/{project_month}/" if project_year and project_month else ""
        if folder_name:
            return f"{uid}/项目文件/{date_path}{proj_dir}/{_safe_name(folder_name)}/{fname}"
        return f"{uid}/项目文件/{date_path}{proj_dir}/{fname}"
    if space == "mind":
        map_dir = f"{_safe_name(mind_map_title)} #{mind_map_id}"
        return f"{uid}/思维/{map_dir}/{fname}"
    if space == "asset":
        return f"{uid}/素材板/{fname}"
    # personal — 有文件夹时放进子目录
    if folder_name:
        return f"{uid}/个人文件/{_safe_name(folder_name)}/{fname}"
    return f"{uid}/个人文件/{fname}"


async def _resolve_conflict(storage, base_key: str, display_name: str, ext: str) -> tuple[str, str]:
    key = base_key
    name = display_name
    n = 0
    from app.services.storage import LocalStorageBackend
    if not isinstance(storage, LocalStorageBackend):
        return key, name
    from pathlib import Path
    root = storage.root
    while (root / key).exists():
        n += 1
        name = f"{display_name}({n})"
        prefix = base_key.rsplit("/", 1)[0]
        key = f"{prefix}/{_safe_name(name)}.{ext.lower()}"
    return key, name
