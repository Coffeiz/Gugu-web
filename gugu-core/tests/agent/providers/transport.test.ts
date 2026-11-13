import { ClientRequest, createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createNodeProviderTransport } from '../../../src/agent/providers/transport/node.js'
import { isPublicAddress, resolvePinnedTarget } from '../../../src/agent/providers/transport/network.js'
import { requestEvents, requestJson } from '../../../src/agent/providers/http.js'
import type { ProviderDriverDependencies } from '../../../src/agent/providers/contracts.js'
import { proxyFor, proxyOptionsFromEnvironment } from '../../../src/agent/providers/transport/proxy.js'
import { syntheticCertificate } from './tls-fixture.js'
import { invocation } from './openai-fixtures.js'
import { providerSelection } from '../../../src/agent/providers/registry.js'

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const value = createServer(handler)
  return listen(value)
}
async function listen(value: Server) {
  value.listen(0, '127.0.0.1'); await once(value, 'listening')
  const address = value.address()
  if (!address || typeof address === 'string') throw new Error('合成HTTP服务未监听')
  return { value, base: `http://provider.example:${address.port}` }
}
async function close(value: Server) { value.closeAllConnections(); await new Promise<void>((resolve, reject) => value.close(error => error ? reject(error) : resolve())) }
const deps = (transport: ProviderDriverDependencies['transport']): ProviderDriverDependencies => ({ transport, digest: () => 'synthetic-network-digest' })

