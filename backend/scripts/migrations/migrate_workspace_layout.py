"""停服迁移所有用户工作区至 workspace/<稳定目录名>；默认仅预检。

先持久化带时间戳的迁移计划和原始元数据，再按计划原子改名。
中断后重跑同一入口续跑；目标冲突、符号链接或路径越界立即失败，不覆盖文件。
"""
from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import select

from app.models import ChatAttachment, File, User, WorkspaceDirectory
from app.services.storage.keys import RESERVED_USER_ROOTS, _safe_name, workspace_directory_segment


def save_journal(path: Path, journal: dict) -> None:
    temporary = path.with_name(f"{path.name}.{uuid4().hex}.tmp")
    with temporary.open("x", encoding="utf-8") as output:
        os.chmod(temporary, 0o600)
        json.dump(journal, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def checked_path(root: Path, relative: str) -> Path:
    path = root / relative
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root):
        raise ValueError("迁移路径不能是符号链接")
    path.resolve().relative_to(root.resolve())
    return path


def execute_moves(root: Path, journal: dict, checkpoint) -> None:
    for move in journal["moves"]:
        if move.get("done"):
            continue
        source = checked_path(root, move["source"])
        target = checked_path(root, move["target"])
        if source.exists():
            identity = source.stat()
            if [identity.st_dev, identity.st_ino] != move["identity"]:
                raise ValueError("迁移目录身份不匹配，拒绝移动源目录")
            if target.exists():
                raise ValueError("工作区迁移目标冲突，未覆盖任何目标文件")
            target.parent.mkdir(parents=True, exist_ok=True)
            source.rename(target)
        elif not target.exists():
            raise ValueError("工作区迁移源与目标均不存在")
        actual = target.stat()
        if [actual.st_dev, actual.st_ino] != move["identity"]:
            raise ValueError("迁移目录身份不匹配，拒绝接管目标")
        for parent in {source.parent, target.parent}:
            descriptor = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        move["done"] = True
        checkpoint()


