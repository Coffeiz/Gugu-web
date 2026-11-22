import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
import { createByokMediaCapabilityProbeRunner } from '../../src/modules/byok/checks/capabilities.js'
import { registerByokMediaCapabilityProbeRoute } from '../../src/modules/byok/routes.js'

const ownerId = '00000000-0000-4000-8000-000000000111'
const apps: Array<ReturnType<typeof Fastify>> = []

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

test('media probe authenticates, validates dimensions and delegates the owner-scoped draft', async () => {
  const calls: unknown[] = []
  const app = Fastify()
  apps.push(app)
  registerByokMediaCapabilityProbeRoute(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'Bearer test') return reply.code(401).send({ detail: '未授权' })
    },
    ownerIdFromRequest: () => ownerId,
    probe: async (owner, input) => {
      calls.push({ owner, input })
      return { dim: input.dim, supported: true, status: 200, detail: '模型支持图片输入' }
    },
  })

  const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/byok/media-capability-probe', payload: {} })
  const invalidDimension = await app.inject({
    method: 'POST', url: '/api/v1/byok/media-capability-probe',
    headers: { authorization: 'Bearer test' },
    payload: { provider: 'minimax', api_format: 'anthropic', base_url: 'https://api.example.invalid', model: 'm3', api_key: 'sk-synthetic', dim: 'document' },
  })
  const response = await app.inject({
    method: 'POST', url: '/api/v1/byok/media-capability-probe',
    headers: { authorization: 'Bearer test' },
    payload: { provider: 'minimax', api_format: 'anthropic', base_url: 'https://api.example.invalid', model: 'm3', api_key: 'sk-synthetic', credential_id: '7', dim: 'image' },
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(invalidDimension.statusCode, 422)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { dim: 'image', supported: true, status: 200, detail: '模型支持图片输入' })
  assert.deepEqual(calls, [{ owner: ownerId, input: {
    provider: 'minimax', api_format: 'anthropic', base_url: 'https://api.example.invalid',
    model: 'm3', api_key: 'sk-synthetic', credential_id: 7, dim: 'image',
  } }])
})

test('local media probe sends the actual image request through the pinned Node transport', async () => {
  let captured: { path?: string; authorization?: string; image?: string } = {}
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: Array<{ content?: Array<{ image_url?: { url?: string } }> }> }
      captured = { path: request.url, authorization: request.headers.authorization, image: body.messages?.[0]?.content?.[1]?.image_url?.url }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[]}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const probe = createByokMediaCapabilityProbeRunner({})
    const result = await probe({
      provider: 'local', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'synthetic-vision', apiKey: 'synthetic-local-key',
    }, 'image')
    assert.deepEqual(result, { supported: true, status: 200, detail: '模型接受了图片输入' })
    assert.equal(captured.path, '/v1/chat/completions')
    assert.equal(captured.authorization, 'Bearer synthetic-local-key')
    assert.match(captured.image ?? '', /^data:image\/png;base64,/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('Responses audio and video remain unknown without sending an unverified request', async () => {
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.writeHead(200).end('{}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const probe = createByokMediaCapabilityProbeRunner({})
    for (const dim of ['audio', 'video'] as const) {
      const result = await probe({ provider: 'openai', apiFormat: 'responses', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-model', apiKey: 'synthetic-key' }, dim)
      assert.equal(result.supported, null)
      assert.equal(result.status, 0)
      assert.match(result.detail, /尚无已验证的 Responses/)
    }
    assert.equal(requests, 0)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('OpenAI-compatible video probe sends a generated MP4 data URL through the pinned transport', async () => {
  let captured: { path?: string; video?: string; fps?: number } = {}
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: Array<{ content?: Array<{ video_url?: { url?: string }; fps?: number }> }> }
      const content = body.messages?.[0]?.content?.[1]
      captured = { path: request.url, video: content?.video_url?.url, fps: content?.fps }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[]}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await createByokMediaCapabilityProbeRunner({})({
      provider: 'local', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-video', apiKey: 'synthetic-key',
    }, 'video')
    assert.equal(result.supported, true)
    assert.equal(captured.path, '/v1/chat/completions')
    assert.match(captured.video ?? '', /^data:video\/mp4;base64,/)
    assert.equal(captured.fps, 2)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

for (const [message, supported] of [
  ['You have uploaded an invalid image. The image data is corrupted or truncated and could not be decoded.', null],
  ['This model does not support image input', false],
] as const) test(`provider media rejection classifies ${message} and redacts echoed credentials`, async () => {
  const secret = 'synthetic-media-secret-123456'
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `${message} api_key=${secret}` } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await createByokMediaCapabilityProbeRunner({})({
      provider: 'local', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-vision', apiKey: secret,
    }, 'image')
    assert.equal(result.supported, supported)
    assert.equal(result.status, 400)
    assert.match(result.detail, supported === false ? /模型拒绝了图片输入/ : /未能判定/)
    assert.match(result.detail, /密钥已隐藏/)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-media-secret/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
