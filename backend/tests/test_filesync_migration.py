from __future__ import annotations

import importlib.util
from pathlib import Path
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import (
    Column, DateTime, Integer, MetaData, String, Table, Uuid, create_engine,
    inspect, text,
)


def test_filesync_migration_is_idempotent_and_preserves_existing_sync_records():
    """升级与重跑迁移不得丢失既有绑定、journal 或冲突记录。"""
    migration_path = (
        Path(__file__).resolve().parents[1]
        / "alembic/versions/20261006000001_add_filesync_reconcile_runs.py"
    )
    spec = importlib.util.spec_from_file_location("filesync_migration", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    metadata = MetaData()
    users = Table("users", metadata, Column("id", Uuid(), primary_key=True))
    bindings = Table(
        "file_sync_bindings", metadata,
        Column("id", Integer, primary_key=True),
        Column("user_id", Uuid(), nullable=False),
        Column("workspace_id", Integer),
        Column("source", String(32)),
        Column("protocol_version", Integer),
        Column("root_path", String(1000)),
        Column("root_fingerprint", String(64)),
        Column("mode", String(24)),
        Column("status", String(24)),
        Column("revision", Integer),
        Column("last_reconciled_at", DateTime(timezone=True)),
        Column("created_at", DateTime(timezone=True)),
        Column("updated_at", DateTime(timezone=True)),
    )
    journals = Table(
        "file_sync_journal", metadata,
        Column("id", Integer, primary_key=True),
        Column("binding_id", Integer, nullable=False),
        Column("user_id", Uuid(), nullable=False),
        Column("relative_path", String(1000), nullable=False),
        Column("observed_fingerprint", String(64)),
        Column("status", String(24)),
    )
    conflicts = Table(
        "file_sync_conflicts", metadata,
        Column("id", Integer, primary_key=True),
        Column("binding_id", Integer, nullable=False),
        Column("user_id", Uuid(), nullable=False),
        Column("relative_path", String(1000), nullable=False),
        Column("status", String(24)),
    )

    engine = create_engine("sqlite://")
    user_id = uuid4()
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(users.insert().values(id=user_id))
        connection.execute(bindings.insert().values(
            id=7, user_id=user_id, source="local_directory", mode="bidirectional",
            status="active", root_path="workspace", root_fingerprint="a" * 64,
            revision=12,
        ))
        connection.execute(journals.insert().values(
            id=11, binding_id=7, user_id=user_id, relative_path="note.txt",
            observed_fingerprint="b" * 64, status="synced",
        ))
        connection.execute(conflicts.insert().values(
            id=13, binding_id=7, user_id=user_id, relative_path="conflict.txt",
            status="pending",
        ))

        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()
            migration.upgrade()

        table_names = set(inspect(connection).get_table_names())
        assert "file_sync_reconcile_runs" in table_names
        assert "file_sync_user_scan_states" in table_names
        binding_row = connection.execute(text(
            "SELECT revision, scope_revision FROM file_sync_bindings WHERE id = 7",
        )).mappings().one()
        journal_row = connection.execute(text(
            "SELECT relative_path, dirty_revision FROM file_sync_journal WHERE id = 11",
        )).mappings().one()
        conflict_row = connection.execute(
            conflicts.select().where(conflicts.c.id == 13),
        ).mappings().one()
        assert binding_row["revision"] == 12
        assert binding_row["scope_revision"] == 0
        assert journal_row["relative_path"] == "note.txt"
        assert journal_row["dirty_revision"] is None
        assert conflict_row["relative_path"] == "conflict.txt"
        assert conflict_row["status"] == "pending"

    engine.dispose()
