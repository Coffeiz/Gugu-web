"""本人会话均返回运行状态，只有 Web 返回未读版本，不泄露其他用户状态。"""
import json

import pytest

from app.api.v1.agent_routes.sessions import list_sessions
from app.models import ConversationMessage, ConversationSession


@pytest.mark.asyncio
async def test_session_list_exposes_only_owned_web_reply_and_running_state(db, user_a, user_b, monkeypatch):
    from app.core.redis import get_redis
    from agent.llm.genstream import _state_key

    monkeypatch.setattr('app.api.v1.agent_routes.sessions.filesystem_authorization_enabled', lambda: False)
    web = ConversationSession(user_id=user_a.id, source='web', title='合成网页')
    im = ConversationSession(user_id=user_a.id, source='qq', title='合成 IM')
    foreign = ConversationSession(user_id=user_b.id, source='web', title='其他账号')
    db.add_all([web, im, foreign])
    await db.flush()
    reply = ConversationMessage(session_id=web.id, role='assistant', content='已完成回复')
    db.add(reply)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=web.id, role='user', content='新问题'),
        ConversationMessage(session_id=web.id, role='assistant', content='', content_json=[], display_timeline=[]),
        ConversationMessage(session_id=im.id, role='assistant', content='IM 回复'),
        ConversationMessage(session_id=foreign.id, role='assistant', content='其他账号回复'),
    ])
    await db.commit()
    redis = get_redis()
    await redis.set(_state_key(web.id), json.dumps({'done': False}))
    await redis.set(_state_key(im.id), json.dumps({'done': False}))
    result = {row['id']: row for row in await list_sessions(current_user=user_a, db=db)}
    assert foreign.id not in result
    assert result[web.id]['isRunning'] is True
    assert result[web.id]['lastAssistantId'] == reply.id
    assert result[im.id]['isRunning'] is True
    assert 'lastAssistantId' not in result[im.id]
    await redis.set(_state_key(web.id), json.dumps({'done': True}))
    await redis.set(_state_key(im.id), json.dumps({'done': True}))
    result = {row['id']: row for row in await list_sessions(current_user=user_a, db=db)}
    assert result[web.id]['isRunning'] is False
    assert result[im.id]['isRunning'] is False
    assert 'lastAssistantId' not in result[im.id]
    attachment_reply = ConversationMessage(session_id=web.id, role='assistant', content='',
                                           files=[{'file_id': 123, 'name': '合成附件'}])
    db.add(attachment_reply)
    await db.commit()
    result = {row['id']: row for row in await list_sessions(current_user=user_a, db=db)}
    assert result[web.id]['lastAssistantId'] == attachment_reply.id
