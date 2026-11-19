import { describe, expect, it } from 'vitest'
import { normalizeTelegramCommand, normalizeTelegramMessage, telegramEntityText } from '../../src/im/telegram-message.js'

const options = { botId: '41', ownerId: 'owner-1', botUsername: 'gugu_bot', botPlatformId: '9001' }
type Message = Record<string, unknown>
const message = (text = '你好', extra: Message = {}): Message => ({
  message_id: 31, date: 1_791_000_000, chat: { id: 7001, type: 'private' },
  from: { id: 7001, first_name: '小北', username: 'sample_user' }, text, entities: [], ...extra,
})
const parse = (value: Message, selected = options) => normalizeTelegramMessage({ update_id: 91, message: value }, selected)

describe('Telegram 入站解析保留 Python 消息契约', () => {
  it('私聊身份、原始文本和时间原样投影，不推断所有者权限', () => {
    expect(parse(message())).toMatchObject({
      platform: 'telegram', channel_id: '41', bot_id: '41', owner_user_id: 'owner-1', chat_type: 'c2c',
      chat_id: '7001', platform_user_id: '7001', platform_user_name: '小北', text: '你好', attention_raw_text: '你好',
      message_id: '31', platform_message_id: '31', platform_event_id: '91', received_at: 1_791_000_000, platform_sent_ms: 1_791_000_000_000,
      telegram_command: null, sender_is_bot: false, group_mentioned: false, attachments: [], quoted_attachments: [],
    })
    expect(parse(message('合成消息', { from: { id: 8001, username: 'moon_小北' } }))?.platform_user_name).toBe('@moon_小北')
    expect(parse(message('合成消息', { date: true }))?.platform_sent_ms).toBeNull()
  })

  it('UTF16 命令偏移和其他 Bot 定向保持边界', () => {
    expect(normalizeTelegramCommand('😀 /bind 123456', [{ type: 'bot_command', offset: 3, length: 5 }], 'gugu_bot')).toEqual(['bind', '123456'])
    expect(normalizeTelegramCommand('/start@GUGU_BOT', [{ type: 'bot_command', offset: 0, length: 15 }], 'gugu_bot')).toEqual(['start', ''])
    expect(normalizeTelegramCommand('/start@other_bot', [{ type: 'bot_command', offset: 0, length: 16 }], 'gugu_bot')).toBeNull()
    expect(telegramEntityText('😀 /bind', { offset: 1, length: 2 })).toBe(' ')
    expect(telegramEntityText('abc', { offset: 'bad', length: 2 })).toBe('')
    expect(normalizeTelegramCommand('/help@other_bot', [], 'gugu_bot')).toBeNull()
    expect(normalizeTelegramCommand('/HELP@gugu_bot 合成参数', [], '@gugu_bot')).toEqual(['help', '合成参数'])
    expect(parse(message(' /help'))).toBeNull()
  })

  it('机器人、匿名、频道与空事件拒绝，媒体单独发送仍保留', () => {
    for (const extra of [{ from: null, sender_chat: { id: -1007999 } }, { from: { id: 9001, is_bot: true } }, { from: {} }, { chat: { id: 42, type: 'channel' } }]) {
      expect(parse(message('合成消息', extra))).toBeNull()
    }
    expect(parse(message(''))).toBeNull()
    expect(normalizeTelegramMessage({ callback_query: {} }, options)).toBeNull()
    expect(parse(message('', { photo: [{ file_id: 'synthetic-photo' }] }))?.attachments[0]?.file_id).toBe('synthetic-photo')
  })

  it('回复当前 Bot 触发群消息但不伪造原生 mention', () => {
    const result = parse(message('继续', {
      chat: { id: -1007002, type: 'supergroup' },
      reply_to_message: { message_id: 30, from: { id: 9001, is_bot: true }, text: '上一条' },
    }))
    expect(result).toMatchObject({ chat_type: 'group', bot_mentioned: true, group_mentioned: true, native_bot_mentioned: false,
      reply_to_message_id: '30', reply_to_platform_message_id: '30', reply_target_sender_id: '9001', reply_target_is_bot: true, quoted_text: '上一条' })
    expect(parse(message('继续', { reply_to_message: { message_id: 30, from: { id: 9002, is_bot: true } } }))?.bot_mentioned).toBe(false)
  })

  it('原生 mention 使用实体完整偏移，展示只改当前 Bot 名称', () => {
    const input = message('嗨 @gugu_bot 和 @other_bot 与 @gugu_botExtra', { entities: [{ type: 'mention', offset: 2, length: 9 }] })
    expect(parse(input)).toMatchObject({ text: '嗨 @咕咕 和 @other_bot 与 @gugu_botExtra', bot_mentioned: true, attention_raw_text: input.text })
    expect(parse({ ...input, entities: [{ type: 'mention', offset: 2, length: 8 }] })?.bot_mentioned).toBe(false)
    expect(parse(message('当前 Bot', { entities: [{ type: 'text_mention', offset: 0, length: 2, user: { id: 9001 } }] }))?.bot_mentioned).toBe(true)
  })

  it.each(['/start', '/help@gugu_bot'])('隐私模式命令 %s 触发群消息，缺实体仍规范化命令', text => {
    expect(parse(message(text, { chat: { id: -1007002, type: 'group' } }))).toMatchObject({ group_mentioned: true, native_bot_mentioned: true })
    expect(parse(message(text, { entities: [{ type: 'bot_command', offset: 0, length: text.length }] }))?.bot_mentioned).toBe(true)
    expect(parse(message('/help@other_bot'))).toBeNull()
  })

  it('图片选最大版本，caption 与引用附件保留 bot/chat 作用域', () => {
    const result = parse(message('', {
      message_id: 55, chat: { id: -1007002, type: 'group' }, caption: '请看看这张图', caption_entities: [],
      photo: [{ file_id: 'small-photo', file_size: 100 }, { file_id: 'large-photo', file_size: 900 }],
      reply_to_message: { message_id: 54, from: { id: 7002 }, document: { file_id: 'quoted-doc', file_size: 25, file_name: 'notes.txt', mime_type: 'text/plain' } },
    }))
    expect(result?.attachments).toEqual([{ file_id: 'large-photo', file_size: 900, file_name: '图片.jpg', mime_type: 'image/jpeg', media_type: 'photo', source_attachment_index: 0 }])
    expect(result).toMatchObject({ text: '请看看这张图', attachment_source_message_id: '41:-1007002:55', quoted_text: '[document 附件]' })
    expect(result?.quoted_attachments[0]).toMatchObject({ source_platform_message_id: '41:-1007002:54', source_attachment_index: 0 })
    const changed = parse(message('', { photo: [{ file_id: 'p' }] }), { ...options, botId: '42' })
    expect(changed?.attachment_source_message_id).toBe('42:7001:31')
  })

  it.each(['document', 'audio', 'voice', 'video', 'animation', 'video_note'])('保留 %s 附件元数据与默认值', field => {
    expect(parse(message('', { [field]: { file_id: `synthetic-${field}`, file_size: 10, file_name: '合成附件.ogg', mime_type: 'application/octet-stream' } }))?.attachments[0])
      .toMatchObject({ media_type: field, file_id: `synthetic-${field}`, file_name: '合成附件.ogg', file_size: 10, mime_type: 'application/octet-stream' })
    expect(parse(message('', { [field]: { file_id: `synthetic-${field}` } }))?.attachments[0]?.file_size).toBeNull()
  })

  it('mention 事实区分明确当前 Bot、其他 Bot、其他成员和未知', () => {
    expect(parse(message('明确成员', { entities: [{ type: 'text_mention', user: { id: 7002, is_bot: false } }] }))).toMatchObject({ native_bot_mentioned: false, mentions_other_member: true, mentions_other_bot: false, has_unresolved_mention: false })
    expect(parse(message('其他机器人', { entities: [{ type: 'text_mention', user: { id: 9002, is_bot: true } }] }))).toMatchObject({ native_bot_mentioned: false, mentions_other_member: true, mentions_other_bot: true, has_unresolved_mention: false })
    expect(parse(message('@someone', { entities: [{ type: 'mention', offset: 0, length: 8 }] }))).toMatchObject({ native_bot_mentioned: null, mentions_other_member: null, mentions_other_bot: null, has_unresolved_mention: true })
    expect(parse(message('@someone', { entities: undefined }))).toMatchObject({ native_bot_mentioned: null, mentions_other_member: null, mentions_other_bot: null, has_unresolved_mention: true })
    expect(parse(message('普通消息', { entities: undefined }))).toMatchObject({ native_bot_mentioned: false, mentions_other_member: null, mentions_other_bot: null, has_unresolved_mention: false })
    expect(parse(message('普通消息', { entities: [] }))).toMatchObject({ native_bot_mentioned: false, mentions_other_member: false, mentions_other_bot: false, has_unresolved_mention: false })
  })

  it('畸形 mention 保持未知，已识别事实不被未知实体抹掉', () => {
    expect(parse(message('合成消息', { entities: [null, { type: 'text_mention', user: { id: 9001 } }, { type: 'text_mention', user: { id: 7002 } }] })))
      // Python 以 other_mention_facts 中已识别的否定事实补齐 attention 的未知。
      .toMatchObject({ native_bot_mentioned: true, mentions_other_member: true, mentions_other_bot: false, has_unresolved_mention: true })
    expect(parse(message('合成消息', { entities: [{ type: 'text_mention' }] }))?.has_unresolved_mention).toBe(true)
  })

  it('caption实体与原生命令事实保留Python空实体列表优先语义', () => {
    // native mention 使用 entities or caption_entities；attention 则保留显式空 entities。
    expect(parse(message('', { caption: '@gugu_bot', document: { file_id: 'doc' }, caption_entities: [{ type: 'mention', offset: 0, length: 9 }] })))
      .toMatchObject({ native_bot_mentioned: true, bot_mentioned: true, mentions_other_bot: false })
    // Python 仅在整条文本以斜杠开头时拒绝定向命令，正文引用仍保留。
    expect(parse(message('嗨 /help@other_bot', { entities: [{ type: 'bot_command', offset: 2, length: 15 }] })))
      .toMatchObject({ text: '嗨 /help@other_bot', bot_mentioned: false, mentions_other_bot: true, telegram_command: null })
  })

  it('解析层兼容编辑消息但不修改输入；超长引用按Unicode字符截断', () => {
    const edited = message('编辑后的消息', { reply_to_message: { message_id: 2, text: '😀'.repeat(2001) } })
    const before = structuredClone(edited)
    const result = normalizeTelegramMessage({ update_id: 92, edited_message: edited }, options)
    expect(result?.text).toBe('编辑后的消息')
    expect([...(result?.quoted_text ?? '')]).toHaveLength(2000)
    expect(edited).toEqual(before)
  })
})
