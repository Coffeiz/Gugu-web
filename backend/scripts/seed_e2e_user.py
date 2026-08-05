"""E2E 专用测试用户注册：建一次性邀请码 + 走真实 /auth/register 接口建号。

CI 每次跑 E2E 都是全新的 Postgres，不能像本地那样手工发邀请码。这里直接插入
一条邀请码记录，再调用后端真实跑着的 HTTP 接口完成注册——账号信息就是
Playwright auth.setup.ts 期望的 PLAYWRIGHT_USERNAME/PLAYWRIGHT_PASSWORD，
不复用任何长期账号。

用法：PYTHONPATH=. python scripts/seed_e2e_user.py <backend_base_url> <username> <password>
"""
from __future__ import annotations

import asyncio
import secrets
import sys

import httpx


async def _seed_invite_code() -> str:
    import app.db.session as ss
    from app.models import InviteCode

    if ss._engine is None:
        ss._build_engine()
    code = secrets.token_hex(8).upper()
    async with ss._SessionLocal() as db:
        db.add(InviteCode(code=code, note="e2e-ci"))
        await db.commit()
    return code


async def _register(base_url: str, username: str, password: str, invite_code: str) -> None:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        resp = await client.post("/api/v1/auth/register", json={
            "username": username,
            "email": f"{username}@e2e.local",
            "password": password,
            "inviteCode": invite_code,
        })
        resp.raise_for_status()


async def main() -> None:
    base_url, username, password = sys.argv[1], sys.argv[2], sys.argv[3]
    invite_code = await _seed_invite_code()
    await _register(base_url, username, password, invite_code)
    print(f"[seed_e2e_user] 已创建测试用户 {username}")


if __name__ == "__main__":
    asyncio.run(main())
