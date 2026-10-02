"""群聊个人召回必须同时满足本人身份和服务端授权。"""
from types import SimpleNamespace

import pytest

from agent.im.actor import ActorContext
from agent.im.permissions import resolve_group_owner_memory
from agent.rag.injection import _request_scopes
from app.models import UserBot


@pytest.mark.parametrize('role,enabled,expected', [
    ('owner', False, ['group']), ('owner', True, ['group', 'owner']),
    ('member', True, ['group', 'member']), ('unknown', True, ['group']),
])
def test_group_personal_recall_requires_owner_and_opt_in(role, enabled, expected):
    request = SimpleNamespace(user_id='owner', source='qq', chat_id='group',
        platform_bot_id='1', platform_user_id='speaker', im_role=role,
        im_group_owner_memory_enabled=enabled)
    assert [scope.scope_type for _, scope in _request_scopes(request)] == expected


@pytest.mark.asyncio
async def test_setting_roundtrip_and_actor_isolation(db, user_a, user_b):
    from app.api.v1.user_bots import BotUpdate, update_my_bot
    bot = UserBot(user_id=user_a.id, platform='feishu', app_id='test')
    db.add(bot)
    await db.commit()
    assert bot.group_owner_memory_enabled is False
    owner = ActorContext(user_a.id, 'feishu', role='owner', chat_type='group')
    assert not await resolve_group_owner_memory(owner, str(bot.id))
    await update_my_bot(bot.id, BotUpdate(group_owner_memory_enabled=True), user_a, db)
    await db.refresh(bot)
    assert bot.group_owner_memory_enabled is True
    assert await resolve_group_owner_memory(owner, str(bot.id))
    for actor in [ActorContext(user_a.id, 'feishu', role='member', chat_type='group'),
                  ActorContext(user_b.id, 'feishu', role='owner', chat_type='group'),
                  ActorContext(user_a.id, 'qq', role='owner', chat_type='group')]:
        assert not await resolve_group_owner_memory(actor, str(bot.id))
    await update_my_bot(bot.id, BotUpdate(group_owner_memory_enabled=False), user_a, db)
    assert not await resolve_group_owner_memory(owner, str(bot.id))


@pytest.mark.asyncio
async def test_im_request_reads_database_setting_not_payload(db, user_a):
    from agent.im.loop import prepare_request
    from agent.im.models import ChatTarget, PlatformMessage, PlatformSender
    bot = UserBot(user_id=user_a.id, platform='feishu', app_id='test',
                  owner_platform_user_id='owner-speaker')
    db.add(bot)
    await db.commit()
    message = PlatformMessage(platform='feishu', bot_id=str(bot.id), message_id='m',
        chat=ChatTarget('group', 'group'), sender=PlatformSender('owner-speaker', '本人'), content='你好')
    payload = {'channel_id': str(bot.id), 'group_owner_memory_enabled': True}
    prepared = await prepare_request(message, payload, user_a.id, '本人')
    assert not prepared.request.im_group_owner_memory_enabled
    bot.group_owner_memory_enabled = True
    await db.commit()
    prepared = await prepare_request(message, {**payload, 'group_owner_memory_enabled': False}, user_a.id, '本人')
    assert prepared.request.im_group_owner_memory_enabled
    from dataclasses import replace
    message = replace(message, sender=PlatformSender('member-speaker', '群友'))
    prepared = await prepare_request(message, payload, user_a.id, '本人')
    assert not prepared.request.im_group_owner_memory_enabled
