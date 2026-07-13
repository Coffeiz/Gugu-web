"""项目领域的写入底座。

项目更新必须把版本比较放进同一条 ``UPDATE``：先读版本再 ORM commit 会留下
并发窗口，两个请求可能同时通过比较并互相覆盖。网页 API 与咕咕工具都应经由
这里执行写入；调用方根据返回值决定是否向用户报告冲突。
"""
from __future__ import annotations

from datetime import date
from typing import Any, Dict, List
import json
import re

from sqlalchemy import func, update

from app.core.tz import now_utc
from app.models import Project

_PROJECT_FIELDS = {
    "name", "client", "status", "start_date", "deadline", "color", "progress",
    "current_stage", "archived", "priority", "stages",
}
_PROJECT_STATUSES = {"pending", "active", "done"}
_PROJECT_PRIORITIES = {"high", "medium", "low"}
_INVALID_NAME_RE = re.compile(r'[\\/:*?"<>|]')


def _validate_name(value: Any) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("名称不能为空")
    if _INVALID_NAME_RE.search(value):
        raise ValueError('名称不能包含以下字符：\\ / : * ? " < > |')


def _validate_date(value: Any, field: str) -> None:
    if value is not None:
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError(f"{field} 必须是 YYYY-MM-DD 格式")
        try:
            date.fromisoformat(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} 必须是 YYYY-MM-DD 格式") from exc


def _validate_stages(stages: Any) -> None:
    if not isinstance(stages, list) or not all(isinstance(stage, dict) for stage in stages):
        raise ValueError("项目阶段必须是对象列表")
    stage_keys = set()
    todo_ids = set()
    for stage in stages:
        key = stage.get("key")
        label = stage.get("label")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("阶段 key 不能为空")
        if key in stage_keys:
            raise ValueError("阶段 key 不能重复")
        stage_keys.add(key)
        if not isinstance(label, str) or not label.strip():
            raise ValueError("阶段名称不能为空")
        todos = stage.get("todos", [])
        if not isinstance(todos, list):
            raise ValueError("阶段 todos 必须是列表")
        for todo in todos:
            if not isinstance(todo, dict):
                raise ValueError("待办必须是对象")
            todo_id = todo.get("id")
            if not isinstance(todo_id, str) or not todo_id.strip():
                raise ValueError("待办 id 不能为空")
            if todo_id in todo_ids:
                raise ValueError("待办 id 不能重复")
            todo_ids.add(todo_id)
            if not isinstance(todo.get("text", ""), str):
                raise ValueError("待办内容必须是文本")
            if "done" in todo and not isinstance(todo["done"], bool):
                raise ValueError("待办完成状态必须是布尔值")


def normalize_project_stages(raw: Any) -> List[Dict[str, Any]]:
    """把咕咕创建项目时的松散阶段输入规范为项目持久化结构。"""
    if not isinstance(raw, list):
        raise ValueError("项目阶段必须是列表")
    stages: List[Dict[str, Any]] = []
    todo_number = 0
    for index, item in enumerate(raw):
        if isinstance(item, str):
            label = item
            todo_source = []
        elif isinstance(item, dict):
            label = item.get("label") or item.get("name") or ""
            todo_source = item.get("todos") or []
        else:
            continue
        label = str(label).strip()
        if not label:
            continue
        if not isinstance(todo_source, list):
            raise ValueError("阶段 todos 必须是列表")
        todos: List[Dict[str, Any]] = []
        for todo in todo_source:
            text = todo.get("text") if isinstance(todo, dict) else todo
            if not isinstance(text, str) or not text.strip():
                continue
            todo_number += 1
            todos.append({
                "id": f"t{todo_number}",
                "text": text,
                "done": bool(todo.get("done")) if isinstance(todo, dict) else False,
            })
        stages.append({"key": f"s{index}", "label": label, "todos": todos})
    _validate_stages(stages)
    return stages