async def migrate(db, root: Path, *, apply: bool) -> dict:
    marker = root / ".workspace-layout-v2.json"
    if marker.is_symlink():
        raise ValueError("迁移清单不能是符号链接")
    if marker.exists():
        journal = json.loads(marker.read_text(encoding="utf-8"))
        if journal["status"] == "completed":
            return {"status": "already_completed"}
    else:
        directories = list((await db.scalars(select(WorkspaceDirectory).order_by(WorkspaceDirectory.id))).all())
        users = list((await db.scalars(select(User.id))).all())
        journal = {"status": "planned", "version": 2, "directories": [], "keys": [], "moves": []}
        by_user: dict[str, list] = {}
        for directory in directories:
            by_user.setdefault(str(directory.user_id), []).append(directory)
        for uid in map(str, users):
            mappings = {"workspace": "default"}
            used = {"default"}
            # 活跃记录优先确定物理根；已删除同根记录沿用映射，不重搬文件。
            for directory in sorted(by_user.get(uid, []), key=lambda row: (row.deleted_at is not None, row.id)):
                old = directory.directory_name
                if not old or _safe_name(old) != old or old in {".", ".."} or (old in RESERVED_USER_ROOTS and old != "workspace"):
                    raise ValueError("旧工作区目录与系统根冲突或路径无效")
                checked_path(root, f"{uid}/{old}")
                if old not in mappings:
                    segment = workspace_directory_segment(directory.name, str(directory.id), is_default=directory.is_default)
                    if segment in used:
                        segment = f"{segment}-{directory.id}"
                    used.add(segment)
                    mappings[old] = segment
                journal["directories"].append({"id": directory.id, "old": old, "new": mappings[old]})
            # 旧 workspace 是默认文件根；先整体改名到同盘暂存，避免向自己的子目录移动。
            legacy = checked_path(root, f"{uid}/workspace")
            if legacy.exists():
                stage = f"{uid}/.workspace-layout-v2-staging"
                if checked_path(root, stage).exists():
                    raise ValueError("存在未登记的迁移暂存目录")
                journal["moves"].extend([
                    {"source": f"{uid}/workspace", "target": stage},
                    {"source": stage, "target": f"{uid}/workspace/default"},
                ])
            for old, segment in mappings.items():
                if old != "workspace" and checked_path(root, f"{uid}/{old}").exists():
                    journal["moves"].append({"source": f"{uid}/{old}", "target": f"{uid}/workspace/{segment}"})
            for model in (File, ChatAttachment):
                records = list((await db.scalars(select(model).where(model.user_id == UUID(uid)))).all())
                for record in records:
                    for old, segment in mappings.items():
                        prefix = f"{uid}/{old}/"
                        if record.storage_key.startswith(prefix):
                            journal["keys"].append({"model": model.__name__, "id": record.id,
                                                    "old": record.storage_key,
                                                    "new": f"{uid}/workspace/{segment}/" + record.storage_key[len(prefix):]})
                            break
        # 完整预检在任何移动之前执行。
        sources = {move["source"] for move in journal["moves"]}
        identities = {}
        for move in journal["moves"]:
            source = checked_path(root, move["source"])
            if source.exists():
                identity = source.stat()
                move["identity"] = [identity.st_dev, identity.st_ino]
            else:
                move["identity"] = identities[move["source"]]
            identities[move["target"]] = move["identity"]
            target = checked_path(root, move["target"])
            if target.exists() and move["target"] not in sources:
                raise ValueError("工作区迁移目标已存在")
        if apply:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            save_journal(root / f".workspace-layout-v2-backup-{stamp}.json", journal)
            save_journal(marker, journal)
    if not apply:
        return {"status": "preview", "directories": len(journal["directories"]), "moves": len(journal["moves"]), "keys": len(journal["keys"])}
    execute_moves(root, journal, lambda: save_journal(marker, journal))
    directory_rows = []
    for item in journal["directories"]:
        row = await db.get(WorkspaceDirectory, item["id"])
        if row is None or row.directory_name not in {item["old"], item["new"]}:
            raise ValueError("迁移期间工作区元数据发生变化")
        directory_rows.append((row, item["new"]))
    # 先移出旧段名空间，再统一写入新段名；避免 QQ→qq 与旧 qq 记录碰撞。
    temporary_prefix = f"migration-{uuid4().hex}"
    for row, _new in directory_rows:
        row.directory_name = f"{temporary_prefix}-{row.id}"
    await db.flush()
    for row, new in directory_rows:
        row.directory_name = new
    for item in journal["keys"]:
        row = await db.get({"File": File, "ChatAttachment": ChatAttachment}[item["model"]], item["id"])
        if row is None or row.storage_key not in {item["old"], item["new"]}:
            raise ValueError("迁移期间文件元数据发生变化")
        row.storage_key = item["new"]
    await db.commit()
    journal["status"] = "completed"
    save_journal(marker, journal)
    return {"status": "completed", "directories": len(journal["directories"]), "moves": len(journal["moves"]), "keys": len(journal["keys"])}


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-real-data", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--services-stopped", action="store_true")
    parser.add_argument("--status", action="store_true", help="只报告布局迁移状态，不修改数据")
    parser.add_argument("--check", action="store_true", help="只确认迁移完成；空库建立新布局标记，旧库拒绝启动")
    args = parser.parse_args()
    if args.status and (args.apply or args.check):
        parser.error("--status 不能与 --apply 或 --check 同时使用")
    if not args.allow_real_data or (args.apply and not args.services_stopped):
        parser.error("需显式 --allow-real-data；执行迁移还需停服并传 --services-stopped")
    from app.core.config import get_settings
    import app.db.session as session
    settings = get_settings()
    if settings.storage.backend != "local":
        if args.status:
            print("external")
            return
        print("非本地存储，跳过工作区磁盘迁移")
        return
    session.ensure_engine()
    root = Path(settings.storage.local_path).resolve()
    if args.status:
        marker = root / ".workspace-layout-v2.json"
        if marker.is_symlink():
            raise ValueError("迁移清单不能是符号链接")
        if marker.exists():
            journal = json.loads(marker.read_text(encoding="utf-8"))
            if journal["status"] == "completed":
                print("completed")
                return
        async with session._SessionLocal() as db:
            state = "pending" if await db.scalar(select(User.id).limit(1)) is not None else "empty"
        print(state)
        return
    if args.check:
        marker = root / ".workspace-layout-v2.json"
        # 使用 migrate 的同一清单事实源，不能由启动进程自称已经停服。
        async with session._SessionLocal() as db:
            result = await migrate(db, root, apply=False)
            if result["status"] == "already_completed":
                return
            if await db.scalar(select(User.id).limit(1)) is not None:
                raise RuntimeError("工作区布局尚未离线迁移完成；请停服、备份后执行迁移，禁止在线移动用户文件")
        root.mkdir(parents=True, exist_ok=True)
        # 全新空库没有旧用户数据；只标记当前布局，不能对有用户的库采用此分支。
        save_journal(marker, {"status": "completed", "version": 2, "directories": [], "keys": [], "moves": []})
        return
    if args.apply:
        root.mkdir(parents=True, exist_ok=True)
    # 两个应用容器可能共享卷并同时启动；全局锁覆盖文件移动和数据库提交。
    if args.apply:
        lock_path = root / ".workspace-layout-v2.lock"
        if lock_path.is_symlink():
            raise ValueError("迁移锁不能是符号链接")
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            async with session._SessionLocal() as db:
                result = await migrate(db, root, apply=True)
    else:
        async with session._SessionLocal() as db:
            result = await migrate(db, root, apply=False)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
