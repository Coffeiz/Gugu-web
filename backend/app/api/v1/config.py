"""
Admin 配置接口
GET   /api/v1/admin/config                  → 读取当前配置（密码字段脱敏）
PATCH /api/v1/admin/config                  → 写入 override，热更新无需重启（DB 配置会触发自动建表）
POST  /api/v1/admin/config/test-connection  → 用当前输入的参数测试连通性
POST  /api/v1/admin/config/init-db           → 手动初始化数据库（建表）
"""

import asyncio
import base64
import io
import json
import time
import wave

import httpx
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator
from typing import Any, Literal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings, save_override
from app.core.redaction import redact
from app.db.session import create_all_tables, reset_engine, get_db

router = APIRouter(prefix="/admin/config", tags=["admin"])


def _mask(d: dict) -> dict:
    """脱敏：含 key / secret / password 的字段显示为 ****"""
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out[k] = _mask(v)
        elif any(word in k.lower() for word in ("key", "secret", "password")):
            out[k] = "****" if v else ""
        else:
            out[k] = v
    return out


@router.get("")
async def read_config():
    cfg = get_settings()
    raw = cfg.model_dump()
    return {"data": _mask(raw)}


class ConfigPatch(BaseModel):
    patch: dict[str, Any]


@router.patch("")
async def update_config(body: ConfigPatch, request: Request, db: AsyncSession = Depends(get_db)):
    import traceback as _tb
    from app.api.v1.audit_log import write_log
    try:
        new_cfg = await save_override(body.patch)
        sections = "、".join(body.patch.keys())
        username = getattr(request.state, "admin_username", "admin")
        await write_log(db, username, "config", f"修改配置：{sections}", request)
        return {"message": "配置已更新", "data": _mask(new_cfg.model_dump())}
    except Exception as e:
        print(f"[config] 操作失败: {type(e).__name__}: {e}\n{_tb.format_exc()}", flush=True)
        raise HTTPException(status_code=500, detail="操作失败，请查看服务端日志排查")


@router.post("/init-db")
async def init_db():
    """手动初始化数据库（建表）。Admin 后台「数据库」标签下有按钮。

    - 强制重置引擎 → 用最新 config 重建连接
    - 调用 create_all_tables 建表
    - 最多等 10s，超时返回 504
    """
    import traceback as _tb
    try:
        reset_engine()
        await asyncio.wait_for(create_all_tables(), timeout=10)
        return {"ok": True, "message": "数据库表已创建/已就绪"}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="数据库 10s 内未连通，请检查连接信息")
    except Exception as e:
        print(f"[config] 操作失败: {type(e).__name__}: {e}\n{_tb.format_exc()}", flush=True)
        raise HTTPException(status_code=500, detail="操作失败，请查看服务端日志排查")


# ── 存储 ↔ DB 对账（只读）────────────────────────────────────────────────

def _is_internal_key(k: str) -> bool:
    """非 File 表管理的内部对象：记忆 .agent/、聊天暂存 .chat_staging/、缩略图 .thumbs/、
    用户头像 avatars/。对账时跳过，避免误报成孤儿。"""
    return (".agent/" in k or ".chat_staging" in k or ".thumbs" in k
            or "_thumb" in k or ".thumbcache" in k or k.startswith("avatars/"))


@router.get("/reconcile-storage")
async def reconcile_storage(db: AsyncSession = Depends(get_db)):
    """存储 ↔ DB 文件表对账（**只读，不改任何数据**）。以实际存储为准判断文件到底在不在：
    - 幽灵记录：DB 有行，但物理文件缺失（app 里看得到、点开 404）
    - 孤儿文件：物理文件存在，但 DB 没有对应记录（app 里看不见）
    """
    from app.models import File, Project
    from app.services.storage import get_storage
    cfg = get_settings()
    storage = get_storage()
    try:
        all_keys = set(await storage.list_keys())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"列出存储失败：{type(e).__name__}: {e}")
    file_keys = {k for k in all_keys if not _is_internal_key(k)}

    # 仅比较 storage_key 会漏掉“DB 和物理文件都指向同一个旧路径、但文件夹归属已变”的历史错位。
    # 复用目录对账的路径真源，把这类文件一并呈现在文件对账入口。
    from app.services.storage import folder_doctor
    doctor_report = await folder_doctor.scan(db, storage)

    rows = (await db.execute(select(File))).scalars().all()
    db_key_set = {f.storage_key for f in rows}
    projs = {p.id: p.name for p in (await db.execute(select(Project))).scalars().all()}

    ghosts = [
        {"id": f.id, "name": f"{f.display_name}.{f.ext}", "space": f.space,
         "project": projs.get(f.project_id), "deleted": f.deleted_at is not None,
         "storage_key": f.storage_key}
        for f in rows if f.storage_key not in all_keys
    ]
    orphans = sorted(file_keys - db_key_set)
    return {
        "backend": cfg.storage.backend,
        "location": cfg.storage.local_path if cfg.storage.backend == "local"
                    else f"{cfg.storage.oss_bucket}/{cfg.storage.oss_prefix}",
        "db_file_rows": len(rows),
        "storage_objects": len(file_keys),
        "matched": len(db_key_set & all_keys),
        "ghost_count": len(ghosts),
        "orphan_count": len(orphans),
        "ghosts": ghosts[:300],
        "orphans": orphans[:300],
        "misplaced_count": len(doctor_report.misplaced_files),
        "misplaced_files": doctor_report.misplaced_files[:300],
        "truncated": len(ghosts) > 300 or len(orphans) > 300 or doctor_report.truncated,
    }


