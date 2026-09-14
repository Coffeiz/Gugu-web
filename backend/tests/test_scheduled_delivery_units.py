"""app/scheduled_tasks.py 单元补测（CRAP 治理 P1）。

覆盖：APScheduler trigger 构造分支、网页任务的固定私聊目标解析、旧任务兼容
地址解析、IM 可触达地址的读写清、邮件投递通路（打桩 SMTP）。
DB 走 conftest 内存库，Redis 走 fakeredis，SMTP/附件全打桩。
"""
import json
from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from app.core.schedule_rules import SCHEDULE_TZ
from app.models import User, UserBot
from app.scheduled_tasks import (
    _legacy_private_target,
    _reach_key,
    build_trigger,
    clear_imreach,
    get_imreach,
    owner_private_targets,
    save_imreach,
)


async def _bot(db, user, platform="qq", *, enabled=True, puid="puid-1"):
    row = UserBot(user_id=user.id, platform=platform, name=f"{platform}-bot",
                  enabled=enabled, owner_platform_user_id=puid)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


# ── build_trigger：三种 schedule_kind 的构造与守卫 ─────────────────────────

def test_build_trigger_kind_guards_and_once():
    with pytest.raises(ValueError):
        build_trigger("* * * * *", schedule_kind="yearly")
    with pytest.raises(ValueError):
        build_trigger("", schedule_kind="once")                       # once 缺 start_at

    trigger = build_trigger("", schedule_kind="once",
                            start_at=datetime(2026, 9, 20, 8, 0))
    assert type(trigger).__name__ == "DateTrigger"
    assert trigger.run_date.tzinfo is not None                        # naive 已补时区

    naive = build_trigger("", schedule_kind="once",
                          start_at=datetime(2026, 9, 20, 8, 0, tzinfo=SCHEDULE_TZ))
    assert naive.run_date.utcoffset() is not None


def test_build_trigger_interval_and_cron_windows():
    with pytest.raises(ValueError):
        build_trigger("", schedule_kind="interval")                   # 缺 interval_minutes

    trigger = build_trigger("", schedule_kind="interval", interval_minutes=30,
                            created_at=datetime(2026, 9, 14, 9, 0),
                            end_at=datetime(2026, 9, 15, 9, 0))
    assert type(trigger).__name__ == "IntervalTrigger"
    assert trigger.interval == timedelta(minutes=30)

    plain = build_trigger("30 9 * * *")
    assert type(plain).__name__ == "CronTrigger"

    windowed = build_trigger("30 9 * * *",
                             start_at=datetime(2026, 9, 14),
                             end_at=datetime(2026, 9, 30))
    assert type(windowed).__name__ == "CronTrigger"
    assert windowed.start_date is not None and windowed.end_date is not None


# ── owner_private_targets：网页任务的固定私聊目标 ─────────────────────────

async def test_owner_private_targets_empty_channels_returns_none(db, user_a):
    assert await owner_private_targets(db, user_a.id, None) is None
    assert await owner_private_targets(db, user_a.id, []) is None
    assert await owner_private_targets(db, user_a.id, {"email"}) is None   # 非 IM 渠道


async def test_owner_private_targets_resolves_enabled_bots(db, user_a):
    targets = await owner_private_targets(db, user_a.id, {"qq", "feishu"})
    assert set(targets) == {"qq", "feishu"}
    assert all(t["chat_type"] == "c2c" and t["chat_id"] is None for t in targets.values())
    assert targets["qq"]["puid"] is None                              # 未绑 bot → 地址留空

    bot = await _bot(db, user_a, "qq", puid="owner-puid")
    targets = await owner_private_targets(db, user_a.id, ["qq"])
    assert targets["qq"]["puid"] == "owner-puid"
    assert targets["qq"]["channel_id"] == str(bot.id)

    await _bot(db, user_a, "feishu", enabled=False, puid="disabled")
    targets = await owner_private_targets(db, user_a.id, {"feishu"})
    assert targets["feishu"]["puid"] is None                          # disabled 不采纳


# ── _legacy_private_target：旧任务兼容地址 ────────────────────────────────

