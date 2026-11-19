import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import type { ProviderConfig } from '@gugu/core/providers'
import { updateConfigOverride } from '../../src/adapters/config/config-override-file.js'
import { createPosixConfigFileLock } from '../../src/adapters/config/posix-config-lock.js'
import { createWebAgentProviderBinding } from '../../src/modules/agent/model-config/web-provider-binding.js'

function fakePool() {
  const statements: string[] = []
  const client = {
    async query(sql: string) {
      statements.push(sql.trim())
      if (sql.includes('FROM user_provider_credentials')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  return { pool: { async connect() { return client } } as unknown as Pick<Pool, 'connect'>, statements }
}

test('Web provider binding snapshots synthetic config and credential versions and rejects stale recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-web-provider-binding-'))
  const path = join(directory, 'config.override.json')
  const identity = { ownerId: 'synthetic-owner', sessionId: '17', runId: 'synthetic-run' }
  const { pool, statements } = fakePool()
  const baseConfig: ProviderConfig = { provider: 'openai', api_format: 'openai', api_key: 'synthetic-platform-key', base_url: 'https://provider.example.test', model: 'model-a', context_tokens: 128_000 }
  try {
    await writeFile(path, JSON.stringify({ ai: baseConfig }))
    let permissionIdentity = 'permission-v1'
    const provider = createWebAgentProviderBinding({
      pool,
      configPath: path,
      versionSecret: 'synthetic-version-secret',
      resolveEffective(document) {
        return {
          ai: document.ai as ProviderConfig,
          byokEnabled: true,
          systemPrompt: 'synthetic system prompt',
          versionMaterial: {
            credentialsMasterKeys: { '1': 'synthetic-master-key' },
            permissionIdentity,
            environment: { providerApiKey: 'synthetic-environment-key' },
          },
        }
      },
      async resolveAccessScope() { return { contextScopeKey: 'b'.repeat(64), accessScopeHash: 'c'.repeat(64) } },
      decryptCredential() { throw new Error('credential decrypt must not run without a stored credential') },
      defaultBaseUrl() { return 'https://provider.example.test' },
      defaultLimit6h: null,
    })

    const first = await provider.bind(identity, new AbortController().signal)
    const firstResolved = await first.resolve(identity, first.modelIdentity, new AbortController().signal)
    assert.equal(firstResolved.config.model, 'model-a')
    assert.equal(first.contextScopeKey, 'b'.repeat(64))
    assert.equal(first.accessScopeHash, 'c'.repeat(64))
    assert.deepEqual(first.usageConfig, { defaultLimit6h: null, byokEnabled: true, localDeployment: false, model: 'model-a', provider: 'openai', isByok: false })
    assert.equal(await provider.accessVersion(identity), first.contextScopeKey)
    assert.match(first.modelIdentity, /^gugu-model-v1\./)
    assert.ok(statements.some(sql => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
    assert.ok(statements.some(sql => sql.includes('FROM user_provider_credentials')))
    assert.ok(statements.includes('COMMIT'))
    assert.doesNotMatch(JSON.stringify([first.modelIdentity, first.accessScopeHash]), /synthetic-platform-key|synthetic-master-key|synthetic-environment-key/)

    const recovery = { identity, modelIdentity: first.modelIdentity, accessScopeHash: first.accessScopeHash }
    const resumed = await provider.bind(identity, new AbortController().signal, recovery)
    assert.equal(resumed.modelIdentity, first.modelIdentity)
    resumed.release()

    await updateConfigOverride(path, { ai: { model: 'model-b' } }, createPosixConfigFileLock())
    await assert.rejects(provider.bind(identity, new AbortController().signal, recovery), /配置或访问范围已变化/)

    permissionIdentity = 'permission-v2'
    const fresh = await provider.bind(identity, new AbortController().signal)
    assert.notEqual(fresh.modelIdentity, first.modelIdentity)
    fresh.release()
    first.release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web provider binding accepts an explicit Host default document when override file is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-web-provider-defaults-'))
  const path = join(directory, 'missing-config.override.json')
  const identity = { ownerId: 'synthetic-owner', sessionId: '19', runId: 'synthetic-defaults-run' }
  const { pool } = fakePool()
  const provider = createWebAgentProviderBinding({
    pool,
    configPath: path,
    versionSecret: 'synthetic-version-secret',
    readConfiguration(candidate) {
      assert.equal(candidate, path)
      return {}
    },
    resolveEffective(document) {
      assert.deepEqual(document, {})
      return {
        ai: { provider: 'openai', api_format: 'openai', api_key: 'synthetic-key', base_url: 'https://provider.example.test', model: 'model-a', context_tokens: 128_000 },
        byokEnabled: false,
        systemPrompt: 'synthetic system prompt',
        versionMaterial: { credentialsMasterKeys: {}, permissionIdentity: 'permission-v1', environment: {} },
      }
    },
    async resolveAccessScope() { return { contextScopeKey: 'b'.repeat(64), accessScopeHash: 'c'.repeat(64) } },
    decryptCredential() { throw new Error('credential decrypt must not run without a stored credential') },
    defaultBaseUrl() { return 'https://provider.example.test' },
    defaultLimit6h: null,
  })
  try {
    assert.match(await provider.accessVersion(identity), /^[a-f0-9]{64}$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web provider binding keeps queued context scope key separate from Core access scope hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-web-provider-context-scope-'))
  const path = join(directory, 'config.override.json')
  const identity = { ownerId: 'synthetic-owner', sessionId: '29', runId: 'synthetic-context-scope-run' }
  const { pool } = fakePool()
  try {
    await writeFile(path, JSON.stringify({ ai: { provider: 'openai', api_format: 'openai', api_key: 'synthetic-key', base_url: 'https://provider.example.test', model: 'model-a', context_tokens: 128_000 } }))
    const provider = createWebAgentProviderBinding({
      pool,
      configPath: path,
      versionSecret: 'synthetic-version-secret',
      resolveEffective(document) {
        return {
          ai: document.ai as ProviderConfig,
          byokEnabled: false,
          systemPrompt: 'synthetic system prompt',
          versionMaterial: { credentialsMasterKeys: {}, permissionIdentity: 'permission-v1', environment: {} },
        }
      },
      resolveAccessScope: async () => ({ contextScopeKey: 'b'.repeat(64), accessScopeHash: 'c'.repeat(64) }),
      decryptCredential() { throw new Error('credential decrypt must not run without a stored credential') },
      defaultBaseUrl() { return 'https://provider.example.test' },
      defaultLimit6h: null,
    })
    const binding = await provider.bind(identity, new AbortController().signal)
    try {
      assert.equal(binding.contextScopeKey, 'b'.repeat(64))
      assert.equal(binding.accessScopeHash, 'c'.repeat(64))
      assert.equal(await provider.accessVersion(identity), 'b'.repeat(64))
    } finally { binding.release() }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
