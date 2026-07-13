"""P0.1 对拍：compose_logical_path + PathMirrorStrategy 必须与现有 _build_key 逐字一致。

_build_key 仍是生产在用的基准（P0.5 才换调用点）；这里锁定「拆分不改行为」。
"""
import pytest

from app.services.storage import LocalStorageBackend
from app.services.storage.keys import _build_key, compose_logical_path
from app.services.storage.key_strategy import PathMirrorStrategy, KeyContext, ResolvedKey

# 覆盖全部分支：personal（根/子夹/嵌套 folder_path）、project（年月/无年月/带夹/嵌套）、mind、asset、非法字符
CASES = [
    dict(uid=7, space="personal", display_name="doc", ext="TXT"),
    dict(uid=7, space="personal", display_name="doc", ext="TXT", folder_name="子/夹"),
    dict(uid=7, space="personal", display_name="doc", ext="TXT", folder_path="资料/会议纪要"),
    dict(uid=7, space="project", display_name="doc", ext="MD",
         project_name="P/1", project_id=3, project_year="2026", project_month="07"),
    dict(uid=7, space="project", display_name="doc", ext="md", project_name="P", project_id=3),
    dict(uid=7, space="project", display_name="doc", ext="md", project_name="P", project_id=3, folder_name="f"),
    dict(uid=7, space="project", display_name="doc", ext="md", project_name="P", project_id=3, folder_path="设计/评审"),
    dict(uid=7, space="mind", display_name="note", ext="MD", mind_map_title="图", mind_map_id=9),
    dict(uid=7, space="asset", display_name="pic", ext="PNG"),
    dict(uid=7, space="personal", display_name="a:b*c", ext="PDF"),   # 非法字符 → _safe_name
]

_PATH_KEYS = {"project_name", "project_id", "project_year", "project_month",
              "folder_name", "folder_path", "mind_map_title", "mind_map_id"}


@pytest.mark.parametrize("kw", CASES)
def test_pathmirror_equals_build_key(kw):
    path_args = {k: v for k, v in kw.items() if k in _PATH_KEYS}
    logical = compose_logical_path(kw["space"], **path_args)
    ctx = KeyContext(user_id=kw["uid"], file_id=None, name=kw["display_name"], ext=kw["ext"], logical_path=logical)
    assert PathMirrorStrategy().build_key(ctx) == _build_key(**kw)


def test_move_semantics_is_relocate():
    assert PathMirrorStrategy().move_semantics == "relocate"


async def test_resolve_conflict_returns_resolved_key(tmp_path):
    storage = LocalStorageBackend(tmp_path)
    await storage.put("7/个人文件/doc.txt", b"x")
    r = await PathMirrorStrategy().resolve_conflict(storage, "7/个人文件/doc.txt", "doc", "txt")
    assert isinstance(r, ResolvedKey)
    assert r.key == "7/个人文件/doc(1).txt"
    assert r.name == "doc(1)"


async def test_resolve_conflict_no_collision(tmp_path):
    storage = LocalStorageBackend(tmp_path)
    r = await PathMirrorStrategy().resolve_conflict(storage, "7/个人文件/doc.txt", "doc", "txt")
    assert (r.key, r.name) == ("7/个人文件/doc.txt", "doc")
