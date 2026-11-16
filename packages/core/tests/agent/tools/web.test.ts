import { expect, it, vi } from 'vitest'
import { createHttpGetTool, type HttpGetPort } from '../../../src/agent/tools/web.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

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
