"""将历史项目阶段数据迁移到严格的阶段/待办结构。"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any

import sqlalchemy as sa
from alembic import op


revision = "20260930000001"
down_revision = "20260928000001"
branch_labels = None
depends_on = None


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _allocate_id(prefix: str, index: int, used: set[str], reserved: set[str]) -> str:
    candidate_index = index
    while True:
        candidate = f"{prefix}{candidate_index}"
        if candidate not in used and candidate not in reserved:
            used.add(candidate)
            return candidate
        candidate_index += 1


def _load_raw_stages(raw_json: str | None, project_id: int) -> list[Any]:
    try:
        raw: Any = json.loads(raw_json) if raw_json is not None else []
        if isinstance(raw, str):
            # 兼容曾被整体 JSON 序列化两次的 stages_json，但只解一层。
            raw = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"projects.id={project_id} 的 stages_json 不是有效 JSON") from exc

    if not isinstance(raw, list):
        raise RuntimeError(f"projects.id={project_id} 的 stages_json 根节点不是数组")
    return raw


class _MigrationIds:
    def __init__(
        self,
        stage_key_counts: Counter,
        todo_id_counts: Counter,
        reserved_stage_keys: set[str],
        reserved_todo_ids: set[str],
    ) -> None:
        self.stage_key_counts = stage_key_counts
        self.todo_id_counts = todo_id_counts
        self.reserved_stage_keys = reserved_stage_keys
        self.reserved_todo_ids = reserved_todo_ids
        self.used_stage_keys: set[str] = set()
        self.used_todo_ids: set[str] = set()
        self.legacy_key_targets: dict[str, str] = {}
        self.next_todo_number = 1

    @classmethod
    def from_stages(cls, raw: list[Any]) -> "_MigrationIds":
        stage_key_counts = Counter(
            item.get("key")
            for item in raw
            if isinstance(item, dict) and _valid_id(item.get("key"))
        )
        todo_ids = []
        for item in raw:
            if not isinstance(item, dict) or not isinstance(item.get("todos"), list):
                continue
            todo_ids.extend(
                todo["id"]
                for todo in item["todos"]
                if isinstance(todo, dict) and _valid_id(todo.get("id"))
            )
        todo_id_counts = Counter(todo_ids)
        return cls(
            stage_key_counts=stage_key_counts,
            todo_id_counts=todo_id_counts,
            reserved_stage_keys={key for key, count in stage_key_counts.items() if count == 1},
            reserved_todo_ids={todo_id for todo_id, count in todo_id_counts.items() if count == 1},
        )

    def stage_key(self, old_key: Any, index: int) -> str:
        if _valid_id(old_key) and self.stage_key_counts[old_key] == 1:
            result = old_key
            self.used_stage_keys.add(result)
        else:
            result = _allocate_id("s", index, self.used_stage_keys, self.reserved_stage_keys)
        if _valid_id(old_key):
            self.legacy_key_targets.setdefault(old_key, result)
        return result

    def todo_id(self, old_id: Any) -> str:
        if _valid_id(old_id) and self.todo_id_counts[old_id] == 1:
            result = old_id
            self.used_todo_ids.add(result)
        else:
            result = _allocate_id("t", self.next_todo_number, self.used_todo_ids, self.reserved_todo_ids)
            self.next_todo_number = int(result[1:]) + 1
        return result


def _normalize_todo(
    todo: Any, stage_index: int, todo_index: int, ids: _MigrationIds, project_id: int,
) -> dict[str, Any]:
    if isinstance(todo, str):
        todo_data: dict[str, Any] = {}
        text = todo
    elif isinstance(todo, dict):
        todo_data = dict(todo)
        text = todo.get("text")
    else:
        raise RuntimeError(
            f"projects.id={project_id} 的第 {stage_index + 1} 个阶段包含无法识别的待办"
        )

    if not isinstance(text, str):
        raise RuntimeError(
            f"projects.id={project_id} 的第 {stage_index + 1} 个阶段第 {todo_index + 1} 个待办缺少文本"
        )

    old_todo_id = todo.get("id") if isinstance(todo, dict) else None
    todo_data.update({"id": ids.todo_id(old_todo_id), "text": text})
    if isinstance(todo_data.get("done"), bool):
        pass
    elif isinstance(todo_data.get("done"), str) and todo_data["done"].lower() in {"true", "false"}:
        todo_data["done"] = todo_data["done"].lower() == "true"
    else:
        todo_data["done"] = False
    for flag in ("autoCompleted", "_savedDone"):
        if not isinstance(todo_data.get(flag), bool):
            todo_data.pop(flag, None)
    return todo_data


def _normalize_stage(item: Any, index: int, ids: _MigrationIds, project_id: int) -> dict[str, Any]:
    if isinstance(item, str):
        stage_data: dict[str, Any] = {}
        label = item
        raw_todos: Any = []
    elif isinstance(item, dict):
        stage_data = dict(item)
        label = item.get("label", item.get("name"))
        raw_todos = item.get("todos", [])
        stage_data.pop("name", None)
    else:
        raise RuntimeError(f"projects.id={project_id} 的 stages_json 第 {index + 1} 项无法识别")

    if not isinstance(label, str) or not label.strip():
        raise RuntimeError(f"projects.id={project_id} 的第 {index + 1} 个阶段缺少有效名称")
    if raw_todos is None:
        raw_todos = []
    if not isinstance(raw_todos, list):
        raise RuntimeError(f"projects.id={project_id} 的第 {index + 1} 个阶段 todos 不是数组")

    old_key = item.get("key") if isinstance(item, dict) else None
    todos = [
        _normalize_todo(todo, index, todo_index, ids, project_id)
        for todo_index, todo in enumerate(raw_todos)
    ]
    stage_data.update({"key": ids.stage_key(old_key, index), "label": label.strip(), "todos": todos})
    return stage_data


def _resolve_current_stage(
    stages: list[dict[str, Any]], current_stage: str | None, ids: _MigrationIds,
) -> str | None:
    if not stages:
        return None
    current = str(current_stage).strip() if current_stage is not None else ""
    if current in ids.used_stage_keys:
        return current
    if current in ids.legacy_key_targets:
        return ids.legacy_key_targets[current]
    label_matches = [stage for stage in stages if stage["label"] == current]
    return label_matches[0]["key"] if label_matches else stages[0]["key"]


def normalize_project_stage_data(
    raw_json: str | None,
    current_stage: str | None,
    project_id: int,
) -> tuple[str, str | None]:
    """转换已知历史形状；无法无损识别时失败，不跳过或清空用户数据。"""
    raw = _load_raw_stages(raw_json, project_id)
    ids = _MigrationIds.from_stages(raw)
    stages = [_normalize_stage(item, index, ids, project_id) for index, item in enumerate(raw)]
    new_current_stage = _resolve_current_stage(stages, current_stage, ids)

    return json.dumps(stages, ensure_ascii=False, separators=(",", ":")), new_current_stage


def upgrade() -> None:
    connection = op.get_bind()
    rows = connection.execute(sa.text(
        "SELECT id, stages_json, current_stage FROM projects ORDER BY id"
    )).mappings()
    for row in rows:
        stages_json, current_stage = normalize_project_stage_data(
            row["stages_json"], row["current_stage"], row["id"],
        )
        connection.execute(
            sa.text(
                "UPDATE projects SET stages_json = :stages_json, current_stage = :current_stage "
                "WHERE id = :project_id"
            ),
            {
                "stages_json": stages_json,
                "current_stage": current_stage,
                "project_id": row["id"],
            },
        )


def downgrade() -> None:
    # 只规范化 JSON 表达，不改变阶段/待办语义；回退代码仍可读取规范结构。
    pass
