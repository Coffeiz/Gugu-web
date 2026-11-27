import assert from 'node:assert/strict'
import { test } from 'vitest'
import { prepareAgentInteractionPrompt } from '../../../src/agent/interactions/prompt-preparation.js'
import { createAgentInteractionDescription } from '../../../src/agent/interactions/prompt-description.js'

const identity = { ownerId: 'owner-a', sessionId: '7', runId: 'run-a' }
const emptyTrusted = {
  async confirmation() { throw new Error('unexpected confirmation') },
  async credential() { throw new Error('unexpected credential') },
  async authorization() { throw new Error('unexpected authorization') },
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
    async authorization(_client, _identity, request) { calls.push(`${request.kind}:${request.id}`); return { ...spec, kind: 'choice' as const } },
  })
  const call = { id: 'call-a', name: 'trusted-tool', input: {} }
  assert.equal((await describe.describe(null, identity, { id: 'confirmation-a', kind: 'confirmation', toolCall: call })).kind, 'confirm')
  assert.equal((await describe.describe(null, identity, { id: 'credential-a', kind: 'credential', toolCall: call })).kind, 'form')
  await assert.rejects(describe.describe(null, identity, { id: 'question-a', kind: 'question', toolCall: { ...call, name: 'other_tool' } }))
  assert.deepEqual(calls, ['confirmation:confirmation-a', 'credential:credential-a'])
})

test('Core delegates user sandbox authorization copy and actions only to trusted Host handler', async () => {
  let called = false
  const describe = createAgentInteractionDescription({ ...emptyTrusted, async authorization(_client, _identity, request) {
    called = true
    assert.equal(request.toolCall.input && (request.toolCall.input as Record<string, unknown>).title, 'model supplied')
    return { kind: 'choice', title: 'trusted', body: 'trusted body', options: [{ id: 'confirm', label: '授权', actionType: 'choice' }], context: { command_action: 'filesystem_authorization_grant' }, allowTextInput: false }
  } })
  const request = { id: 'auth-a', kind: 'question' as const,
    toolCall: { id: 'call-a', name: 'ask_user', input: { kind: 'choice', authorization: 'user_sandbox', title: 'model supplied', options: [{ id: 'confirm', label: 'fake' }] } } }
  const spec = await describe.describe(null, identity, request)
  assert.equal(called, true)
  assert.equal(spec.title, 'trusted')
  assert.deepEqual(spec.context, { command_action: 'filesystem_authorization_grant' })
  assert.equal(spec.allowTextInput, false)
})

test('IM 恢复旧 ask_user 请求时，卡片只投影单选选项', async () => {
  const request = { id: 'im-question', kind: 'question' as const, toolCall: {
    id: 'call-a', name: 'ask_user', input: {
      kind: 'choice', title: '请选择', selection_mode: 'multiple',
      options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }],
    },
  } }
  const normal = await createAgentInteractionDescription(emptyTrusted).describe(null, identity, request)
  const im = await createAgentInteractionDescription(emptyTrusted, { singleChoiceOnly: true }).describe(null, identity, request)
  assert.equal(normal.selectionMode, 'multiple')
  assert.equal(Object.hasOwn(im, 'selectionMode'), false)
  assert.deepEqual(im.options, normal.options)
})

test('问答从协议包装里恢复标题、正文和实际候选项，自定义回复只作为附加选项', async () => {
  const args = { kind: 'choice', title: '请选择方案', body: '方案将用于后续操作。',
    options: [{ id: 'a', label: '方案 A' }, { id: 'b', label: '方案 B' }] }
  const describe = createAgentInteractionDescription(emptyTrusted)
  for (const input of [{ arguments: args }, { tool_name: 'ask_user', arguments: args }]) {
    const request = { id: 'wrapped-question', kind: 'question' as const, toolCall: { id: 'ask', name: 'ask_user', input } }
    const prompt = await describe.describe(null, identity, request)
    assert.equal(prompt.title, args.title)
    assert.equal(prompt.body, args.body)
    assert.deepEqual(prepareAgentInteractionPrompt(prompt, request, 0).options.map(option => option.id), ['a', 'b', '__custom_reply__'])
  }
  await assert.rejects(describe.describe(null, identity, { id: 'wrapped-auth', kind: 'question',
    toolCall: { id: 'ask', name: 'ask_user', input: { arguments: { ...args, authorization: 'untrusted' } } } }))
})