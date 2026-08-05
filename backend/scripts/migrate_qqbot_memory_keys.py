"""把记忆存储中的 .agent/im/qqbot 前缀迁移为 .agent/im/qq。"""

import asyncio

from app.services.storage import get_storage


OLD_MARKER = "/.agent/im/qqbot/"
NEW_MARKER = "/.agent/im/qq/"


async def main() -> None:
    storage = get_storage()
    moved = 0
    for old_key in await storage.list_keys():
        if OLD_MARKER not in old_key:
            continue
        new_key = old_key.replace(OLD_MARKER, NEW_MARKER, 1)
        if await storage.exists(new_key):
            raise RuntimeError(f"记忆目标已存在，停止迁移以避免覆盖: {new_key}")
        await storage.rename_file(old_key, new_key)
        moved += 1
    print(f"已迁移 QQ 记忆对象: {moved} 个")


if __name__ == "__main__":
    asyncio.run(main())
