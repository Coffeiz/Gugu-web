import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { decryptByokCredential, resolveByokLlm, type ByokCredential } from '../../src/domains/agent-config/byok.js'
function seal(key: Buffer, nonce: Buffer, value: Buffer, aad: string) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(aad))
  return Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()])
}
function fixture(): ByokCredential {
  const dataKey = randomBytes(32), nonce = randomBytes(12), wrapNonce = randomBytes(12), key = createHash('sha256').update('synthetic-master').digest()
  return { provider: 'deepseek', api_format: '', base_url: '', model: 'user-model', key_version: 1,
    encrypted_value: seal(dataKey, nonce, Buffer.from('synthetic-key'), 'gugu-byok-envelope-v1').toString('base64'), nonce: nonce.toString('base64'),
    encrypted_data_key: Buffer.concat([wrapNonce, seal(key, wrapNonce, dataKey, "b'gugu-byok-envelope-v1':1")]).toString('base64'),
    max_tokens: null, context_tokens: null, thinking: null, reasoning_effort: null, reasoning_persistence: 'off', image: false, audio: false, video: false, image_detail: 'auto', web_search_enabled: false }
}
test('信封解密兼容既有格式，错误密钥不得静默回退', () => {
  const row = fixture()
  assert.equal(decryptByokCredential(row, () => 'synthetic-master'), 'synthetic-key')
  assert.throws(() => decryptByokCredential(row, () => 'wrong'))
})
test('解密 Python BYOK 加密器生成的合成信封', () => {
  const row = { ...fixture(), encrypted_value: 'b28BIEMMt2EEUk8AfZISjWaMbGTJweRfK2xHX0St4BuJepS5', nonce: 'KJmwyIxzHZA1ap7X', encrypted_data_key: 'VqpGMca4Bh1aKiN75EBsRVueoIszq2DLrSy03Jwt+4WtwfArJFpn+L9dr40+8JCGjcHzWb2pcAPzneyb' }
  assert.equal(decryptByokCredential(row, () => 'synthetic-master'), 'synthetic-python-key')
})
test('用户凭据仅绑定自身地址，未知目的地不使用用户密钥', () => {
  const row = fixture(), base = { provider: 'platform', base_url: 'https://platform.example.test', api_key: 'platform-key', model: 'platform-model' }
  const decrypt = (value: ByokCredential) => decryptByokCredential(value, () => 'synthetic-master')
  assert.equal(resolveByokLlm(base, row, decrypt, () => ''), base)
  const resolved = resolveByokLlm(base, row, decrypt, () => 'https://provider.example.test/')
  assert.equal(resolved.base_url, 'https://provider.example.test'); assert.equal(resolved.api_key, 'synthetic-key')
})

test('问候短文本异步解封BYOK后仍绑定用户目的地并覆盖模型字段', async () => {
  const { resolveByokLlmAsync } = await import('../../src/domains/agent-config/byok.js')
  const row = fixture(), base = { provider: 'platform', base_url: 'https://platform.example.test', api_key: 'platform-key', model: 'platform-model' }
  const resolved = await resolveByokLlmAsync(base, row, async value => decryptByokCredential(value, () => 'synthetic-master'), () => 'https://provider.example.test/')
  assert.equal(resolved.provider, 'deepseek')
  assert.equal(resolved.base_url, 'https://provider.example.test')
  assert.equal(resolved.api_key, 'synthetic-key')
  assert.equal(resolved.model, 'user-model')
})

test('运行绑定仅允许原 owner 和 run 使用，身份不含配置密钥', async () => {
  const { bindProviderSelection } = await import('../../src/domains/agent-config/provider-resolver.js')
  const identity = { ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }, signal = new AbortController().signal
  let requestedOwner = ''
  const binding = await bindProviderSelection(identity, {
    selectPlatformModel: async owner => { requestedOwner = owner; return { config: { model: 'model', api_key: 'synthetic-secret' }, systemPrompt: 'system', accessScopeHash: 'scope', byokEnabled: true, localDeployment: false } },
    readActiveCredential: async () => fixture(), decryptCredential: row => decryptByokCredential(row, () => 'synthetic-master'), defaultBaseUrl: () => 'https://provider.example.test',
  }, signal)
  assert.equal(requestedOwner, 'owner-a')
  const selected = await binding.resolve(identity, binding.modelIdentity, signal)
  assert.equal(selected.config.api_key, 'synthetic-key'); assert.equal(selected.config.is_byok, true)
  assert.equal(JSON.stringify([selected.modelIdentity, selected.accessScopeHash]).includes('synthetic'), false)
  await assert.rejects(binding.resolve({ ...identity, ownerId: 'owner-b' }, binding.modelIdentity, signal))
  await assert.rejects(binding.resolve(identity, 'other-model', signal))
})


test('异步选择期间固定运行身份，释放池名额只执行一次', async () => {
  const { bindProviderSelection } = await import('../../src/domains/agent-config/provider-resolver.js')
  const identity = { ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }, original = { ...identity }, signal = new AbortController().signal
  let proceed!: () => void, selectedOwner = '', credentialOwner = '', releases = 0
  const gate = new Promise<void>(resolve => { proceed = resolve })
  const bindingPromise = bindProviderSelection(identity, {
    selectPlatformModel: async owner => { selectedOwner = owner; await gate; return { config: { model: 'model' }, systemPrompt: '', accessScopeHash: 'scope', byokEnabled: true, localDeployment: false, release: () => { releases++ } } },
    readActiveCredential: async owner => { credentialOwner = owner; return null }, decryptCredential: () => 'unused', defaultBaseUrl: () => '',
  }, signal)
  identity.ownerId = 'owner-b'; identity.sessionId = 'session-b'; identity.runId = 'run-b'; proceed()
  const binding = await bindingPromise
  assert.equal(selectedOwner, 'owner-a'); assert.equal(credentialOwner, 'owner-a')
  await binding.resolve(original, binding.modelIdentity, signal)
  await assert.rejects(binding.resolve(identity, binding.modelIdentity, signal))
  binding.release(); binding.release(); assert.equal(releases, 1)
})
