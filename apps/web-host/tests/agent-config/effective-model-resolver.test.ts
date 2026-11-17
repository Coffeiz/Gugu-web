import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderConfig } from '@gugu/core/providers'
import { resolveHostEffectiveModelConfiguration } from '../../src/domains/agent-config/effective-model-resolver.js'

const platformModel: ProviderConfig = {
  provider: 'openai', api_format: 'openai', api_key: 'synthetic-platform-key',
  base_url: 'https://provider.example.test', model: 'platform-model',
}

const common = {
  settings: {
    ai: platformModel,
    ai_presets: {
      strategy: 'pool', pool_mode: 'round_robin',
      items: [{ ...platformModel, id: 'pool-a', model: 'pool-model', in_pool: true }],
    },
    byokEnabled: false,
  },
  systemPrompt: 'synthetic resolved prompt',
  credentialsMasterKeys: {},
  permissionIdentity: 'synthetic-permission-v1',
  environment: { deployment: 'synthetic-test' },
}

test('effective model keeps Python pool inputs intact for the shared model strategy', () => {
  const effective = resolveHostEffectiveModelConfiguration(common)

  assert.equal(effective.ai.model, 'platform-model')
  assert.deepEqual(effective.ai_presets, common.settings.ai_presets)
  assert.equal(effective.byokEnabled, false)
  assert.equal(effective.systemPrompt, 'synthetic resolved prompt')
})

test('effective model enables BYOK for local deployment and requires a usable key ring', () => {
  assert.throws(() => resolveHostEffectiveModelConfiguration({
    ...common,
    settings: { ...common.settings, ai: { ...platformModel, deployment_mode: 'local' } },
  }), /credentials master keys/)

  const effective = resolveHostEffectiveModelConfiguration({
    ...common,
    settings: { ...common.settings, ai: { ...platformModel, deployment_mode: 'local' } },
    credentialsMasterKeys: { '3': 'synthetic-master-key-v3' },
  })

  assert.equal(effective.byokEnabled, true)
  assert.deepEqual(effective.versionMaterial.credentialsMasterKeys, { '3': 'synthetic-master-key-v3' })
})

test('effective model refuses missing permission identity instead of weakening recovery scope', () => {
  assert.throws(() => resolveHostEffectiveModelConfiguration({
    ...common,
    permissionIdentity: '',
  }), /permission identity/)
})

test('effective model requires the resolved prompt and environment inputs instead of inventing defaults', () => {
  assert.throws(() => resolveHostEffectiveModelConfiguration({
    ...common,
    systemPrompt: '',
  }), /system prompt/)
  assert.throws(() => resolveHostEffectiveModelConfiguration({
    ...common,
    environment: undefined as never,
  }), /environment snapshot/)
})
