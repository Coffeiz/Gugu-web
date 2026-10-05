"""文件存储 key / 路径构建——纯路径逻辑，从 app/api/v1/files.py 原样迁出（P2④-③ 第三刀）。

只搬「与授权、删除无关」的 key 构建 + 冲突改名：_safe_name / _build_key / _resolve_conflict。
files.py、trash.py、agent/tools/files 三处共享（各改 import 指向这里），行为逐字不变。
授权(get_owned)、_find_conflict(DB 查询) 均不在此、保持原位；回收站路径
(to_trash_key/move_file_to_trash/restore_file_storage) 已进一步搬到
app/services/storage/trash.py（P2），files.py/trash.py/agent 三处共用一份。
"""
import re

_INVALID_RE = re.compile(r'[\\/:*?"<>|]')

# 用户存储根（<uid>/）下的系统保留顶层目录名——个人文件/项目文件/思维/素材板/默认
# 工作区/旧 shell 迁移目录。Workspace 物理目录统一位于 workspace/，不得占用这些
# 名称；本集合是唯一事实源，新增系统顶层目录时在此登记。
RESERVED_USER_ROOTS = frozenset({"workspace", "shell", "个人文件", "项目文件", "思维", "素材板"})


def workspace_directory_path(directory_name: str) -> str:
    """所有工作区共享 workspace 命名空间，目录字段只保存稳定段名。"""
    if not directory_name or directory_name in {".", ".."} or _safe_name(directory_name) != directory_name:
        raise ValueError("工作区目录名无效")
    return f"workspace/{directory_name}"


def workspace_directory_segment(name: str, identity: str, *, is_default: bool = False) -> str:
    """创建时冻结宿主与容器共用段名，非 ASCII 名称及保留段用稳定身份消歧。"""
    if is_default:
        return "default"
    segment = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip()).strip("-_ ").lower()[:48]
    return segment if segment and segment != "default" else f"workspace-{identity}"


def _safe_name(name: str) -> str:
    return _INVALID_RE.sub("_", name)


def _build_key(uid: int, space: str, display_name: str, ext: str,
               project_name: str = "", project_id: int = 0,
               project_year: str = "", project_month: str = "",
               folder_name: str = "", folder_path: str = "",
               mind_map_title: str = "", mind_map_id: int = 0,
               workspace_directory_name: str = "") -> str:
    """构造存储 key。folder_path 是根到叶的目录链，folder_name 仅为旧调用兼容。"""
    fname = f"{_safe_name(display_name)}.{ext.lower()}"
    # 旧 folder_name 的斜杠一直按非法文件名替换，不能因为新增层级能力悄悄变成真实目录；
    # 只有显式传入的 folder_path 才按 / 拆为父子目录。
    safe_folder_path = (
        "/".join(_safe_name(part) for part in folder_path.split("/") if part)
        if folder_path else _safe_name(folder_name)
    )
    if space == "project":
        proj_dir = f"{_safe_name(project_name)} #{project_id}"
        date_path = f"{project_year}/{project_month}/" if project_year and project_month else ""
        if safe_folder_path:
            return f"{uid}/项目文件/{date_path}{proj_dir}/{safe_folder_path}/{fname}"
        return f"{uid}/项目文件/{date_path}{proj_dir}/{fname}"
    if space == "mind":
        map_dir = f"{_safe_name(mind_map_title)} #{mind_map_id}"
        return f"{uid}/思维/{map_dir}/{fname}"
    if space == "asset":
        return f"{uid}/素材板/{fname}"
    if space == "workspace":
        base = f"{uid}/{workspace_directory_path(workspace_directory_name)}"
        return f"{base}/{safe_folder_path}/{fname}" if safe_folder_path else f"{base}/{fname}"
    # personal — 有文件夹时放进子目录
    if safe_folder_path:
        return f"{uid}/个人文件/{safe_folder_path}/{fname}"
    return f"{uid}/个人文件/{fname}"


def compose_logical_path(
    space: str, *,
    project_name: str = "", project_id: int = 0,
    project_year: str = "", project_month: str = "",
    folder_name: str = "", folder_path: str = "",
    mind_map_title: str = "", mind_map_id: int = 0,
    workspace_directory_name: str = "",
) -> str:
    """业务命名：把 space/项目/年月/文件夹 组成「可浏览逻辑路径」——**不含 uid 前缀、不含文件名**。

    从 _build_key 拆出的纯函数（P0.1）：PathMirrorStrategy 只吃它的结果 `{uid}/{logical_path}/{name}.{ext}`，
    存储层因此不必知道 project_year/mind_map_title 等业务字段。等价性由 test_key_strategy 对拍锁定。
    """
    safe_folder_path = (
        "/".join(_safe_name(part) for part in folder_path.split("/") if part)
        if folder_path else _safe_name(folder_name)
    )
    if space == "project":
        if not project_name and not project_id and not project_year and not project_month and not safe_folder_path:
            return "项目文件"
        proj_dir = f"{_safe_name(project_name)} #{project_id}"
        date_path = f"{project_year}/{project_month}/" if project_year and project_month else ""
        base = f"项目文件/{date_path}{proj_dir}"
        return f"{base}/{safe_folder_path}" if safe_folder_path else base
    if space == "mind":
        return f"思维/{_safe_name(mind_map_title)} #{mind_map_id}"
    if space == "asset":
        return "素材板"
    if space == "workspace":
        base = workspace_directory_path(workspace_directory_name)
        return f"{base}/{safe_folder_path}" if safe_folder_path else base
    # personal
    return f"个人文件/{safe_folder_path}" if safe_folder_path else "个人文件"


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
