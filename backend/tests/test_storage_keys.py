"""storage.keys 路径构建纯逻辑——从 files.py 迁出后的对称测试（P2④-③）。

行为须与迁出前逐字一致；这些断言即「纯移动不改语义」的护栏。
"""
from app.services.storage import LocalStorageBackend
from app.services.storage.keys import _safe_name, _build_key, _resolve_conflict


def test_safe_name_replaces_invalid_chars():
    assert _safe_name(r'a/b\c:d*e?f"g<h>i|j') == 'a_b_c_d_e_f_g_h_i_j'
    assert _safe_name('正常名') == '正常名'


def test_build_key_personal():
    assert _build_key(7, 'personal', 'doc', 'TXT') == '7/个人文件/doc.txt'
    assert _build_key(7, 'personal', 'doc', 'TXT', folder_name='子/夹') == '7/个人文件/子_夹/doc.txt'
    assert _build_key(7, 'personal', 'doc', 'TXT', folder_path='资料/会议纪要') == '7/个人文件/资料/会议纪要/doc.txt'


def test_build_key_project():
    assert _build_key(7, 'project', 'doc', 'MD', project_name='P/1', project_id=3,
                      project_year='2026', project_month='07') == '7/项目文件/2026/07/P_1 #3/doc.md'
    # 无年月 → 无日期段
    assert _build_key(7, 'project', 'doc', 'md', project_name='P', project_id=3) == '7/项目文件/P #3/doc.md'
    # 带文件夹
    assert _build_key(7, 'project', 'doc', 'md', project_name='P', project_id=3, folder_name='f') == '7/项目文件/P #3/f/doc.md'
    assert _build_key(7, 'project', 'doc', 'md', project_name='P', project_id=3,
                      folder_path='设计/评审') == '7/项目文件/P #3/设计/评审/doc.md'


def test_build_key_mind_and_asset():
    assert _build_key(7, 'mind', 'note', 'MD', mind_map_title='图', mind_map_id=9) == '7/思维/图 #9/note.md'
    assert _build_key(7, 'asset', 'pic', 'PNG') == '7/素材板/pic.png'


def test_build_key_lowercases_ext_and_sanitizes():
    assert _build_key(7, 'personal', 'a:b', 'PDF') == '7/个人文件/a_b.pdf'


async def test_resolve_conflict_no_collision(tmp_path):
    storage = LocalStorageBackend(tmp_path)
    assert await _resolve_conflict(storage, '7/个人文件/doc.txt', 'doc', 'txt') == ('7/个人文件/doc.txt', 'doc')


async def test_resolve_conflict_bumps_on_collision(tmp_path):
    storage = LocalStorageBackend(tmp_path)
    await storage.put('7/个人文件/doc.txt', b'x')
    key, name = await _resolve_conflict(storage, '7/个人文件/doc.txt', 'doc', 'txt')
    assert (key, name) == ('7/个人文件/doc(1).txt', 'doc(1)')


async def test_resolve_conflict_non_local_backend_skips(tmp_path):
    class FakeOSS:
        pass
    assert await _resolve_conflict(FakeOSS(), '7/x/doc.txt', 'doc', 'txt') == ('7/x/doc.txt', 'doc')