def _fmt_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _parse_path_migration_key(key: str) -> dict | None:
    """解析 path-mirror key 的稳定归属部分，不做数据库查询。"""
    import re
    import uuid as _uuid

    parts = key.split("/")
    if len(parts) < 3:
        return None
    if any(part in {"", ".", ".."} for part in parts):
        return None
    try:
        user_id = str(_uuid.UUID(parts[0]))
    except ValueError:
        return None
    name, dot, ext = parts[-1].rpartition(".")
    if not dot:
        name, ext = parts[-1], ""
    if parts[1] == "个人文件":
        return {
            "user_id": user_id, "space": "personal", "project_id": None,
            "folder_parts": parts[2:-1], "display_name": name, "ext": ext.lower(),
        }
    if parts[1] != "项目文件":
        return None
    project_id = None
    project_index = None
    for index, part in enumerate(parts[2:-1], start=2):
        match = re.search(r"#(\d+)$", part)
        if match:
            project_id = int(match.group(1))
            project_index = index
            break
    if project_id is None or project_index is None:
        return None
    return {
        "user_id": user_id, "space": "project", "project_id": project_id,
        "folder_parts": parts[project_index + 1:-1], "display_name": name,
        "ext": ext.lower(),
    }


def _same_file_scope(file, parsed: dict) -> bool:
    return file.space == parsed["space"] and file.project_id == parsed["project_id"]


async def _import_orphan(db, key: str, storage) -> bool:
    """按已验证的 path-mirror key 导入孤儿文件，不猜测不完整的归属。"""
    import mimetypes
    import uuid
    from app.models import File, Project, User

    parsed = _parse_path_migration_key(key)
    if parsed is None:
        return False
    uid_text = parsed["user_id"]
    uid = uuid.UUID(uid_text)
    if not await db.get(User, uid):
        return False
    # 修复接口也可能被手工传入重复 key；不能让同一物理对象产生第二条 File。
    existing = (await db.execute(select(File).where(File.storage_key == key))).scalars().first()
    if existing is not None:
        return False

    info = await storage.stat(key)
    if info is None:
        return False

    fname = key.rsplit("/", 1)[-1]
    name, _, ext = fname.rpartition(".")
    if not name:
        name, ext = fname, ""
    project_id = parsed["project_id"]
    if project_id is not None:
        project = await db.get(Project, project_id)
        if project is None or str(project.user_id) != uid_text:
            return False
    folder_id = await _resolve_import_folder(db, uid, project_id, parsed["folder_parts"])
    if parsed["folder_parts"] and folder_id is None:
        return False
    db.add(File(
        user_id=uid, display_name=name, ext=ext.lower(), space=parsed["space"],
        project_id=project_id, folder_id=folder_id, storage_key=key,
        size=_fmt_size(info.size), size_bytes=info.size,
        mime_type=mimetypes.guess_type(fname)[0],
    ))
    return True


async def _resolve_import_folder(db, user_id, project_id: int | None, folder_parts: list[str]) -> int | None:
    """按物理路径逐级解析文件夹，避免嵌套文件误挂到第一级目录。"""
    from app.models import Folder

    parent_id = None
    for name in folder_parts:
        folder = (await db.execute(select(Folder).where(
            Folder.user_id == user_id,
            Folder.project_id == project_id if project_id is not None else Folder.project_id.is_(None),
            Folder.parent_id == parent_id if parent_id is not None else Folder.parent_id.is_(None),
            Folder.name == name,
            Folder.deleted_at.is_(None),
        ))).scalars().first()
        if folder is None:
            return None
        parent_id = folder.id
    return parent_id


class RepairRequest(BaseModel):
    action: Literal["delete", "import"]
    keys: list[str]


class PathMigrationItem(BaseModel):
    file_id: int
    key: str
    expected_old_key: str


class PathMigrationRequest(BaseModel):
    items: list[PathMigrationItem]

    def model_post_init(self, __context: Any) -> None:
        if len(self.items) > 1000:
            raise ValueError("单次路径迁移最多处理 1000 项")


class TrashMigrationRequest(BaseModel):
    file_ids: list[int]


@router.get("/migrate-trash")
async def scan_legacy_trash(db: AsyncSession = Depends(get_db)):
    """扫描旧版按 file_id 分目录的本地回收站对象，只读。"""
    from app.models import File
    from app.services.storage import LocalStorageBackend, get_storage
    from app.services.storage.keys import _resolve_conflict
    from app.services.storage.trash import is_legacy_trash_key, original_storage_key, to_trash_key

    storage = get_storage()
    if not isinstance(storage, LocalStorageBackend):
        return {"backend": "oss", "items": [], "note": "当前不是本地存储，无需迁移。"}
    rows = (await db.execute(select(File).where(File.deleted_at.isnot(None)))).scalars().all()
    items = []
    for f in rows:
        if not is_legacy_trash_key(f) or not await storage.exists(f.storage_key):
            continue
        original = await original_storage_key(f, db)
        target, _ = await _resolve_conflict(storage, to_trash_key(f.user_id, original, f.display_name, f.ext), f.display_name, f.ext)
        items.append({"file_id": f.id, "name": f.display_name, "ext": f.ext,
                      "source_key": f.storage_key, "target_key": target,
                      "conflict": await storage.exists(target)})
    return {"backend": "local", "items": items, "count": len(items)}


@router.post("/migrate-trash")
async def migrate_legacy_trash(body: TrashMigrationRequest, db: AsyncSession = Depends(get_db)):
    """迁移指定旧回收站对象；只处理扫描结果对应的已删除文件，不覆盖目标文件。"""
    from app.models import File
    from app.services.storage import LocalStorageBackend, get_storage
    from app.services.storage.keys import _resolve_conflict
    from app.services.storage.trash import is_legacy_trash_key, original_storage_key, to_trash_key

    storage = get_storage()
    if not isinstance(storage, LocalStorageBackend):
        raise HTTPException(status_code=409, detail="当前不是本地存储，无需迁移")
    rows = (await db.execute(select(File).where(File.id.in_(body.file_ids), File.deleted_at.isnot(None)))).scalars().all()
    done, skipped = [], []
    for f in rows:
        if not is_legacy_trash_key(f) or not await storage.exists(f.storage_key):
            skipped.append({"file_id": f.id, "reason": "不是可迁移的旧回收站对象"})
            continue
        original = await original_storage_key(f, db)
        target, _ = await _resolve_conflict(storage, to_trash_key(f.user_id, original, f.display_name, f.ext), f.display_name, f.ext)
        if await storage.exists(target):
            skipped.append({"file_id": f.id, "reason": "目标已存在，未覆盖"})
            continue
        await storage.rename_file(f.storage_key, target)
        f.storage_key = target
        done.append(f.id)
    await db.commit()
    return {"done": done, "skipped": skipped}


