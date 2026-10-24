"""统一群工具权限迁移需保留新 Provider 搜索并收敛旧值。"""
import importlib.util
from pathlib import Path

import sqlalchemy as sa


def migration():
    path = Path(__file__).parents[3] / "alembic/versions/20261022000002_normalize_group_tool_permissions.py"
    spec = importlib.util.spec_from_file_location("group_tool_permission_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_preserves_provider_search_and_normalizes_legacy_group_tools(monkeypatch):
    module = migration()
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    table = sa.Table(
        "user_bots", metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("group_allowed_tools", sa.JSON),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(table.insert(), [
            {"id": 1, "group_allowed_tools": ["web_search", "http_get", "xng_search"]},
            {"id": 2, "group_allowed_tools": ["image_search", "inspect_images", "retired_tool"]},
            {"id": 3, "group_allowed_tools": ["web_search", "retired_tool"]},
        ])
        monkeypatch.setattr(module.op, "get_bind", lambda: connection)
        module.upgrade()
        rows = connection.execute(sa.select(table).order_by(table.c.id)).all()

    assert rows[0].group_allowed_tools == ["web_search", "http_get", "xng_search"]
    assert rows[1].group_allowed_tools == ["xng_search", "http_get", "similar_image_search", "read_file"]
    assert rows[2].group_allowed_tools == ["web_search", "http_get"]
