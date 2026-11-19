import assert from 'node:assert/strict'
import { test } from 'vitest'
import { extractQqFaces, normalizeQqAttachmentPlaceholders, normalizeQqFaces, parseQqMessage, qqPlatformSentMs } from '../../src/im/qq-message.js'

const options = { botId: '7', ownerId: 'owner-synthetic' }
const base = { id: 'event-synthetic', content: ' 合成正文 ', author: { user_openid: 'user-openid', member_openid: 'member-openid', username: '小北' }, group_openid: 'group-synthetic', timestamp: '1760000000' }
const face = (type: string, id = '14', label = '') => `<faceType=${type},faceId="${id}",ext="${label ? Buffer.from(JSON.stringify({ text: label })).toString('base64') : ''}">`

test('仅处理旧支持的三种事件，事件ID为空/缺sender/缺群scope均failclosed', () => {
  assert.equal(parseQqMessage('INTERACTION_CREATE', base, options), null)
  assert.equal(parseQqMessage('C2C_MESSAGE_CREATE', { ...base, id: '' }, options), null)
  assert.equal(parseQqMessage('C2C_MESSAGE_CREATE', { ...base, author: {} }, options), null)
  assert.equal(parseQqMessage('GROUP_AT_MESSAGE_CREATE', { ...base, group_openid: '' }, options), null)
  assert.throws(() => parseQqMessage('C2C_MESSAGE_CREATE', base, { botId: '', ownerId: options.ownerId }))
})

test('群sender优先user_openid以复用私聊绑定，Bot/owner不接受事件覆盖', () => {
  const group = parseQqMessage('GROUP_MESSAGE_CREATE', { ...base, owner_user_id: 'untrusted', channel_id: 'untrusted' }, options)!
  assert.equal(group.payload.platform_user_id, 'user-openid')
  assert.equal(group.payload.owner_user_id, options.ownerId)
  assert.equal(group.payload.channel_id, options.botId)
  assert.equal(group.payload.chat_type, 'group')
  assert.equal(group.payload.chat_id, 'group-synthetic')
  const older = parseQqMessage('GROUP_AT_MESSAGE_CREATE', { ...base, author: { member_openid: 'legacy-member' } }, options)!
  assert.equal(older.payload.platform_user_id, 'legacy-member')
  const privateMessage = parseQqMessage('C2C_MESSAGE_CREATE', base, options)!
  assert.equal(privateMessage.payload.platform_user_id, 'user-openid')
  assert.equal(privateMessage.payload.chat_id, undefined)
})

test('GROUP_AT事件名不证明提及当前Bot，只有bot=true且is_you=true才确认', () => {
  const absent = parseQqMessage('GROUP_AT_MESSAGE_CREATE', base, options)!.payload
  assert.equal(absent.bot_mentioned, false)
  assert.equal(absent.native_bot_mentioned, null)
  const ambiguous = parseQqMessage('GROUP_AT_MESSAGE_CREATE', { ...base, mentions: [{ bot: true }] }, options)!.payload
  assert.equal(ambiguous.native_bot_mentioned, null)
  assert.equal(ambiguous.has_unresolved_mention, true)
  const current = parseQqMessage('GROUP_MESSAGE_CREATE', { ...base, mentions: [{ bot: true, is_you: true, id: 'bot-openid' }] }, options)!.payload
  assert.equal(current.bot_mentioned, true)
  assert.equal(current.group_mentioned, true)
  assert.equal(current.platform_bot_user_id, 'bot-openid')
})

test('其他Bot和成员mention事实保持三态，部分已知事实不被未知节点覆盖', () => {
  const payload = parseQqMessage('GROUP_MESSAGE_CREATE', { ...base, mentions: [{ bot: true, is_you: false }, { bot: false }, {}] }, options)!.payload
  assert.equal(payload.native_bot_mentioned, false)
  assert.equal(payload.mentions_other_bot, true)
  assert.equal(payload.mentions_other_member, true)
  assert.equal(payload.has_unresolved_mention, true)
  const empty = parseQqMessage('GROUP_MESSAGE_CREATE', { ...base, mentions: [] }, options)!.payload
  assert.equal(empty.native_bot_mentioned, false)
  assert.equal(empty.mentions_other_bot, false)
  assert.equal(parseQqMessage('C2C_MESSAGE_CREATE', { ...base, mentions: [{}] }, options)!.payload.has_unresolved_mention, false)
})

test('附件占位仅在同索引和MIME匹配时移除，不把未收到的附件假装已处理', () => {
  const placeholder = '<attachmentType="image/jpeg",attachmentIndex=0,description="合成图片">'
  assert.equal(normalizeQqAttachmentPlaceholders(placeholder, [{ content_type: 'image/jpeg; charset=binary' }]), '')
  assert.equal(normalizeQqAttachmentPlaceholders(placeholder, [{ content_type: 'image/png' }]), placeholder)
  assert.equal(normalizeQqAttachmentPlaceholders(placeholder, []), placeholder)
  const parsed = parseQqMessage('C2C_MESSAGE_CREATE', { ...base, content: placeholder, attachments: [{ url: 'https://example.invalid/image.jpg', content_type: 'image/jpeg' }] }, options)!
  assert.equal(parsed.payload.text, '')
  assert.deepEqual(parsed.payload.attachments, [])
  assert.equal(parsed.mediaItems.length, 1)
  assert.deepEqual(parsed.preflight.attachments, [{ pending_media: true }])
})

