import { describe, expect, it } from 'vitest'
import { createRemoteAgentDeepResearchClient, createRemoteAgentSearchAvailabilityClient, createRemoteAgentSimilarImageSearchClient } from '../../src/agent/search-client.js'

import { MAX_DESKTOP_SEARCH_IMAGE_BYTES } from '../../src/agent/search-contracts.js'

const session = {
  provider: 'self-hosted' as const,
  origin: 'https://search.example.test',
  accountId: 'c7dcb182-25a4-4edb-9d2e-20a696551433',
  token: 'synthetic-session-token',
}

it('远程搜索只公开服务器确认可用的能力', async () => {
  const client = createRemoteAgentSearchAvailabilityClient(async (input, init) => {
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-session-token')
    const path = (input as URL).pathname
    if (path === '/api/v1/agent/desktop-search/similar-image') return new Response(null, { status: 404 })
    expect(path).toBe('/api/v1/agent/desktop-search/deep-research')
    return Response.json({ available: true })
  })
  await expect(client(session, 'deep-research')).resolves.toBe(true)
  await expect(client(session, 'similar-image')).resolves.toBe(false)
})

describe('desktop remote deep research client', () => {
  it('uses the authenticated HTTPS origin and sends only a bounded operation request', async () => {
    let target: URL | undefined
    let init: RequestInit | undefined
    const client = createRemoteAgentDeepResearchClient(async (input, options) => {
      target = input as URL
      init = options
      return new Response(JSON.stringify({
        kind: 'completed', successful: true, mutated: false, value: { answer: '合成结果' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await client(session, {
      operation_id: 'acf6ac9c-663e-491a-a50c-3056c4c98d19', query: '合成查询', max_results: 3,
    })

    expect(target?.href).toBe('https://search.example.test/api/v1/agent/desktop-search/deep-research')
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-session-token')
    expect(JSON.parse(String(init?.body))).toEqual({
      operation_id: 'acf6ac9c-663e-491a-a50c-3056c4c98d19', query: '合成查询', max_results: 3,
    })
    expect(result.kind).toBe('completed')
  })

  it('rejects malformed operation IDs before making a network request', async () => {
    let called = false
    const client = createRemoteAgentDeepResearchClient(async () => {
      called = true
      return new Response('{}', { status: 200 })
    })
    await expect(client(session, { operation_id: 'bad', query: '查询' } as never)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(called).toBe(false)
  })
})

describe('desktop remote similar image search client', () => {
  it('uses the authenticated HTTPS origin and posts only the image URL', async () => {
    let target: URL | undefined
    let init: RequestInit | undefined
    const client = createRemoteAgentSimilarImageSearchClient(async (input, options) => {
      target = input as URL
      init = options
      return new Response(JSON.stringify({ kind: 'completed', successful: true, mutated: false, value: [] }), { status: 200 })
    })

    const result = await client(session, {
      operation_id: 'acf6ac9c-663e-491a-a50c-3056c4c98d19',
      image_url: 'https://images.example.test/synthetic.png', max_results: 4,
    })

    expect(target?.href).toBe('https://search.example.test/api/v1/agent/desktop-search/similar-image')
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-session-token')
    expect(JSON.parse(String(init?.body))).toEqual({
      operation_id: 'acf6ac9c-663e-491a-a50c-3056c4c98d19',
      image_url: 'https://images.example.test/synthetic.png', max_results: 4,
    })
    expect(result.kind).toBe('completed')
  })

  it('通过认证请求发送原始图片，超过 4 MiB 时在出站前拒绝', async () => {
    const operation_id = 'acf6ac9c-663e-491a-a50c-3056c4c98d19'
    const image_base64 = Buffer.alloc(MAX_DESKTOP_SEARCH_IMAGE_BYTES).toString('base64')
    let calls = 0
    const client = createRemoteAgentSimilarImageSearchClient(async (_input, init) => {
      calls++
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-session-token')
      const body = JSON.parse(String(init?.body))
      expect(Object.keys(body).sort()).toEqual(['image_base64', 'operation_id'])
      expect(body.operation_id).toBe(operation_id)
      expect(body.image_base64 === image_base64).toBe(true)
      return Response.json({ kind: 'completed', successful: true, mutated: false, value: [] })
    })
    await expect(client(session, { operation_id, image_base64 })).resolves.toMatchObject({ successful: true })
    const tooLarge = Buffer.alloc(MAX_DESKTOP_SEARCH_IMAGE_BYTES + 1).toString('base64')
    expect(tooLarge.length).toBe(image_base64.length)
    await expect(client(session, { operation_id, image_base64: tooLarge }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(calls).toBe(1)
  })

  it('rejects malformed operation IDs before making a network request', async () => {
    let called = false
    const client = createRemoteAgentSimilarImageSearchClient(async () => {
      called = true
      return new Response('{}', { status: 200 })
    })
    await expect(client(session, {
      operation_id: 'bad', image_url: 'https://images.example.test/synthetic.png',
    } as never)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(called).toBe(false)
  })
})

it('取消桌面搜索会取消进行中的 HTTP 请求', async () => {
  const controller = new AbortController()
  const request: typeof fetch = async (_input, options) => {
    const signal = options?.signal
    if (!signal) throw new Error('缺少取消信号')
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  const operation_id = 'acf6ac9c-663e-491a-a50c-3056c4c98d19'
  const deepResearch = createRemoteAgentDeepResearchClient(request)(session, {
    operation_id, query: '合成查询',
  }, controller.signal)
  const similarImage = createRemoteAgentSimilarImageSearchClient(request)(session, {
    operation_id, image_url: 'https://images.example.test/synthetic.png',
  }, controller.signal)
  controller.abort()
  await expect(deepResearch).rejects.toBe(controller.signal.reason)
  await expect(similarImage).rejects.toBe(controller.signal.reason)
})

it.each(['deep-research', 'similar-image'] as const)('取消 %s 时释放已经开始读取的响应流，并保留取消原因', async capability => {
  const controller = new AbortController()
  const reading = Promise.withResolvers<void>()
  let released = false
  const request: typeof fetch = async () => new Response(new ReadableStream({
    pull() { reading.resolve() },
    cancel() { released = true },
  }, { highWaterMark: 0 }))
  const operation_id = 'acf6ac9c-663e-491a-a50c-3056c4c98d19'
  const result = capability === 'deep-research'
    ? createRemoteAgentDeepResearchClient(request)(session, { operation_id, query: '合成查询' }, controller.signal)
    : createRemoteAgentSimilarImageSearchClient(request)(session, { operation_id, image_url: 'https://images.example.test/synthetic.png' }, controller.signal)
  await reading.promise
  controller.abort()
  await expect(result).rejects.toBe(controller.signal.reason)
  expect(released).toBe(true)
})
