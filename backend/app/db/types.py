"""跨库 aware-UTC datetime 类型——见 docs/backend/时区与时钟迁移方案.md Phase 2。

问题:直接用 `DateTime(timezone=True)` 时,SQLite（测试库）读回 naive、Postgres 读回 aware,
业务代码与 `now_utc()`(aware) 比较就会 naive/aware 混用 → TypeError,且两库行为不一致。

`UtcDateTime` 统一两库语义:
- **写入**:naive 视作 UTC、aware 归一到 UTC;SQLite 落 naive 串（避免带 offset 的串解析问题），
  Postgres 落 aware（timestamptz)。
- **读出**:一律返回**带 UTC tzinfo 的 aware datetime**（SQLite 读回 naive → 补 UTC）。

于是全站 datetime 列进出都是 aware UTC,和 `now_utc()` 比较不再混用,SQLite 测试也能真正验 aware 路径。
"""
from datetime import datetime, timezone

from sqlalchemy.types import TypeDecorator, DateTime


class UtcDateTime(TypeDecorator):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)   # naive 视作 UTC
        value = value.astimezone(timezone.utc)
        if dialect.name == "sqlite":
            return value.replace(tzinfo=None)            # SQLite 存 naive（UTC）
        return value                                     # Postgres 存 aware（timestamptz）

    def process_result_value(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)    # SQLite 读回 naive → 补 UTC
        return value.astimezone(timezone.utc)
