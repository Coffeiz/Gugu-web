import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelStrategy } from '../../src/modules/agent/llm/selection.js'
import { agentAccessScopeHash } from '../../src/modules/agent/llm/access.js'
import { bindProviderSelection } from '../../src/modules/agent/llm/bind.js'
const signal = new AbortController().signal
const items = [{ id: 'a', model: 'a', in_pool: true }, { id: 'b', model: 'b', in_pool: true }, { id: 'c', model: 'c', in_pool: false }]
const settings = (mode: string, strategy = 'pool') => ({ ai: { model: 'active', api_key: 'synthetic-secret' }, ai_presets: { strategy, pool_mode: mode, items }, systemPrompt: 'system', contextScopeKey: 'a'.repeat(64), accessScopeHash: 'scope', byokEnabled: false })
test('active、空池、router 默认选择激活模型；随机和轮询只选池内模型', async () => {
  for (const value of [settings('random', 'active'), settings('random', 'router'), { ...settings('random'), ai_presets: { strategy: 'pool', items: [] } }]) {
    const selected = await createModelStrategy(async () => value)('owner', signal); assert.equal(selected.config.model, 'active'); selected.release()
  }
  const random = createModelStrategy(async () => settings('random'), () => 0.9)
  assert.equal((await random('owner', signal)).config.model, 'b')
  const round = createModelStrategy(async () => settings('round_robin'))
  assert.deepEqual((await Promise.all([round('owner', signal), round('owner', signal), round('owner', signal)])).map(x => x.config.model), ['a', 'b', 'a'])
})
test('最少在途预留和幂等释放在并发绑定中生效，快照不受后续配置变化影响', async () => {
  const source = settings('least_loaded'), select = createModelStrategy(async () => source)
  const [a, b] = await Promise.all([select('owner', signal), select('owner', signal)])
  assert.deepEqual([a.config.model, b.config.model], ['a', 'b'])
  a.release(); a.release(); const next = await select('owner', signal)
  assert.equal(next.config.model, 'a'); source.ai.model = 'changed'; assert.equal(a.config.model, 'a')
  b.release(); next.release()
})
test('范围身份跨 run 稳定，配置版本变化失效且不包含凭据', async () => {
  const scope = (model: string) => agentAccessScopeHash('synthetic-server-key', 'owner', { permissions: 'p1', model, credentials: 'c1' })
  assert.equal(scope('v1'), scope('v1')); assert.notEqual(scope('v1'), scope('v2'))
  const services = { selectPlatformModel: createModelStrategy(async () => ({ ...settings('random', 'active'), accessScopeHash: scope('v1') })), readActiveCredential: async () => null, decryptCredential: () => '', defaultBaseUrl: () => '' }
  const a = await bindProviderSelection({ ownerId: 'owner', sessionId: '1', runId: 'a' }, services, signal)
  const b = await bindProviderSelection({ ownerId: 'owner', sessionId: '1', runId: 'b' }, services, signal)
  const selected = await a.resolve({ ownerId: 'owner', sessionId: '1', runId: 'a' }, a.modelIdentity, signal)
  const second = await b.resolve({ ownerId: 'owner', sessionId: '1', runId: 'b' }, b.modelIdentity, signal)
  assert.equal(selected.accessScopeHash, second.accessScopeHash); assert.doesNotMatch(selected.accessScopeHash, /synthetic/)
  a.release(); b.release()
})

test('凭据解析失败释放最少在途占位，不能改变后续模型选择', async () => {
  const select = createModelStrategy(async () => ({ ...settings('least_loaded'), byokEnabled: true }))
  const services = { selectPlatformModel: select, readActiveCredential: async () => { throw new Error('synthetic failure') }, decryptCredential: () => '', defaultBaseUrl: () => '' }
  await assert.rejects(bindProviderSelection({ ownerId: 'owner', sessionId: '1', runId: 'a' }, services, signal))
  const next = await select('owner', signal)
  assert.equal(next.config.model, 'a'); next.release()
})

test('来源 selection 与 Provider 使用同一范围摘要，版本和可信 actor 变化均隔离', async () => {
  const { agentContextAccessScope } = await import('../../src/modules/agent/llm/access.js')
  const { contextAccessScopeHash, stableJson } = await import('@gugu/core/agent')
  const { createHash } = await import('node:crypto')
  const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
  const identity = { ownerId: 'owner', sessionId: '1' }, selection = { groupChat: true, contextPolicy: { loadOwnerContext: false, memoryEnabled: true } }, versions = { permissions: 'p1', model: 'm1', credentials: 'c1' }
  const scope = agentContextAccessScope('synthetic-secret', identity, selection, versions, digest, 'actor-a')
  assert.equal(scope.accessScopeHash, contextAccessScopeHash(identity, { ...selection, contextScopeKey: scope.contextScopeKey }, digest))
  assert.notEqual(scope.accessScopeHash, agentContextAccessScope('synthetic-secret', identity, selection, versions, digest, 'actor-b').accessScopeHash)
  assert.notEqual(scope.accessScopeHash, agentContextAccessScope('synthetic-secret', identity, selection, { ...versions, model: 'm2' }, digest, 'actor-a').accessScopeHash)
})
