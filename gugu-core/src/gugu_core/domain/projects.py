"""项目规则与阶段操作；不依赖数据库、Web 或宿主配置。"""
from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Protocol
import json
import re

from gugu_core.domain.project_colors import PROJECT_COLOR_PRESETS


class ProjectState(Protocol):
    """增量校验需要的状态，不依赖 ORM 或宿主身份模型。"""

    start_date: str | None
    deadline: str | None
    current_stage: str | None

    @property
    def stages(self) -> List[Dict[str, Any]]: ...


_PROJECT_FIELDS = {
    "name", "summary", "client", "status", "start_date", "deadline", "color", "progress",
    "current_stage", "archived", "priority", "stages",
}
_PROJECT_STATUSES = {"pending", "active", "done"}
_PROJECT_PRIORITIES = {"high", "medium", "low"}
_PROJECT_COLORS = set(PROJECT_COLOR_PRESETS)
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
    """把阶段名称/对象列表规范为持久化结构；完整校验，不跳过无效项。"""
    if not isinstance(raw, list) or not raw:
        raise ValueError("项目阶段必须是非空列表")
    stages: List[Dict[str, Any]] = []
    todo_number = 0
    for index, item in enumerate(raw):
        if isinstance(item, str):
            item = {"label": item}
        if not isinstance(item, dict):
            raise ValueError(f"第 {index + 1} 个阶段必须是对象")
        if set(item) - {"label", "todos"}:
            raise ValueError(f"第 {index + 1} 个阶段包含未知字段")
        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"第 {index + 1} 个阶段必须提供非空 label")
        label = label.strip()
        todo_source = item.get("todos", [])
        if not isinstance(todo_source, list):
            raise ValueError("阶段 todos 必须是列表")
        todos: List[Dict[str, Any]] = []
        for todo_index, todo in enumerate(todo_source):
            text = todo
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"阶段「{label}」的第 {todo_index + 1} 个待办必须是非空文本")
            todo_number += 1
            todos.append({
                "id": f"t{todo_number}",
                "text": text.strip(),
                "done": False,
            })
        stages.append({"key": f"s{index}", "label": label, "todos": todos})
    _validate_stages(stages)
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
    """声明式替换阶段结构，按现有 key/唯一名称保留阶段身份和未覆盖待办。"""
    if not isinstance(raw, list) or not raw:
        raise ValueError('需提供非空 stages 列表，如 [{"label":"开发","todos":["接口"]}]')

    old_by_key = {stage.get("key"): stage for stage in old_stages}
    old_by_label: Dict[str, List[Dict[str, Any]]] = {}
    for old_stage in old_stages:
        old_by_label.setdefault(old_stage.get("label"), []).append(old_stage)
    stages: List[Dict[str, Any]] = []
    used_keys: set[str] = set()
    todo_number = next_project_todo_number(old_stages)
    for index, item in enumerate(raw):
        if isinstance(item, str):
            item = {"label": item}
        if not isinstance(item, dict):
            raise ValueError(f"第 {index + 1} 个阶段必须是对象")
        if set(item) - {"key", "label", "todos"}:
            raise ValueError(f"第 {index + 1} 个阶段包含未知字段")
        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"第 {index + 1} 个阶段必须提供非空 label")
        label = label.strip()
        explicit_key = item.get("key")
        if explicit_key is not None:
            if not isinstance(explicit_key, str) or not explicit_key.strip():
                raise ValueError(f"第 {index + 1} 个阶段的 key 必须是非空文本")
            previous = old_by_key.get(explicit_key)
            if previous is None:
                raise ValueError(f"阶段 key 不存在: {explicit_key}")
        else:
            same_label = old_by_label.get(label, [])
            if len(same_label) > 1:
                raise ValueError(f"阶段名称「{label}」重名，请在 stages 项中提供 key")
            previous = same_label[0] if same_label else None
        if previous is not None and previous["key"] in used_keys:
            raise ValueError(f"阶段 key 不能重复: {previous['key']}")
        if previous is not None:
            stage_key = previous["key"]
        else:
            stage_key = next_project_stage_key(old_stages + stages)
        if stage_key in used_keys:
            raise ValueError(f"阶段 key 不能重复: {stage_key}")
        used_keys.add(stage_key)

        todos: List[Dict[str, Any]] = []
        if "todos" in item:
            todo_source = item["todos"]
            if not isinstance(todo_source, list):
                raise ValueError(f"阶段「{label}」的 todos 必须是列表")
            for todo_index, text in enumerate(todo_source):
                if not isinstance(text, str) or not text.strip():
                    raise ValueError(f"阶段「{label}」的第 {todo_index + 1} 个待办必须是非空文本")
                todo_number += 1
                todos.append({"id": f"t{todo_number}", "text": text.strip(), "done": False})
        elif previous is not None:
            # 阶段改名或重排时，沿用原待办身份和完成状态。
            todos = [dict(todo) for todo in previous.get("todos", [])]
        stages.append({"key": stage_key, "label": label, "todos": todos})
    if not stages:
        raise ValueError("stages 解析后为空")
    _validate_stages(stages)

    next_current = (
        current_stage
        if any(stage["key"] == current_stage for stage in stages)
        else stages[0]["key"]
    )
    return stages, next_current


def prepare_project_update(fields: Dict[str, Any], existing_project: ProjectState | None = None) -> Dict[str, Any]:
    """校验并转换项目可写字段，供 API 和工具共用。"""
    unknown = set(fields) - _PROJECT_FIELDS
    if unknown:
        raise ValueError("包含不支持的项目字段")

    values = dict(fields)
    if "name" in values:
        _validate_name(values["name"])
    if "summary" in values:
        summary = values["summary"]
        if summary is not None and not isinstance(summary, str):
            raise ValueError("项目摘要必须是文本或空值")
        if summary is not None:
            summary = summary.strip() or None
            if summary is not None and len(summary) > 200:
                raise ValueError("项目摘要不能超过 200 个字符")
        values["summary"] = summary
    if "status" in values and values["status"] not in _PROJECT_STATUSES:
        raise ValueError("项目状态必须是 pending、active 或 done")
    if "priority" in values and values["priority"] not in _PROJECT_PRIORITIES | {None}:
        raise ValueError("优先级必须是 high、medium、low 或空")
    if "color" in values and values["color"] not in _PROJECT_COLORS:
        raise ValueError("颜色必须是预设色板中的值")
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



def prepare_project_create(fields: Dict[str, Any]) -> Dict[str, Any]:
    """创建与更新共用校验，创建必须显式提供名称。"""
    values = prepare_project_update(fields)
    if "name" not in values:
        raise ValueError("名称不能为空")
    # 独立宿主不经过 Web schema，缺省阶段列表也必须验证引用。
    if values.get("current_stage") is not None and "stages_json" not in values:
        raise ValueError("当前阶段必须属于阶段列表")
    return values
