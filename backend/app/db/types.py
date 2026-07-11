"""跨库 aware-UTC datetime 类型——见 docs/backend/时区与时钟迁移方案.md Phase 2。

问题:直接用 `DateTime(timezone=True)` 时,SQLite（测试库）读回 naive、Postgres 读回 aware,
业务代码与 `now_utc()`(aware) 比较就会 naive/aware 混用 → TypeError,且两库行为不一致。

`UtcDateTime` 统一两库语义:
- **写入**:naive 视作 UTC、aware 归一到 UTC;SQLite 落 naive 串（避免带 offset 的串解析问题），
  Postgres 落 aware（timestamptz)。
- **读出**:一律返回**带 UTC tzinfo 的 aware datetime**（SQLite 读回 naive → 补 UTC）。

于是全站 datetime 列进出都是 aware UTC,和 `now_utc()` 比较不再混用,SQLite 测试也能真正验 aware 路径。
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy.types import TypeDecorator, DateTime


class UtcDateTime(TypeDecorator):
    impl = DateTime(timezone=True)
    cache_ok = True

    def coerce_compared_value(self, op, value):
        # `TypeDecorator` 默认不会把「列 + timedelta」这类算术委托给 impl（DateTime）的比较器
        # 去推导——于是 SQLAlchemy 把右侧 timedelta 字面量也按本列类型(UtcDateTime)绑定，asyncpg
        # 方言据此给参数加 `::TIMESTAMP WITH TIME ZONE` cast（应该是 `::INTERVAL`），Postgres 报
        # 「timestamp with time zone + timestamp with time zone」不存在此运算符；这层不崩，只是
        # 生成的 SQL 是错的。显式委托给 impl 的推导，`UtcDateTime 列 + timedelta` 才会正确按
        # Interval 绑定，和裸 `DateTime(timezone=True)` 列同样行为。（2026-07-11：Admin 数据总览
        # /summary 500 的根因；同一次改动顺带在 process_bind_param 加了 timedelta 兜底，双保险。）
        return self.impl_instance.coerce_compared_value(op, value)

    def process_bind_param(self, value: datetime | timedelta | None, dialect):
        if value is None:
            return None
        if isinstance(value, timedelta):
            return value   # 有了上面的 coerce_compared_value，正常不会走到这——留着兜底更保险
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
