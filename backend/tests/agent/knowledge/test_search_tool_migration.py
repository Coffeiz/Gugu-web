"""旧搜索授权迁移应保留搜索能力，不授予新增的付费搜索权限。"""
import importlib.util
from pathlib import Path

import sqlalchemy as sa


def migration():
    path = Path(__file__).parents[3] / 'alembic/versions/20261018000001_migrate_search_tool_references.py'
    spec = importlib.util.spec_from_file_location('search_tool_migration', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migrate_stored_tool_permissions_preserves_existing_capabilities(monkeypatch):
    module = migration()
    engine = sa.create_engine('sqlite://')
    metadata = sa.MetaData()
    table = sa.Table('user_bots', metadata, sa.Column('id', sa.Integer, primary_key=True), sa.Column('group_allowed_tools', sa.JSON))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(table.insert(), [
            {'id': 1, 'group_allowed_tools': ['web_search', 'image_search', 'read_file']},
            {'id': 2, 'group_allowed_tools': []},
        ])
        monkeypatch.setattr(module.op, 'get_bind', lambda: connection)
        module._migrate_list_column('user_bots', 'id', 'group_allowed_tools', module._FORWARD)
        rows = connection.execute(sa.select(table).order_by(table.c.id)).all()
        assert rows[0].group_allowed_tools == ['xng_search', 'similar_image_search', 'read_file']
        assert rows[1].group_allowed_tools == []


def test_migrate_skill_snapshot_preserves_unrelated_context():
    module = migration()
    original = {'other': {'keep': True}, 'user_skill_snapshot': [{'name': 'U1', 'related_tools': ['web_search', 'image_search', 'read_file']}]}
    result = module._migrate_skill_snapshot(original, module._FORWARD)
    assert result['other'] == original['other']
    assert result['user_skill_snapshot'][0]['related_tools'] == ['xng_search', 'similar_image_search', 'read_file']
    assert original['user_skill_snapshot'][0]['related_tools'] == ['web_search', 'image_search', 'read_file']
