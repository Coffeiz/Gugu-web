import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentLlmConfigService, createAdminProviderModelFetcher } from '../../../../src/modules/admin/llm-settings.js'

test('预设修改在注入锁内读取最新配置并原子发布，仅改变 ai 相关字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-llm-config-')), path = join(dir, 'config.json')
  try {
    writeFileSync(path, JSON.stringify({ ai: { provider: 'openai', model: 'old', api_key: 'synthetic-key' }, db: { password: 'synthetic-db' }, extra: { value: 1 } }))
    let locked = false, lockPath = ''
    const service = createAgentLlmConfigService(path, { exclusive: (target, work) => {
      assert.equal(locked, false); locked = true; lockPath = target
      try { return work() } finally { locked = false }
    } })
    assert.equal(service.read().ai_presets?.active_id, 'default')
    service.mutate(config => {
      assert.equal(locked, true)
      config.ai = { provider: 'openai', model: 'new' }
      ;(config as Record<string, unknown>).db = { password: 'incorrect' }
    })
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(lockPath, join(dir, '.config.json.lock'))
    assert.deepEqual(saved.ai, { provider: 'openai', model: 'new' })
    assert.deepEqual(saved.db, { password: 'synthetic-db' }); assert.deepEqual(saved.extra, { value: 1 })
    const before = readFileSync(path, 'utf8')
    assert.throws(() => service.mutate(config => { config.ai = { model: 'partial' }; throw new Error('合成校验失败') }), /合成校验失败/)
    assert.equal(readFileSync(path, 'utf8'), before)
    writeFileSync(path, '{invalid')
    assert.throws(() => service.mutate(() => undefined), /格式无效/)
    assert.equal(readFileSync(path, 'utf8'), '{invalid')
    rmSync(path)
    assert.throws(() => service.mutate(() => undefined), /拒绝创建/)
    const explicitSave = createAgentLlmConfigService(path, { exclusive: (_target, work) => work() }, { allowCreate: true })
    explicitSave.mutate(config => { config.ai = { model: 'synthetic' } })
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).ai.model, 'synthetic')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('模型目录使用 Provider 传输、去重排序且不回传密钥', async () => {
  let closed = false
  const fetch = createAdminProviderModelFetcher({ allowLocal: false, createTransport: () => ({
    async request(request) {
      assert.equal(request.headers.Authorization, 'Bearer synthetic-key')
      return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode('{"data":[{"id":"z"},{"id":"a"},{"id":"a"}]}') })(), cancel() {} }
    }, async close() { closed = true },
  }) })
  assert.deepEqual(await fetch('https://model.example/v1', 'openai', 'synthetic-key', 'openai'), ['a', 'z'])
  assert.equal(closed, true)
})

test('云 Provider 模型目录拒绝访问回环地址', async () => {
  const fetch = createAdminProviderModelFetcher({ allowLocal: false })
  await assert.rejects(fetch('http://127.0.0.1:80/v1', 'openai', 'synthetic-key', 'openai'))
})
