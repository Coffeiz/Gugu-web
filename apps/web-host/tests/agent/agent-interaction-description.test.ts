import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentInteractionDescription } from '../../src/domains/agent-sessions/agent-interaction-description.js'
const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
test('普通问题仅构造澄清选项，模型不能指定授权或凭据目标', async () => {
  const port = createAgentInteractionDescription({ confirmation: async () => { throw new Error('unexpected') }, credential: async () => { throw new Error('unexpected') } })
  const request = { id: 'x', kind: 'question' as const, toolCall: { id: 'call', name: 'ask_user', input: { kind: 'question', title: '请说明', options: [] } } }
  const result = await port.describe(null as never, identity, request)
  assert.equal(result.kind, 'question'); assert.equal(result.allowTextInput, true)
  const choice = await port.describe(null as never, identity, { ...request, toolCall: { ...request.toolCall, input: { kind:'choice',title:'请选择',body:'' } } })
  assert.equal(choice.kind, 'choice'); assert.deepEqual(choice.options, []); assert.equal(choice.allowTextInput, true)
  await assert.rejects(port.describe(null as never, identity, { ...request, toolCall: { ...request.toolCall, input: { authorization: 'user_sandbox' } } }))
  await assert.rejects(port.describe(null as never, identity, { ...request, toolCall: { ...request.toolCall, input: { secret_target: { kind: 'mcp_credentials' } } } }))
})
test('确认和凭据交互只调用可信适配器', async () => {
  const calls: string[] = []
  const spec = { kind: 'confirm' as const, title: '确认', body: '', options: [], context: {} }
  const port = createAgentInteractionDescription({ confirmation: async () => { calls.push('confirmation'); return spec }, credential: async () => { calls.push('credential'); return spec } })
  const call = { id: 'c', name: 'tool', input: {} }
  await port.describe(null as never, identity, { id: 'x', kind: 'confirmation', toolCall: call })
  await port.describe(null as never, identity, { id: 'y', kind: 'credential', toolCall: call })
  assert.deepEqual(calls, ['confirmation', 'credential'])
})
