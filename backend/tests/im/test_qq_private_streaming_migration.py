"""验证恢复 QQ 私聊流式开关时保留迁移前的有效行为。"""
import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


_MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic/versions/20261024000001_restore_qq_private_streaming_setting.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("restore_qq_private_streaming", _MIGRATION_PATH)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_migration_preserves_streaming_for_existing_markdown_bots_and_defaults_new_bots_off():
    migration = _load_migration()
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE user_bots (id INTEGER PRIMARY KEY, "
            "private_message_format VARCHAR(16) NOT NULL DEFAULT 'markdown')"
        )
        connection.exec_driver_sql(
            "INSERT INTO user_bots(id, private_message_format) VALUES "
            "(1, 'markdown'), (2, 'compat')"
        )
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()
        assert connection.exec_driver_sql(
            "SELECT private_streaming_enabled FROM user_bots ORDER BY id"
        ).scalars().all() == [1, 0]
        connection.exec_driver_sql(
            "INSERT INTO user_bots(id, private_message_format) VALUES (3, 'markdown')"
        )
        assert connection.exec_driver_sql(
            "SELECT private_streaming_enabled FROM user_bots WHERE id = 3"
        ).scalar_one() == 0
        with Operations.context(context):
            migration.downgrade()
        assert "private_streaming_enabled" not in {
            column["name"] for column in sa.inspect(connection).get_columns("user_bots")
        }
    engine.dispose()