def normalize_project_stages_for_read(raw: Any) -> List[Dict[str, Any]]:
    """兼容旧阶段数据，确保读接口始终返回当前前端可消费的结构。"""
    if not isinstance(raw, list):
        return []

    stages: List[Dict[str, Any]] = []
    stage_keys = set()
    todo_ids = set()
    todo_number = 0
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            continue

        key = item.get("key")
        if not isinstance(key, str) or not key.strip() or key in stage_keys:
            key = f"s{index}"
            while key in stage_keys:
                key = f"s{len(stage_keys)}"
        stage_keys.add(key)

        raw_todos = item.get("todos")
        todos: List[Dict[str, Any]] = []
        if isinstance(raw_todos, list):
            for todo in raw_todos:
                if not isinstance(todo, dict):
                    continue
                text = todo.get("text")
                if not isinstance(text, str) or not text.strip():
                    continue
                todo_id = todo.get("id")
                if not isinstance(todo_id, str) or not todo_id.strip() or todo_id in todo_ids:
                    todo_number += 1
                    todo_id = f"t{todo_number}"
                    while todo_id in todo_ids:
                        todo_number += 1
                        todo_id = f"t{todo_number}"
                todo_ids.add(todo_id)
                normalized_todo: Dict[str, Any] = {
                    "id": todo_id,
                    "text": text,
                    "done": todo.get("done") if isinstance(todo.get("done"), bool) else False,
                }
                if isinstance(todo.get("autoCompleted"), bool):
                    normalized_todo["autoCompleted"] = todo["autoCompleted"]
                if isinstance(todo.get("_savedDone"), bool):
                    normalized_todo["_savedDone"] = todo["_savedDone"]
                todos.append(normalized_todo)
        stages.append({"key": key, "label": label, "todos": todos})
    return stages


def find_project_stage(stages: List[Dict[str, Any]], target: str) -> Dict[str, Any] | None:
    """按稳定 key 或展示名称定位阶段。"""
    value = str(target).strip()
    return next((stage for stage in stages if stage.get("key") == value or stage.get("label") == value), None)


def next_project_stage_key(stages: List[Dict[str, Any]], prefix: str = "s") -> str:
    """返回当前结构中下一个不冲突的阶段 key。"""
    largest = -1
    for stage in stages:
        key = str(stage.get("key", ""))
        if key.startswith(prefix) and key[len(prefix):].isdigit():
            largest = max(largest, int(key[len(prefix):]))
    return f"{prefix}{largest + 1}"


def next_project_todo_number(stages: List[Dict[str, Any]]) -> int:
    """返回现有 tN 待办 id 的最大编号。"""
    largest = 0
    for stage in stages:
        for todo in stage.get("todos", []):
            todo_id = str(todo.get("id", ""))
            if todo_id.startswith("t") and todo_id[1:].isdigit():
                largest = max(largest, int(todo_id[1:]))
    return largest


def replace_project_stages(
    old_stages: List[Dict[str, Any]],
    current_stage: str | None,
    raw: Any,
) -> tuple[List[Dict[str, Any]], str]:
    """声明式替换阶段结构，同时保留同名阶段未显式覆盖的待办。"""
    if not isinstance(raw, list) or not raw:
        raise ValueError('需提供 stages 列表，如 ["需求","开发"] 或 [{"label":"开发","todos":["接口"]}]')

    old_by_label = {stage.get("label"): stage for stage in old_stages}
    stages: List[Dict[str, Any]] = []
    todo_number = 0
    for index, item in enumerate(raw):
        if isinstance(item, str):
            label, todo_source, has_todos = item, [], False
        elif isinstance(item, dict):
            label = item.get("label") or item.get("name") or ""
            todo_source = item.get("todos") or []
            has_todos = "todos" in item
        else:
            continue
        label = str(label).strip()
        if not label:
            continue
        if has_todos:
            source = [
                {
                    "text": todo.get("text") if isinstance(todo, dict) else todo,
                    "done": bool(todo.get("done")) if isinstance(todo, dict) else False,
                }
                for todo in todo_source
            ]
        elif label in old_by_label:
            source = [
                {"text": todo.get("text"), "done": todo.get("done", False)}
                for todo in old_by_label[label].get("todos", [])
            ]
        else:
            source = []
        todos: List[Dict[str, Any]] = []
        for todo in source:
            if not isinstance(todo.get("text"), str) or not todo["text"].strip():
                continue
            todo_number += 1
            todos.append({"id": f"t{todo_number}", "text": todo["text"], "done": bool(todo.get("done"))})
        stages.append({"key": f"s{index}", "label": label, "todos": todos})
    if not stages:
        raise ValueError("stages 解析后为空")
    _validate_stages(stages)

    old_current = next((stage for stage in old_stages if stage.get("key") == current_stage), None)
    current_label = old_current.get("label") if old_current else None
    next_current = next((stage["key"] for stage in stages if stage["label"] == current_label), stages[0]["key"])
    return stages, next_current


