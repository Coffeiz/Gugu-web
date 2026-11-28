import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeTelegramCommand, normalizeTelegramMessage, telegramEntityText } from '../src/platforms/telegram/message.ts'

const options = { botId: '41', ownerId: 'owner-1', botUsername: 'gugu_bot', botPlatformId: '9001' }
type Message = Record<string, unknown>
const message = (text = '你好', extra: Message = {}): Message => ({
  message_id: 31, date: 1_791_000_000, chat: { id: 7001, type: 'private' },
  from: { id: 7001, first_name: '小北', username: 'sample_user' }, text, entities: [], ...extra,
})
const parse = (value: Message, selected = options) => normalizeTelegramMessage({ update_id: 91, message: value }, selected)

describe('Telegram 入站解析保留 Python 消息契约', () => {
  it('私聊身份、原始文本和时间原样投影，不推断所有者权限', () => {
    assert.partialDeepStrictEqual(parse(message()), {
      platform: 'telegram', channel_id: '41', bot_id: '41', owner_user_id: 'owner-1', chat_type: 'c2c',
      chat_id: '7001', platform_user_id: '7001', platform_user_name: '小北', text: '你好', attention_raw_text: '你好',
      message_id: '31', platform_message_id: '31', platform_event_id: '91', received_at: 1_791_000_000, platform_sent_ms: 1_791_000_000_000,
      telegram_command: null, sender_is_bot: false, group_mentioned: false, attachments: [], quoted_attachments: [],
    })
    assert.equal(parse(message('合成消息', { from: { id: 8001, username: 'moon_小北' } }))?.platform_user_name, '@moon_小北')
    assert.equal(parse(message('合成消息', { date: true }))?.platform_sent_ms, null)
  })

  it('UTF16 命令偏移和其他 Bot 定向保持边界', () => {
    assert.deepEqual(normalizeTelegramCommand('😀 /bind 123456', [{ type: 'bot_command', offset: 3, length: 5 }], 'gugu_bot'), ['bind', '123456'])
    assert.deepEqual(normalizeTelegramCommand('/start@GUGU_BOT', [{ type: 'bot_command', offset: 0, length: 15 }], 'gugu_bot'), ['start', ''])
    assert.equal(normalizeTelegramCommand('/start@other_bot', [{ type: 'bot_command', offset: 0, length: 16 }], 'gugu_bot'), null)
    assert.equal(telegramEntityText('😀 /bind', { offset: 1, length: 2 }), ' ')
    assert.equal(telegramEntityText('abc', { offset: 'bad', length: 2 }), '')
    assert.equal(normalizeTelegramCommand('/help@other_bot', [], 'gugu_bot'), null)
    assert.deepEqual(normalizeTelegramCommand('/HELP@gugu_bot 合成参数', [], '@gugu_bot'), ['help', '合成参数'])
    assert.equal(parse(message(' /help')), null)
  })

  it('机器人、匿名、频道与空事件拒绝，媒体单独发送仍保留', () => {
    for (const extra of [{ from: null, sender_chat: { id: -1007999 } }, { from: { id: 9001, is_bot: true } }, { from: {} }, { chat: { id: 42, type: 'channel' } }]) {
      assert.equal(parse(message('合成消息', extra)), null)
    }
    assert.equal(parse(message('')), null)
    assert.equal(normalizeTelegramMessage({ callback_query: {} }, options), null)
    assert.equal(parse(message('', { photo: [{ file_id: 'synthetic-photo' }] }))?.attachments[0]?.file_id, 'synthetic-photo')
  })

  it('回复当前 Bot 触发群消息但不伪造原生 mention', () => {
    const result = parse(message('继续', {
      chat: { id: -1007002, type: 'supergroup' },
      reply_to_message: { message_id: 30, from: { id: 9001, is_bot: true }, text: '上一条' },
    }))
    assert.partialDeepStrictEqual(result, { chat_type: 'group', bot_mentioned: true, group_mentioned: true, native_bot_mentioned: false,
      reply_to_message_id: '30', reply_to_platform_message_id: '30', reply_target_sender_id: '9001', reply_target_is_bot: true, quoted_text: '上一条' })
    assert.equal(parse(message('继续', { reply_to_message: { message_id: 30, from: { id: 9002, is_bot: true } } }))?.bot_mentioned, false)
  })

  it('原生 mention 使用实体完整偏移，展示只改当前 Bot 名称', () => {
    const input = message('嗨 @gugu_bot 和 @other_bot 与 @gugu_botExtra', { entities: [{ type: 'mention', offset: 2, length: 9 }] })
    assert.partialDeepStrictEqual(parse(input), { text: '嗨 @咕咕 和 @other_bot 与 @gugu_botExtra', bot_mentioned: true, attention_raw_text: input.text })
    assert.equal(parse({ ...input, entities: [{ type: 'mention', offset: 2, length: 8 }] })?.bot_mentioned, false)
    assert.equal(parse(message('当前 Bot', { entities: [{ type: 'text_mention', offset: 0, length: 2, user: { id: 9001 } }] }))?.bot_mentioned, true)
  })

  for (const text of ['/start', '/help@gugu_bot']) {
    it(`隐私模式命令 ${text} 触发群消息，缺实体仍规范化命令`, () => {
      assert.partialDeepStrictEqual(parse(message(text, { chat: { id: -1007002, type: 'group' } })), { group_mentioned: true, native_bot_mentioned: true })
      assert.equal(parse(message(text, { entities: [{ type: 'bot_command', offset: 0, length: text.length }] }))?.bot_mentioned, true)
      assert.equal(parse(message('/help@other_bot')), null)
    })
  }

  it('图片选最大版本，caption 与引用附件保留 bot/chat 作用域', () => {
    const result = parse(message('', {
      message_id: 55, chat: { id: -1007002, type: 'group' }, caption: '请看看这张图', caption_entities: [],
      photo: [{ file_id: 'small-photo', file_size: 100 }, { file_id: 'large-photo', file_size: 900 }],
      reply_to_message: { message_id: 54, from: { id: 7002 }, document: { file_id: 'quoted-doc', file_size: 25, file_name: 'notes.txt', mime_type: 'text/plain' } },
    }))
    assert.deepEqual(result?.attachments, [{ file_id: 'large-photo', file_size: 900, file_name: '图片.jpg', mime_type: 'image/jpeg', media_type: 'photo', source_attachment_index: 0 }])
    assert.partialDeepStrictEqual(result, { text: '请看看这张图', attachment_source_message_id: '41:-1007002:55', quoted_text: '[document 附件]' })
    assert.partialDeepStrictEqual(result?.quoted_attachments[0], { source_platform_message_id: '41:-1007002:54', source_attachment_index: 0 })
    const changed = parse(message('', { photo: [{ file_id: 'p' }] }), { ...options, botId: '42' })
    assert.equal(changed?.attachment_source_message_id, '42:7001:31')
  })

  for (const field of ['document', 'audio', 'voice', 'video', 'animation', 'video_note']) {
    it(`保留 ${field} 附件元数据与默认值`, () => {
      assert.partialDeepStrictEqual(parse(message('', { [field]: { file_id: `synthetic-${field}`, file_size: 10, file_name: '合成附件.ogg', mime_type: 'application/octet-stream' } }))?.attachments[0], { media_type: field, file_id: `synthetic-${field}`, file_name: '合成附件.ogg', file_size: 10, mime_type: 'application/octet-stream' })
      assert.equal(parse(message('', { [field]: { file_id: `synthetic-${field}` } }))?.attachments[0]?.file_size, null)
    })
  }

  it('mention 事实区分明确当前 Bot、其他 Bot、其他成员和未知', () => {
    assert.partialDeepStrictEqual(parse(message('明确成员', { entities: [{ type: 'text_mention', user: { id: 7002, is_bot: false } }] })), { native_bot_mentioned: false, mentions_other_member: true, mentions_other_bot: false, has_unresolved_mention: false })
    assert.partialDeepStrictEqual(parse(message('其他机器人', { entities: [{ type: 'text_mention', user: { id: 9002, is_bot: true } }] })), { native_bot_mentioned: false, mentions_other_member: true, mentions_other_bot: true, has_unresolved_mention: false })
    assert.partialDeepStrictEqual(parse(message('@someone', { entities: [{ type: 'mention', offset: 0, length: 8 }] })), { native_bot_mentioned: null, mentions_other_member: null, mentions_other_bot: null, has_unresolved_mention: true })
    assert.partialDeepStrictEqual(parse(message('@someone', { entities: undefined })), { native_bot_mentioned: null, mentions_other_member: null, mentions_other_bot: null, has_unresolved_mention: true })
    assert.partialDeepStrictEqual(parse(message('普通消息', { entities: undefined })), { native_bot_mentioned: false, mentions_other_member: null, mentions_other_bot: null, has_unresolved_mention: false })
    assert.partialDeepStrictEqual(parse(message('普通消息', { entities: [] })), { native_bot_mentioned: false, mentions_other_member: false, mentions_other_bot: false, has_unresolved_mention: false })
  })

  it('畸形 mention 保持未知，已识别事实不被未知实体抹掉', () => {
    // 保留已识别的 mention 事实。
    assert.partialDeepStrictEqual(parse(message('合成消息', { entities: [null, { type: 'text_mention', user: { id: 9001 } }, { type: 'text_mention', user: { id: 7002 } }] })), { native_bot_mentioned: true, mentions_other_member: true, mentions_other_bot: false, has_unresolved_mention: true })
    assert.equal(parse(message('合成消息', { entities: [{ type: 'text_mention' }] }))?.has_unresolved_mention, true)
  })

  it('caption实体与原生命令事实保留Python空实体列表优先语义', () => {
    // native mention 使用 entities or caption_entities；attention 则保留显式空 entities。
    assert.partialDeepStrictEqual(parse(message('', { caption: '@gugu_bot', document: { file_id: 'doc' }, caption_entities: [{ type: 'mention', offset: 0, length: 9 }] })), { native_bot_mentioned: true, bot_mentioned: true, mentions_other_bot: false })
    // Python 仅在整条文本以斜杠开头时拒绝定向命令，正文引用仍保留。
    assert.partialDeepStrictEqual(parse(message('嗨 /help@other_bot', { entities: [{ type: 'bot_command', offset: 2, length: 15 }] })), { text: '嗨 /help@other_bot', bot_mentioned: false, mentions_other_bot: true, telegram_command: null })
  })

  it('解析层兼容编辑消息但不修改输入；超长引用按Unicode字符截断', () => {
    const edited = message('编辑后的消息', { reply_to_message: { message_id: 2, text: '😀'.repeat(2001) } })
    const before = structuredClone(edited)
    const result = normalizeTelegramMessage({ update_id: 92, edited_message: edited }, options)
    assert.equal(result?.text, '编辑后的消息')
    assert.equal(([...(result?.quoted_text ?? '')]).length, 2000)
    assert.deepEqual(edited, before)
  })
})
