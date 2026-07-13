"""folder_doctor —— 文件夹目录对账工具（P1.5，低频兜底，非常驻扫描）。

diff「DB 文件夹树期望的物理目录」vs「盘上实际目录」，产出报告：
- **missing_dirs**：DB 有文件夹但盘上没目录（治 123 空夹缺失）——可**自动补**（ensure_folder，安全）。
- **orphan_dirs**：盘上有目录但**无对应 DB 文件夹、且其下无任何文件**的空骨架（治 adr 幽灵目录）
  ——**先报告，人工确认（remove_orphans=True）后才清**；非空目录绝不纳入（更不自动删）。

判定孤儿用「父目录合法性」而非枚举全部结构目录：一个文件夹目录的合法父目录只能是
`{uid}/个人文件`、某项目 base 目录、或另一个存活文件夹目录（containers ∪ expected）。
盘上某目录若其父合法、自身不在 expected、且其下无文件 → 顶层孤儿（删它即递归清其空子树）。
结构目录（个人文件 / 项目文件/年/月/项目 / trash / .thumbs …）父不在合法集，天然不会被误判。

对象存储无「空目录」概念 → 全程 no-op（返回空报告）。这是唯一按后端类型分支的地方：
对账本就是文件系统完整性工具，与业务层「不 if local」的约束不冲突。

**安全**：repair 一律在服务端**重新 scan**、只对服务端计算出的列表动作，绝不接受调用方传入
的待删路径（否则等于给 rmtree 开任意路径入口）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Folder, Project
from app.services.storage import LocalStorageBackend, StorageBackend
from app.services.storage.folders import folder_dir_key
from app.services.storage.keys import _safe_name


@dataclass
class DoctorReport:
    missing_dirs: list[str] = field(default_factory=list)   # 应存在但盘上没有 → 可自动补
    orphan_dirs: list[str] = field(default_factory=list)    # 无对应文件夹的空目录 → 确认后清
    scanned_folders: int = 0
    created: int = 0
    removed: int = 0

    def to_dict(self) -> dict:
        return {
            "missing_dirs": self.missing_dirs,
            "orphan_dirs": self.orphan_dirs,
            "scanned_folders": self.scanned_folders,
            "created": self.created,
            "removed": self.removed,
            "healthy": not self.missing_dirs and not self.orphan_dirs,
        }


async def _expected_and_containers(db: AsyncSession, user_id) -> tuple[set[str], set[str], int]:
    """返回 (expected 目录集, 合法父容器集, 扫描的文件夹数)。"""
    fstmt = select(Folder)
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
    return report


async def repair(db: AsyncSession, storage: StorageBackend, *,
                 user_id=None, remove_orphans: bool = False) -> DoctorReport:
    """服务端重新 scan → 补缺失目录（总是）；remove_orphans=True 时清空孤儿（人工确认后）。
    只对服务端计算的列表动作，孩子二次校验仍空才删——绝不接受外部传入路径。"""
    report = await scan(db, storage, user_id)
    if not isinstance(storage, LocalStorageBackend):
        return report
    for dk in report.missing_dirs:
        await storage.ensure_folder(dk)
        report.created += 1
    if remove_orphans:
        for d in report.orphan_dirs:
            if not await storage.dir_has_files(d):   # 二次确认仍空
                await storage.remove_folder(d)
                report.removed += 1
    return report
