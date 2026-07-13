"""folder_doctor —— 文件夹目录对账工具（P1.5，低频兜底，非常驻扫描）。

diff「DB 文件夹树期望的物理目录」vs「盘上实际目录」，产出报告：
- **missing_dirs**：DB 有文件夹但盘上没目录（治 123 空夹缺失）——可**自动补**（ensure_folder，安全）。
- **orphan_dirs**：盘上有目录但**无对应 DB 文件夹、且其下无任何文件**的空骨架（治 adr 幽灵目录）
  ——**先报告，人工确认（remove_orphans=True）后才清**；非空目录绝不纳入（更不自动删）。
- **misplaced_files**：存活 File 的物理 `storage_key` 与其**当前** folder_id/project_id 算出的
  key 不一致——即「DB 说文件在 A 文件夹，物理字节却还躺在旧位置」（P1.4 relocate 本该在文件夹
  改名/移动时同步这个，但历史数据可能来自更早、relocate 逻辑还不存在/不可靠的年代，或某次
  relocate 因故未覆盖到）。——**先报告，人工确认（relocate_files=True）后才搬**：物理对象已丢
  的（幽灵记录范畴，文件对账管）不重复报；destination 冲突走 key_strategy.resolve_conflict。

判定孤儿目录用「父目录合法性」而非枚举全部结构目录：一个文件夹目录的合法父目录只能是
`{uid}/个人文件`、某项目 base 目录、或另一个存活文件夹目录（containers ∪ expected）。
盘上某目录若其父合法、自身不在 expected、且其下无文件 → 顶层孤儿（删它即递归清其空子树）。
结构目录（个人文件 / 项目文件/年/月/项目 / trash / .thumbs …）父不在合法集，天然不会被误判。

misplaced_files 范围限定 `space in (personal, project, asset)`——**不含 mind**：
`MindMap` 模型文档明确「`files.mind_map_id` 是历史字段，只留给旧的思维空间文件存档，
不得再用它判断文件位置」，对这类冻结的历史归档做「纠正物理位置」没有意义，反而可能误动。

对象存储无「空目录」概念 → 全程 no-op（返回空报告）。这是唯一按后端类型分支的地方：
对账本就是文件系统完整性工具，与业务层「不 if local」的约束不冲突。

**安全**：repair 一律在服务端**重新 scan**、只对服务端计算出的列表动作，绝不接受调用方传入
的待删/待搬路径（否则等于给 rmtree/rename 开任意路径入口）；relocate 前对每条记录重新核算
预期 key + 物理对象仍存在，防止基于陈旧报告盲搬。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import File, Folder, Project
from app.services.storage import LocalStorageBackend, StorageBackend
from app.services.storage.factory import get_key_strategy
from app.services.storage.folders import folder_dir_key, resolve_folder_path
from app.services.storage.key_strategy import KeyContext
from app.services.storage.keys import _safe_name, compose_logical_path

# mind 空间的物理位置由历史遗留字段驱动，不在本工具的「纠正物理位置」范围内（见模块顶注）。
_MISPLACED_SPACES = frozenset({"personal", "project", "asset"})
_MISPLACED_CAP = 300   # 报告条数上限，超出标 truncated（同 Config 页文件对账的既有惯例）


@dataclass
class DoctorReport:
    missing_dirs: list[str] = field(default_factory=list)      # 应存在但盘上没有 → 可自动补
    orphan_dirs: list[str] = field(default_factory=list)       # 无对应文件夹的空目录 → 确认后清
    misplaced_files: list[dict] = field(default_factory=list)  # storage_key 跟不上当前归属 → 确认后搬
    scanned_folders: int = 0
    created: int = 0
    removed: int = 0
    relocated: int = 0
    truncated: bool = False

    def to_dict(self) -> dict:
        return {
            "missing_dirs": self.missing_dirs,
            "orphan_dirs": self.orphan_dirs,
            "misplaced_files": self.misplaced_files,
            "scanned_folders": self.scanned_folders,
            "created": self.created,
            "removed": self.removed,
            "relocated": self.relocated,
            "truncated": self.truncated,
            "healthy": not self.missing_dirs and not self.orphan_dirs and not self.misplaced_files,
        }


async def _expected_and_containers(db: AsyncSession, user_id) -> tuple[set[str], set[str], int]:
    """返回 (expected 目录集, 合法父容器集, 扫描的文件夹数)。

    只认存活文件夹（deleted_at IS NULL）——软删的文件夹（P2）不再是「应该存在」的目录，
    它的物理目录留给回收站流程处理（搬 trash / 30 天后 remove_folder 清），不归本对账工具管；
    对账工具此后看到它会当成普通孤儿空目录（若已被搬空）报告，符合软删语义。
    """
    fstmt = select(Folder).where(Folder.deleted_at.is_(None))
    pstmt = select(Project)
    if user_id is not None:
        fstmt = fstmt.where(Folder.user_id == user_id)
        pstmt = pstmt.where(Project.user_id == user_id)
    folders = list((await db.execute(fstmt)).scalars().all())
    projects = list((await db.execute(pstmt)).scalars().all())

    expected: set[str] = set()
    for f in folders:
        dk = await folder_dir_key(db, f.user_id, f)
        if dk:
            expected.add(dk)

    containers: set[str] = set()
    uids = {f.user_id for f in folders} | {p.user_id for p in projects}
    if user_id is not None:
        uids.add(user_id)                           # 用户可能只有孤儿、无文件夹/项目
    for uid in uids:
        containers.add(f"{uid}/个人文件")           # 个人空间文件夹的根容器
    for p in projects:                              # 每个项目的 base 目录（项目文件夹挂这下面）
        date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
        y, m = date_str[:4], date_str[5:7]
        containers.add(f"{p.user_id}/项目文件/{y}/{m}/{_safe_name(p.name)} #{p.id}")
    return expected, containers, len(folders)


async def _expected_file_key(db: AsyncSession, key_strategy, file: File) -> Optional[str]:
    """file **当前** folder_id/project_id/space 算出的 key 应该是什么。
    项目/文件夹断链（已删但未级联清干净）→ None，不在本工具判定范围（那是另一类损坏）。"""
    project = None
    project_year = project_month = ""
    folder_path = ""
    if file.project_id is not None:
        project = await get_owned(db, Project, file.project_id, file.user_id)
        if not project:
            return None
        date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    if file.folder_id is not None:
        resolved = await resolve_folder_path(db, file.user_id, file.folder_id, file.project_id)
        if not resolved:
            return None
        _, folder_path = resolved
    logical = compose_logical_path(
        file.space, project_name=project.name if project else "",
        project_id=file.project_id or 0, project_year=project_year,
        project_month=project_month, folder_path=folder_path)
    ctx = KeyContext(user_id=file.user_id, file_id=file.id, name=file.display_name,
                     ext=file.ext, logical_path=logical)
    return key_strategy.build_key(ctx)


async def _scan_misplaced_files(db: AsyncSession, storage: LocalStorageBackend, user_id) -> tuple[list[dict], bool]:
    key_strategy = get_key_strategy()
    fstmt = select(File).where(File.deleted_at.is_(None))
    if user_id is not None:
        fstmt = fstmt.where(File.user_id == user_id)
    files = (await db.execute(fstmt)).scalars().all()

    misplaced: list[dict] = []
    truncated = False
    for f in files:
        if f.space not in _MISPLACED_SPACES:
            continue   # mind 空间不纳入（历史归档字段，见模块顶注）
        expected_key = await _expected_file_key(db, key_strategy, f)
        if expected_key is None or expected_key == f.storage_key:
            continue
        if not await storage.exists(f.storage_key):
            continue   # 物理对象已丢——幽灵记录范畴（文件对账管），这里不重复报
        if len(misplaced) >= _MISPLACED_CAP:
            truncated = True
            break
        misplaced.append({
            "file_id": f.id,
            "display_name": f.display_name,
            "current_key": f.storage_key,
            "expected_key": expected_key,
        })
    return misplaced, truncated


async def scan(db: AsyncSession, storage: StorageBackend, user_id=None) -> DoctorReport:
    report = DoctorReport()
    if not isinstance(storage, LocalStorageBackend):
        return report   # 对象存储无目录 → 空报告
    expected, containers, n = await _expected_and_containers(db, user_id)
    report.scanned_folders = n

    for dk in sorted(expected):
        if not (storage.root / dk).is_dir():
            report.missing_dirs.append(dk)

    parents_ok = containers | expected
    scan_prefix = str(user_id) if user_id is not None else ""
    orphans: list[str] = []
    for d in await storage.list_dirs(scan_prefix):
        if d in expected:
            continue
        parent = d.rsplit("/", 1)[0] if "/" in d else ""
        if parent not in parents_ok:
            continue                       # 父非合法容器 → 结构目录/无关目录，不判孤儿
        if await storage.dir_has_files(d):
            continue                       # 非空 → 绝不纳入（更不自动删）
        orphans.append(d)
    report.orphan_dirs = sorted(orphans)

    report.misplaced_files, report.truncated = await _scan_misplaced_files(db, storage, user_id)
    return report


async def repair(db: AsyncSession, storage: StorageBackend, *,
                 user_id=None, remove_orphans: bool = False,
                 relocate_files: bool = False) -> DoctorReport:
    """服务端重新 scan → 补缺失目录（总是）；remove_orphans=True 时清空孤儿；relocate_files=True
    时把 misplaced_files 物理搬到当前归属应在的位置。均只对服务端计算的列表动作，relocate 前
    逐条重新核算预期 key + 物理对象仍存在，防止基于陈旧报告盲搬。

    返回值反映**修复后的真实状态**（有动作发生时重新扫描一遍），而非停留在修复前的快照——
    否则「已经搬完了但报告还说 misplaced」会误导调用方（管理面板据此判断是否已 healthy）。
    """
    report = await scan(db, storage, user_id)
    if not isinstance(storage, LocalStorageBackend):
        return report
    created = removed = relocated = 0
    for dk in report.missing_dirs:
        await storage.ensure_folder(dk)
        created += 1
    if remove_orphans:
        for d in report.orphan_dirs:
            if not await storage.dir_has_files(d):   # 二次确认仍空
                await storage.remove_folder(d)
                removed += 1
    if relocate_files and report.misplaced_files:
        key_strategy = get_key_strategy()
        for item in report.misplaced_files:
            f = await db.get(File, item["file_id"])
            if f is None or f.deleted_at is not None:
                continue
            expected_key = await _expected_file_key(db, key_strategy, f)
            if expected_key is None or expected_key == f.storage_key:
                continue                              # 状态已变（并发改动），跳过
            if not await storage.exists(f.storage_key):
                continue                              # 物理对象已消失，跳过（幽灵记录范畴）
            resolved = await key_strategy.resolve_conflict(storage, expected_key, f.display_name, f.ext)
            await storage.rename_file(f.storage_key, resolved.key)
            f.storage_key = resolved.key
            f.display_name = resolved.name
            relocated += 1
        await db.commit()
    if created or removed or relocated:
        report = await scan(db, storage, user_id)   # 重新扫描，返回修复后的真实状态
    report.created = created
    report.removed = removed
    report.relocated = relocated
    return report
