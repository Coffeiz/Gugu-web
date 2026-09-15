"""统一解析文件库存储上限；None 表示继承/无限，0 是有效的零额度。"""
from __future__ import annotations


UNLIMITED_BYTES = 2**63 - 1


def resolve_file_library_limit(user_limit: int | None, global_limit: int | None) -> int:
    """用户额度优先于全局额度；只有 None 才表示未配置。"""
    if user_limit is not None:
        return int(user_limit)
    if global_limit is not None:
        return int(global_limit)
    return UNLIMITED_BYTES
