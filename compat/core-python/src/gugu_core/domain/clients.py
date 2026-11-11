"""联系人资料与写入规则，不依赖 Web 的请求模型。"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict
from uuid import UUID


@dataclass(frozen=True)
class ClientRecord:
    id: int
    user_id: UUID
    name: str
    contact: str | None
    email: str | None
    phone: str | None
    notes: str
    created_at: datetime


def prepare_client_fields(fields: Dict[str, Any], *, creating: bool = False) -> Dict[str, Any]:
    limits = {"name": 200, "contact": 200, "email": 300, "phone": 50, "notes": None}
    if fields.keys() - limits.keys():
        raise ValueError("包含不支持的联系人字段")
    values = dict(fields)
    if creating and "name" not in values:
        raise ValueError("联系人名称不能为空")
    for name, value in values.items():
        if name in {"name", "notes"} or value is not None:
            if not isinstance(value, str):
                raise ValueError("联系人字段必须是文本")
            if name == "name" and not value.strip():
                raise ValueError("联系人名称不能为空")
            limit = limits[name]
            if limit is not None and len(value) > limit:
                raise ValueError("联系人字段超过长度限制")
    return values
