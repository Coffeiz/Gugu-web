import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_DESKTOP_SEARCH_IMAGE_BYTES } from '@gugu/core/agent/search-contracts'
import { createApp } from '../../../src/app.js'
import { signedUserToken } from '../../helpers/auth.js'

test('桌面深度研究路由只使用认证 owner，并拒绝请求体里的 owner', async () => {
  const secret = 'synthetic-desktop-search-secret'
  const owner = 'df133e5e-602c-4d60-8971-ac9f5f3f0747'
  const otherOwner = '5fc9bc9b-b35c-42fc-bef2-96d7531de3b8'
  const calls: unknown[] = []
  const app = createApp({
    appName: '桌面深度研究测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return {
      id, username: 'moon_example', displayName: null, email: 'moon@example.test', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true,
    } } },
    desktopAgentDeepResearch: { async available(ownerId) { return ownerId === owner }, async run(ownerId, input) {
      calls.push({ ownerId, input })
      return { kind: 'completed', successful: true, mutated: false, value: { answer: '合成结果' } }
    } },
  })
  const operationId = 'afc437fc-dc27-4e97-9042-61d5e507c3cb'
  try {
    const statusUrl = '/api/v1/agent/desktop-search/deep-research'
    assert.equal((await app.inject({ method: 'GET', url: statusUrl })).statusCode, 401)
    const status = (id: string) => app.inject({
      method: 'GET', url: `${statusUrl}?owner_id=${owner}`,
      headers: { authorization: `Bearer ${signedUserToken(secret, id)}` },
    })
    assert.deepEqual((await status(owner)).json(), { available: true })
    assert.deepEqual((await status(otherOwner)).json(), { available: false })
    const anonymous = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/deep-research',
      payload: { operation_id: operationId, query: '合成查询' },
    })
    const forgedOwner = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/deep-research',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { operation_id: operationId, query: '合成查询', owner_id: otherOwner },
    })
    const valid = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/deep-research',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { operation_id: operationId, query: '合成查询', max_results: 3, depth: 'advanced' },
    })
    assert.equal(anonymous.statusCode, 401)
    assert.equal(forgedOwner.statusCode, 422)
    assert.equal(valid.statusCode, 200)
    assert.deepEqual(valid.json(), { kind: 'completed', successful: true, mutated: false, value: { answer: '合成结果' } })
    assert.deepEqual(calls, [{ ownerId: owner, input: {
      operation_id: operationId, query: '合成查询', max_results: 3, depth: 'advanced',
    } }])
  } finally { await app.close() }
})

test('桌面相似图片路由接受 URL 或有界图片数据并使用认证 owner', async () => {
  const secret = 'synthetic-desktop-similar-image-secret'
  const owner = 'df133e5e-602c-4d60-8971-ac9f5f3f0747'
  const calls: unknown[] = []
  const app = createApp({
    appName: '桌面相似图片测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return {
      id, username: 'moon_example', displayName: null, email: 'moon@example.test', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true,
    } } },
    desktopAgentSimilarImageSearch: { async run(ownerId, input) {
      calls.push({ ownerId, input })
      return { kind: 'completed', successful: true, mutated: false, value: [{ url: 'https://images.example.test/result.png' }] }
    } },
  })
  const operationId = 'afc437fc-dc27-4e97-9042-61d5e507c3cb'
  try {
    const anonymous = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/similar-image',
      payload: { operation_id: operationId, image_url: 'https://images.example.test/input.png' },
    })
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/similar-image',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { operation_id: operationId, image_url: 'https://images.example.test/input.png', owner_id: owner },
    })
    const valid = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/similar-image',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { operation_id: operationId, image_url: 'https://images.example.test/input.png', max_results: 3 },
    })
    const imageInput = { operation_id: operationId, image_base64: 'AQID' }
    const uploaded = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/similar-image',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: imageInput,
    })
    assert.equal(uploaded.statusCode, 200)
    const tooLarge = await app.inject({
      method: 'POST', url: '/api/v1/agent/desktop-search/similar-image',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { ...imageInput, image_base64: Buffer.alloc(MAX_DESKTOP_SEARCH_IMAGE_BYTES + 1).toString('base64') },
    })
    assert.equal(tooLarge.statusCode, 422)

    assert.equal(anonymous.statusCode, 401)
    assert.equal(invalid.statusCode, 422)
    assert.equal(valid.statusCode, 200)
    assert.deepEqual(calls, [{ ownerId: owner, input: {
      operation_id: operationId, image_url: 'https://images.example.test/input.png', max_results: 3,
    } }, { ownerId: owner, input: imageInput }])
  } finally { await app.close() }
})

test('桌面深度研究在请求体已读完后仍响应客户端断开', { timeout: 5_000 }, async () => {
  const secret = 'synthetic-desktop-disconnect-secret'
  const owner = 'df133e5e-602c-4d60-8971-ac9f5f3f0747'
  let entered!: () => void
  let disconnected!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const aborted = new Promise<void>(resolve => { disconnected = resolve })
  const app = createApp({
    appName: '桌面搜索断开测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return {
      id, username: 'moon_example', displayName: null, email: 'moon@example.test', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true,
    } } },
    desktopAgentDeepResearch: { async run(_owner, _input, signal) {
      entered()
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      disconnected()
    } },
  })
  const controller = new AbortController()
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const result = fetch(new URL('/api/v1/agent/desktop-search/deep-research', origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation_id: 'afc437fc-dc27-4e97-9042-61d5e507c3cb', query: '合成查询' }),
      signal: controller.signal,
    })
    const rejected = assert.rejects(result, { name: 'AbortError' })
    await started
    controller.abort()
    await rejected
    await aborted
  } finally {
    controller.abort()
    await app.close()
  }
})
