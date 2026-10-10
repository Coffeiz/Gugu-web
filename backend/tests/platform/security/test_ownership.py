"""get_owned 单元测试——所有权查询层本身的行为契约。

契约（app/core/ownership.py）：
- 本人的行 → 返回对象（UUID/str 混用也得认得出来，别把自己人挡在门外）
- 别人的行 → None（且这是越权信号，打 ownership.denied 日志）
- 不存在的 id / None id → None
"""
import logging

from app.core.ownership import _ownership_identity, _ownership_warning_fields, get_owned
from app.models import File
from app.security.events import security_fingerprint


async def _mk_file(db, owner) -> File:
    f = File(user_id=owner.id, display_name="doc", ext="md", storage_key=f"{owner.id}/t/doc.md")
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def test_owner_gets_own_row(db, user_a):
    f = await _mk_file(db, user_a)
    got = await get_owned(db, File, f.id, user_a.id)
    assert got is not None and got.id == f.id


async def test_owner_id_as_str_still_matches(db, user_a):
    """user_id 在不同调用路径可能是 UUID 对象或字符串——str 归一后都要能匹配。"""
    f = await _mk_file(db, user_a)
    got = await get_owned(db, File, f.id, str(user_a.id))
    assert got is not None and got.id == f.id


async def test_cross_user_denied(db, user_a, user_b):
    f = await _mk_file(db, user_b)
    assert await get_owned(db, File, f.id, user_a.id) is None


async def test_cross_user_denied_logs_warning(db, user_a, user_b, caplog):
    """越权尝试必须留下 ownership.denied 信号——运行时检测靠它。"""
    f = await _mk_file(db, user_b)
    with caplog.at_level(logging.WARNING, logger="ownership"):
        await get_owned(db, File, f.id, user_a.id)
    assert any("ownership.denied" in r.message for r in caplog.records)
    assert any("model=File" in r.message for r in caplog.records)
    denied = next(r.message for r in caplog.records if "ownership.denied" in r.message)
    assert f"resource={security_fingerprint(f.id)[:16]} owner=" in denied
    assert f"owner={security_fingerprint(user_b.id)[:16]} requester={security_fingerprint(user_a.id)[:16]}" in denied
    assert f"resource={f.id} owner=" not in denied


def test_ownership_identity_handles_missing_owner_as_unowned():
    assert _ownership_identity(object(), "owner-id") == (None, False)


def test_ownership_warning_fields_emit_exact_truncated_fingerprints_and_none_owner():
    resource_id = "private-resource-id"
    owner_id = "private-owner-id"
    requester_id = "private-requester-id"
    fields = _ownership_warning_fields(File, resource_id, owner_id, requester_id)
    assert fields == (
        "File",
        security_fingerprint(resource_id)[:16],
        security_fingerprint(owner_id)[:16],
        security_fingerprint(requester_id)[:16],
    )
    assert _ownership_warning_fields(File, resource_id, None, requester_id)[2] is None


async def test_missing_row_is_none_without_denied_log(db, user_a, caplog):
    """行不存在 → None，但**不该**打越权日志（那不是越权，是普通 miss）。"""
    with caplog.at_level(logging.WARNING, logger="ownership"):
        assert await get_owned(db, File, 99999, user_a.id) is None
    assert not any("ownership.denied" in r.message for r in caplog.records)


async def test_none_id_is_none(db, user_a):
    assert await get_owned(db, File, None, user_a.id) is None
