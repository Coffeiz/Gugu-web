"""执行显式标记为 bootstrap 兼容的幂等 Alembic revisions。"""

from alembic.config import Config
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.engine import Connection


def apply_bootstrap_revisions(connection: Connection, config: Config) -> None:
    """执行显式标记为 bootstrap_on_empty_database 的 revisions。

    这些 revision 必须能在当前 ORM schema 上幂等执行。
    """
    _apply_marked_revisions(connection, config, "bootstrap_on_empty_database")


def apply_legacy_compatibility_revisions(connection: Connection, config: Config) -> None:
    """只执行显式声明兼容无版本表旧库的幂等 revisions。"""
    _apply_marked_revisions(connection, config, "bootstrap_on_legacy_database")


def _apply_marked_revisions(connection: Connection, config: Config, marker: str) -> None:
    script = ScriptDirectory.from_config(config)
    migration_context = MigrationContext.configure(connection)
    with migration_context.begin_transaction():
        with Operations.context(migration_context):
            revisions = reversed(list(script.walk_revisions()))
            for revision in revisions:
                if getattr(revision.module, marker, False):
                    revision.module.upgrade()
