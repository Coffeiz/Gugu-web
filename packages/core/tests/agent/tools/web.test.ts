import { expect, it, vi } from 'vitest'
import { createHttpGetTool, createWebDownloadTool, type HttpGetPort } from '../../../src/agent/tools/web.js'
import { createDeepResearchTool, createSimilarImageSearchTool, createWebSearchTool } from '../../../src/agent/tools/search.js'
import { fakeDependencies, fakeResponse } from '../providers/fixtures.js'
import { ProviderError } from '../../../src/agent/providers/errors.js'
import { retryClock } from '../../../src/agent/providers/retry.js'
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

function httpResponse(body: string, contentType = 'text/plain; charset=utf-8') {
  return { status: 200, headers: { 'content-type': contentType }, body: new TextEncoder().encode(body) }
}

function pdfWithText(text: string): Uint8Array {
  const operations = text.match(/.{1,1000}/gu) ?? []
  const stream = operations.map(part => `BT /F1 1 Tf 72 180 Td (${part}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 3000] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).length)
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = new TextEncoder().encode(source).length
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(source)
}

it('http_get 单 URL 使用 Python 默认与硬上限，并从可信运行身份传 owner', async () => {
  const calls: unknown[] = []
  const port: HttpGetPort = { async get(input) { calls.push(input); return httpResponse('页面正文') } }
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
    return { ...httpResponse('正文'), url: input.url }
  } }
  const { registry, scope } = mount(port)
  const result = await registry.tools.dispatch({ id: 'batch', name: 'http_get', input: {
    urls: ['https://first.test', 'https://bad.test', 'https://third.test'], max_chars: 100,
  } }, scope())
  expect(result).toMatchObject({ successful: true, value: { results: [
    { status: 200, url: 'https://first.test' }, { error: '网页请求失败，请改用其他来源' }, { status: 200, url: 'https://third.test' },
  ] } })
  expect(JSON.stringify(result)).not.toContain('凭据和响应正文')
})

it('http_get 单 URL 请求异常返回 Python 兼容错误对象且不泄露异常消息', async () => {
  const { registry, scope } = mount({ async get() { throw new TypeError('上游响应和请求头不能泄漏') } })
  const result = await registry.tools.dispatch({ id: 'failed', name: 'http_get', input: { url: 'https://bad.test' } }, scope())
  expect(result).toMatchObject({ successful: true, value: { error: '网页请求失败，请改用其他来源' } })
  expect(JSON.stringify(result)).not.toContain('上游响应和请求头')
})

it('http_get 返回连接超时和网络失败的安全原因', async () => {
  const { registry, scope } = mount({ async get(input) {
    if (input.url === 'https://slow.test') throw new ProviderError('timeout', { timeoutPhase: 'connect' })
    throw new ProviderError('network')
  } })
  const result = await registry.tools.dispatch({ id: 'failed-sites', name: 'http_get', input: {
    urls: ['https://slow.test', 'https://offline.test'],
  } }, scope())
  expect(result).toMatchObject({ value: { results: [
    { error_code: 'timeout', error: '连接目标网站超时，请改用其他来源' },
    { error_code: 'network', error: '无法连接目标网站或连接中断，请改用其他来源' },
  ] } })
})

it('http_get 补全默认 HTTPS，并在 Host 网络端口前拒绝 URL 凭据', async () => {
  const calls: string[] = []
  const { registry, scope } = mount({ async get(input) { calls.push(input.url); return httpResponse('') } })
  const result = await registry.tools.dispatch({ id: 'urls', name: 'http_get', input: {
    urls: ['example.test', 'ftp://example.test', 'https://user:secret@example.test'],
  } }, scope())
  expect(result).toMatchObject({ value: { results: [
    { status: 200 }, { status: 200 }, { error: '非法 url' },
  ] } })
  expect(calls).toEqual(['https://example.test', 'https://ftp://example.test'])
})

it('http_get 拒绝混用 URL 形式、重复或超量批量输入，并在撤权时不请求', async () => {
  const get = vi.fn(async ({ url }: { url: string }) => ({ ...httpResponse(''), url }))
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
  let finish!: (value: Awaited<ReturnType<HttpGetPort['get']>>) => void
  let started!: () => void
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  const port: HttpGetPort = { get: () => new Promise(resolve => { finish = resolve; started() }) }
  const { registry, scope } = mount(port)
  const controller = new AbortController()
  const pending = registry.tools.dispatch({ id: 'cancel', name: 'http_get', input: { url: 'https://one.test' } }, scope(controller.signal))
  await requestStarted
  controller.abort()
  finish(httpResponse('不得进入上下文'))
  await expect(pending).rejects.toThrow()
})

it('http_get 清理 HTML 噪音、保留链接，并拒绝不安全自定义请求头', async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = []
  const html = `<html><body><nav>导航噪音</nav><article><h1>正文标题</h1><p>${'正文内容。'.repeat(18)} <a href="https://example.test/source">原文</a></p><script>secret()</script></article></body></html>`
  const { registry, scope } = mount({ async get(input) { calls.push(input); return httpResponse(html, 'text/html; charset=utf-8') } })
  const accepted = await registry.tools.dispatch({ id: 'html', name: 'http_get', input: {
    url: 'https://example.test/page', headers: { 'X-Locale': 'zh-CN' },
  } }, scope())
  expect(accepted).toMatchObject({ value: { status: 200, content_type: 'text/html', body: expect.stringContaining('[原文](https://example.test/source)'), truncated: false } })
  expect(JSON.stringify(accepted)).not.toContain('导航噪音')
  expect(JSON.stringify(accepted)).not.toContain('secret()')
  expect(calls[0]).toMatchObject({ headers: { 'x-locale': 'zh-CN' } })
  const truncated = await registry.tools.dispatch({ id: 'html-short', name: 'http_get', input: {
    url: 'https://example.test/page', max_chars: 100,
  } }, scope())
  expect(truncated).toMatchObject({ value: { truncated: true, total_chars: expect.any(Number), body: expect.stringMatching(/^.{100}$/su) } })
  const rejected = await registry.tools.dispatch({ id: 'unsafe-header', name: 'http_get', input: {
    url: 'https://example.test/page', headers: { Host: 'other.test' },
  } }, scope())
  expect(rejected).toMatchObject({ value: { error: '不允许设置 Host 请求头' } })
  const insecure = await registry.tools.dispatch({ id: 'insecure-header', name: 'http_get', input: {
    url: 'http://example.test/page', headers: { 'X-Locale': 'zh-CN' },
  } }, scope())
  expect(insecure).toMatchObject({ value: { error: '自定义请求头仅允许通过 HTTPS 发送' } })
  expect(calls).toHaveLength(2)
})

it('http_get 提取 PDF 正文并按旧工具契约返回截断及总字符数', async () => {
  const pdf = pdfWithText('Hello from PDF')
  const { registry, scope } = mount({ async get() { return { status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf } } })
  const full = await registry.tools.dispatch({ id: 'pdf', name: 'http_get', input: { url: 'https://example.test/report.pdf' } }, scope())
  expect(full).toMatchObject({ successful: true, value: {
    status: 200, content_type: 'application/pdf', body: expect.stringContaining('Hello from PDF'), truncated: false,
  } })
  const totalChars = (full.value as { total_chars: number }).total_chars
  expect(totalChars).toBeGreaterThanOrEqual('Hello from PDF'.length)
  const short = await registry.tools.dispatch({ id: 'pdf-short', name: 'http_get', input: { url: 'https://example.test/report.pdf', max_chars: 5 } }, scope())
  expect(short).toMatchObject({ successful: true, value: { body: expect.stringMatching(/^.{5}$/su), truncated: true, total_chars: totalChars } })
})

it('http_get 对格式错误 PDF 返回明确错误且不泄露解析器异常详情', async () => {
  const { registry, scope } = mount({ async get() { return { status: 200, headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('not a pdf') } } })
  const result = await registry.tools.dispatch({ id: 'broken-pdf', name: 'http_get', input: { url: 'https://example.test/broken.pdf' } }, scope())
  expect(result).toMatchObject({ successful: true, value: { error: expect.stringMatching(/^PDF 提取失败：/u) } })
  expect(result.value).not.toHaveProperty('status')
  expect(result.value).not.toHaveProperty('url')
  expect(JSON.stringify(result)).not.toContain('not a pdf')
})

it('http_get PDF 提取遵守 Python 文档服务 200000 字符上限', async () => {
  const pdf = pdfWithText('x'.repeat(200_100))
  const { registry, scope } = mount({ async get() { return { status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf } } })
  const result = await registry.tools.dispatch({ id: 'pdf-limit', name: 'http_get', input: { url: 'https://example.test/large.pdf' } }, scope())
  expect(result).toMatchObject({ successful: true, value: { truncated: true, total_chars: 200_000 } })
})

it('web_search 固定本轮厂商参数和凭据，权限撤销后不再请求', async () => {
  const { scope } = mount({ async get() { return httpResponse('') } })
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
  const { scope } = mount({ async get() { return httpResponse('') } })
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

it('相似图搜索先归一旧版数字字符串结果数，再按整数范围校验', async () => {
  const { scope } = mount({ async get() { return httpResponse('') } })
  const search = vi.fn(async (input: { attachmentId: string; url: string; maxResults?: number }) => ({
    kind: 'completed' as const, successful: true, mutated: false,
    value: { count: input.maxResults ?? 15, results: [] },
  }))
  const registry = createToolRegistry({
    tools: [createSimilarImageSearchTool({ search })],
    authorize: async () => true,
  })
  const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'similar', name: 'similar_image_search', input }, scope())

  await expect(dispatch({ attach_id: 'attach-1', max_results: '5' }))
    .resolves.toMatchObject({ successful: true, value: { count: 5 } })
  expect(search.mock.calls[0]?.[0]).toEqual({ attachmentId: 'attach-1', url: '', maxResults: 5 })
  await expect(dispatch({ attach_id: 'attach-1', max_results: '21' }))
    .resolves.toMatchObject({ successful: false, executed: false })
  expect(search).toHaveBeenCalledTimes(1)
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
  const { scope } = mount({ async get() { return httpResponse('') } })
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

it('web_download 对中断流和瞬时网络失败按旧退避重试，非重试错误不重发', async () => {
  const { scope } = mount({ async get() { return httpResponse('') } })
  const broken = {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: (async function* () {
      yield new TextEncoder().encode('partial')
      throw new ProviderError('network', { retryable: true })
    })(),
    async cancel() {},
  }
  const complete = fakeResponse(null, { chunks: [new TextEncoder().encode('complete')] })
  const open = vi.fn()
    .mockResolvedValueOnce(broken)
    .mockRejectedValueOnce(new ProviderError('timeout', { retryable: true }))
    .mockResolvedValueOnce(complete)
  const store = vi.fn(async ({ data }) => {
    let content = ''
    for await (const chunk of data) content += new TextDecoder().decode(chunk)
    return { kind: 'completed' as const, successful: true, mutated: true, value: { content } }
  })
  const registry = createToolRegistry({ tools: [createWebDownloadTool({
    prepare: async () => ({ capacity: null, store }), open, extension: () => null,
  })], authorize: async () => true })
  const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'retry-download', name: 'web_download', input }, scope())

  const sleep = vi.spyOn(retryClock, 'sleep')
  vi.useFakeTimers()
  try {
    const pending = dispatch({ url: 'https://example.test/file' })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toMatchObject({ successful: true, value: { content: 'complete' } })
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 2000])
  } finally { vi.useRealTimers(); sleep.mockRestore() }
  expect(open).toHaveBeenCalledTimes(3)
  expect(store).toHaveBeenCalledTimes(2)
  expect(complete.closed).toBe(true)

  const refusedOpen = vi.fn(async () => ({ ...complete, status: 503 }))
  const refused = createToolRegistry({ tools: [createWebDownloadTool({
    prepare: async () => ({ capacity: null, store }), open: refusedOpen, extension: () => null,
  })], authorize: async () => true })
  await expect(refused.tools.dispatch({ id: 'http-error', name: 'web_download', input: { url: 'https://example.test/file' } }, scope()))
    .resolves.toMatchObject({ successful: false, value: { error: '下载失败：远端返回 HTTP 503' } })
  expect(refusedOpen).toHaveBeenCalledTimes(1)
})

it('web_download 取消退避等待后不再发起下一次网络请求', async () => {
  const { scope } = mount({ async get() { return httpResponse('') } })
  let started!: () => void
  const retryStarted = new Promise<void>(resolve => { started = resolve })
  const originalSleep = retryClock.sleep.bind(retryClock)
  const sleep = vi.spyOn(retryClock, 'sleep').mockImplementation((milliseconds, signal) => {
    started()
    return originalSleep(milliseconds, signal)
  })
  const open = vi.fn(async () => { throw new ProviderError('timeout', { retryable: true }) })
  const store = vi.fn(async () => ({ kind: 'completed' as const, successful: true, mutated: true, value: {} }))
  const registry = createToolRegistry({ tools: [createWebDownloadTool({
    prepare: async () => ({ capacity: null, store }), open, extension: () => null,
  })], authorize: async () => true })
  const controller = new AbortController()

  vi.useFakeTimers()
  try {
    const pending = registry.tools.dispatch({ id: 'cancel-retry', name: 'web_download', input: { url: 'https://example.test/file' } }, scope(controller.signal))
    await retryStarted
    controller.abort()
    await expect(pending).resolves.toMatchObject({ kind: 'unknown' })
  } finally { vi.useRealTimers(); sleep.mockRestore() }
  expect(open).toHaveBeenCalledTimes(1)
  expect(store).not.toHaveBeenCalled()
})
