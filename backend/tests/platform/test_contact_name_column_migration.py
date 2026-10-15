"""项目与日历活动的自由文本联系人列迁移。"""
import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.models import CalendarEvent, Project


BACKEND = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    BACKEND / "alembic/versions/20261016000001_rename_client_columns_to_contact_name.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("contact_name_column_migration", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_contact_name_column_migration_preserves_values_and_can_be_reverted():
    """升级不丢失已有自由文本，降级后原列和值均可恢复。"""
    assert Project.client.property.columns[0].name == "contact_name"
    assert CalendarEvent.client.property.columns[0].name == "contact_name"

    engine = sa.create_engine("sqlite://")
    migration = _load_migration()
    try:
        with engine.begin() as connection:
            for table in ("projects", "calendar_events"):
                connection.exec_driver_sql(
                    f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, client VARCHAR(200))'
                )
                connection.exec_driver_sql(
                    f'INSERT INTO "{table}" (id, client) VALUES (1, ?), (2, NULL)',
                    ("外部联系人",),
                )

            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()

            for table in ("projects", "calendar_events"):
                columns = {column["name"] for column in sa.inspect(connection).get_columns(table)}
                assert "contact_name" in columns
                assert "client" not in columns
                assert connection.exec_driver_sql(
                    f'SELECT contact_name FROM "{table}" ORDER BY id'
                ).scalars().all() == ["外部联系人", None]

            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()

            for table in ("projects", "calendar_events"):
                columns = {column["name"] for column in sa.inspect(connection).get_columns(table)}
                assert "client" in columns
                assert "contact_name" not in columns
                assert connection.exec_driver_sql(
                    f'SELECT client FROM "{table}" ORDER BY id'
                ).scalars().all() == ["外部联系人", None]
    finally:
        engine.dispose()


def test_contact_name_column_migration_is_safe_on_current_orm_schema():
    """无版本表兼容启动遇到新 ORM 列时跳过重命名，不因列已迁移而失败。"""
    engine = sa.create_engine("sqlite://")
    migration = _load_migration()
    try:
        with engine.begin() as connection:
            for table in ("projects", "calendar_events"):
                connection.exec_driver_sql(
                    f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, contact_name VARCHAR(200))'
                )

            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()

            for table in ("projects", "calendar_events"):
                columns = {column["name"] for column in sa.inspect(connection).get_columns(table)}
                assert "contact_name" in columns
                assert "client" not in columns
    finally:
        engine.dispose()
