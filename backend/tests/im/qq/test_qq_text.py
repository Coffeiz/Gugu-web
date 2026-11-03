"""QQ 特定的链接约束不能截断流，也不能污染其他平台原文。"""
import re
import json
from unittest.mock import AsyncMock

import pytest

from agent.gateway.qq import outbound
from agent.gateway.qq.client import QQAPIError, QQStreamDeliveryError, QQStreamFinalizationError
from agent.gateway.qq.text import prepare_qq_text


MAP_LINK = '[示例店铺](baidumap://map/place/detail?uid=synthetic_poi&src=web.demo)'
WEB_LINK = '[示例店铺](https://api.map.baidu.com/place/detail?uid=synthetic_poi&output=html)'


def test_map_links_convert_without_changing_original():
    assert prepare_qq_text(MAP_LINK) == WEB_LINK
    assert prepare_qq_text(WEB_LINK) == WEB_LINK
    assert 'baidumap://' in MAP_LINK


@pytest.mark.parametrize('text', [
    '[打开](unknownapp://map/detail)', 'unknownapp://map/detail',
    '[打开](baidumap://map/place/detail?uid=one&uid=two)',
    '[打开](baidumap://map/nearbysearch?query=demo)',
])
def test_unsupported_routes_keep_readable_notice_without_unsafe_protocol(text):
    result = prepare_qq_text(text)
    assert 'QQ 不支持' in result
    assert '://' not in result


def test_every_stream_prefix_is_safe_including_partial_markdown_targets():
    for text in [MAP_LINK, 'baidumap://map/place/detail?uid=synthetic_poi', '[打开](https://example.com/path)']:
        for end in range(len(text) + 1):
            result = prepare_qq_text(text[:end], final=False)
            assert not re.search(r'(?:baidumap|unknownapp):/', result)
            assert not re.search(r'\]\([^)]*$', result)
    assert prepare_qq_text('[打开](unknownapp://map', final=True).startswith('打开')


@pytest.mark.parametrize('group', [False, True])
async def test_regular_messages_share_link_policy(monkeypatch, group):
    request = AsyncMock()
    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    send = outbound._post_group if group else outbound._post
    await send('synthetic-bot', 'synthetic-user', MAP_LINK, 'synthetic-message', 'markdown')
    assert request.call_args.kwargs['json_body']['markdown']['content'] == WEB_LINK


async def test_stream_frames_never_send_custom_links(monkeypatch):
    frames = []

    async def request(*args, json_body):
        frames.append(dict(json_body))
        return {'stream_msg_id': 'synthetic-stream'}

    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    stream = outbound.create_private_text_stream('synthetic-user', channel_id='synthetic-bot', message_id='synthetic-message')
    await stream.finish(MAP_LINK)
    assert frames[-1]['input_state'] == 10
    # QQ C2C 原生 Markdown 的 DONE 分片必须以换行收尾。
    assert frames[-1]['content_raw'] == WEB_LINK + "\n"
    assert all('baidumap:' not in frame['content_raw'] for frame in frames)


@pytest.mark.parametrize('close_fails', [False, True])
async def test_rejected_content_closes_exact_last_acknowledged_body_and_still_fails(monkeypatch, close_fails):
    frames = []

    async def request(*args, json_body):
        frames.append(dict(json_body))
        if '拒绝' in json_body['content_raw']:
            raise QQAPIError('POST', '/synthetic', 400, {'code': 40034028})
        if close_fails and json_body['input_state'] == 10:
            raise TimeoutError('合成关闭超时')
        return {'stream_msg_id': 'synthetic-stream'}

    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    stream = outbound.create_private_text_stream('synthetic-user', channel_id='synthetic-bot', message_id='synthetic-message')
    stream.push('已送达前缀\n')
    await stream._timer
    expected_error = QQStreamFinalizationError if close_fails else QQStreamDeliveryError
    with pytest.raises(expected_error):
        await stream.finish('已送达前缀\n拒绝的尾部')
    assert frames[-1]['input_state'] == 10
    assert frames[-1]['stream_msg_id'] == 'synthetic-stream'
    assert frames[-1]['content_raw'] == '已送达前缀\n'
    assert stream.last_sent_text == '已送达前缀\n'


