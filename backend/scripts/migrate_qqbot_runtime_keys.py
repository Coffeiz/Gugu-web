"""迁移 Redis 中历史 qqbot 运行时 key。

数据库字段由 Alembic 迁移负责；本脚本处理无法由 Alembic 管理的 Redis 状态：
imreach 触达地址和 imsession 会话指针。脚本可重复执行，已存在的新 key 不覆盖。
"""
from __future__ import annotations

import argparse
import asyncio
import json

from app.core.redis import get_redis


async def _move_key(redis, old_key: str, new_key: str, dry_run: bool) -> bool:
    if await redis.exists(new_key):
        if not dry_run:
            await redis.delete(old_key)
        return True
    if dry_run:
        return True
    if old_key.startswith("imreach:"):
        raw = await redis.get(old_key)
        if raw:
            try:
                value = json.loads(raw)
                if isinstance(value, dict):
                    value["platform"] = "qq"
                    ttl = await redis.ttl(old_key)
                    kwargs = {"ex": ttl} if ttl > 0 else {}
                    await redis.set(new_key, json.dumps(value, ensure_ascii=False), **kwargs)
                    await redis.delete(old_key)
                    return True
            except (TypeError, ValueError, json.JSONDecodeError):
                # 无法识别的旧值不覆盖目标，保留旧 key 供人工处理。
                return False
    return bool(await redis.renamenx(old_key, new_key))


async def migrate(dry_run: bool = False) -> int:
    redis = get_redis()
    moved = 0
    patterns = ("imreach:*:qqbot", "imsession:qqbot:*")
    for pattern in patterns:
        keys = [key async for key in redis.scan_iter(match=pattern)]
        for old_key in keys:
            new_key = old_key.replace(":qqbot:", ":qq:", 1)
            if old_key.startswith("imsession:qqbot:"):
                new_key = old_key.replace("imsession:qqbot:", "imsession:qq:", 1)
            if await _move_key(redis, old_key, new_key, dry_run):
                moved += 1
    return moved


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="迁移 Redis 中的 qqbot 运行时 key")
    parser.add_argument("--dry-run", action="store_true", help="只统计，不修改 Redis")
    return parser.parse_args()


async def main() -> None:
    args = _parse_args()
    moved = await migrate(dry_run=args.dry_run)
    action = "待迁移" if args.dry_run else "已迁移"
    print(f"{action} QQ Redis 运行时 key: {moved} 个")


if __name__ == "__main__":
    asyncio.run(main())
