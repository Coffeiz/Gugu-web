import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createAdminLlmPresetMediaProbe } from '../../src/modules/admin/llm-preset-media-probe.js'
import { readConfigOverride } from '../../src/adapters/config-override-file.js'
import { createLlmStrategyFileMutator } from '../../src/modules/admin/llm-strategy.js'

const apps: Array<ReturnType<typeof Fastify>> = []
const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test('已保存预设媒体探测先鉴权与校验维度，并将明确结论写回配置', async () => {
  const item = { id: 'vision', provider: 'openai', model: 'synthetic-model', base_url: 'https://example.test/v1', api_key: 'synthetic-key', image: false, video: false, audio: true }
  const document: Record<string, unknown> = { ai_presets: { active_id: 'vision', items: [item] } }
  const probed: string[] = []
  let invalidated = 0
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: {
      registerRoutes() {}, async verifyAdmin() { return true },
      async requireAdmin(request, reply) { if (request.headers.authorization !== 'Bearer admin') return reply.code(401).send({ detail: '未授权' }) },
    },
    adminLlmPresetMediaProbe: {
      probe: createAdminLlmPresetMediaProbe({
        readDocument: () => structuredClone(document),
        mutate: async change => change(document),
        probe: async input => { const { dim } = input; probed.push(dim); return { dim, supported: dim === 'image' ? true : null, status: dim === 'image' ? 200 : 0, detail: dim === 'image' ? '模型接受了图片输入' : '未能判定' } },
        invalidate: async () => { invalidated++ },
      }),
    },
  })
  apps.push(app)

  const url = '/api/v1/admin/agent/llm-presets/vision/probe-media'
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: `${url}?dim=document`, headers: { authorization: 'Bearer admin' } })).statusCode, 400)
  const response = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer admin' } })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(probed, ['image', 'video', 'audio'])
  assert.deepEqual(response.json().results, {
    image: { dim: 'image', supported: true, status: 200, detail: '模型接受了图片输入' },
    video: { dim: 'video', supported: null, status: 0, detail: '未能判定' },
    audio: { dim: 'audio', supported: null, status: 0, detail: '未能判定' },
  })
  assert.equal(item.image, true)
  assert.equal(item.video, false)
  assert.equal(item.audio, true)
  assert.equal((document.ai as Record<string, unknown>).image, true)
  assert.equal(invalidated, 1)
})

test('单维度已保存预设探测经过生产 App、Core 和受控本地 Provider', async () => {
  const received: { path?: string; authorization?: string } = {}
  const upstream = createServer((request, response) => {
    received.path = request.url
    received.authorization = String(request.headers.authorization ?? '')
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[]}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const directory = await mkdtemp(join(tmpdir(), 'gugu-llm-media-probe-'))
  tempDirs.push(directory)
  const configPath = join(directory, 'config.override.json')
  const item = { id: 'vision', provider: 'local', api_format: 'openai', model: 'synthetic-model', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'synthetic-key', image: false }
  const document = { ai_presets: { active_id: 'vision', items: [item] } }
  await writeFile(configPath, `${JSON.stringify(document)}\n`, 'utf8')
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin() {} },
    adminLlmPresetMediaProbe: {
      probe: createAdminLlmPresetMediaProbe({
        environment: {}, readDocument: () => readConfigOverride(configPath),
        mutate: createLlmStrategyFileMutator(configPath), invalidate: async () => {},
      }),
    },
  })
  apps.push(app)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/vision/probe-media?dim=image' })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), {
      dim: 'image', supported: true, status: 200, detail: '模型接受了图片输入',
      declared_capabilities: response.json().declared_capabilities, probe: { supported: true, status: 200 },
    })
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as { ai?: { image?: boolean }; ai_presets?: { items?: Array<{ image?: boolean }> } }
    assert.equal(saved.ai_presets?.items?.[0]?.image, true)
    assert.equal(saved.ai?.image, true)
    assert.equal(received.path, '/v1/chat/completions')
    assert.equal(received.authorization, 'Bearer synthetic-key')
    assert.equal(JSON.stringify(response.json()).includes('synthetic-key'), false)
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})

test('探测期间预设目的地变化返回冲突并保留新配置', async () => {
  const item = { id: 'vision', provider: 'openai', model: 'original-model', base_url: 'https://example.test/v1', image: false }
  const document: Record<string, unknown> = { ai_presets: { active_id: 'vision', items: [item] } }
  let invalidated = 0
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin() {} },
    adminLlmPresetMediaProbe: {
      probe: createAdminLlmPresetMediaProbe({
        readDocument: () => structuredClone(document),
        mutate: async change => { item.model = 'concurrently-updated-model'; return change(document) },
        probe: async input => ({ dim: input.dim, supported: true, status: 200, detail: '模型接受了图片输入' }),
        invalidate: async () => { invalidated++ },
      }),
    },
  })
  apps.push(app)

  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/vision/probe-media?dim=image' })
  assert.equal(response.statusCode, 409)
  assert.deepEqual(response.json(), { detail: '探测期间预设已更改，请重新探测' })
  assert.equal(item.model, 'concurrently-updated-model')
  assert.equal(item.image, false)
  assert.equal(invalidated, 0)
})
