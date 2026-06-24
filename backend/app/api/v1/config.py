"""
Admin 配置接口
GET   /api/v1/admin/config                  → 读取当前配置（密码字段脱敏）
PATCH /api/v1/admin/config                  → 写入 override，热更新无需重启（DB 配置会触发自动建表）
POST  /api/v1/admin/config/test-connection  → 用当前输入的参数测试连通性
POST  /api/v1/admin/config/init-db           → 手动初始化数据库（建表）
"""

import asyncio
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
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}\n{_tb.format_exc()}")


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
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}\n{_tb.format_exc()}")


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
    from app.models import File, Folder, User
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
        for p in parts:
            mm = re.search(r"#(\d+)$", p)
            if mm:
                project_id = int(mm.group(1))
                break
    elif seg == "个人文件" and len(parts) >= 4:
        fo = (await db.execute(select(Folder).where(
            Folder.user_id == uid, Folder.name == parts[2], Folder.project_id.is_(None)
        ))).scalars().first()
        if fo:
            folder_id = fo.id
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


class RepairRequest(BaseModel):
    action: Literal["delete", "import"]
    keys: list[str]


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

        subject = "咕咕 - SMTP 测试邮件"
        body_text = "这是来自咕咕后台的 SMTP 连通性测试邮件，收到即表示配置正确。"
        msg = (
            f"From: {from_addr}\r\n"
            f"To: {to_addr}\r\n"
            f"Subject: {subject}\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\n\r\n"
            f"{body_text}"
        )

        def _send():
            if use_ssl:
                ctx = _ssl.create_default_context()
                with smtplib.SMTP_SSL(host, port, context=ctx, timeout=10) as s:
                    if user:
                        s.login(user, password)
                    s.sendmail(from_addr, [to_addr], msg.encode("utf-8"))
            else:
                with smtplib.SMTP(host, port, timeout=10) as s:
                    s.starttls(context=_ssl.create_default_context())
                    if user:
                        s.login(user, password)
                    s.sendmail(from_addr, [to_addr], msg.encode("utf-8"))

        await asyncio.to_thread(_send)
        return {"ok": True, "message": f"测试邮件已发送至 {to_addr}"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