@router.post("/reconcile-storage/repair")
async def reconcile_repair(body: RepairRequest, db: AsyncSession = Depends(get_db)):
    """对账修复（**会改数据**）：delete 删孤儿物理文件；import 把孤儿重建成 DB 记录。"""
    from app.services.storage import get_storage
    storage = get_storage()
    done, failed = [], []
    for key in body.keys:
        try:
            if body.action == "delete":
                await storage.delete(key)
                done.append(key)
            else:
                if await _import_orphan(db, key, storage):
                    done.append(key)
                else:
                    failed.append({"key": key, "error": "无法从路径解析归属"})
        except Exception as e:
            failed.append({"key": key, "error": f"{type(e).__name__}: {e}"[:80]})
    await db.commit()
    return {"action": body.action, "done": len(done), "failed": failed, "done_keys": done}


@router.get("/reconcile-storage/path-migration")
async def scan_path_migration(db: AsyncSession = Depends(get_db)):
    """扫描物理路径已变、但 File 记录仍指向旧路径的文件；只返回唯一安全匹配项。"""
    from app.models import File
    from app.services.storage import get_storage

    storage = get_storage()
    keys = {k for k in await storage.list_keys() if not _is_internal_key(k)}
    rows = (await db.execute(select(File).where(File.deleted_at.is_(None)))).scalars().all()
    by_identity: dict[tuple, list] = {}
    for file in rows:
        identity = (str(file.user_id), file.display_name, (file.ext or "").lower(), file.size_bytes or 0)
        by_identity.setdefault(identity, []).append(file)
    known = {file.storage_key for file in rows}
    orphan_groups: dict[tuple, list[dict]] = {}
    for key in sorted(keys - known):
        parsed = _parse_path_migration_key(key)
        if parsed is None:
            continue
        info = await storage.stat(key)
        identity = (parsed["user_id"], parsed["display_name"], parsed["ext"], info.size if info else 0)
        orphan_groups.setdefault(identity, []).append({"key": key, "parsed": parsed, "size_bytes": identity[3]})

    candidates, ambiguous = [], []
    for identity, orphans in orphan_groups.items():
        matches = by_identity.get(identity, [])
        # 一个 identity 对应多个物理对象时，不能猜哪一个才是 File 的真源。
        if len(orphans) != 1 or len(matches) != 1:
            ambiguous.append({
                "keys": [item["key"] for item in orphans],
                "file_ids": [file.id for file in matches],
                "name": identity[1],
                "size_bytes": identity[3],
                "reason": "同一 identity 存在多个物理对象或数据库记录",
            })
            continue
        file = matches[0]
        parsed = orphans[0]["parsed"]
        if parsed["space"] == "project":
            from app.models import Project
            project = await db.get(Project, parsed["project_id"])
            if project is None or str(project.user_id) != parsed["user_id"]:
                ambiguous.append({"keys": [orphans[0]["key"]], "file_ids": [file.id],
                                  "name": identity[1], "size_bytes": identity[3],
                                  "reason": "项目不存在或不属于文件所有者"})
                continue
        parsed["folder_id"] = await _resolve_import_folder(
            db, parsed["user_id"], parsed["project_id"], parsed["folder_parts"]
        )
        if parsed["folder_parts"] and parsed["folder_id"] is None:
            ambiguous.append({"keys": [orphans[0]["key"]], "file_ids": [file.id],
                              "name": identity[1], "size_bytes": identity[3],
                              "reason": "目录路径无法解析"})
            continue
        if not _same_file_scope(file, parsed):
            ambiguous.append({
                "keys": [orphans[0]["key"]], "file_ids": [file.id],
                "name": identity[1], "size_bytes": identity[3],
                "reason": "物理路径的空间或项目归属与数据库不一致",
            })
            continue
        candidates.append({
            "key": orphans[0]["key"], "file_id": file.id,
            "expected_old_key": file.storage_key,
            "old_folder_id": file.folder_id,
            "space": parsed["space"], "project_id": parsed["project_id"],
            "folder_id": parsed["folder_id"], "name": identity[1],
            "size_bytes": identity[3],
        })
    return {"candidates": candidates, "ambiguous": ambiguous,
            "candidate_count": len(candidates), "ambiguous_count": len(ambiguous)}


