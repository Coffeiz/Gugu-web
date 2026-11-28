import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractWechatQuote, parseWechatMessage, wechatPlatformSentMs } from '../src/platforms/wechat/message.ts'

const options = { botId: '7', ownerId: 'owner-synthetic' }
const base = { message_type: 1, from_user_id: 'sender-synthetic', context_token: 'synthetic-context', group_id: '',
  item_list: [{ type: 1, text_item: { text: ' 合成正文 ' } }] }

test('仅接用户事件并使用可信Bot归属，空消息与缺失发言身份不启动Agent', () => {
  for (const message of [null, { ...base, message_type: 2 }, { ...base, message_type: '1' }, { ...base, from_user_id: '' }, { ...base, item_list: [] }])
    assert.equal(parseWechatMessage(message, options), null)
  const result = parseWechatMessage({ ...base, owner_user_id: 'untrusted', channel_id: 'untrusted' }, options)
  assert.ok(result)
  assert.equal(result.payload.owner_user_id, options.ownerId)
  assert.equal(result.payload.channel_id, options.botId)
  assert.equal(result.payload.text, '合成正文')
  assert.equal(result.payload.message_id, base.context_token)
  assert.equal(result.payload.context_token, base.context_token)
  assert.deepEqual(result.payload.attachments, [])
  assert.equal(result.payload.chat_type, 'c2c')
  assert.equal(result.payload.chat_id, undefined)
  assert.equal(result.payload.typing_ticket, undefined)
})

test('群作用域与私聊隔离，不从消息声称的owner或channel推断归属', () => {
  const result = parseWechatMessage({ ...base, group_id: 'group-synthetic' }, options)
  assert.ok(result)
  assert.equal(result.payload.chat_type, 'group')
  assert.equal(result.payload.chat_id, 'group-synthetic')
  assert.equal(result.payload.wechat_group_id, 'group-synthetic')
  assert.equal(result.payload.platform_user_id, base.from_user_id)
})

test('平台ASR直接作为对话正文，不请求语音下载；空转写给旧版提示', () => {
  const result = parseWechatMessage({ ...base, item_list: [{ type: 1, text_item: { text: '前文' } }, { type: 3, voice_item: { text: ' 合成转写 ' } }, { type: 3, voice_item: {} }] }, options)
  assert.ok(result)
  assert.equal(result.payload.text, '前文\n\n🎤 用户发来一条语音（已转文字）：「合成转写」。请直接听懂这段话并自然回应——这是对话内容，不是文件，别问「要不要保存」这类话。\n\n🎤 用户发来一条语音，但转写失败/没听清，麻烦让用户用文字重新说一下。')
  assert.deepEqual(result.mediaItems, [])
})

test('引用文本优先于类型与摘要，语音保留转写或占位，未知引用不虚构原文', () => {
  const rows = [
    [null, null], [{ title: ' 摘要 ' }, '摘要'], [{ message_item: { type: 1, text_item: { text: ' 原文 ' } }, title: '摘要' }, '原文'],
    [{ message_item: { type: 3, voice_item: { text: ' 转写 ' } } }, '转写'], [{ message_item: { type: 3 } }, '[语音消息]'],
    [{ message_item: { type: 4 } }, '[文件消息]'], [{ message_item: { type: 5 } }, '[视频消息]'],
    [{ title: ' 摘要 ', message_item: { type: 0, msg_id: 'synthetic-id' } }, '摘要'],
    [{ message_item: { type: 0, msg_id: 'synthetic-id' } }, '[微信暂不支持消息引用识别]'],
  ]
  for (const [raw, expected] of rows) {
    const quote = extractWechatQuote(raw)
    assert.equal(quote.quotedText, expected)
    assert.deepEqual(quote.mediaItems, [])
  }
})

test('引用图片与当前图片保留有序媒体需求，不伪造已下载附件', () => {
  const image = { type: 2, image_item: { aeskey: '00112233445566778899aabbccddeeff', media: { encrypt_query_param: 'synthetic-download' } } }
  assert.deepEqual(extractWechatQuote({ message_item: image }), { quotedText: '[图片消息]', mediaItems: [image] })
  const result = parseWechatMessage({ ...base, item_list: [{ ...base.item_list[0], ref_msg: { message_item: image } }, image] }, options)
  assert.ok(result)
  assert.equal(result.hasQuote, true)
  assert.equal(result.payload.quoted_text, '[图片消息]')
  assert.deepEqual(result.mediaItems.map(item => [item.source, item.kind]), [['message', 'image'], ['quote', 'image']])
  assert.deepEqual(result.payload.attachments, [])
  image.image_item.media.encrypt_query_param = 'changed-after-parse'
  assert.equal(result.mediaItems[0].item.image_item.media.encrypt_query_param, 'synthetic-download')
})

test('文件与视频不扩大为可下载能力，仅保留unsupported需求供Host预检和最终判空', () => {
  const result = parseWechatMessage({ ...base, item_list: [{ type: 4, file_item: { file_name: '合成文件.txt' } }, { type: 5, video_item: { media: {} } }] }, options)
  assert.ok(result)
  assert.equal(result.payload.text, '')
  assert.deepEqual(result.mediaItems.map(item => item.kind), ['unsupported', 'unsupported'])
  assert.deepEqual(result.payload.attachments, [])
})

test('只取首个有效引用，空正文不能仅凭引用触发新消息', () => {
  const result = parseWechatMessage({ ...base, item_list: [{ type: 1, text_item: { text: 'a' }, ref_msg: {} }, { type: 1, text_item: { text: 'b' }, ref_msg: { title: '第一条引用' } }, { type: 1, ref_msg: { title: '第二条引用' } }] }, options)
  assert.ok(result)
  assert.equal(result.payload.text, 'ab')
  assert.equal(result.payload.quoted_text, '第一条引用')
  assert.equal(parseWechatMessage({ ...base, item_list: [{ type: 1, text_item: {}, ref_msg: { title: '只有引用' } }] }, options), null)
})

test('时间戳保留Python整数转换，拒绝布尔无效和不精确排序值', () => {
  for (const raw of [1760000123456, '1760000123456', '+1_760_000_123_456', '１７６００００１２３４５６', 1760000123456.7])
    assert.equal(wechatPlatformSentMs({ create_time_ms: raw }), 1760000123456)
  for (const raw of [undefined, true, false, null, '', 'abc', '1.5', 0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(wechatPlatformSentMs({ create_time_ms: raw }), null)
})

test('异常协议形状以固定错误拒绝，不把对象或秘密强转进正文', () => {
  for (const item_list of ['invalid', [null], [{ type: 1, text_item: { text: { secret: 'synthetic' } } }]])
    assert.throws(() => parseWechatMessage({ ...base, item_list }, options), error => error instanceof TypeError && !error.message.includes('synthetic'))
  assert.throws(() => parseWechatMessage(base, { botId: '', ownerId: options.ownerId }))
})