test('表情ext按平台文字归一，无标签保留稳定占位，原始协议ID单独保留', () => {
  const marker = face('3', '14', '合成表情')
  assert.equal(normalizeQqFaces(marker), '合成表情')
  assert.equal(normalizeQqFaces(face('3')), '[QQ表情]')
  assert.deepEqual(extractQqFaces(marker), [{ face_type: '3', face_id: '14' }])
  const parsed = parseQqMessage('C2C_MESSAGE_CREATE', { ...base, content: marker }, options)!
  assert.equal(parsed.payload.text, '合成表情')
  assert.deepEqual(parsed.payload.emoji_refs, [{ face_type: '3', face_id: '14' }])
  assert.equal(parsed.splitFace.waitForImage, false)
})

test('收藏表情等待后续图片的需求显式返回，系统表情不等待，带附件时去掉协议标记', () => {
  const favorite = parseQqMessage('C2C_MESSAGE_CREATE', { ...base, content: face('6') }, options)!
  assert.equal(favorite.splitFace.waitForImage, true)
  assert.equal(favorite.splitFace.faceOnly, true)
  const image = parseQqMessage('C2C_MESSAGE_CREATE', { ...base, content: face('3') + '正文', attachments: [{ url: 'https://example.invalid/face.jpg' }] }, options)!
  assert.equal(image.payload.text, '正文')
  assert.equal(image.mediaItems[0]!.item.qq_face, true)
  assert.deepEqual(image.payload.attachments, [])
})

test('内联引用正文与用户正文分离，引用媒体递归去重并映射来源索引', () => {
  const source = { ...base, content: '用户问题', message_scene: { ext: ['msg_idx=current-idx', { key: 'ref_msg_idx', value: 'quoted-idx' }] },
    quote: { content: '引用 &lt;正文&gt;', attachments: [{ url: 'https://example.invalid/q.jpg', filename: '引用.jpg' }], nested: { image_url: 'https://example.invalid/q.jpg' } } }
  const parsed = parseQqMessage('GROUP_MESSAGE_CREATE', source, options)!
  assert.equal(parsed.payload.text, '用户问题')
  assert.equal(parsed.payload.quoted_text, '引用 <正文>')
  assert.equal(parsed.payload.platform_message_id, 'current-idx')
  assert.equal(parsed.mediaItems.length, 1)
  assert.equal(parsed.mediaItems[0]!.source, 'quote')
  assert.equal(parsed.mediaItems[0]!.sourcePlatformMessageId, 'quoted-idx')
  assert.equal(parsed.mediaItems[0]!.item.source_attachment_index, 0)
  assert.equal(parsed.quoteRequest!.contentRequired, false)
  assert.equal(parsed.payload.reply_target_sender_id, null)
})

test('缺失引用内容只返回ownerBot会话索引需求，不伪造数据库正文或绑定成功', () => {
  const parsed = parseQqMessage('GROUP_MESSAGE_CREATE', { ...base, message_scene: { ext: [{ ref_msg_idx: 'source-idx' }] } }, options)!
  assert.equal(parsed.payload.quoted_text, null)
  assert.deepEqual(parsed.quoteRequest, { referenceIndex: 'source-idx', chatType: 'group', chatId: 'group-synthetic', senderId: 'user-openid', contentRequired: true })
  const code = parseQqMessage('C2C_MESSAGE_CREATE', { ...base, content: '123456' }, options)!
  assert.equal(code.preflight.text, '123456')
  assert.equal(code.payload.text, '123456')
  assert.equal('bound' in code, false)
})

test('timestamp沿Python整数秒/毫秒规则，不猜ISO文本或布尔值', () => {
  assert.equal(qqPlatformSentMs({ timestamp: '1760000000' }), 1760000000000)
  assert.equal(qqPlatformSentMs({ timestamp: 1760000000000 }), 1760000000000)
  assert.equal(qqPlatformSentMs({ timestamp: true }), null)
  assert.equal(qqPlatformSentMs({ timestamp: '2026-01-01T00:00:00Z' }), null)
})

test('安全预检保留原文与媒体待处理信号，不对非法嵌套正文进行隐式字符串转换', () => {
  const parsed = parseQqMessage('C2C_MESSAGE_CREATE', { ...base, content: face('3', '14', '表情') }, options)!
  assert.equal(parsed.rawText, face('3', '14', '表情'))
  assert.equal(parsed.preflight.raw_text, parsed.rawText)
  assert.equal(parsed.preflight.text, '表情')
  assert.throws(() => parseQqMessage('C2C_MESSAGE_CREATE', { ...base, content: { private: 'synthetic-secret' } }, options), error => error instanceof TypeError && !error.message.includes('secret'))
})
