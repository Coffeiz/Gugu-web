"""迁移 Redis 中历史 qqbot 运行时 key。

数据库字段由 Alembic 迁移负责；本脚本处理无法由 Alembic 管理的 Redis 状态：
imreach 触达地址和 imsession 会话指针。脚本可重复执行，已存在的新 key 不覆盖。
"""
from __future__ import annotations

import argparse
import asyncio
import json

from app.core.redis import get_redis


async def _rewrite_json_platform(redis, key: str, dry_run: bool) -> bool:
    """把某个 key 的 JSON 值里 platform=qqbot 原地改成 qq，保留 TTL；不重命名 key。

    用于 imreach:<user_id> 这种无平台后缀的"最近触达"兜底记录——key 本身不区分
    平台，不能按 key 名迁移，只能读值判断是不是 QQ 的记录。
    """
    raw = await redis.get(key)
    if not raw:
        return False
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return False
    if not isinstance(value, dict) or value.get("platform") != "qqbot":
        return False
    if dry_run:
        return True
    value["platform"] = "qq"
    ttl = await redis.ttl(key)
    kwargs = {"ex": ttl} if ttl and ttl > 0 else {}
    await redis.set(key, json.dumps(value, ensure_ascii=False), **kwargs)
    return True


async def _move_key(redis, old_key: str, new_key: str, dry_run: bool) -> bool:
    """把 old_key 迁移到 new_key；old_key 是 imreach 且携带 JSON 时顺带把 platform 字段改掉。"""
    if old_key == new_key:
        # 不应该发生——调用方按明确的后缀替换拼出 new_key，相同说明上游拼接逻辑本身
        # 有问题（历史上出过一次：中缀 replace 对末尾无冒号的 key 不生效，导致这里把
        # "已存在"误判成自己，进而把唯一一份数据删掉）。这里宁可跳过、留给人工核查，
        # 也不能按"已迁移"处理再删 old_key。
        print(f"[skip] old_key 与 new_key 相同，跳过避免误删: {old_key}")
        return False
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
                    kwargs = {"ex": ttl} if ttl and ttl > 0 else {}
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

    # imreach:<user_id>:qqbot -> imreach:<user_id>:qq
    # key 以 "qqbot" 结尾、后面没有冒号，中缀替换 ":qqbot:" 永远匹配不到，
    # 必须显式按后缀替换。
    async for old_key in redis.scan_iter(match="imreach:*:qqbot"):
        new_key = old_key.removesuffix(":qqbot") + ":qq"
        if await _move_key(redis, old_key, new_key, dry_run):
            moved += 1

    # imsession:qqbot:* -> imsession:qq:*（这一支的前缀是中缀，原逻辑没问题，保持不变）
    async for old_key in redis.scan_iter(match="imsession:qqbot:*"):
        new_key = "imsession:qq:" + old_key[len("imsession:qqbot:"):]
        if await _move_key(redis, old_key, new_key, dry_run):
            moved += 1

    # imreach:<user_id>（无平台后缀的兜底"最近触达"记录，见 scheduled_tasks.py 的
    # _reach_key）：key 本身不带平台、不能重命名迁移，只在 JSON 值里 platform=qqbot
    # 时原地改成 qq，保留 TTL。用冒号数量区分：带平台后缀是两段冒号，兜底 key 只有一段。
    async for key in redis.scan_iter(match="imreach:*"):
        if key.count(":") != 1:
            continue
        if await _rewrite_json_platform(redis, key, dry_run):
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
