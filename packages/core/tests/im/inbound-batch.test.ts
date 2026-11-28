import { describe, expect, it } from 'vitest'
import { aggregateImInboundPayloads, imConversationKey, partitionImInboundBatch, type ImBatchMessage, type ImInboundItem } from '../../src/im/inbound-batch.js'
import { resolveImAccess, resolveImActor } from '../../src/im/access.js'

const base: ImBatchMessage = { platform: 'qq', botId: 'bot-a', chatType: 'group', senderId: '小北', chatId: 'group-a' }
const item = (eventId: string, fields: Partial<ImBatchMessage> = {}): ImInboundItem => ({ eventId, message: { ...base, ...fields } })

describe('IM 批次隔离和平台顺序', () => {
  it('跨 Bot、平台、群和私聊不得进入同一批次', () => {
    for (const fields of [{ botId: 'bot-b' }, { platform: 'telegram' as const }, { chatId: 'group-b' }, { chatType: 'c2c' as const }])
      expect(() => partitionImInboundBatch([item('1-0'), item('2-0', fields)])).toThrow('作用域不一致')
    expect(() => imConversationKey({ ...base, senderId: '' })).toThrow('作用域无效')
    expect(imConversationKey({ ...base, chatType: 'c2c', senderId: '小北' }))
      .not.toBe(imConversationKey({ ...base, chatType: 'c2c', senderId: '小南' }))
  })

  it('同群不同发言人可合批，完整键不发生分隔符碰撞', () => {
    expect(partitionImInboundBatch([item('1-0'), item('2-0', { senderId: '小南' })])).toHaveLength(1)
    expect(imConversationKey({ ...base, botId: 'a:b', chatId: 'c' }))
      .not.toBe(imConversationKey({ ...base, botId: 'a', chatId: 'b:c' }))
  })

  it('按平台时间排序，当前 Bot mention 独立切段且不改动输入', () => {
    const input = [item('100-3', { platformSentMs: 30 }), item('100-1', { platformSentMs: 10 }),
      item('100-2', { platformSentMs: 20, botMentioned: true }), item('100-4', { platformSentMs: 40 })]
    expect(partitionImInboundBatch(input).map(segment => segment.map(value => value.eventId)))
      .toEqual([['100-1'], ['100-2'], ['100-3', '100-4']])
    expect(input[0]!.eventId).toBe('100-3')
  })

  it('提及其他 Bot 不触发单独切段，等待输入恢复仍独立', () => {
    expect(partitionImInboundBatch([item('1-0'), item('2-0', { botMentioned: true, mentionsOtherBot: true }),
      item('3-0', { pendingAskResume: true }), item('4-0')]).map(segment => segment.map(value => value.eventId)))
      .toEqual([['1-0', '2-0'], ['3-0'], ['4-0']])
  })

  it('Redis 序号超过 JS 安全整数仍精确排序，同时间保持原始顺序', () => {
    const input = [item('9007199254740993-2'), item('9007199254740993-1'), item('9007199254740992-0')]
    expect(partitionImInboundBatch(input)[0]!.map(value => value.eventId))
      .toEqual(['9007199254740992-0', '9007199254740993-1', '9007199254740993-2'])
    expect(partitionImInboundBatch([item('1-0'), item('1-0')])[0]).toHaveLength(2)
  })

  it('完整保留逐消息正文/附件/锚点，最后原生回复路由与混合speaker最低权限一致', () => {
    const bot = { ownerId: 'owner', id: '7', platform: 'qq' as const, ownerPlatformUserId: 'owner-speaker',
      groupAllowedTools: ['web_search'], groupOwnerMemoryEnabled: true }
    const payload = { owner_user_id: 'owner', platform: 'qq', bot_id: '7', channel_id: '7', chat_type: 'group', chat_id: 'g' }
    const input = [
      { eventId: '1-0', payload: { ...payload, platform_user_id: 'owner-speaker', platform_user_name: '小北', message_id: 'first',
        text: '第一条', quoted_text: '合成引用', attachments: ['attach-a'] }, anchor: { messageId: 9, conversationSeq: 9 } },
      { eventId: '2-0', payload: { ...payload, platform_user_id: 'member-speaker', platform_user_name: '小南', message_id: 'last',
        text: '第二条', attachments: ['attach-b'] }, anchor: { messageId: 8, conversationSeq: 8 } },
    ]
    const merged = aggregateImInboundPayloads(input)
    expect(merged.text).toBe('第一条\n第二条')
    expect(merged.message_id).toBe('last')
    expect(merged._early_message_ids).toEqual([9, 8])
    expect((merged._batch_messages as Record<string, unknown>[]).map(p => p.attachments)).toEqual([['attach-a'], ['attach-b']])
    expect((merged._batch_messages as Record<string, unknown>[])[0]!.quoted_text).toBe('合成引用')
    const speakers = (merged._turn_speakers as { platform_user_id: string }[]).map(p => ({ platformUserId: p.platform_user_id }))
    const actor = resolveImActor({ ownerId: 'owner', platform: 'qq', botId: '7', chatType: 'group', chatId: 'g',
      platformUserId: 'member-speaker', botMentioned: false, mentionsOtherBot: false, speakers }, scope => resolveImAccess(scope, bot))
    expect(actor.role).toBe('member')
    expect(actor.verifiedOwner).toBe(false)
    expect(actor.allowedToolNames).toEqual(['web_search', 'http_get'])
    ;(input[0]!.payload.attachments as string[]).push('later-change')
    expect((merged._batch_messages as Record<string, unknown>[])[0]!.attachments).toEqual(['attach-a'])
  })

  it('聚合不能借用另一owner/Bot/群锚点，QQ表情标记不重复进入合并正文', () => {
    const first = { eventId: '1-0', payload: { owner_user_id: 'owner', platform: 'qq', bot_id: '7', chat_type: 'group',
      chat_id: 'g', platform_user_id: 'member', text: '[QQ表情]', qq_face_marker: true, attachments: ['face-a'] }, anchor: { messageId: 1, conversationSeq: 1 } }
    const last = { ...first, eventId: '2-0', payload: { ...first.payload, text: '后续正文', qq_face_marker: false }, anchor: { messageId: 2, conversationSeq: 2 } }
    expect(aggregateImInboundPayloads([first, last]).text).toBe('后续正文')
    expect((aggregateImInboundPayloads([first, last])._batch_messages as Record<string, unknown>[])[0]!.text).toBe('[QQ表情]')
    for (const patch of [{ owner_user_id: 'other-owner' }, { bot_id: '8' }, { chat_id: 'other-group' }])
      expect(() => aggregateImInboundPayloads([first, { ...last, payload: { ...last.payload, ...patch } }])).toThrow('作用域或锚点不一致')
    expect(() => aggregateImInboundPayloads([first, { ...last, anchor: first.anchor }])).toThrow('作用域或锚点不一致')
  })
})