def test_rejected_content_has_safe_platform_specific_error():
    from agent.errors import describe_llm_error
    presentation = describe_llm_error(QQStreamDeliveryError('合成错误'))
    assert presentation.code == 'qq_content_rejected'
    assert 'QQ 拒绝' in presentation.text


@pytest.mark.parametrize('group', [False, True])
async def test_mixed_button_protocols_keep_supported_native_buttons(monkeypatch, group):
    from agent.im.replies import send_link_button_message
    buttons = [
        {'id': 'poi', 'label': '示例店铺', 'url': 'baidumap://map/place/detail?uid=synthetic_poi'},
        {'id': 'unknown', 'label': '未知应用', 'url': 'demoapp://map/detail'},
    ]
    native = AsyncMock(return_value=True)
    fallback = AsyncMock()
    monkeypatch.setattr('agent.gateway.qq.send_link_keyboard', native)
    monkeypatch.setattr('agent.im.replies.send_text', fallback)
    result = await send_link_button_message({
        'platform': 'qq', 'chat_type': 'group' if group else 'c2c',
        'platform_user_id': 'synthetic-user', 'chat_id': 'synthetic-group',
    }, '按钮测试', buttons)
    sent = native.call_args.args
    assert len(sent[2]) == 1
    assert sent[2][0]['url'].startswith('https://api.map.baidu.com/')
    assert '未知应用' in sent[1] and 'QQ 不支持' in sent[1]
    assert 'demoapp:' not in sent[1]
    assert result['delivery'] == 'native'
    assert result['button_count'] == 1
    assert result['unsupported_button_ids'] == ['unknown']
    assert buttons[0]['url'].startswith('baidumap:')
    fallback.assert_not_called()


@pytest.mark.parametrize('native_ok,unsupported_only,expected_count', [
    (False, False, 1), (True, True, 0),
])
async def test_button_text_delivery_never_claims_native_success(monkeypatch, native_ok, unsupported_only, expected_count):
    from agent.im.replies import send_link_button_message
    native = AsyncMock(return_value=native_ok)
    fallback = AsyncMock(return_value=True)
    monkeypatch.setattr('agent.gateway.qq.send_link_keyboard', native)
    monkeypatch.setattr('agent.im.replies.send_text', fallback)
    url = 'demoapp://map/detail' if unsupported_only else 'https://example.com/'
    result = await send_link_button_message({
        'platform': 'qq', 'platform_user_id': 'synthetic-user',
    }, '入口', [{'id': 'entry', 'label': '入口', 'url': url}])
    assert native.await_count == expected_count
    assert fallback.await_count == 1
    assert result['delivery'] == 'text'
    assert result['button_count'] == 0


async def test_gateway_link_keyboard_adapts_poi_and_sanitizes_description(monkeypatch):
    request = AsyncMock(return_value={})
    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    sent = await outbound.send_link_keyboard('synthetic-user', MAP_LINK, [
        {'id': 'poi', 'label': '店铺', 'url': 'baidumap://map/place/detail?uid=synthetic_poi'},
    ], channel_id='synthetic-bot')
    assert sent
    body = request.call_args.kwargs['json_body']
    assert 'baidumap:' not in json.dumps(body)
    assert body['keyboard']['content']['rows'][0]['buttons'][0]['action']['data'].startswith('https://')


@pytest.mark.parametrize('delivery,unsupported,expected', [
    ('native', [], '✅ 链接按钮已发送'),
    ('native', ['unknown'], '⚠️ 已发送支持的链接按钮，其他入口已单独提示'),
    ('text', [], '⚠️ 链接按钮未发送，已改为文字'),
    ('none', [], '⚠️ 链接按钮发送失败'),
])
def test_qq_tool_notice_reports_actual_delivery(delivery, unsupported, expected):
    from agent.tool_messages import format_tool_event
    event = {'type': 'tool_done', 'name': 'send_link_buttons', 'status': 'success', 'result': {
        'platform': 'qq', 'delivery': delivery, 'unsupported_button_ids': unsupported,
    }}
    assert format_tool_event(event, markdown=False) == expected


