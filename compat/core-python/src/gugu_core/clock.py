"""宿主可注入时钟；独立运行时默认使用 aware UTC。"""
from datetime import datetime, timezone


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