@router.post("/reconcile-storage/path-migration/repair")
async def repair_path_migration(body: PathMigrationRequest, db: AsyncSession = Depends(get_db)):
    """按物理 key 重新计算文件夹归属并更新 File 记录；不搬动物理文件。"""
    from app.models import File
    from app.services.storage import get_storage

    storage = get_storage()
    requested = {item.file_id: item for item in body.items}
    if len(requested) != len(body.items):
        raise HTTPException(status_code=422, detail="同一文件不能重复提交迁移项")
    rows = (await db.execute(select(File).where(File.id.in_(requested), File.deleted_at.is_(None)))).scalars().all()
    found_ids = {file.id for file in rows}
    missing_ids = sorted(set(requested) - found_ids)
    all_files = (await db.execute(select(File))).scalars().all()
    occupied = {file.storage_key: file.id for file in all_files}
    # 扫描与修复之间可能又出现同 identity 的记录/对象；这里重新建立计数，
    # 不把旧扫描结果当成永久授权。没有唯一 fingerprint 时，启发式匹配必须保持唯一。
    db_identity_counts: dict[tuple, int] = {}
    for file in all_files:
        if file.deleted_at is not None:
            continue
        identity = (str(file.user_id), file.display_name, (file.ext or "").lower(), file.size_bytes or 0)
        db_identity_counts[identity] = db_identity_counts.get(identity, 0) + 1
    known_keys = {file.storage_key for file in all_files}
    orphan_identity_counts: dict[tuple, int] = {}
    for key in await storage.list_keys():
        if key in known_keys or _is_internal_key(key):
            continue
        parsed_key = _parse_path_migration_key(key)
        if parsed_key is None:
            continue
        info = await storage.stat(key)
        if info is None:
            continue
        identity = (parsed_key["user_id"], parsed_key["display_name"], parsed_key["ext"], info.size)
        orphan_identity_counts[identity] = orphan_identity_counts.get(identity, 0) + 1
    done = []
    failed = [{"file_id": file_id, "error": "文件不存在或已删除"} for file_id in missing_ids]
    for file in rows:
        try:
            item = requested[file.id]
            new_key = item.key
            if item.expected_old_key != file.storage_key:
                failed.append({"file_id": file.id, "error": "旧路径已变化，请重新扫描"})
                continue
            if new_key == file.storage_key:
                failed.append({"file_id": file.id, "error": "新旧路径相同"})
                continue
            if not new_key.startswith(f"{file.user_id}/") or ".." in new_key.split("/"):
                failed.append({"file_id": file.id, "error": "路径不属于文件所有者"})
                continue
            if occupied.get(new_key) not in (None, file.id):
                failed.append({"file_id": file.id, "error": "新路径已被其他文件占用"})
                continue
            if await storage.exists(file.storage_key):
                failed.append({"file_id": file.id, "error": "旧路径仍存在，拒绝覆盖"})
                continue
            if not await storage.exists(new_key):
                failed.append({"file_id": file.id, "error": "物理文件不存在"})
                continue
            parsed = _parse_path_migration_key(new_key)
            if parsed is None:
                failed.append({"file_id": file.id, "error": "路径无法解析"})
                continue
            if parsed["user_id"] != str(file.user_id):
                failed.append({"file_id": file.id, "error": "路径不属于文件所有者"})
                continue
            if parsed["display_name"] != file.display_name or parsed["ext"] != (file.ext or "").lower():
                failed.append({"file_id": file.id, "error": "文件名或扩展名不匹配"})
                continue
            stat = await storage.stat(new_key)
            if stat is None:
                failed.append({"file_id": file.id, "error": "物理文件不存在"})
                continue
            if stat.size != (file.size_bytes or 0):
                failed.append({"file_id": file.id, "error": "文件大小不匹配"})
                continue
            identity = (str(file.user_id), file.display_name, (file.ext or "").lower(), stat.size)
            if db_identity_counts.get(identity) != 1 or orphan_identity_counts.get(identity) != 1:
                failed.append({"file_id": file.id, "error": "路径身份不再唯一，请重新扫描"})
                continue
            # 路径迁移只允许同空间、同项目内修复；跨空间/项目必须走正式移动接口，
            # 避免只改 storage_key 而留下其它归属字段互相矛盾。
            if not _same_file_scope(file, parsed):
                failed.append({"file_id": file.id, "error": "不支持跨空间或跨项目路径迁移"})
                continue
            if parsed["space"] == "project":
                from app.models import Project
                project = await db.get(Project, parsed["project_id"])
                if project is None or str(project.user_id) != str(file.user_id):
                    failed.append({"file_id": file.id, "error": "项目不存在或不属于文件所有者"})
                    continue
            folder_id = await _resolve_import_folder(
                db, file.user_id, parsed["project_id"], parsed["folder_parts"]
            )
            if parsed["folder_parts"] and folder_id is None:
                failed.append({"file_id": file.id, "error": "目录路径无法解析"})
                continue
            file.space = parsed["space"]
            file.project_id = parsed["project_id"]
            file.folder_id = folder_id
            file.storage_key = new_key
            done.append(file.id)
        except Exception as exc:
            failed.append({"file_id": file.id, "error": type(exc).__name__})
    await db.commit()
    return {"done": done, "failed": failed}


# ── 连接测试 ──────────────────────────────────────────────────────────────

class DbTestParams(BaseModel):
    host: str
    port: int = 5432
    name: str
    user: str
    password: str


class RedisTestParams(BaseModel):
    host: str
    port: int = 6379
    password: str = ""


class OssTestParams(BaseModel):
    endpoint: str
    bucket: str
    access_key_id: str
    access_key_secret: str
    prefix: str = ""


class TestConnectionRequest(BaseModel):
    type: Literal["db", "redis", "oss"]
    db: DbTestParams | None = None
    redis: RedisTestParams | None = None
    oss: OssTestParams | None = None


