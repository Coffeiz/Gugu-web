import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createAgentInteractionDescription } from '../../../src/agent/interactions/prompt-description.js'

const identity = { ownerId: 'owner-a', sessionId: '7', runId: 'run-a' }
const emptyTrusted = {
  async confirmation() { throw new Error('unexpected confirmation') },
  async credential() { throw new Error('unexpected credential') },
}

test('Core parses ask_user prompts and blocks model-declared authority or secrets', async () => {
  const describe = createAgentInteractionDescription(emptyTrusted)
  const request = { id: 'interaction-a', kind: 'question' as const,
    toolCall: { id: 'call-a', name: 'ask_user', input: { kind: 'question', title: ' 请说明 ', options: [] } } }
  const question = await describe.describe(null, identity, request)
  assert.deepEqual(question, { kind: 'question', title: '请说明', body: '', options: [], context: {}, allowTextInput: true })
  const choice = await describe.describe(null, identity, { ...request,
    toolCall: { ...request.toolCall, input: { kind: 'choice', title: '请选择', body: '', options: [{ id: 'yes', label: ' 是 ' }] } } })
  assert.equal(choice.kind, 'choice')
  assert.deepEqual(choice.options, [{ id: 'yes', label: '是', actionType: 'choice' }])
  for (const input of [
    { authorization: 'user_sandbox' }, { secret_target: { kind: 'mcp_credentials' } },
    { secret_fields: [{ name: 'token' }] }, { kind: 'form' }, { options: Array.from({ length: 9 }, (_, i) => ({ id: String(i), label: 'x' })) },
  ]) await assert.rejects(describe.describe(null, identity, { ...request, toolCall: { ...request.toolCall, input } }))
})

test('Core routes confirmation and credential prompts only to trusted Host descriptions', async () => {
  const calls: string[] = []
  const spec = { kind: 'confirm' as const, title: '确认', body: '', options: [], context: {} }
  const describe = createAgentInteractionDescription({
    async confirmation(_client, _identity, request) { calls.push(`${request.kind}:${request.id}`); return spec },
    async credential(_client, _identity, request) { calls.push(`${request.kind}:${request.id}`); return { ...spec, kind: 'form' as const } },
  })
  const call = { id: 'call-a', name: 'trusted-tool', input: {} }
  assert.equal((await describe.describe(null, identity, { id: 'confirmation-a', kind: 'confirmation', toolCall: call })).kind, 'confirm')
  assert.equal((await describe.describe(null, identity, { id: 'credential-a', kind: 'credential', toolCall: call })).kind, 'form')
  await assert.rejects(describe.describe(null, identity, { id: 'question-a', kind: 'question', toolCall: { ...call, name: 'other_tool' } }))
  assert.deepEqual(calls, ['confirmation:confirmation-a', 'credential:credential-a'])
})
