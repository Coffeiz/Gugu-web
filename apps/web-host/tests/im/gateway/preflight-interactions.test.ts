import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { consumeInteractionText } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { createImTextChoiceConsumer, type ScopedImTextPrompt } from '../../../src/modules/im/gateway/interactions/preflight.js'
import { consumeInteractionAction, type InteractionPromptRecord, type InteractionActionRecord,
  type InteractionConsumeTransaction } from '@gugu/core/agent/interactions/consume-action'
import type { AgentInteractionRespondService } from '../../../src/modules/agent/interactions/respond.js'

const scope: ImPreflightScope = { ownerId: 'owner-a', botId: '4', platform: 'telegram', chatType: 'group', chatId: 'group-a', platformUserId: 'member-a', eventId: 'event-a' }
const signal = new AbortController().signal
function fixture() {
  const now = new Date('2026-11-18T00:00:00Z'), expiresAt = new Date(now.getTime() + 60_000)
  const prompt: InteractionPromptRecord = { id: 7, ownerId: scope.ownerId, sessionId: 19, kind: 'choice', status: 'active', expiresAt, resolvedAt: null,
    schema: { source: 'agent', allow_text_input: true, options: [{ id: 'yes', label: '继续' }, { id: '__custom_reply__', label: '自己回复' }], context: { tool_call_id: 'tool-a' } } }
  const action: InteractionActionRecord = { id: 8, promptId: 7, tokenHash: createHash('sha256').update('opaque-token').digest('hex'), actionType: 'choice', optionId: 'yes', context: { tool_call_id: 'tool-a' }, status: 'pending', expiresAt, consumedAt: null, consumedEventId: null }
  let commits = 0, resumes = 0, redeems = 0
  const tx: InteractionConsumeTransaction = {
    getOwnedPrompt: async (ownerId, id) => ownerId === prompt.ownerId && id === prompt.id ? prompt : null,
    lockAction: async (id, hash) => id === action.promptId && hash === action.tokenHash ? action : null,
    applyCommandAction: async () => { throw new Error('此测试不允许其他命令') },
    redeemConfirmation: async () => { redeems++; return true },
    commit: async () => { commits++; if (prompt.status === 'resolved') resumes++ },
  }
  // 数据库/事务替身；动作和文本消费使用正式业务服务，未调用 Provider 或平台网络。
  const service: AgentInteractionRespondService = {
    respond: (ownerId, promptId, token, eventId) => consumeInteractionAction({ transaction: run => run(tx) }, { ownerId, promptId, token, eventId }, () => now),
    resumeText: (ownerId, promptId, text, eventId) => consumeInteractionText({ transaction: run => run({ getOwnedPrompt: tx.getOwnedPrompt,
      enqueueResume: async () => {}, commit: tx.commit }) }, { ownerId, promptId, text, eventId }, () => now),
  }
  const projected: ScopedImTextPrompt = { scope, promptId: 7, sessionId: 19, kind: 'choice', secret: false, allowTextInput: true, customInputActive: false,
    options: [{ id: 'yes', label: '继续', token: 'opaque-token' }, { id: '__custom_reply__', label: '自己回复', token: 'custom-token' }] }
  return { prompt, action, service, projected, stats: () => ({ commits, resumes, redeems }) }
}
test('IM文本序号经正式动作服务一次消费并提交，不绕过现有确认门', async () => {
  const f = fixture(), checks: string[] = []
  const consume = createImTextChoiceConsumer({ service: f.service,
    find: async input => { assert.deepEqual(input, scope); return [f.projected] },
    authorize: async (_scope, prompt, session) => { checks.push(`${prompt}:${session}`); return true } })
  assert.deepEqual(await consume(scope, '1', signal), { status: 'selected', text: '继续' })
  assert.equal(f.action.status, 'consumed'); assert.equal(f.action.consumedEventId, 'event-a')
  assert.equal(f.prompt.status, 'resolved'); assert.deepEqual(checks, ['7:19'])
  assert.deepEqual(f.stats(), { commits: 1, resumes: 1, redeems: 0 })
  await assert.rejects(consume(scope, '1', signal))
  assert.equal(f.stats().resumes, 1)
})
test('不同Bot、群、owner、平台、成员或聊天类型的prompt不调用统一消费服务', async () => {
  for (const change of [{ ownerId: 'owner-b' }, { botId: '5' }, { platform: 'qq' as const }, { chatId: 'group-b' }, { platformUserId: 'member-b' }, { chatType: 'c2c' as const, chatId: null }]) {
    const f = fixture()
    const consume = createImTextChoiceConsumer({ service: f.service, find: async () => [{ ...f.projected, scope: { ...scope, ...change } }], authorize: async () => true })
    await assert.rejects(consume(scope, '1', signal), /作用域/)
    assert.equal(f.stats().commits, 0)
  }
})
test('确认文本仍兑换正式一次性确认码，不由IM入口直接宣称业务完成', async () => {
  const f = fixture()
  f.prompt.kind = 'confirm'; f.prompt.schema.options = [{ id: 'confirm', label: '确认' }]
  f.action.optionId = 'confirm'; f.action.actionType = 'confirm'; f.action.context.confirm_code = 'synthetic-confirm-code'
  const consume = createImTextChoiceConsumer({ service: f.service,
    find: async () => [{ ...f.projected, kind: 'confirm', options: [{ id: 'confirm', label: '确认', token: 'opaque-token' }] }], authorize: async () => true })
  assert.deepEqual(await consume(scope, '确认', signal), { status: 'selected', text: '确认' })
  assert.equal(f.stats().redeems, 1)
  assert.equal((f.prompt.schema.resolved_result as { confirm: boolean }).confirm, true)
})
test('查到prompt后权限撤销仍拒绝，秘密prompt不走普通文本消费', async () => {
  const f = fixture()
  const revoked = createImTextChoiceConsumer({ service: f.service, find: async () => [f.projected], authorize: async () => false })
  await assert.rejects(revoked(scope, '1', signal), /授权/)
  const secret = createImTextChoiceConsumer({ service: f.service, find: async () => [{ ...f.projected, secret: true }], authorize: async () => { throw new Error('不应执行') } })
  assert.equal(await secret(scope, '1', signal), null); assert.equal(f.stats().commits, 0)
})
test('自定义回答经正式consumeInteractionText恢复，普通选项存在时不能直接注入回答', async () => {
  const f = fixture()
  const make = (active: boolean) => createImTextChoiceConsumer({ service: f.service,
    find: async () => [{ ...f.projected, customInputActive: active }], authorize: async () => true })
  assert.equal(await make(false)(scope, '合成回答', signal), null)
  f.prompt.schema.custom_input_active = true
  assert.deepEqual(await make(true)(scope, '合成回答', signal), { status: 'selected', text: '合成回答' })
  assert.equal(f.prompt.status, 'resolved'); assert.equal(f.stats().resumes, 1)
})
test('作用域内已有消费事件收据时静默消费重放，不重复提交或恢复', async () => {
  const f = fixture()
  const consume = createImTextChoiceConsumer({ service: f.service, find: async input => {
    assert.equal(input.eventId, 'event-a'); return { replayed: true }
  }, authorize: async () => { throw new Error('不应再次消费') } })
  assert.deepEqual(await consume(scope, '1', signal), { status: 'replay' })
  assert.equal(f.stats().commits, 0)
})
