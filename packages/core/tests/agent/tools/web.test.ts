import { expect, it, vi } from 'vitest'
import { createHttpGetTool, createWebDownloadTool, type HttpGetPort } from '../../../src/agent/tools/web.js'
import { createDeepResearchTool, createWebSearchTool } from '../../../src/agent/tools/search.js'
import { fakeDependencies, fakeResponse } from '../providers/fixtures.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { similarImageProbe } from '../../../src/agent/providers/similar-image.js'

function mount(port: HttpGetPort, authorize: (name: string) => Promise<boolean> = async () => true) {
  const registry = createToolRegistry({ tools: [createHttpGetTool(port)], authorize: (_identity, name) => authorize(name) })
  const scope = (signal = new AbortController().signal) => ({
    identity: { ownerId: 'synthetic-owner', sessionId: 'synthetic-session', runId: 'synthetic-run' },
    roundId: 'synthetic-round', signal, resolution: null,
    execute: async () => { throw new Error('不执行宿主进程') },
  })
  return { registry, scope }
}

it('http_get 单 URL 使用 Python 默认与硬上限，并从可信运行身份传 owner', async () => {
  const calls: unknown[] = []
  const port: HttpGetPort = { async get(input) { calls.push(input); return { status: 200, body: '页面正文' } } }
  const { registry, scope } = mount(port)
  const first = await registry.tools.dispatch({ id: 'one', name: 'http_get', input: { url: 'example.test' } }, scope())
  const second = await registry.tools.dispatch({ id: 'two', name: 'http_get', input: { url: 'https://example.test', max_chars: 90000 } }, scope())
  expect(first).toMatchObject({ successful: true, mutated: false, value: { status: 200, body: '页面正文' } })
  expect(second).toMatchObject({ successful: true, value: { body: '页面正文' } })
  expect(calls).toEqual([
    { ownerId: 'synthetic-owner', url: 'https://example.test', maxChars: 4000 },
    { ownerId: 'synthetic-owner', url: 'https://example.test', maxChars: 40000 },
  ])
})

it('http_get 批量按输入顺序部分成功，单项异常不泄露异常消息', async () => {
  const port: HttpGetPort = { async get(input) {
    if (input.url === 'https://bad.test') throw new Error('凭据和响应正文不能泄漏')
    return { status: 200, url: input.url, body: '正文' }
  } }
  const { registry, scope } = mount(port)
  const result = await registry.tools.dispatch({ id: 'batch', name: 'http_get', input: {
    urls: ['https://first.test', 'https://bad.test', 'https://third.test'], max_chars: 100,
  } }, scope())
  expect(result).toMatchObject({ successful: true, value: { results: [
    { status: 200, url: 'https://first.test' }, { error: '请求失败：Error' }, { status: 200, url: 'https://third.test' },
  ] } })
  expect(JSON.stringify(result)).not.toContain('凭据和响应正文')
})

it('http_get 单 URL 请求异常返回 Python 兼容错误对象且不泄露异常消息', async () => {
  const { registry, scope } = mount({ async get() { throw new TypeError('上游响应和请求头不能泄漏') } })
  const result = await registry.tools.dispatch({ id: 'failed', name: 'http_get', input: { url: 'https://bad.test' } }, scope())
  expect(result).toMatchObject({ successful: true, value: { error: '请求失败：TypeError' } })
  expect(JSON.stringify(result)).not.toContain('上游响应和请求头')
})

it('http_get 补全默认 HTTPS，并在 Host 网络端口前拒绝 URL 凭据', async () => {
  const calls: string[] = []
  const { registry, scope } = mount({ async get(input) { calls.push(input.url); return { status: 200, body: '' } } })
  const result = await registry.tools.dispatch({ id: 'urls', name: 'http_get', input: {
    urls: ['example.test', 'ftp://example.test', 'https://user:secret@example.test'],
  } }, scope())
  expect(result).toMatchObject({ value: { results: [
    { status: 200 }, { status: 200 }, { error: '非法 url' },
  ] } })
  expect(calls).toEqual(['https://example.test', 'https://ftp://example.test'])
})