describe('外连地址与DNS固定', () => {
  it('DNS等待可立即取消且晚到解析结果不继续请求，连接预算包含解析阶段', async () => {
    const controller = new AbortController()
    const resolve = vi.fn(() => new Promise<readonly { address: string; family: 4 }[]>(() => undefined))
    const waiting = resolvePinnedTarget('https://provider.example', { resolve, signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
    await expect(resolvePinnedTarget('https://provider.example', { resolve, timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout', options: { timeoutPhase: 'connect' } })
  })
  it.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', '2001:db8::1'])('拒绝非公网地址%s及IPv4映射绕过', address => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it('混合公私DNS整体拒绝，凭据/fragment/query密钥不进入连接', async () => {
    const resolve = vi.fn(async () => [{ address: '1.1.1.1', family: 4 as const }, { address: '127.0.0.1', family: 4 as const }])
    await expect(resolvePinnedTarget('https://provider.example/v1', { resolve })).rejects.toMatchObject({ code: 'input_rejected' })
    for (const url of ['https://name:secret@provider.example', 'https://provider.example/#fragment', 'https://provider.example/?api_key=synthetic'])
      await expect(resolvePinnedTarget(url, { resolve })).rejects.toMatchObject({ code: 'input_rejected' })
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

describe('真实Node HTTP与分片、取消和响应体', () => {
  it('完整JSON读取后复用真实TCP连接，空闲过期后新建连接而非只复用fake对象', async () => {
    const sockets = new Set<unknown>()
    const test = await server((request, response) => { sockets.add(request.socket); response.end('{"ok":true}') })
    const transport = createNodeProviderTransport({ allowLocal: true, idleTimeoutMs: 30, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    const input = { url: test.base, method: 'GET' as const, headers: {}, allowLocal: true }
    try {
      await requestJson(deps(transport), input, new AbortController().signal)
      await requestJson(deps(transport), input, new AbortController().signal)
      expect(sockets.size).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 70))
      await requestJson(deps(transport), input, new AbortController().signal)
      expect(sockets.size).toBe(2)
    } finally { await transport.close(); await close(test.value) }
  })
  it('四协议实际请求共用五分钟读空闲及10秒连接/写、5秒池等待默认预算', async () => {
    const test = await server((_request, response) => { response.writeHead(200); response.flushHeaders() })
    const transport = createNodeProviderTransport({ allowLocal: true, maxSockets: 1, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    const reads = vi.spyOn(ClientRequest.prototype, 'setTimeout'), timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      for (const format of ['openai', 'responses', 'anthropic', 'ollama']) {
        const selected = providerSelection({ provider: format === 'ollama' ? 'ollama' : 'local', api_format: format === 'ollama' ? 'openai' : format, model: 'synthetic', base_url: test.base, ollama_api_mode: format === 'ollama' ? 'native' : 'openai' })
        const request = selected.driver.buildRequest(invocation({ ...selected, history: [{ role: 'user', content: '合成输入' }] }), deps(transport), false)
        const response = await transport.request(request, new AbortController().signal)
        const controller = new AbortController()
        const waiting = transport.request(request, controller.signal)
        // 让DNS准备和池排队落定，检查真实创建的计时器，随后立即取消，不等待五分钟。
        await new Promise<void>(resolve => setImmediate(resolve))
        controller.abort(); await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
        await response.cancel()
      }
      expect(reads.mock.calls.map(call => call[0])).toEqual([300_000, 300_000, 300_000, 300_000])
      expect(timers.mock.calls.some(call => call[1] === 10_000)).toBe(true)
      expect(timers.mock.calls.filter(call => call[1] === 5000)).toHaveLength(4)
    } finally { reads.mockRestore(); timers.mockRestore(); await transport.close(); await close(test.value) }
  })
  it('不支持的响应编码拒绝后释放连接配额，下一请求不会卡在pool', async () => {
    let count = 0
    const test = await server((_request, response) => { if (++count === 1) response.setHeader('content-encoding', 'synthetic-unknown'); response.end('{"ok":true}') })
    const transport = createNodeProviderTransport({ allowLocal: true, maxSockets: 1, poolTimeoutMs: 30, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    const input = { url: test.base, method: 'GET' as const, headers: {}, allowLocal: true }
    try {
      await expect(requestJson(deps(transport), input, new AbortController().signal)).rejects.toMatchObject({ code: 'protocol' })
      expect(await requestJson(deps(transport), input, new AbortController().signal)).toEqual({ ok: true })
    } finally { await transport.close(); await close(test.value) }
  })
  it('连接池已满时使用独立pool预算，不把排队算成连接或整个Run超时', async () => {
    const test = await server((_request, response) => { response.writeHead(200); response.flushHeaders() })
    const transport = createNodeProviderTransport({ allowLocal: true, maxSockets: 1, poolTimeoutMs: 20, connectTimeoutMs: 1000, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    let first: Awaited<ReturnType<typeof transport.request>> | undefined
    try {
      first = await transport.request({ url: test.base, method: 'GET', headers: {}, allowLocal: true }, new AbortController().signal)
      await expect(transport.request({ url: test.base, method: 'GET', headers: {}, allowLocal: true }, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout', options: { timeoutPhase: 'pool' } })
    } finally { await first?.cancel(); await transport.close(); await close(test.value) }
  })
  it('HTTPS代理隧道仍校验目标TLS域名和可信CA，SNI不被固定IP替换', async () => {
    const certificate = syntheticCertificate()
    const target = await listen(createSecureServer(certificate, (_request, response) => response.end('{"tls":true}')))
    const proxy = await listen(createSecureServer(certificate, (_request, response) => { response.writeHead(500); response.end() }))
    const sockets = new Set<Duplex>()
    proxy.value.on('connect', (_request, socket, head) => {
      const upstream = connect({ host: '127.0.0.1', port: Number(new URL(target.base).port) })
      sockets.add(socket); sockets.add(upstream)
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
      upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
      socket.once('close', () => upstream.destroy())
    })
    const transport = createNodeProviderTransport({ allowLocal: true, ca: certificate.cert, resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      proxy: { https: { url: proxy.base.replace('http:', 'https:').replace('provider.example', 'proxy.example'), ca: certificate.cert } } })
    try {
      const base = target.base.replace('http:', 'https:')
      await expect(requestJson(deps(transport), { url: base, method: 'GET', headers: {}, allowLocal: true }, new AbortController().signal)).resolves.toEqual({ tls: true })
      await expect(requestJson(deps(transport), { url: base.replace('provider.example', 'mismatch.example'), method: 'GET', headers: {}, allowLocal: true }, new AbortController().signal)).rejects.toMatchObject({ code: 'network', options: { retryable: false } })
    } finally { await transport.close(); for (const socket of sockets) socket.destroy(); await close(proxy.value); await close(target.value) }
  })
  it('真实代理CONNECT使用固定目标IP，代理认证不转发目标，NO_PROXY按域及端口绕过', async () => {
    let path = '', authorization = '', targetProxyHeader: string | undefined
    const target = await server((request, response) => { targetProxyHeader = request.headers['proxy-authorization'] as string | undefined; response.end('{"proxied":true}') })
    const sockets = new Set<Duplex>(), proxy = await server((_request, response) => { response.writeHead(500); response.end() })
    proxy.value.on('connect', (request, socket, head) => {
      path = request.url ?? ''; authorization = request.headers['proxy-authorization'] as string
      const upstream = connect({ host: '127.0.0.1', port: Number(new URL(target.base).port) })
      sockets.add(socket); sockets.add(upstream)
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
      upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
      socket.once('close', () => upstream.destroy())
    })
    const proxyUrl = proxy.base.replace('provider.example', 'proxy.example')
    const transport = createNodeProviderTransport({ allowLocal: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }], proxy: { http: { url: proxyUrl, authorization: 'synthetic-proxy-authorization' } } })
    try {
      await expect(requestJson(deps(transport), { url: target.base, method: 'GET', headers: {}, allowLocal: true }, new AbortController().signal)).resolves.toEqual({ proxied: true })
      expect(path).toBe(`127.0.0.1:${new URL(target.base).port}`)
      expect(authorization).toBe('synthetic-proxy-authorization'); expect(targetProxyHeader).toBeUndefined()
      expect(proxyFor(new URL('https://api.provider.example'), { https: { url: 'https://proxy.example' }, noProxy: '.provider.example:443' })).toBeUndefined()
      const environment = proxyOptionsFromEnvironment({ HTTPS_PROXY: 'http://synthetic:proxy@proxy.example:8080', NO_PROXY: 'localhost' })
      expect(environment.https?.url).not.toContain('synthetic'); expect(environment.https?.authorization).toMatch(/^Basic /)
    } finally { await transport.close(); for (const socket of sockets) socket.destroy(); await close(proxy.value); await close(target.value) }
  })
  it('对端停读的大请求由write超时终止，end入队不能误判已经发完', async () => {
    const test = await server((request, _response) => request.pause())
    const transport = createNodeProviderTransport({ allowLocal: true, writeTimeoutMs: 20, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    try {
      // 持续分块到socket真正背压，避免固定小体积已被系统发送缓冲完整接收。
      const chunk = new Uint8Array(1024 * 1024)
      const body = (async function* () { while (true) yield chunk })()
      await expect(transport.request({ url: test.base, method: 'POST', headers: {}, allowLocal: true, timeoutMs: 5000, body }, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout', options: { timeoutPhase: 'write' } })
    } finally { await transport.close(); await close(test.value) }
  })
  it('合成域名只解析一次并实际连接固定IP，Host保留原域名；本地授权需双开关', async () => {
    let host = '', requests = 0
    const test = await server((request, response) => { requests++; host = request.headers.host ?? ''; response.end('{"ok":true}') })
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }])
    const transport = createNodeProviderTransport({ allowLocal: true, resolve })
    try {
      await expect(requestJson(deps(transport), { url: test.base, method: 'GET', headers: {} }, new AbortController().signal)).rejects.toMatchObject({ code: 'input_rejected' })
      expect(requests).toBe(0)
      resolve.mockClear()
      await expect(requestJson(deps(transport), { url: test.base, method: 'POST', headers: {}, body: { query: '合成' }, allowLocal: true }, new AbortController().signal)).resolves.toEqual({ ok: true })
      expect(resolve).toHaveBeenCalledTimes(1); expect(host).toBe(new URL(test.base).host); expect(requests).toBe(1)
    } finally { await transport.close(); await close(test.value) }
  })
  it('拒绝自动跟随重定向，gzip解压后的字节进入JSON与响应预算', async () => {
    let targetHits = 0
    const test = await server((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: '/target' }); response.end(); return }
      if (request.url === '/target') targetHits++
      response.setHeader('content-encoding', 'gzip'); response.end(gzipSync(JSON.stringify({ text: '合成'.repeat(500) })))
    })
    const transport = createNodeProviderTransport({ allowLocal: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    try {
      const call = (path: string) => requestJson(deps(transport), { url: test.base + path, method: 'GET', headers: {}, allowLocal: true }, new AbortController().signal)
      await expect(call('/redirect')).rejects.toMatchObject({ code: 'upstream' }); expect(targetHits).toBe(0)
      await expect(call('/gzip')).resolves.toEqual({ text: '合成'.repeat(500) })
    } finally { await transport.close(); await close(test.value) }
  })
  it('UTF8和CRLF逐字节切分仍保持SSE顺序，消费者return关闭底层响应', async () => {
    const encoder = new TextEncoder(), bytes = encoder.encode('event: content\r\ndata: {"text":"合成"}\r\n\r\ndata: [DONE]\n\n')
    let pulls = 0
    const cancel = vi.fn()
    const transport = { request: async () => ({ status: 200, headers: {}, cancel, body: (async function* () { for (const byte of bytes) { pulls++; yield Uint8Array.of(byte) } })() }) }
    const stream = requestEvents(deps(transport), { url: 'https://provider.example/v1', method: 'GET', headers: {} }, new AbortController().signal)
    expect((await stream.next()).value).toEqual({ event: 'content', data: { text: '合成' } })
    expect(pulls).toBeLessThan(bytes.length)
    await stream.return(undefined); expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('真实连接的读空闲超时和主动取消关闭流，不用总时限截断持续数据', async () => {
    const test = await server((_request, response) => { response.writeHead(200); response.flushHeaders() })
    const transport = createNodeProviderTransport({ allowLocal: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
    try {
      const controller = new AbortController()
      const first = requestJson(deps(transport), { url: test.base, method: 'GET', headers: {}, allowLocal: true, timeoutMs: 30 }, controller.signal)
      await expect(first).rejects.toMatchObject({ code: 'timeout' })
      const next = new AbortController(), second = requestJson(deps(transport), { url: test.base, method: 'GET', headers: {}, allowLocal: true }, next.signal)
      next.abort(); await expect(second).rejects.toMatchObject({ code: 'cancelled' })
    } finally { await transport.close(); await close(test.value) }
  })
})