@pytest.mark.parametrize('text', [
    '说明：\n- `baidumap://` 能转换，`demoapp://` 不支持\n结尾',
    '开头\n' + MAP_LINK + '\n' + '[未知](demoapp://map/detail)' + '\n末行',
    '首行\nbaidumap://map/place/detail?uid=synthetic_poi\n尾行',
    '开头\n[gugu](gugu://project/1)\n末行',
    '开头\n[未完成](demoapp://map\n下一行',
])
def test_stream_conversion_only_appends_and_final_tail_matches_regular_output(text):
    """安全不能只检查非法协议，还必须保证任意分片都不改写已发前缀。"""
    previous = ''
    for end in range(len(text) + 1):
        current = prepare_qq_text(text[:end], final=False)
        assert current.startswith(previous)
        previous = current
    assert prepare_qq_text(text).startswith(previous)


async def test_real_transport_accepts_every_character_split_without_prefix_rewrite(monkeypatch):
    frames = []

    async def request(*args, json_body):
        if frames:
            assert json_body['content_raw'].startswith(frames[-1]['content_raw'])
        frames.append(dict(json_body))
        return {'stream_msg_id': 'synthetic-stream'}

    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    stream = outbound.create_private_text_stream('synthetic-user', channel_id='synthetic-bot', message_id='synthetic-message')
    text = '开始\n- `baidumap://` 可转换\n' + MAP_LINK + '\n末行'
    for char in text:
        stream.push(char)
        await stream._flush()
    assert frames and '末行' not in frames[-1]['content_raw']
    await stream.finish(text)
    assert frames[-1]['input_state'] == 10
    # 完整原文后补平台要求的结束换行，但不能改写已确认前缀。
    assert frames[-1]['content_raw'] == prepare_qq_text(text) + "\n"


async def test_final_response_can_replace_streamed_draft_in_same_qq_message(monkeypatch):
    frames = []

    async def request(*args, json_body):
        frames.append(dict(json_body))
        return {'stream_msg_id': 'synthetic-stream'}

    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    stream = outbound.create_private_text_stream('synthetic-user', channel_id='synthetic-bot', message_id='synthetic-message')
    stream.push('已发送\n')
    await stream._flush()
    await stream.finish('最终回答\n', allow_rewrite=True)

    assert [frame['input_state'] for frame in frames] == [1, 1, 10]
    assert [frame['content_raw'] for frame in frames] == ['已发送\n', '最终回答\n', '最终回答\n']
    assert {frame['stream_msg_id'] for frame in frames[1:]} == {'synthetic-stream'}


async def test_noncanonical_stream_finish_still_rejects_prefix_edit(monkeypatch):
    request = AsyncMock(return_value={'stream_msg_id': 'synthetic-stream'})
    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    stream = outbound.create_private_text_stream('synthetic-user', channel_id='synthetic-bot', message_id='synthetic-message')
    stream.push('已发送\n')
    await stream._flush()

    with pytest.raises(QQStreamFinalizationError):
        await stream.finish('非权威改写\n')
    assert request.await_count == 1


async def test_segment_closure_keeps_acknowledged_newline(monkeypatch):
    frames = []

    async def request(*args, json_body):
        if frames:
            assert json_body['content_raw'].startswith(frames[-1]['content_raw'])
        frames.append(dict(json_body))
        return {'stream_msg_id': 'synthetic-stream'}

    monkeypatch.setattr(outbound, '_qq_request', request)
    monkeypatch.setattr(outbound, '_next_seq', AsyncMock(return_value=1))
    stream = outbound.create_private_text_stream('synthetic-user', channel_id='synthetic-bot', message_id='synthetic-message')
    stream.push('图表前说明\n')
    await stream._flush()
    await stream.finish('图表前说明')
    assert frames[-1]['input_state'] == 10
    assert frames[-1]['content_raw'] == '图表前说明\n'
