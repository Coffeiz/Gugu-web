import { describe, expect, it, vi } from 'vitest'
import { consumeInteractionText } from '../../../src/agent/interactions/consume-text.js'

function fixture(schema: Record<string, unknown> = { source: 'agent', allow_text_input: true, options: [{ id: '__custom_reply__' }] }) {
  const prompt = { id: 7, ownerId: 'owner-a', sessionId: 12, kind: 'question', status: 'active', expiresAt: new Date('2026-11-17T12:00:00Z'), resolvedAt: null as Date | null, schema }
  const tx = {
    getOwnedPrompt: vi.fn(async (ownerId: string, promptId: number) => ownerId === prompt.ownerId && promptId === prompt.id ? prompt : null),
    enqueueResume: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  }
  const store = { transaction: (run: (value: typeof tx) => Promise<unknown>) => run(tx) }
  return { prompt, tx, store }
}

describe('Agent 文本交互消费用例', () => {
  it('按 owner 消费文本并把 Run 恢复引用安排在同一提交前', async () => {
    const f = fixture({ source: 'agent', allow_text_input: true, custom_input_active: true, context: { tool_call_id: 'call-a' } })
    const order: string[] = []
    f.tx.enqueueResume.mockImplementation(async (_prompt, eventId) => { order.push(`enqueue:${f.prompt.schema.resolved_result && (f.prompt.schema.resolved_result as { text?: string }).text}:${eventId ?? ''}`) })
    f.tx.commit.mockImplementation(async () => { order.push('commit') })
    const result = await consumeInteractionText(f.store as never, {
      ownerId: 'owner-a', promptId: 7, text: '  合成回答  ', eventId: 'event-a',
    }, () => new Date('2026-11-17T11:00:00Z'))

    expect(result).toMatchObject({ prompt_id: 7, session_id: 12, kind: 'question', context: { tool_call_id: 'call-a' }, result: { status: 'answered', text: '合成回答' } })
    expect(order).toEqual(['enqueue:合成回答:event-a', 'commit'])
    expect(f.prompt.status).toBe('resolved')
  })

  it('必须先激活带真实选项提问的自定义回答，且拒绝凭据表单', async () => {
    const choice = fixture({ source: 'agent', allow_text_input: true, options: [{ id: 'a' }, { id: '__custom_reply__' }] })
    await expect(consumeInteractionText(choice.store as never, { ownerId: 'owner-a', promptId: 7, text: '回答' }, () => new Date('2026-11-17T11:00:00Z')))
      .rejects.toMatchObject({ code: 'custom_reply_must_be_selected' })
    expect(choice.tx.commit).not.toHaveBeenCalled()

    const secret = fixture({ source: 'agent', allow_text_input: true, secret_fields: [{ name: 'token' }], context: { secret_target: { kind: 'mcp_credentials' } } })
    await expect(consumeInteractionText(secret.store as never, { ownerId: 'owner-a', promptId: 7, text: 'token' }, () => new Date('2026-11-17T11:00:00Z')))
      .rejects.toMatchObject({ code: 'secret_interaction_requires_private_route' })
  })

  it('越权不暴露交互；过期状态先提交再返回冲突', async () => {
    const owned = fixture()
    await expect(consumeInteractionText(owned.store as never, { ownerId: 'owner-b', promptId: 7, text: '回答' }, () => new Date('2026-11-17T11:00:00Z')))
      .rejects.toMatchObject({ code: 'interaction_not_found' })

    const expired = fixture()
    await expect(consumeInteractionText(expired.store as never, { ownerId: 'owner-a', promptId: 7, text: '回答' }, () => new Date('2026-11-17T12:00:00Z')))
      .rejects.toMatchObject({ code: 'interaction_expired' })
    expect(expired.prompt.status).toBe('expired')
    expect(expired.tx.commit).toHaveBeenCalledOnce()
  })
})

it('逐题保存回答，重复事件与过时题序不推进，最后只恢复运行一次', async () => {
  const f = fixture({ source: 'agent', context: { tool_call_id: 'call-a', tool_name: 'ask_user' }, questions: [
    { id: 'format', title: '输出格式', options: [{ id: 'md', label: 'Markdown' }] },
    { id: 'length', title: '输出长度' },
  ] })
  const reply = (text: string, questionIndex: number, eventId: string) => consumeInteractionText(f.store as never, {
    ownerId: 'owner-a', promptId: 7, text, questionIndex, eventId,
  }, () => new Date('2026-11-17T11:00:00Z'))

  await expect(reply('1', 0, 'first')).resolves.toMatchObject({ result: { status: 'question_next', text: expect.stringContaining('第 2 / 2 题') } })
  await expect(reply('1', 1, 'first')).resolves.toMatchObject({ result: { status: 'question_replay' } })
  await expect(reply('Markdown', 0, 'stale')).resolves.toMatchObject({ result: { status: 'question_next' } })
  expect(f.prompt.status).toBe('active')
  expect(f.tx.enqueueResume).not.toHaveBeenCalled()

  await expect(reply('简短', 1, 'second')).resolves.toMatchObject({ result: { status: 'answered', answers: [
    { question_id: 'format', option_ids: ['md'] }, { question_id: 'length', text: '简短' },
  ] } })
  expect(f.prompt.status).toBe('resolved')
  expect(f.tx.enqueueResume).toHaveBeenCalledOnce()
})