async def test_legacy_private_target_prefers_bot_then_reach(db, user_a, monkeypatch):
    bot = await _bot(db, user_a, "qq", puid="legacy-puid")
    target = await _legacy_private_target(user_a.id, "qq")
    assert target == {"platform": "qq", "chat_type": "c2c", "chat_id": None,
                      "puid": "legacy-puid", "channel_id": str(bot.id)}

    # bot 无 owner 绑定 → 回落 Redis 可触达地址（仅限私聊、无群 id）
    from app.core import redis as R
    reach = {"platform": "feishu", "chat_type": "c2c", "chat_id": None,
             "puid": "ou-123", "channel_id": "ch-1"}
    await R.get_redis().set(_reach_key(user_a.id, "feishu"), json.dumps(reach))
    await _bot(db, user_a, "feishu", puid="")
    assert await _legacy_private_target(user_a.id, "feishu") == reach

    group_reach = {"platform": "qq", "chat_type": "group", "chat_id": "g-1", "puid": "p"}
    await R.get_redis().set(_reach_key(user_a.id, "qq2"), json.dumps(group_reach))
    assert await _legacy_private_target(user_a.id, "qq2") is None      # 群地址不作兼容目标

    assert await _legacy_private_target(user_a.id, "wechat") is None   # 两处都没有


# ── get_imreach / clear_imreach：可触达地址读写清 ─────────────────────────

async def test_get_imreach_platform_key_recent_fallback_and_garbage(user_a):
    assert await get_imreach(user_a.id, "qq") is None                  # 什么都没有

    per_platform = {"platform": "qq", "chat_type": "c2c", "puid": "p1"}
    recent = {"platform": "feishu", "chat_type": "c2c", "puid": "p2"}
    from app.core import redis as R
    await R.get_redis().set(_reach_key(user_a.id, "qq"), json.dumps(per_platform))
    await R.get_redis().set(_reach_key(user_a.id), json.dumps(recent))

    assert await get_imreach(user_a.id, "qq") == per_platform          # 平台键优先
    assert await get_imreach(user_a.id, "feishu") == recent            # 平台键缺失 → 最近键且平台吻合
    assert await get_imreach(user_a.id, "wechat") is None              # 最近键是别的平台
    assert await get_imreach(user_a.id) == recent                      # 不指定平台 → 最近键

    await R.get_redis().set(_reach_key(user_a.id, "bad"), b"{broken")
    assert await get_imreach(user_a.id, "bad") is None                 # 坏 JSON → None


async def test_clear_imreach_deletes_platform_and_matching_recent(user_a):
    from app.core import redis as R
    other = {"platform": "feishu", "puid": "p2"}
    await save_imreach(user_a.id, "qq", "ch", None, "p1")
    await R.get_redis().set(_reach_key(user_a.id), json.dumps(other))

    await clear_imreach(user_a.id, "qq")
    r = R.get_redis()
    assert await r.get(_reach_key(user_a.id, "qq")) is None            # 平台键已删
    assert json.loads(await r.get(_reach_key(user_a.id))) == other     # 最近键是别的平台 → 保留

    await R.get_redis().set(_reach_key(user_a.id), json.dumps({"platform": "qq", "puid": "p1"}))
    await clear_imreach(user_a.id, "qq")
    assert await r.get(_reach_key(user_a.id)) is None                  # 最近键正是该平台 → 连带删


# ── _deliver_email：收件人/附件/SMTP 打桩通路 ─────────────────────────────

async def _mk_user_without_email(db):
    user = User(id=uuid4(), username="noemail-user", email="", hashed_password="x")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def test_deliver_email_missing_recipient(db):
    from app.scheduled_tasks import _deliver_email

    user = await _mk_user_without_email(db)
    ok, note = await _deliver_email(user.id, "提醒", "正文")   # email 为空串=未绑定
    assert (ok, note) == (False, "收件人邮箱不存在")


async def test_deliver_email_paths(db, user_a, monkeypatch):
    from app.scheduled_tasks import _deliver_email
    from app.services.email import attachments as att_mod

    async def fake_attachments(db, user_id, *, file_ids=None, artifacts=None):
        return []

    monkeypatch.setattr(att_mod, "resolve_email_attachments", fake_attachments)

    calls = {}

    def fake_send(subject, body, **kwargs):
        calls["to"] = kwargs["to_addr"]
        calls["subject"] = subject
        return {"status": "sent"}

    monkeypatch.setattr("app.services.email.send_email_with_status", fake_send)
    ok, note = await _deliver_email(user_a.id, "周报提醒", "记得写周报")
    assert (ok, note) == (True, "已发送")
    assert calls["to"] == user_a.email and "周报提醒" in calls["subject"]

    monkeypatch.setattr("app.services.email.send_email_with_status",
                        lambda *a, **k: {"status": "error", "error_code": "smtp_auth"})
    ok, note = await _deliver_email(user_a.id, "周报提醒", "正文")
    assert (ok, note) == (False, "发送失败（smtp_auth）")

    async def boom(*a, **k):
        raise att_mod.EmailAttachmentError("文件已被清理")

    monkeypatch.setattr(att_mod, "resolve_email_attachments", boom)
    ok, note = await _deliver_email(user_a.id, "带附件", "正文", file_ids=[1])
    assert ok is False and "附件不可用" in note
