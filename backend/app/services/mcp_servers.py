"""当前用户 MCP server 持久化边界。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UserMcpServer


async def list_user_mcp_servers(db: AsyncSession, user_id) -> list[UserMcpServer]:
    return list((await db.scalars(select(UserMcpServer).where(
        UserMcpServer.user_id == user_id,
        UserMcpServer.scope == "user",
    ).order_by(UserMcpServer.created_at))).all())


async def get_user_mcp_server(db: AsyncSession, user_id, *, server_id=None, name=None):
    stmt = select(UserMcpServer).where(
        UserMcpServer.user_id == user_id,
        UserMcpServer.scope == "user",
    )
    if server_id is not None:
        stmt = stmt.where(UserMcpServer.id == server_id)
    elif name is not None:
        stmt = stmt.where(UserMcpServer.name == name)
    else:
        return None
    return await db.scalar(stmt)


async def user_mcp_server_name_exists(db: AsyncSession, user_id, name: str, *, exclude_id=None) -> bool:
    stmt = select(UserMcpServer.id).where(
        UserMcpServer.user_id == user_id,
        UserMcpServer.scope == "user",
        UserMcpServer.name == name,
    )
    if exclude_id is not None:
        stmt = stmt.where(UserMcpServer.id != exclude_id)
    return await db.scalar(stmt) is not None


async def count_user_mcp_servers(db: AsyncSession, user_id) -> int:
    rows = await db.scalars(select(UserMcpServer.id).where(
        UserMcpServer.user_id == user_id,
        UserMcpServer.scope == "user",
    ))
    return len(rows.all())


async def add_user_mcp_server(db: AsyncSession, **values) -> UserMcpServer:
    row = UserMcpServer(**values)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def save_user_mcp_server(
    db: AsyncSession, row: UserMcpServer, fields: dict | None = None,
) -> UserMcpServer:
    for name, value in (fields or {}).items():
        setattr(row, name, value)
    await db.commit()
    await db.refresh(row)
    return row


async def set_user_mcp_server_enabled(db: AsyncSession, row: UserMcpServer, enabled: bool) -> None:
    row.enabled = enabled
    await db.flush()


async def remove_user_mcp_server(db: AsyncSession, row: UserMcpServer) -> None:
    await db.delete(row)
    await db.flush()
