"""
Admin 配置接口
GET   /api/v1/admin/config                  → 读取当前配置（密码字段脱敏）
PATCH /api/v1/admin/config                  → 写入 override，热更新无需重启（DB 配置会触发自动建表）
POST  /api/v1/admin/config/test-connection  → 用当前输入的参数测试连通性
POST  /api/v1/admin/config/init-db           → 手动初始化数据库（建表）
"""

import asyncio
import json
import time

import httpx
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from typing import Any, Literal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings, save_override
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
        "truncated": len(ghosts) > 300 or len(orphans) > 300,
    }


def _fmt_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


async def _import_orphan(db, key: str, storage) -> bool:
    """把一个孤儿物理文件按其存储路径重建成 File 记录（best-effort）。
    路径形如 {uid}/个人文件/[文件夹/]name.ext 或 {uid}/项目文件/yyyy/mm/{项目} #{pid}/[文件夹/]name.ext。
    解析不出归属时仍尽量建在空间根（folder_id=None），让文件至少在 app 里现身。"""
    import uuid as _uuid, re, mimetypes
    from app.models import File, User
    parts = key.split("/")
    if len(parts) < 3:
        return False
    try:
        uid = _uuid.UUID(parts[0])
    except ValueError:
        return False
    if not await db.get(User, uid):
        return False
    fname = parts[-1]
    name, _, ext = fname.rpartition(".")
    if not name:
        name, ext = fname, ""
    space, project_id, folder_id = "personal", None, None
    seg = parts[1] if len(parts) > 1 else ""
    if seg == "项目文件":
        space = "project"
        project_segment_index = None
        for index, p in enumerate(parts):
            mm = re.search(r"#(\d+)$", p)
            if mm:
                project_id = int(mm.group(1))
                project_segment_index = index
                break
        folder_parts = parts[project_segment_index + 1:-1] if project_segment_index is not None else []
        folder_id = await _resolve_import_folder(db, uid, project_id, folder_parts)
    elif seg == "个人文件":
        folder_id = await _resolve_import_folder(db, uid, None, parts[2:-1])
    try:
        size_bytes = len(await storage.get(key))
    except Exception:
        size_bytes = 0
    db.add(File(
        user_id=uid, display_name=name, ext=ext.lower(), space=space,
        project_id=project_id, folder_id=folder_id, storage_key=key,
        size=_fmt_size(size_bytes), size_bytes=size_bytes,
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
    import uuid as _uuid
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
    candidates, ambiguous = [], []
    for key in sorted(keys - known):
        parts = key.split("/")
        if len(parts) < 3:
            continue
        try:
            user_id = str(_uuid.UUID(parts[0]))
        except ValueError:
            continue
        name, dot, ext = parts[-1].rpartition(".")
        if not dot:
            name, ext = parts[-1], ""
        info = await storage.stat(key)
        identity = (user_id, name, ext.lower(), info.size if info else 0)
        matches = by_identity.get(identity, [])
        item = {"key": key, "name": parts[-1], "size_bytes": identity[3]}
        if len(matches) == 1:
            file = matches[0]
            item.update({"file_id": file.id, "expected_old_key": file.storage_key, "old_folder_id": file.folder_id})
            candidates.append(item)
        elif len(matches) > 1:
            item["file_ids"] = [file.id for file in matches]
            ambiguous.append(item)
    return {"candidates": candidates, "ambiguous": ambiguous,
            "candidate_count": len(candidates), "ambiguous_count": len(ambiguous)}


@router.post("/reconcile-storage/path-migration/repair")
async def repair_path_migration(body: PathMigrationRequest, db: AsyncSession = Depends(get_db)):
    """按物理 key 重新计算文件夹归属并更新 File 记录；不搬动物理文件。"""
    from app.models import File
    from app.services.storage import get_storage

    storage = get_storage()
    requested = {item.file_id: item for item in body.items}
    rows = (await db.execute(select(File).where(File.id.in_(requested), File.deleted_at.is_(None)))).scalars().all()
    all_files = (await db.execute(select(File))).scalars().all()
    occupied = {file.storage_key: file.id for file in all_files}
    done, failed = [], []
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
            parts = new_key.split("/")
            if len(parts) < 3:
                failed.append({"file_id": file.id, "error": "路径无法解析"})
                continue
            name, dot, ext = parts[-1].rpartition(".")
            if not dot:
                name, ext = parts[-1], ""
            if name != file.display_name or (ext.lower() if dot else "") != (file.ext or "").lower():
                failed.append({"file_id": file.id, "error": "文件名或扩展名不匹配"})
                continue
            stat = await storage.stat(new_key)
            if stat and file.size_bytes and stat.size != file.size_bytes:
                failed.append({"file_id": file.id, "error": "文件大小不匹配"})
                continue
            project_id = None
            if parts[1] not in ("个人文件", "项目文件"):
                failed.append({"file_id": file.id, "error": "空间路径无法解析"})
                continue
            folder_parts = parts[2:-1] if parts[1] == "个人文件" else []
            if parts[1] == "项目文件":
                import re
                for index, part in enumerate(parts):
                    match = re.search(r"#(\d+)$", part)
                    if match:
                        project_id = int(match.group(1))
                        folder_parts = parts[index + 1:-1]
                        break
                if project_id is None:
                    failed.append({"file_id": file.id, "error": "项目路径无法解析"})
                    continue
                from app.models import Project
                project = await db.get(Project, project_id)
                if project is None or project.user_id != file.user_id:
                    failed.append({"file_id": file.id, "error": "项目不属于文件所有者"})
                    continue
            folder_id = await _resolve_import_folder(db, file.user_id, project_id, folder_parts)
            if folder_parts and folder_id is None:
                failed.append({"file_id": file.id, "error": "目录路径无法解析"})
                continue
            file.folder_id = folder_id
            file.storage_key = "/".join(parts)
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
    target:          Literal["searxng", "searxng_images", "tavily"]
    searxng_url:     str = ""   # 留空=用已存配置
    searxng_engines: str = ""
    searxng_image_engines: str = ""
    tavily_api_key:  str = ""   # 留空=用已存配置


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

    return {"ok": False, "message": "未知测试目标"}


# ── Embedding 模型连通测试 ────────────────────────────────────────────────────

class EmbeddingTestRequest(BaseModel):
    provider:   str = ""   # bailian/dashscope 可启用百炼专用请求参数
    multimodal: bool = False
    base_url:   str = ""   # 留空=用已存配置
    api_key:    str = ""   # 留空=用已存配置
    model:      str = ""
    dimensions: int = 0


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
        await r.set(_REBUILD_KEY, json.dumps(
            {"status": "done", **res, "tag": tag, "ts": time.time()}), ex=3600)
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
            if d.get("status") == "running":
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
        return json.loads(cur if isinstance(cur, str) else cur.decode())
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
