"""E2E 专用测试用户注册：走真实 /auth/register 接口建号。

CI 每次跑 E2E 都是全新的 Postgres，直接调用后端真实跑着的 HTTP 接口完成注册——账号信息就是
Playwright auth.setup.ts 期望的 PLAYWRIGHT_USERNAME/PLAYWRIGHT_PASSWORD，
不复用任何长期账号。

用法：PYTHONPATH=. python scripts/seed_e2e_user.py <backend_base_url> <username> <password>
"""
from __future__ import annotations

import asyncio
import sys

import httpx


async def _register(base_url: str, username: str, password: str) -> None:
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as client:
        resp = await client.post("/api/v1/auth/register", json={
            "username": username,
            "email": f"{username}@e2e.local",
            "password": password,
        })
        resp.raise_for_status()


async def main() -> None:
    base_url, username, password = sys.argv[1], sys.argv[2], sys.argv[3]
    await _register(base_url, username, password)
    print(f"[seed_e2e_user] 已创建测试用户 {username}")


if __name__ == "__main__":
    asyncio.run(main())