it('http_get 拒绝混用 URL 形式、重复或超量批量输入，并在撤权时不请求', async () => {
  const get = vi.fn(async ({ url }: { url: string }) => ({ status: 200, url, body: '' }))
  const { registry, scope } = mount({ get })
  for (const input of [
    { url: 'https://one.test', urls: ['https://two.test'] },
    { urls: ['https://one.test', 'https://one.test'] },
    { urls: Array.from({ length: 6 }, (_, index) => `https://${index}.test`) },
  ]) {
    expect(await registry.tools.dispatch({ id: 'invalid', name: 'http_get', input }, scope())).toMatchObject({ successful: false, executed: false })
  }
  const revoked = mount({ get }, async () => false)
  expect(await revoked.registry.tools.dispatch({ id: 'denied', name: 'http_get', input: { url: 'https://one.test' } }, revoked.scope()))
    .toMatchObject({ successful: false, executed: false })
  expect(get).not.toHaveBeenCalled()
})

it('http_get 取消后不把晚到响应返回给工具调用方', async () => {
  let finish!: (value: Record<string, unknown>) => void
  let started!: () => void
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  const port: HttpGetPort = { get: () => new Promise(resolve => { finish = resolve; started() }) }
  const { registry, scope } = mount(port)
  const controller = new AbortController()
  const pending = registry.tools.dispatch({ id: 'cancel', name: 'http_get', input: { url: 'https://one.test' } }, scope(controller.signal))
  await requestStarted
  controller.abort()
  finish({ status: 200, body: '不得进入上下文' })
  await expect(pending).rejects.toThrow()
})

it('web_search 固定本轮厂商参数和凭据，权限撤销后不再请求', async () => {
  const { scope } = mount({ async get() { return {} } })
  const { dependencies, requests } = fakeDependencies([fakeResponse({ results: [{ title: '检索结果' }] })])
  const config = { provider: 'ollama', model: 'synthetic', base_url: 'https://ollama.com', api_key: 'synthetic-key', web_search_enabled: true }
  const transport = {
    digest: dependencies.digest,
    async withTransport<T>(_signal: AbortSignal, execute: (t: typeof dependencies.transport) => Promise<T>) {
      return execute(dependencies.transport)
    },
  }
  const tool = createWebSearchTool(config, transport)
  expect(createWebSearchTool({ ...config, web_search_enabled: false }, transport)).toBeUndefined()
  expect(createWebSearchTool({ ...config, api_key: '' }, transport)).toBeUndefined()
  expect(createWebSearchTool({ ...config, base_url: 'https://foreign.example.test' }, transport)).toBeUndefined()
  let allowed = true
  const registry = createToolRegistry({ tools: [tool!], authorize: async id => allowed && id.ownerId === scope().identity.ownerId })
  const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'search', name: 'web_search', input }, scope())
  expect(await dispatch({ query: '搜索词', count: 5 })).toMatchObject({ successful: false, executed: false })
  expect(await dispatch({ query: '搜索词', max_results: 5 })).toMatchObject({ successful: true, value: { results: [{ title: '检索结果' }] } })
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ url: 'https://ollama.com/api/web_search', body: { query: '搜索词', max_results: 5 } })
  allowed = false
  expect(await dispatch({ query: '搜索词' })).toMatchObject({ successful: false, executed: false })
  expect(requests).toHaveLength(1)
})

