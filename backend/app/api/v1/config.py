"""
Admin 配置接口
GET   /api/v1/admin/config                  → 读取当前配置（密码字段脱敏）
PATCH /api/v1/admin/config                  → 写入 override，热更新无需重启（DB 配置会触发自动建表）
POST  /api/v1/admin/config/test-connection  → 用当前输入的参数测试连通性
POST  /api/v1/admin/config/init-db           → 手动初始化数据库（建表）
"""

import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Literal
from app.core.config import get_settings, save_override
from app.db.session import create_all_tables, reset_engine

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
async def update_config(body: ConfigPatch):
    import traceback as _tb
    try:
        new_cfg = await save_override(body.patch)
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
