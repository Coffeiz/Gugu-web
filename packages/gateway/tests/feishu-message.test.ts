import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFeishuCardText, parseFeishuEvent, parseFeishuQuoteFacts } from '../src/platforms/feishu/message.ts'
import type { ParsedFeishuMessage } from '../src/platforms/feishu/message.ts'

const nowMs = 1800000000000
const options = { botId: '7', ownerId: 'owner-synthetic', appId: 'cli_expected', botOpenId: 'ou_bot', nowMs }
function event(type = 'text', body: unknown = { text: '合成正文' }) {
  return { header: { app_id: options.appId, event_type: 'im.message.receive_v1', create_time: String(nowMs), event_id: 'event-synthetic' },
    event: { message: { message_id: 'om_synthetic', message_type: type, content: JSON.stringify(body), chat_id: 'oc_group', chat_type: 'p2p', parent_id: '', create_time: String(nowMs), mentions: [] as unknown[] },
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' } } }
}
function message(value: unknown): ParsedFeishuMessage {
  const parsed = parseFeishuEvent(value, options)
  assert.equal(parsed?.kind, 'message')
  return parsed as ParsedFeishuMessage
}

test('app_id错投和超过20秒retry丢弃，边界20秒保留且时钟只能由Host提供', () => {
  const other = event(); other.header.app_id = 'cli_other'
  assert.equal(parseFeishuEvent(other, options), null)
  const stale = event(); stale.header.create_time = String(nowMs - 20001)
  assert.equal(parseFeishuEvent(stale, options), null)
  stale.header.create_time = String(nowMs - 20000)
  assert.equal(parseFeishuEvent(stale, options)?.kind, 'message')
  stale.header.create_time = 'invalid-time'
  assert.equal(parseFeishuEvent(stale, options)?.kind, 'message')
  assert.throws(() => parseFeishuEvent(event(), { ...options, nowMs: NaN }))
})

test('可信Bot归属不从事件覆盖，p2p归一c2c，群chatid与发言人身份分离', () => {
  const raw = event(); Object.assign(raw.event, { owner_user_id: 'untrusted', bot_id: 'untrusted' })
  const result = message(raw)
  assert.equal(result.payload.owner_user_id, options.ownerId)
  assert.equal(result.payload.channel_id, options.botId)
  assert.equal(result.payload.chat_type, 'c2c')
  assert.equal(result.preflight.chat_id, null)
  raw.event.message.chat_type = 'group'
  const group = message(raw)
  assert.equal(group.payload.chat_type, 'group')
  assert.equal(group.payload.chat_id, 'oc_group')
  assert.equal(group.payload.platform_user_id, 'ou_sender')
})

test('只有结构化mention确认当前Bot，展示名替换不改变注意力原文或可信身份', () => {
  const raw = event('text', { text: '@_user_1 /help 给 @_user_2' })
  raw.event.message.mentions = [{ key: '@_user_1', name: '＠咕咕', id: { open_id: 'ou_bot' } }, { key: '@_user_2', name: '@小北', id: { open_id: 'ou_member' } }]
  const result = message(raw)
  assert.equal(result.payload.text, '@咕咕 /help 给 @小北')
  assert.equal(result.payload.attention_raw_text, '@_user_1 /help 给 @_user_2')
  assert.equal(result.payload.bot_mentioned, true)
  assert.equal(result.payload.native_bot_mentioned, true)
  assert.equal(result.payload.mentions_other_member, true)
  assert.equal(result.preflight.text, '@_user_1 /help 给 @_user_2')
  assert.equal(message(event('text', { text: '@咕咕 /help' })).payload.bot_mentioned, false)
})

test('无法解析或未知Bot身份的mention保持三态，不擅自把@其他成员当邀请', () => {
  const raw = event(); raw.event.message.mentions = [{}]
  const unresolved = message(raw)
  assert.equal(unresolved.payload.has_unresolved_mention, true)
  assert.equal(unresolved.payload.native_bot_mentioned, null)
  raw.event.message.mentions = [{ id: { open_id: 'ou_other_bot' }, is_bot: true }]
  const other = message(raw)
  assert.equal(other.payload.bot_mentioned, false)
  assert.equal(other.payload.mentions_other_bot, true)
  const unknown = parseFeishuEvent(raw, { ...options, botOpenId: null }) as ParsedFeishuMessage
  assert.equal(unknown.payload.native_bot_mentioned, null)
  assert.equal(unknown.payload.has_unresolved_mention, true)
})

test('post按原行顺序解析文字链接和at，图片与视频只返回下载需求', () => {
  const result = message(event('post', { title: ' 标题 ', content: [[{ tag: 'text', text: '正文' }, { tag: 'a', href: 'https://example.invalid' }, { tag: 'at', user_name: '小北' }, { tag: 'img', image_key: 'img_synthetic' }], [{ tag: 'media', file_key: 'file_video' }]] }))
  assert.equal(result.payload.text, '标题\n正文https://example.invalid@小北')
  assert.deepEqual(result.mediaItems, [
    { messageId: 'om_synthetic', resourceKey: 'img_synthetic', resourceType: 'image', fileName: '图片.jpg', source: 'post', isVoice: false },
    { messageId: 'om_synthetic', resourceKey: 'file_video', resourceType: 'file', fileName: '视频.mp4', source: 'post', isVoice: false },
  ])
  assert.deepEqual(result.payload.attachments, [])
  assert.deepEqual(result.preflight.attachments, [{ pending_media: true }])
  assert.equal(result.preflight.text, '')
})

test('图片文件语音视频保留Python资源类型和文件名，不假造已处理媒体', () => {
  for (const [type, key, resourceType, fileName, voice] of [['image', 'image_key', 'image', '图片.jpg', false], ['file', 'file_key', 'file', '合成.txt', false], ['audio', 'file_key', 'file', '语音.opus', true], ['media', 'file_key', 'file', '视频.mp4', false]] as const) {
    const result = message(event(type, { [key]: 'resource-synthetic', file_name: '合成.txt' }))
    assert.deepEqual(result.mediaItems, [{ messageId: 'om_synthetic', resourceKey: 'resource-synthetic', resourceType, fileName, source: 'message', isVoice: voice }])
    assert.equal(result.payload.processable_media, false)
    assert.deepEqual(result.payload.attachments, [])
  }
})

test('转发interactive卡片只取可读文字，CardKit结构兼容而卡片内图片不下载', () => {
  const body = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '第一段' }, [{ tag: 'text', text: '第二段' }], { tag: 'img', img_key: 'not-downloaded' }] } }
  assert.equal(extractFeishuCardText(body), '第一段\n第二段')
  const result = message(event('interactive', body))
  assert.equal(result.payload.text, '第一段\n第二段')
  assert.deepEqual(result.mediaItems, [])
  const invalid = event('interactive'); invalid.event.message.content = '{'
  assert.equal(message(invalid).payload.text, '[卡片消息，解析失败]')
})

