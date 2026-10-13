"""验证保留的 QQ 格式选项迁移及其数据库默认值。"""
import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


_MIGRATION_PATH = (
    Path(__file__).parents[2]
    / "alembic/versions/20261014000001_remove_smart_qq_message_format.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("qq_message_format_migration", _MIGRATION_PATH)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_existing_smart_settings_become_markdown_without_changing_other_choices_or_data_default():
    migration = _load_migration()
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE user_bots (id INTEGER PRIMARY KEY, "
            "group_message_format VARCHAR(16) NOT NULL DEFAULT 'compat', "
            "private_message_format VARCHAR(16) NOT NULL DEFAULT 'smart')"
        )
        connection.exec_driver_sql(
            "INSERT INTO user_bots(id, group_message_format, private_message_format) VALUES "
            "(1, 'smart', 'smart'), (2, 'compat', 'markdown')"
        )
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        values = connection.exec_driver_sql(
            "SELECT group_message_format, private_message_format FROM user_bots ORDER BY id"
        ).all()
        assert values == [("markdown", "markdown"), ("compat", "markdown")]
        private_default = next(
            column["dflt_value"]
            for column in sa.inspect(connection).get_columns("user_bots")
            if column["name"] == "private_message_format"
        )
        assert private_default == "'markdown'"

        with Operations.context(context):
            migration.downgrade()
        # 回滚不能推断哪些 Markdown 值曾来自智能模式，故保留已归一化的数据。
        assert connection.exec_driver_sql(
            "SELECT group_message_format, private_message_format FROM user_bots ORDER BY id"
        ).all() == values
        private_default = next(
            column["dflt_value"]
            for column in sa.inspect(connection).get_columns("user_bots")
            if column["name"] == "private_message_format"
        )
        assert private_default == "'smart'"
    engine.dispose()
