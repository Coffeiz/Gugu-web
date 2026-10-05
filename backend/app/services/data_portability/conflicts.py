"""导入预检阶段可安全判定的用户级唯一约束冲突。"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import BinaryExpression, BooleanClauseList, Grouping, TextClause
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DataPortableIdentity, WorkspaceDirectory
from app.services.data_portability.projection import RECORD_SPECS
from app.services.data_portability.schema import PortableArchiveManifest, PortableEntityRecord


def _unique_constraints(model) -> list[tuple[tuple[str, ...], Any | None]]:
    result = [
        (tuple(column.key for column in constraint.columns), None)
        for constraint in model.__table__.constraints
        if constraint.__class__.__name__ == "UniqueConstraint"
    ]
    for index in model.__table__.indexes:
        if not index.unique:
            continue
        predicate = index.dialect_options["postgresql"].get("where")
        if predicate is None:
            predicate = index.dialect_options["sqlite"].get("where")
        result.append((tuple(column.key for column in index.columns), predicate))
    return result


def _predicate_field_value(spec, field: str, record: PortableEntityRecord, known_targets):
    source = field.removesuffix("_json") if field.endswith("_json") else field
    if source in record.fields:
        return True, record.fields[source]
    found, value = _field_value(spec, field, record, known_targets)
    if found:
        return True, value
    relation_spec = next((item for item in spec.refs if item[0] == field), None)
    if relation_spec is None:
        return False, None
    relation = next((item for item in record.relations if item.relation_type == relation_spec[1]), None)
    # 对索引谓词中的 IS [NOT] NULL，关系 portable id 足以判断 FK 是否存在；
    # 具体目标数据库 ID 可能要到前向引用解析后才可用。
    return True, relation.target_portable_id if relation is not None else None


def _partial_index_applies(predicate, spec, record: PortableEntityRecord, known_targets) -> bool:
    if predicate is None:
        return True
    if isinstance(predicate, TextClause):
        match = re.fullmatch(r"(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)\s+IS\s+(NOT\s+)?NULL", str(predicate).strip(), re.IGNORECASE)
        if match is None:
            return True
        found, value = _predicate_field_value(spec, match.group(1), record, known_targets)
        if not found:
            return True
        expects_non_null = bool(match.group(2))
        return (value is not None) is expects_non_null
    if isinstance(predicate, Grouping):
        return _partial_index_applies(predicate.element, spec, record, known_targets)
    if isinstance(predicate, BooleanClauseList):
        checks = [
            _partial_index_applies(clause, spec, record, known_targets)
            for clause in predicate.clauses
        ]
        if predicate.operator is operators.and_:
            return all(checks)
        if predicate.operator is operators.or_:
            return any(checks)
        return True
    if isinstance(predicate, BinaryExpression):
        column = predicate.left if hasattr(predicate.left, "key") else predicate.right
        if not hasattr(column, "key"):
            return True
        found, value = _predicate_field_value(spec, column.key, record, known_targets)
        if not found:
            return True
        other = predicate.right if column is predicate.left else predicate.left
        other_value = getattr(other, "value", None)
        operator = predicate.operator
        if operator is operators.is_:
            return value is other_value
        if operator is operators.is_not:
            return value is not other_value
        if operator is operators.eq:
            return value == other_value
        if operator is operators.ne:
            return value != other_value
    # 未知谓词采用保守路径，不漏报可能违反的唯一约束。
    return True


def _coerce(column, value: Any) -> Any:
    python_type = column.type.python_type
    if value is None:
        return None
    if python_type is str and isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if python_type is datetime and isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    if python_type is date and isinstance(value, str):
        return date.fromisoformat(value)
    if python_type is UUID and isinstance(value, str):
        return UUID(value)
    return python_type(value) if not isinstance(value, python_type) else value


def _field_value(spec, field: str, record: PortableEntityRecord, known_targets) -> tuple[bool, Any]:
    source = field.removesuffix("_json") if field.endswith("_json") else field
    column = spec.model.__table__.columns[field]
    if source in record.fields:
        value = _coerce(column, record.fields[source])
    else:
        relation_spec = next((item for item in spec.refs if item[0] == field), None)
        if relation_spec is None:
            return False, None
        relation = next((item for item in record.relations if item.relation_type == relation_spec[1]), None)
        if relation is None:
            return True, None
        value = known_targets.get((relation.target_type, relation.target_portable_id))
        if value is None:
            return False, None
        value = _coerce(column, value)
    try:
        hash(value)
    except TypeError:
        return False, None
    return True, value


async def find_unique_conflicts(
    db: AsyncSession,
    *, user_id: UUID,
    archive,
    manifest: PortableArchiveManifest,
) -> list[dict[str, Any]]:
    """只报告完全由 owner 与归档内直接字段构成、且不会误报 NULL 语义的冲突。"""
    known_rows = (await db.execute(select(
        DataPortableIdentity.source_type, DataPortableIdentity.portable_id,
        DataPortableIdentity.target_type, DataPortableIdentity.target_id,
    ).where(
        DataPortableIdentity.user_id == user_id,
        DataPortableIdentity.origin_id == manifest.origin_id,
    ))).all()
    known = {(row.source_type, row.portable_id) for row in known_rows}
    known_targets = {(row.target_type, row.portable_id): row.target_id for row in known_rows}
    specs = {spec.record_type: spec for spec in RECORD_SPECS}
    seen: dict[tuple[str, tuple[str, ...], str | None], set[tuple[Any, ...]]] = {}
    conflicts: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in manifest.entries:
        if not entry.path.startswith("records/") or not entry.path.endswith((".jsonl", ".json")):
            continue
        with archive.open(entry.path, "r") as stream:
            for line in stream:
                if not line.strip():
                    continue
                record = PortableEntityRecord.model_validate_json(line)
                if record.source_type not in specs or (record.source_type, record.portable_id) in known:
                    continue
                spec = specs[record.source_type]
                if spec.owner_field not in {"user_id", "owner_id", "owner_user_id"}:
                    continue
                default_directory_id = None
                if spec.record_type == "workspace_directory" and record.fields.get("is_default") is True:
                    default_directory_id = (await db.execute(select(WorkspaceDirectory.id).where(
                        WorkspaceDirectory.user_id == user_id,
                        WorkspaceDirectory.is_default.is_(True),
                        WorkspaceDirectory.deleted_at.is_(None),
                    ).limit(1))).scalar_one_or_none()
                for constraint, predicate in _unique_constraints(spec.model):
                    if not _partial_index_applies(predicate, spec, record, known_targets):
                        continue
                    columns = tuple(field for field in constraint if field != spec.owner_field)
                    if not columns:
                        continue
                    resolved = [_field_value(spec, field, record, known_targets) for field in columns]
                    if not all(found for found, _ in resolved):
                        continue
                    values = tuple(value for _, value in resolved)
                    # SQL unique constraints generally allow multiple NULL values.
                    if any(value is None for value in values):
                        continue
                    signature = (spec.record_type, columns, str(predicate) if predicate is not None else None)
                    if values in seen.setdefault(signature, set()):
                        conflicts[(spec.record_type, record.portable_id)] = {
                            "source_type": spec.record_type,
                            "portable_id": record.portable_id,
                            "fields": list(columns),
                            "kind": "archive_duplicate",
                        }
                        continue
                    seen[signature].add(values)
                    # 每个目标账号已有系统默认目录；该来源记录会映射到它，不是名称冲突。
                    if default_directory_id is not None:
                        continue
                    conditions = [getattr(spec.model, spec.owner_field) == user_id]
                    conditions.extend(getattr(spec.model, field) == value for field, value in zip(columns, values))
                    if predicate is not None:
                        conditions.append(predicate)
                    target_id = (await db.execute(select(getattr(spec.model, spec.id_field)).where(*conditions).limit(1))).scalar_one_or_none()
                    if target_id is not None:
                        conflicts[(spec.record_type, record.portable_id)] = {
                            "source_type": spec.record_type,
                            "portable_id": record.portable_id,
                            "fields": list(columns),
                            "kind": "target_conflict",
                        }
    return list(conflicts.values())
