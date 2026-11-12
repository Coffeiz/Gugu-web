"""项目数据快照；不会把 ORM session 或延迟加载关系传给调用方。"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List
from uuid import UUID
import json


@dataclass(frozen=True)
class ProjectRecord:
    id: int
    user_id: UUID
    name: str
    summary: str | None
    client: str | None
    status: str
    start_date: str | None
    deadline: str | None
    color: str
    progress: int
    stages_json: str
    current_stage: str | None
    priority: str | None
    version: int
    archived: bool
    done_at: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None

    @property
    def stages(self) -> List[Dict[str, Any]]:
        return json.loads(self.stages_json)