test('parent引用与用户正文分离，只返回真实远程查询需求而不伪造引用事实', () => {
  const raw = event(); raw.event.message.parent_id = 'om_parent'
  const result = message(raw)
  assert.equal(result.payload.text, '合成正文')
  assert.equal(result.payload.quoted_text, null)
  assert.equal(result.payload.reply_target_sender_id, null)
  assert.deepEqual(result.quoteRequest, { messageId: 'om_parent', cardContentType: 'user_card_content' })
  const quote = parseFeishuQuoteFacts({ msg_type: 'interactive', create_time: nowMs, body: { content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '真实查询的引用正文' }] } }) }, sender: { sender_id: { open_id: 'ou_bot' } } }, options.botOpenId)
  assert.deepEqual(quote, { text: '真实查询的引用正文', sender_id: 'ou_bot', sender_is_bot: true, platform_sent_ms: nowMs })
})

test('卡片点击仅产生交互动作，动作token不混入Agent普通文字或媒体', () => {
  const raw = { header: { app_id: options.appId, event_type: 'card.action.trigger', event_id: 'evt-action' }, event: { operator: { open_id: 'ou_operator' }, action: { value: { prompt_id: '9', token: 'synthetic-one-time-token', option_id: ' cancel ', label: ' 取消 ' } } } }
  assert.deepEqual(parseFeishuEvent(raw, options), { kind: 'card_action', ownerId: options.ownerId, botId: options.botId, eventId: 'evt-action', operatorId: 'ou_operator', promptId: 9, actionToken: 'synthetic-one-time-token', optionId: 'cancel', label: '取消' })
  assert.equal('payload' in parseFeishuEvent(raw, options)!, false)
  raw.header.app_id = 'cli_other'; assert.equal(parseFeishuEvent(raw, options), null)
})

test('旧不支持类型、空文本与缺稳定身份直接丢弃，损坏对象不暴露正文', () => {
  assert.equal(parseFeishuEvent(event('location', { text: '不支持' }), options), null)
  assert.equal(parseFeishuEvent(event('text', { text: '' }), options), null)
  const missing = event(); missing.event.sender.sender_id.open_id = ''
  assert.equal(parseFeishuEvent(missing, options), null)
  assert.throws(() => parseFeishuEvent(event('text', { text: { private: 'synthetic-secret' } }), options), error => error instanceof TypeError && !error.message.includes('secret'))
  assert.equal(parseFeishuQuoteFacts({ msg_type: 'file' }, null).text, '[文件消息]')
})