it('deep_research 使用可信运行身份、默认深度并保留完成和失败结果', async () => {
  const { scope } = mount({ async get() { return {} } })
  const research = vi.fn(async (input, context) => {
    expect(input).toEqual({ query: '研究题目', maxResults: undefined, depth: 'basic' })
    expect(context.identity).toEqual(scope().identity)
    return { kind: 'completed' as const, successful: true, mutated: true, value: { query: input.query, answer: null, results: [] } }
  })
  const registry = createToolRegistry({ tools: [createDeepResearchTool({ search: research })], authorize: async () => true })
  const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'research', name: 'deep_research', input }, scope())
  expect(await dispatch({ query: '  ', max_results: 5 })).toMatchObject({ successful: false, mutated: false })
  expect(await dispatch({ query: '研究题目', max_results: 21 })).toMatchObject({ successful: false, executed: false })
  expect(await dispatch({ query: '  研究题目  ' })).toMatchObject({ successful: true, mutated: true, value: { query: '研究题目', answer: null, results: [] } })
  expect(research).toHaveBeenCalledTimes(1)
})

it('相似图结果超出预算时省略长链接，保留完整候选链接和截断说明', async () => {
  const { dependencies } = fakeDependencies([fakeResponse({
    requestId: 'synthetic-request',
    res_data: { res_items: [
      { title: '过长地址', objurl: 'https://example.invalid/image?' + 'q'.repeat(70_000) },
      { title: '完整地址', objurl: 'https://example.invalid/image.png' },
    ] },
  })])
  const report = await similarImageProbe('synthetic-key', Uint8Array.of(1), 2, dependencies, new AbortController().signal)
  expect(report).toMatchObject({
    request_id: 'synthetic-request', count: 2,
    results: [{ image_url: null }, { image_url: 'https://example.invalid/image.png' }],
    _gugu_search_limits: { truncated: true },
  })
})


it('web_download 可信目标预检优先于网络，推导文件名并流式限制容量', async () => {
  const { scope } = mount({ async get() { return {} } })
  const encoder = new TextEncoder()
  const downloaded = fakeResponse(null, { headers: {
    'content-type': 'image/png; charset=UTF-8',
    'content-disposition': "attachment; filename*=UTF-8''..%2Fphoto",
  }, chunks: [encoder.encode('123'), encoder.encode('456')] })
  let capacity = 6
  const open = vi.fn(async (_url: string) => downloaded)
  const store = vi.fn(async ({ name, mimeType, data }) => {
    const bytes: number[] = []
    for await (const chunk of data) bytes.push(...chunk)
    expect(bytes).toHaveLength(6)
    expect(name).toBe('photo.png')
    expect(mimeType).toBe('image/png')
    return { kind: 'completed' as const, successful: true, mutated: true, value: { file_id: 7 } }
  })
  const prepare = vi.fn(async (location, context) => {
    expect(location).toEqual({ space: null, projectId: null, folderId: null })
    expect(context.identity).toEqual(scope().identity)
    return { capacity, store }
  })
  const registry = createToolRegistry({ tools: [createWebDownloadTool({
    prepare, open, extension: type => type === 'image/png' ? 'png' : null,
  })], authorize: async () => true })
  const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'download', name: 'web_download', input }, scope())
  await expect(dispatch({ url: 'example.test', space: 'personal', project_id: 3 })).resolves.toMatchObject({ value: { error: 'space=personal 不能提供 project_id' } })
  expect(open).not.toHaveBeenCalled()
  await expect(dispatch({ url: 'example.test/file' })).resolves.toMatchObject({ successful: true, value: { file_id: 7 } })
  expect(open.mock.calls[0]?.[0]).toBe('https://example.test/file')
  expect(downloaded.closed).toBe(true)
  capacity = 5
  const overflow = fakeResponse(null, { chunks: [encoder.encode('123'), encoder.encode('456')] })
  open.mockResolvedValueOnce(overflow)
  await expect(dispatch({ url: 'example.test/file' })).resolves.toMatchObject({ successful: false, mutated: false, value: { error: '下载内容超过当前用户可用存储空间' } })
  expect(overflow.closed).toBe(true)
})
