"""导入预检阶段可安全判定的用户级唯一约束冲突。"""
from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DataPortableIdentity
from app.services.data_portability.projection import RECORD_SPECS
from app.services.data_portability.schema import PortableArchiveManifest, PortableEntityRecord


def _unique_constraints(model) -> list[tuple[str, ...]]:
    result = [tuple(column.key for column in constraint.columns)
              for constraint in model.__table__.constraints
              if constraint.__class__.__name__ == "UniqueConstraint"]
    result.extend(
        tuple(column.key for column in index.columns)
        for index in model.__table__.indexes if index.unique
    )
    return result


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
    seen: dict[tuple[str, tuple[str, ...]], set[tuple[Any, ...]]] = {}
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
                for constraint in _unique_constraints(spec.model):
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
                    signature = (spec.record_type, columns)
                    if values in seen.setdefault(signature, set()):
                        conflicts[(spec.record_type, record.portable_id)] = {
                            "source_type": spec.record_type,
                            "portable_id": record.portable_id,
                            "fields": list(columns),
                            "kind": "archive_duplicate",
                        }
                        continue
                    seen[signature].add(values)
                    conditions = [getattr(spec.model, spec.owner_field) == user_id]
                    conditions.extend(getattr(spec.model, field) == value for field, value in zip(columns, values))
                    target_id = (await db.execute(select(getattr(spec.model, spec.id_field)).where(*conditions).limit(1))).scalar_one_or_none()
                    if target_id is not None:
                        conflicts[(spec.record_type, record.portable_id)] = {
                            "source_type": spec.record_type,
                            "portable_id": record.portable_id,
                            "fields": list(columns),
                            "kind": "target_conflict",
                        }
    return list(conflicts.values())
