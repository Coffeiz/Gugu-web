"""宿主解析后的数据归属；Core 不接收登录凭据或隐式管理员。"""
from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True)
class DataContext:
    owner_id: UUID

    def __post_init__(self):
        if not isinstance(self.owner_id, UUID):
            raise ValueError("数据上下文必须提供有效的所有者 UUID")