def prepare_project_update(fields: Dict[str, Any], existing_project: Project | None = None) -> Dict[str, Any]:
    """校验并转换项目可写字段，供 API 和工具共用。"""
    unknown = set(fields) - _PROJECT_FIELDS
    if unknown:
        raise ValueError("包含不支持的项目字段")

    values = dict(fields)
    if "name" in values:
        _validate_name(values["name"])
    if "status" in values and values["status"] not in _PROJECT_STATUSES:
        raise ValueError("项目状态必须是 pending、active 或 done")
    if "priority" in values and values["priority"] not in _PROJECT_PRIORITIES | {None}:
        raise ValueError("优先级必须是 high、medium、low 或空")
    if "progress" in values and (not isinstance(values["progress"], int) or not 0 <= values["progress"] <= 100):
        raise ValueError("项目进度必须是 0 到 100 的整数")
    _validate_date(values.get("start_date"), "开始日期")
    _validate_date(values.get("deadline"), "截止日期")
    start_date = values.get("start_date", existing_project.start_date if existing_project else None)
    deadline = values.get("deadline", existing_project.deadline if existing_project else None)
    if start_date and deadline and start_date > deadline:
        raise ValueError("开始日期不能晚于截止日期")
    if "stages" in values:
        stages = values.pop("stages")
        _validate_stages(stages)
        current_stage = values.get("current_stage", existing_project.current_stage if existing_project else None)
        if current_stage is not None and current_stage not in {stage["key"] for stage in stages}:
            raise ValueError("当前阶段必须属于阶段列表")
        values["stages_json"] = json.dumps(stages, ensure_ascii=False)
    elif "current_stage" in values and existing_project is not None:
        if values["current_stage"] is not None and values["current_stage"] not in {stage.get("key") for stage in existing_project.stages}:
            raise ValueError("当前阶段必须属于阶段列表")
    return values


def build_project(user_id, fields: Dict[str, Any]) -> Project:
    """创建项目模型前的统一字段校验与转换；调用方负责 add/commit。"""
    values = prepare_project_update(fields)
    if "name" not in values:
        raise ValueError("名称不能为空")
    return Project(user_id=user_id, **values)


async def update_project_atomic(
    db,
    project_id: int,
    user_id,
    client_version: int,
    fields: Dict[str, Any],
    existing_project: Project | None = None,
) -> bool:
    """按版本原子更新项目；``False`` 表示资源不存在、无权或版本已经变化。"""
    values = prepare_project_update(fields, existing_project)
    if not values:
        return False

    if "status" in values:
        values["done_at"] = (
            func.coalesce(Project.done_at, now_utc()) if values["status"] == "done" else None
        )
    values["version"] = Project.version + 1
    values["updated_at"] = now_utc()
    result = await db.execute(
        update(Project)
        .where(
            Project.id == project_id,
            Project.user_id == user_id,
            Project.version == client_version,
        )
        .values(**values)
    )
    return result.rowcount == 1