@router.post("/test-connection")
async def test_connection(body: TestConnectionRequest):
    # 密码为空时回退到已保存的配置（前端留空 = 未修改）
    cfg = get_settings()

    if body.type == "db":
        if not body.db:
            return {"ok": False, "message": "缺少数据库参数"}
        try:
            import asyncpg
            p = body.db
            conn = await asyncpg.connect(
                host=p.host,
                port=p.port,
                database=p.name,
                user=p.user,
                password=p.password or cfg.db.password,
                timeout=5,
            )
            ver = await conn.fetchval("SELECT version()")
            await conn.close()
            short = ver.split(",")[0] if ver else "连接成功"
            return {"ok": True, "message": short}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    elif body.type == "redis":
        if not body.redis:
            return {"ok": False, "message": "缺少 Redis 参数"}
        try:
            import redis.asyncio as aioredis
            p = body.redis
            password = p.password or cfg.redis.password
            url = (
                f"redis://:{password}@{p.host}:{p.port}"
                if password
                else f"redis://{p.host}:{p.port}"
            )
            r = aioredis.from_url(url, socket_connect_timeout=5)
            await r.ping()
            await r.aclose()
            return {"ok": True, "message": "PONG — 连接正常"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    elif body.type == "oss":
        if not body.oss:
            return {"ok": False, "message": "缺少 OSS 参数"}
        try:
            import asyncio
            import oss2
            p = body.oss
            key_id     = p.access_key_id     or cfg.storage.oss_access_key_id
            key_secret = p.access_key_secret or cfg.storage.oss_access_key_secret
            endpoint   = p.endpoint or cfg.storage.oss_endpoint
            bucket_name = p.bucket or cfg.storage.oss_bucket
            auth   = oss2.Auth(key_id, key_secret)
            bucket = oss2.Bucket(auth, endpoint, bucket_name)
            # 列举最多 1 个对象，验证 bucket 可访问
            await asyncio.to_thread(lambda: list(oss2.ObjectIterator(bucket, max_keys=1)))
            return {"ok": True, "message": f"Bucket「{bucket_name}」连接正常"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    return {"ok": False, "message": "未知连接类型"}


# ── 搜索测试（SearXNG / Tavily）──────────────────────────────────────────────

class SearchTestRequest(BaseModel):
    target:          Literal["searxng", "searxng_images", "tavily", "baidu_similar_images"]
    searxng_url:     str = ""   # 留空=用已存配置
    searxng_engines: str = ""
    searxng_image_engines: str = ""
    tavily_api_key:  str = ""   # 留空=用已存配置
    baidu_qianfan_api_key: str = ""   # 留空=用已存配置


@router.post("/test-search")
async def test_search(body: SearchTestRequest):
    cfg = get_settings()

    if body.target in ("searxng", "searxng_images"):
        url = (body.searxng_url or cfg.search.searxng_url or "").rstrip("/")
        if not url:
            return {"ok": False, "message": "未填 SearXNG 地址"}
        is_images = body.target == "searxng_images"
        if is_images:
            engines = body.searxng_image_engines or cfg.search.searxng_image_engines or cfg.search.searxng_engines
        else:
            engines = body.searxng_engines or cfg.search.searxng_engines
        params = {"q": "test", "format": "json", "engines": engines}
        if is_images:
            params["categories"] = "images"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(12.0)) as client:
                resp = await client.get(f"{url}/search", params=params)
        except Exception as e:
            return {"ok": False, "message": f"连不上：{type(e).__name__}: {str(e)[:80]}"}
        if resp.status_code == 403:
            return {"ok": False, "message": "403 — SearXNG 未开启 JSON 输出。请在其 settings.yml 的 search.formats 加上 json（并设 server.limiter: false），重启容器后再试"}
        if resp.status_code != 200:
            return {"ok": False, "message": f"HTTP {resp.status_code}（非 200）"}
        try:
            data = resp.json()
        except Exception:
            return {"ok": False, "message": "返回的不是 JSON（多半未开启 json 格式）"}
        n = len(data.get("results") or [])
        dead = [e[0] for e in (data.get("unresponsive_engines") or [])]
        if n == 0:
            return {"ok": False, "message": f"能连上但返回 0 条结果（引擎可能被限/不可达；超时引擎：{dead or '无'}）"}
        msg = f"OK — 返回 {n} 条结果"
        if dead:
            msg += f"（超时引擎：{'、'.join(dead)}）"
        return {"ok": True, "message": msg}

    elif body.target == "tavily":
        key = body.tavily_api_key or cfg.search.tavily_api_key
        if not key:
            return {"ok": False, "message": "未配 Tavily API Key"}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
                resp = await client.post("https://api.tavily.com/search",
                                         json={"api_key": key, "query": "test", "max_results": 1})
                resp.raise_for_status()
                resp.json()
        except Exception as e:
            return {"ok": False, "message": f"Key 无效或请求失败：{str(e)[:90]}"}
        return {"ok": True, "message": "OK — Tavily Key 有效（本次测试消耗 1 次调用）"}

    elif body.target == "baidu_similar_images":
        key = body.baidu_qianfan_api_key or cfg.search.baidu_qianfan_api_key
        if not key:
            return {"ok": False, "message": "未配置百度千帆 API Key"}
        # 只发一个固定的 1x1 PNG 作为连通性测试，不读取用户输入，也不把图片内容写入日志。
        probe_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        try:
            from agent.tools.search import _call_baidu_similar_image
            result = await _call_baidu_similar_image(
                probe_png, key, 1, cfg.search.similar_image_timeout_seconds,
            )
        except Exception:
            return {"ok": False, "message": "百度相似图搜索测试失败，请查看受限诊断日志"}
        if result.get("error"):
            return {"ok": False, "message": result["error"]}
        return {"ok": True, "message": "百度千帆相似图搜索连接正常（本次测试可能消耗 1 次调用）"}

    return {"ok": False, "message": "未知测试目标"}


# ── Embedding 模型连通测试 ────────────────────────────────────────────────────

class EmbeddingTestRequest(BaseModel):
    provider:   str = ""   # bailian/dashscope 可启用百炼专用请求参数
    multimodal: bool = False
    base_url:   str = ""   # 留空=用已存配置
    api_key:    str = ""   # 留空=用已存配置
    model:      str = ""
    dimensions: int = 0

    @field_validator("dimensions", mode="before")
    @classmethod
    def normalize_dimensions(cls, value: Any) -> int:
        from app.core.config import normalize_dimensions

        return normalize_dimensions(value)


@router.post("/test-embedding")
async def test_embedding(body: EmbeddingTestRequest):
    """用当前输入的参数测 embedding 端点是否通，成功返回向量维度。走 OpenAI 兼容 /embeddings。"""
    cfg = get_settings().embedding
    from agent.memory.embedding import build_payload, resolve_base_url

    provider = body.provider or cfg.provider
    base_url = resolve_base_url(provider, body.base_url or cfg.base_url or "")
    api_key  = body.api_key or cfg.api_key
    model    = body.model or cfg.model
    dims     = body.dimensions or cfg.dimensions
    if not base_url or not model:
        return {"ok": False, "message": "缺少 Base URL 或模型名"}
    if body.multimodal:
        from agent.memory.embedding import BAILIAN_MULTIMODAL_PATH

        if provider.lower() not in {"bailian", "dashscope", "aliyun"}:
            return {"ok": False, "message": "多模态 Embedding 目前仅支持百炼"}
        multimodal_base = base_url.split("/compatible-mode/v1", 1)[0]
        payload = {
            "model": model,
            "input": {"contents": [{"text": "连通性测试"}]},
            "parameters": {"output_type": "dense"},
        }
        if dims:
            payload["parameters"]["dimension"] = dims
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
                resp = await client.post(
                    multimodal_base.rstrip("/") + BAILIAN_MULTIMODAL_PATH,
                    json=payload,
                    headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
                )
        except Exception as e:
            return {"ok": False, "message": f"连不上：{type(e).__name__}: {str(e)[:80]}"}
        if resp.status_code != 200:
            return {"ok": False, "message": f"HTTP {resp.status_code}：{resp.text[:120]}"}
        try:
            vec = resp.json()["output"]["embeddings"][0]["embedding"]
        except Exception:
            return {"ok": False, "message": "返回格式不对（不是百炼多模态 Embedding 响应）"}
        if not isinstance(vec, list) or not vec:
            return {"ok": False, "message": "返回的多模态向量为空"}
        return {"ok": True, "message": f"OK — 多模态连通，向量维度 {len(vec)}"}
    payload = build_payload(provider, base_url, model, "连通性测试", dims)
    # key 为空就不发 Authorization 头（Ollama 无需鉴权；空 key 拼 "Bearer " 是非法 header）
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            resp = await client.post(f"{base_url}/embeddings", json=payload, headers=headers)
    except Exception as e:
        return {"ok": False, "message": f"连不上：{type(e).__name__}: {str(e)[:80]}"}
    if resp.status_code != 200:
        return {"ok": False, "message": f"HTTP {resp.status_code}：{resp.text[:120]}"}
    try:
        vec = resp.json()["data"][0]["embedding"]
    except Exception:
        return {"ok": False, "message": "返回格式不对（不是 OpenAI 兼容 /embeddings 响应）"}
    if not isinstance(vec, list) or not vec:
        return {"ok": False, "message": "返回的向量为空"}
    return {"ok": True, "message": f"OK — 连通，向量维度 {len(vec)}"}


# ── 语音识别模型连通测试 ────────────────────────────────────────────────────

class VoiceTestRequest(BaseModel):
    api_format: str = "openai"
    dashscope_service: str = "qwen3-asr"
    base_url: str = ""
    api_key: str = ""
    model: str = ""


def _voice_test_wav() -> bytes:
    """生成短静音 WAV，只用于探测接口，不写入存储。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        # 1 秒有效 PCM，比极短的 0.1 秒静音更容易通过上游音频预检；
        # 测试只验证请求能被模型接收，不要求返回可识别文本。
        wav.writeframes(b"\x00\x00" * 16000)
    return buf.getvalue()


@router.post("/test-voice")
async def test_voice(body: VoiceTestRequest):
    """按当前输入测试语音模型，不保存配置、不写聊天记录。"""
    cfg = get_settings().voice
    model = (body.model or cfg.model or "").strip()
    base_url = (body.base_url or cfg.base_url or "").strip()
    api_key = body.api_key if body.api_key and body.api_key != "****" else cfg.api_key
    api_format = (body.api_format or cfg.api_format or "openai").strip().lower()
    if not model or not base_url:
        return {"ok": False, "message": "请先填写模型名和 Base URL"}
    if api_format not in {"openai", "dashscope"}:
        return {"ok": False, "message": "API 格式只支持 OpenAI 兼容或百炼 DashScope"}
    dashscope_service = (body.dashscope_service or getattr(cfg, "dashscope_service", "qwen3-asr") or "qwen3-asr").strip().lower()
    if api_format == "dashscope" and dashscope_service not in {"qwen3-asr", "qwen-audio", "fun-asr"}:
        return {"ok": False, "message": "百炼产品线只支持 Qwen3 ASR、Qwen-Audio 3.0 或 Fun-ASR"}
    try:
        from agent.voice import transcribe

        audio = base64.b64encode(_voice_test_wav()).decode()
        text = await transcribe(
            [{"type": "audio", "mime": "audio/wav", "b64": audio}],
            {"voice": {
                "api_key": api_key,
                "base_url": base_url,
                "model": model,
                "api_format": api_format,
                "dashscope_service": dashscope_service,
            }},
            raise_errors=True,
        )
        if text is None:
            return {"ok": False, "message": "语音模型未配置"}
        return {"ok": True, "message": "连接正常（静音测试已收到响应）"}
    except httpx.HTTPStatusError as e:
        # 上游 4xx 的响应体通常包含真正的参数/模型校验原因；只返回短的
        # 脱敏摘要，避免把可能包含凭据或请求细节的完整响应暴露给前端。
        detail = redact((e.response.text or "").strip()[:300])
        suffix = f"：{detail}" if detail else ""
        return {"ok": False, "message": f"测试失败：HTTP {e.response.status_code}{suffix}"}
    except Exception as e:
        return {"ok": False, "message": f"测试失败：{redact(f'{type(e).__name__}: {e}')}"}


# ── Embedding 向量重建（换模型后批量重算所有用户的 pattern 向量）──────────────────
_REBUILD_KEY = "emb:rebuild"


async def _rebuild_worker(user_ids: list[str]) -> None:
    """后台批量重算。进度写 Redis（跨 worker 可读）。best-effort，末尾标 done/error。"""
    from agent.memory import embedding, store
    from app.core.redis import get_redis
    r = get_redis()
    tag = embedding.model_tag()

    async def prog(done: int, total: int) -> None:
        if done % 5 == 0 or done == total:
            await r.set(_REBUILD_KEY, json.dumps(
                {"status": "running", "done": done, "total": total, "tag": tag, "ts": time.time()}))

    try:
        res = await store.rebuild_all_vecs(user_ids, on_progress=prog)
        failed = int(res.get("failed_users") or 0)
        status = "error" if failed else "done"
        message = (
            f"重建完成：pattern {res.get('pattern_vectors', 0)} 条，"
            f"memory {res.get('memory_vectors', 0)} 块"
            + (f"；失败用户 {failed} 个" if failed else "")
        )
        await r.set(_REBUILD_KEY, json.dumps(
            {"status": status, **res, "message": message, "tag": tag, "ts": time.time()}), ex=3600)
    except Exception as e:
        await r.set(_REBUILD_KEY, json.dumps(
            {"status": "error", "message": str(e)[:100], "ts": time.time()}), ex=3600)


@router.post("/embedding-rebuild")
async def embedding_rebuild(db: AsyncSession = Depends(get_db)):
    """换 embedding 模型后，批量给所有用户的 pattern 重算向量（force）。后台跑、立即返回。
    未启用/已在跑 → 拒绝。进度用 GET /embedding-rebuild/status 轮询。"""
    from agent.memory import embedding
    from app.core.redis import get_redis
    from app.models import User
    if not embedding.is_enabled():
        return {"ok": False, "message": "请先启用并配置 embedding 模型（保存后再重建）"}
    r = get_redis()
    cur = await r.get(_REBUILD_KEY)
    if cur:
        try:
            d = json.loads(cur if isinstance(cur, str) else cur.decode())
            if d.get("status") == "running":
                return {"ok": False, "message": "已有重建任务在跑", "status": d}
        except Exception:
            pass
    rows = (await db.execute(select(User.id))).scalars().all()
    user_ids = [str(u) for u in rows]
    await r.set(_REBUILD_KEY, json.dumps(
        {"status": "running", "done": 0, "total": len(user_ids), "ts": time.time()}))
    asyncio.create_task(_rebuild_worker(user_ids))
    return {"ok": True, "message": f"重建已启动，共 {len(user_ids)} 个用户", "total": len(user_ids)}


@router.get("/embedding-rebuild/status")
async def embedding_rebuild_status():
    from app.core.redis import get_redis
    cur = await get_redis().get(_REBUILD_KEY)
    if not cur:
        return {"status": "idle"}
    try:
        return json.loads(cur if isinstance(cur, str) else cur.decode())
    except Exception:
        return {"status": "idle"}


# ── 记忆一键维护：pattern 复核删除 + 身份内容搬去 profile + 画像事件迁 memory + daily 改格式 + 清遗留文件
# （2026-07-09，见 scripts/refresh_memory.py）────────────────────────────────────
# 预览(preview) 和真删(apply) 分两步：预览只跑一次 LLM 判断（review + split，各 3 次投票，
# dry_run），结果连同具体 fact id 存 Redis；apply 直接按存下来的 id 执行，**不重新调用 LLM**——
# 同一批数据前后两次调用结果可能差很多（今天踩过：40%→94%），"预览看到的" 必须等于 "真删的"，
# 不能是"重新掷一次骰子"。画像事件迁移 / daily 迁格式 / legacy 文件清理都是确定性改写，
# 没有 LLM 参与，但也一起挂进 preview/apply，保持一个入口做完。
_MEM_CLEANUP_KEY = "mem_cleanup:plan"
_MEM_CLEANUP_STALE_SECONDS = 600


async def _mem_cleanup_worker(user_ids: list[str]) -> None:
    from scripts.refresh_memory import _migrate_daily, _migrate_profile_events, _review_patterns, _split_profile
    from agent.memory.store import _key, PATTERN_FILE
    from app.services.storage import get_storage
    from app.core.redis import get_redis
    r = get_redis()
    settings = get_settings()
    storage = get_storage()
    plan: dict = {}
    done = 0
    for uid in user_ids:
        try:
            review = await _review_patterns(uid, settings, dry_run=True, trials=3, temperature=0.1)
            split = await _split_profile(uid, settings, dry_run=True, trials=3, temperature=0.1)
            profile_events = await _migrate_profile_events(uid, settings, dry_run=True)
            daily = await _migrate_daily(uid, settings, dry_run=True)
            legacy_files = []
            if await storage.exists(_key(uid, PATTERN_FILE)):
                for legacy_name in ("facts.json", "facts.md", "facts_vec.json"):
                    if await storage.exists(_key(uid, legacy_name)):
                        legacy_files.append(legacy_name)
            if review.get("removed") or split.get("moved") or profile_events.get("migrated") or daily.get("migrated") or legacy_files:
                plan[uid] = {
                    "removed_ids": review.get("removed_ids", []), "removed_texts": review.get("removed_texts", []),
                    "moved_ids": split.get("moved_ids", []), "moved_texts": split.get("moved_texts", []),
                    "profile_event_migrated": profile_events.get("migrated", 0),
                    "profile_event_texts": profile_events.get("moved_texts", []),
                    "daily_migrated": daily.get("migrated", 0),
                    "daily_texts": daily.get("migrated_texts", []),
                    "legacy_files": legacy_files,
                    "total": review.get("total", 0),
                }
        except Exception as e:
            plan[uid] = {"error": f"{type(e).__name__}: {str(e)[:150]}"}
        done += 1
        await r.set(_MEM_CLEANUP_KEY, json.dumps(
            {"status": "running", "done": done, "total": len(user_ids), "plan": plan, "ts": time.time()}))
    await r.set(_MEM_CLEANUP_KEY, json.dumps(
        {"status": "done", "done": done, "total": len(user_ids), "plan": plan, "ts": time.time()}), ex=3600)


@router.post("/memory-cleanup/preview")
async def memory_cleanup_preview(db: AsyncSession = Depends(get_db)):
    """对所有用户的 pattern.json 跑一次批量复核（3 次投票，dry-run，不写），后台跑、立即返回。
    进度/结果用 GET /memory-cleanup/status 轮询；确认没问题再调 POST /memory-cleanup/apply。"""
    from app.core.redis import get_redis
    from app.models import User
    r = get_redis()
    cur = await r.get(_MEM_CLEANUP_KEY)
    if cur:
        try:
            d = json.loads(cur if isinstance(cur, str) else cur.decode())
            if d.get("status") == "running" and time.time() - float(d.get("ts") or 0) < _MEM_CLEANUP_STALE_SECONDS:
                return {"ok": False, "message": "已有清理预览在跑", "status": d}
        except Exception:
            pass
    rows = (await db.execute(select(User.id))).scalars().all()
    user_ids = [str(u) for u in rows]
    await r.set(_MEM_CLEANUP_KEY, json.dumps(
        {"status": "running", "done": 0, "total": len(user_ids), "plan": {}, "ts": time.time()}))
    asyncio.create_task(_mem_cleanup_worker(user_ids))
    return {"ok": True, "message": f"预览已启动，共 {len(user_ids)} 个用户", "total": len(user_ids)}


@router.get("/memory-cleanup/status")
async def memory_cleanup_status():
    from app.core.redis import get_redis
    cur = await get_redis().get(_MEM_CLEANUP_KEY)
    if not cur:
        return {"status": "idle"}
    try:
        data = json.loads(cur if isinstance(cur, str) else cur.decode())
        if data.get("status") == "running" and time.time() - float(data.get("ts") or 0) >= _MEM_CLEANUP_STALE_SECONDS:
            data = {"status": "stale", "done": data.get("done", 0), "total": data.get("total", 0), "message": "上次预览已超时，请重新生成"}
            await get_redis().set(_MEM_CLEANUP_KEY, json.dumps(data, ensure_ascii=False), ex=3600)
        return data
    except Exception:
        return {"status": "idle"}


@router.post("/memory-cleanup/apply")
async def memory_cleanup_apply():
    """一键执行上一次 preview 存下来的全部结果——不重新调 LLM，预览看到的就是真删/真搬的。
    五件事都做：① 删 pattern 里过时的条目 ② 把该属于画像的条目搬进 profile.json
    ③ 把误进 profile 的阶段性事件迁去 memory.md ④ 把旧 daily.md 改成按日期分组的新格式
    ⑤ 清掉已迁移完的遗留 facts.json/facts.md。
    执行完清掉 Redis 里的 plan，防止同一份 plan 被误重复应用（比如两次点了确认）。"""
    from app.core.redis import get_redis
    from agent.memory import store
    from agent.memory.store import _key
    from app.services.storage import get_storage
    from scripts.refresh_memory import _migrate_profile_events
    r = get_redis()
    storage = get_storage()
    raw = await r.get(_MEM_CLEANUP_KEY)
    if not raw:
        raise HTTPException(400, "没有可执行的清理预览，先跑一次预览")
    data = json.loads(raw if isinstance(raw, str) else raw.decode())
    if data.get("status") != "done":
        raise HTTPException(400, "预览还没跑完，等它跑完再确认")
    applied_users, applied_total, moved_total, profile_event_total, daily_total, legacy_total = 0, 0, 0, 0, 0, 0
    for uid, p in (data.get("plan") or {}).items():
        remove_ids = set(p.get("removed_ids") or [])
        move_ids = set(p.get("moved_ids") or [])
        moved_texts = p.get("moved_texts") or []
        profile_event_count = int(p.get("profile_event_migrated") or 0)
        daily_count = int(p.get("daily_migrated") or 0)
        touched = False

        if remove_ids or move_ids:
            patterns = await store.read_pattern_list(uid)
            drop_ids = remove_ids | move_ids
            new_patterns = [pattern for pattern in patterns if pattern["id"] not in drop_ids]
            if len(new_patterns) != len(patterns):
                await store.write_pattern_list(uid, new_patterns)
                await store.sync_pattern_vecs(uid, new_patterns)
                applied_total += len(remove_ids)
                touched = True

        if moved_texts:
            profile = await store.read_profile_list(uid)
            profile = store.apply_profile_ops(profile, moved_texts, [])
            await store.write_profile_list(uid, profile)
            moved_total += len(moved_texts)
            touched = True

        if profile_event_count:
            profile_events = await _migrate_profile_events(uid, get_settings(), dry_run=False)
            profile_event_total += int(profile_events.get("migrated") or 0)
            touched = True

        if daily_count:
            daily = await store.migrate_legacy_daily(uid, dry_run=False)
            daily_total += int(daily.get("migrated") or 0)
            touched = True

        for legacy_name in (p.get("legacy_files") or []):
            legacy_key = _key(uid, legacy_name)
            if await storage.exists(legacy_key):
                await storage.delete(legacy_key)
                legacy_total += 1
                touched = True

        if touched:
            applied_users += 1
    await r.delete(_MEM_CLEANUP_KEY)
    return {
        "ok": True, "users_applied": applied_users,
        "total_removed": applied_total, "total_moved": moved_total,
        "total_profile_events_migrated": profile_event_total,
        "total_daily_migrated": daily_total, "legacy_files_removed": legacy_total,
    }


# ── SMTP 测试发送 ──────────────────────────────────────────────────────────

class SmtpTestParams(BaseModel):
    host:      str
    port:      int
    user:      str
    password:  str = ""
    from_addr: str = ""
    to_addr:   str
    use_ssl:   bool = True


@router.post("/test-smtp")
async def test_smtp(body: SmtpTestParams):
    cfg = get_settings()
    try:
        import smtplib, ssl as _ssl, asyncio
        host      = body.host or cfg.smtp.host
        port      = body.port or cfg.smtp.port
        user      = body.user or cfg.smtp.user
        password  = body.password or cfg.smtp.password
        from_addr = body.from_addr or cfg.smtp.from_addr or user
        to_addr   = body.to_addr or cfg.smtp.to_addr
        use_ssl   = body.use_ssl

        if not host:
            return {"ok": False, "message": "SMTP 服务器未配置"}
        if not to_addr:
            return {"ok": False, "message": "收件人地址未配置"}

        from app.services import email as email_svc
        await asyncio.to_thread(
            email_svc.send_test_email,
            host=host, port=port, user=user, password=password,
            from_addr=from_addr, to_addr=to_addr, use_ssl=use_ssl)
        return {"ok": True, "message": f"测试邮件已发送至 {to_addr}"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
