import assert from 'node:assert/strict'
import test from 'node:test'
import { bindRecoverableProvider, type RecoverableProviderServices } from '../../src/domains/agent-config/recoverable-provider.js'
import { createModelStrategy } from '../../src/domains/agent-config/model-strategy.js'
const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }, signal = new AbortController().signal
function setup() {
  let configuration = 'v1', credential = 'c1', scope = 'scope-v1', releases = 0
  const strategy = createModelStrategy(async () => ({ ai: { model: 'active' }, ai_presets: { strategy: 'pool', pool_mode: 'round_robin', items: [{ id: 'a', model: 'model-a', in_pool: true }, { id: 'b', model: 'model-b', in_pool: true }] }, byokEnabled: false, systemPrompt: 'system', accessScopeHash: scope }))
  const services: RecoverableProviderServices = { async select(id, abort, ref) { const selected = await strategy(id.ownerId, abort, ref); return { ...selected, configVersion: configuration, credentialVersion: credential, credential: null, release() { releases++; selected.release() } } }, decryptCredential: () => '', defaultBaseUrl: () => '' }
  return { services, setConfig: (v: string) => { configuration = v }, setCredential: (v: string) => { credential = v }, setScope: (v: string) => { scope = v }, releases: () => releases }
}
test('重启按 checkpoint 固定模型恢复，不再轮询，身份不包含凭据', async () => {
  const { services, releases } = setup()
  const first = await bindRecoverableProvider(identity, services, 'synthetic-signing-key', signal)
  const initial = await first.resolve(identity, first.modelIdentity, signal)
  const next = await bindRecoverableProvider({ ...identity, runId: 'run-b' }, services, 'synthetic-signing-key', signal)
  assert.equal((await next.resolve({ ...identity, runId: 'run-b' }, next.modelIdentity, signal)).config.model, 'model-b')
  const restored = await bindRecoverableProvider(identity, services, 'synthetic-signing-key', signal, { identity, modelIdentity: first.modelIdentity, accessScopeHash: first.accessScopeHash })
  assert.equal((await restored.resolve(identity, restored.modelIdentity, signal)).config.model, initial.config.model)
  assert.equal(restored.modelIdentity, first.modelIdentity); assert.doesNotMatch(first.modelIdentity, /synthetic-secret/)
  first.release(); first.release(); next.release(); restored.release(); assert.equal(releases(), 3)
})
test('版本、范围和运行身份漂移拒绝恢复并释放模型占位', async () => {
  const state = setup(), first = await bindRecoverableProvider(identity, state.services, 'synthetic-key', signal)
  const recovery = { identity, modelIdentity: first.modelIdentity, accessScopeHash: first.accessScopeHash }
  state.setConfig('v2'); await assert.rejects(bindRecoverableProvider(identity, state.services, 'synthetic-key', signal, recovery)); state.setConfig('v1')
  state.setCredential('c2'); await assert.rejects(bindRecoverableProvider(identity, state.services, 'synthetic-key', signal, recovery)); state.setCredential('c1')
  state.setScope('scope-v2'); await assert.rejects(bindRecoverableProvider(identity, state.services, 'synthetic-key', signal, recovery)); state.setScope('scope-v1')
  await assert.rejects(bindRecoverableProvider({ ...identity, ownerId: 'owner-b' }, state.services, 'synthetic-key', signal, recovery))
  await assert.rejects(bindRecoverableProvider({ ...identity, runId: 'run-b' }, state.services, 'synthetic-key', signal, recovery))
  await assert.rejects(bindRecoverableProvider(identity, state.services, 'synthetic-key', signal, { ...recovery, modelIdentity: 'legacy-random-uuid' }))
  assert.equal(state.releases(), 3); first.release()
})

test('恢复复用最少在途预设并在版本拒绝后释放预留', async () => {
  let version = 'v1'
  const strategy = createModelStrategy(async () => ({ ai: { model: 'active' }, ai_presets: { strategy: 'pool', pool_mode: 'least_loaded', items: [{ id: 'a', model: 'a', in_pool: true }, { id: 'b', model: 'b', in_pool: true }] }, byokEnabled: false, systemPrompt: '', accessScopeHash: 'scope' }))
  const services: RecoverableProviderServices = { async select(id, abort, ref) { const selected = await strategy(id.ownerId, abort, ref); return { ...selected, credential: null, configVersion: version, credentialVersion: 'c1' } }, decryptCredential: () => '', defaultBaseUrl: () => '' }
  const first = await bindRecoverableProvider(identity, services, 'synthetic-key', signal)
  version = 'v2'
  await assert.rejects(bindRecoverableProvider(identity, services, 'synthetic-key', signal, { identity, modelIdentity: first.modelIdentity, accessScopeHash: first.accessScopeHash }))
  first.release(); version = 'v1'
  const after = await bindRecoverableProvider({ ...identity, runId: 'next' }, services, 'synthetic-key', signal)
  assert.equal((await after.resolve({ ...identity, runId: 'next' }, after.modelIdentity, signal)).config.model, 'a')
  after.release()
})
