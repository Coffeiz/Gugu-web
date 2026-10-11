"""统一解析文件库存储上限；None 继承全局，-1 明确不限额，0 是零额度。"""
from __future__ import annotations


UNLIMITED_BYTES = 2**63 - 1


def resolve_file_library_limit(user_limit: int | None, global_limit: int | None) -> int:
    """用户额度优先于全局额度；-1 映射为账本无限额哨兵。"""
    if user_limit == -1:
        return UNLIMITED_BYTES
    if user_limit is not None:
        return int(user_limit)
    if global_limit is not None:
        return int(global_limit)
    return UNLIMITED_BYTES


def is_unlimited_limit(limit_bytes: int) -> bool:
    """账本用 64 位上界表示无限额；该哨兵只用于跳过容量拦截。"""
    return int(limit_bytes) >= UNLIMITED_BYTES
