"""账户注销的共用逻辑：admin 删除用户 / 用户自助注销都调这一份，避免两边各写一次、后续改动漂移。

DB 级联之外，还必须清**存储层**——AI 记忆（.agent/）、上传文件、语音（.voice/）、聊天暂存都不在
DB 表里，级联碰不到；不清就违背隐私政策「注销后从数据库和存储中永久删除」的承诺。
顺序：先清盘外数据，再删 DB 行。
"""
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User


async def delete_account(db: AsyncSession, user: User) -> int:
    """删掉一个用户的存储数据 + DB 行。返回清除的存储对象数（-1 = 存储清理失败，DB 仍会删）。"""
    # ① 缩略图缓存（按 file_id 存共享目录，不在用户前缀下，得按文件逐个清）
    from sqlalchemy import select
    from app.models import File
    from app.api.v1.files import _delete_thumb_cache
    fids = (await db.execute(select(File.id).where(File.user_id == user.id))).scalars().all()
    for fid in fids:
        _delete_thumb_cache(fid)

    # ② 存储层：整个 {user_id}/ 前缀（上传文件 + .agent/ 记忆 + .voice/ + .chat_staging/ 全在其下）
    from app.services.storage import get_storage
    try:
        removed = await get_storage().delete_prefix(f"{user.id}/")
    except Exception as e:
        # 存储清理失败不拦 DB 删除（人工可重清），但必须留痕
        print(f"[account_deletion] 注销清存储失败 user={user.username}: {type(e).__name__}: {e}", flush=True)
        removed = -1

    # ③ Redis 侧用户数据：聊天暂存附件元数据 + IM 可达地址
    try:
        from app.core import chat_attach
        from app.core.redis import get_redis
        await chat_attach.clear_staged(user.id)
        await get_redis().delete(f"imreach:{user.id}")
    except Exception:
        pass

    # ④ DB 行（cascade 级联清 projects/files/folders/events/clients/conversations 等）
    await db.delete(user)
    await db.commit()
    return removed
