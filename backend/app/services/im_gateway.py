"""向 IM 网关管理器发送配置重载通知。"""
from __future__ import annotations

from sqlalchemy import text

from app.core.redaction import diag_log


async def notify_gateway_reload() -> bool:
    """通过 PostgreSQL transaction notification 请求一次配置对账。

    Bot 行变更由数据库触发器通知；全局 IM 平台开关保存在 override 配置中，
    因此由配置接口使用同一通知通道显式唤醒。通知正文固定，不携带凭据。
    """
    import app.db.session as S

    try:
        engine = S.ensure_engine()
        async with engine.begin() as connection:
            await connection.execute(
                text("SELECT pg_notify('im_gateway_reload', '1')")
            )
    except Exception as exc:
        diag_log("app.services.im_gateway.notify_reload", exc)
        return False
    return True
