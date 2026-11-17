import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePlatformModelSettings } from '../../src/domains/agent-config/platform-model-settings.js'

test('平台模型设置按默认值、环境和配置覆盖的顺序合并并保留模型池', () => {
  const settings = resolvePlatformModelSettings({
    ai: { provider: 'configured-provider', model: 'configured-model', max_tokens: 900 },
    ai_presets: { strategy: 'pool', pool_mode: 'round_robin', items: [
      { id: 'preset-a', provider: 'pool-provider', model: 'pool-model', api_key: '', in_pool: true },
    ] },
  }, {
    AI: JSON.stringify({ provider: 'json-provider', context_tokens: 64_000 }),
    AI__MODEL: 'environment-model',
    AI__MAX_TOKENS: '1200',
    BYOK__ENABLED: 'false',
  })

  assert.equal(settings.ai.provider, 'configured-provider')
  assert.equal(settings.ai.model, 'configured-model')
  assert.equal(settings.ai.max_tokens, 900)
  assert.equal(settings.ai.context_tokens, 64_000)
  assert.equal(settings.ai_presets.strategy, 'pool')
  assert.equal(settings.ai_presets.items?.[0]?.model, 'pool-model')
  assert.equal(settings.byokEnabled, false)
})

test('缺少预设时以有效模型配置创建默认预设', () => {
  const settings = resolvePlatformModelSettings({}, { AI__PROVIDER: 'openai', AI__MODEL: 'env-model' })
  assert.equal(settings.ai.provider, 'openai')
  assert.equal(settings.ai.model, 'env-model')
  assert.deepEqual(settings.ai_presets.items?.map(item => ({ id: item.id, provider: item.provider, model: item.model })), [
    { id: 'default', provider: 'openai', model: 'env-model' },
  ])
  assert.equal(settings.byokEnabled, true)
})

test('local deployment 即使 BYOK 关闭也启用 BYOK 凭据读取策略', () => {
  const settings = resolvePlatformModelSettings({ ai: { deployment_mode: 'local' }, byok: { enabled: false } }, {
    AI__DEPLOYMENT_MODE: 'cloud',
    BYOK__ENABLED: 'false',
  })
  assert.equal(settings.ai.deployment_mode, 'local')
  assert.equal(settings.byokEnabled, true)
})

test('拒绝损坏的环境模型配置和无效 BYOK 布尔值', () => {
  assert.throws(() => resolvePlatformModelSettings({}, { AI: '[]' }), /AI 环境配置无效/)
  assert.throws(() => resolvePlatformModelSettings({}, { BYOK__ENABLED: 'sometimes' }), /BYOK运行策略布尔值无效/)
  assert.throws(() => resolvePlatformModelSettings({ ai_presets: { items: 'invalid' } }, {}), /LLM 预设配置无效/)
})
