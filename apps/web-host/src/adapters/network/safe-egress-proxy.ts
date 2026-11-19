import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { ProviderHttpResponse, ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import type { SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'
import { validateSafeEgressProxyUrl } from '@gugu/core/preferences/safe-egress-update'
import { decryptEncryptedString } from '../security/encrypted-string.js'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest, Agent } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'
import { SafeEgressProbeError } from '@gugu/core/preferences/safe-egress-probe'

export interface SafeEgressProxy { url: string; authorization?: string; ca?: string }
/** DoH 使用固定可信域名作为 CONNECT 目标；业务目标使用已验证 IP。 */
export async function safeEgressRequest(proxy: SafeEgressProxy, origin: URL, connectHost: string, timeoutMs: number, signal?: AbortSignal): Promise<{status:number; body:string}> {
  signal?.throwIfAborted()
  const endpoint = new URL(proxy.url), started = Date.now()
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started))
  let tunnel: Socket | undefined, secure: TLSSocket | undefined, agent: Agent | undefined
  try {
    tunnel = await new Promise<Socket>((resolve, reject) => {
      const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80')
      const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)({
        hostname: endpoint.hostname.replace(/^\[|\]$/g, ''), port, method: 'CONNECT', path: `${connectHost}:443`, agent: false, signal,
        headers: { Host: `${connectHost}:443`, ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}) },
        ...(proxy.ca ? { ca: proxy.ca } : {}),
      })
      const timer = setTimeout(() => request.destroy(new Error('超时')), remaining())
      request.once('error', () => { clearTimeout(timer); reject(new SafeEgressProbeError('proxy_unavailable', '代理连接失败或代理拒绝建立隧道')) })
      request.once('connect', (response, socket, head) => {
        clearTimeout(timer)
        if (response.statusCode !== 200) { socket.destroy(); reject(new SafeEgressProbeError('proxy_unavailable', response.statusCode === 407 ? '代理认证失败（HTTP 407）' : '代理连接失败或代理拒绝建立隧道')); return }
        if (head.length) socket.unshift(head)
        resolve(socket)
      })
      request.end()
    })
    signal?.throwIfAborted()
    secure = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = tlsConnect({ socket: tunnel, servername: origin.hostname, ...(proxy.ca ? { ca: proxy.ca } : {}) })
      const timer = setTimeout(() => socket.destroy(new Error('超时')), remaining())
      const abort = () => socket.destroy(new Error('已取消'))
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      signal?.addEventListener('abort', abort, { once: true })
      socket.once('secureConnect', () => { cleanup(); resolve(socket) })
      socket.once('error', () => { cleanup(); reject(new SafeEgressProbeError('tls_verification_failed', '目标站点 TLS 握手或证书验证失败，已拒绝连接')) })
    })
    agent = new Agent({ keepAlive: false })
    agent.createConnection = () => secure!
    return await new Promise((resolve, reject) => {
      const request = httpsRequest(origin, { method:'GET', agent, signal, headers: origin.hostname === 'cloudflare-dns.com' ? { accept:'application/dns-json' } : { 'User-Agent':'Gugu-web/1.0' } }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error('响应过大')); else chunks.push(chunk) })
        response.once('error', reject)
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      const timer = setTimeout(() => request.destroy(new Error('超时')), remaining())
      request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end()
    })
  } finally { agent?.destroy(); secure?.destroy(); tunnel?.destroy() }
}

function configuredProxy(settings: SafeEgressReadSettings, secretKey: string): SafeEgressProxy | undefined {
  if (!settings.enabled) return undefined
  const url = validateSafeEgressProxyUrl(settings.proxy_url)
  if (!settings.proxy_auth_secret) return { url }
  const auth: unknown = JSON.parse(decryptEncryptedString(secretKey, settings.proxy_auth_secret))
  if (!auth || typeof auth !== 'object' || !('username' in auth) || !('password' in auth)
    || typeof auth.username !== 'string' || typeof auth.password !== 'string') throw new Error('代理认证配置无效')
  return { url, authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` }
}

async function resolveThroughProxy(proxy: SafeEgressProxy, hostname: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const records = await Promise.all(['A', 'AAAA'].map(async type => {
    const url = new URL('https://cloudflare-dns.com/dns-query')
    url.searchParams.set('name', hostname)
    url.searchParams.set('type', type)
    const response = await safeEgressRequest(proxy, url, 'cloudflare-dns.com', 5_000, signal)
    if (response.status !== 200) throw new Error('安全 DNS 查询失败')
    const reply = JSON.parse(response.body)
    if (reply?.Status !== 0) throw new Error('安全 DNS 查询失败')
    return Array.isArray(reply.Answer) ? reply.Answer : []
  }))
  signal.throwIfAborted()
  return records.flat().flatMap((record: { type?: unknown; data?: unknown } | null) => {
    if (typeof record?.data !== 'string' || (record.type !== 1 && record.type !== 28)) return []
    const family = isIP(record.data)
    if (family !== (record.type === 1 ? 4 : 6)) throw new Error('安全 DNS 记录无效')
    return [{ address: record.data, family: family as 4 | 6 }]
  })
}


/** 公网 Agent 请求使用当前管理员出站策略，DNS 解析和实际连接固定同一个公网 IP。 */
export function createPublicAgentEgress(readSettings: () => SafeEgressReadSettings, secretKey: string) {
  function transportFor(signal: AbortSignal) {
    signal.throwIfAborted()
    const proxy = configuredProxy(readSettings(), secretKey)
    const proxyHostname = proxy ? new URL(proxy.url).hostname : null
    return createNodeProviderTransport({
      allowLocal: false, trustEnvironment: false, connectTimeoutMs: 10_000, writeTimeoutMs: 10_000,
      ...(proxy ? {
        proxy: { all: proxy },
        async resolve(hostname) {
          // 管理员代理本身使用可信系统 DNS，业务目标走代理 DoH。
          if (hostname === proxyHostname) {
            return (await lookup(hostname, { all: true })).flatMap(value =>
              value.family === 4 || value.family === 6 ? [{ address: value.address, family: value.family }] : [])
          }
          return resolveThroughProxy(proxy, hostname, signal)
        },
      } : {}),
    })
  }
  return {
    assertConfigured() { configuredProxy(readSettings(), secretKey) },
    async withTransport<T>(signal: AbortSignal, execute: (transport: ProviderTransport) => Promise<T>): Promise<T> {
      const transport = transportFor(signal)
      try { return await execute(transport) }
      finally { await transport.close() }
    },
    /** 流由调用方消费，消费结束、失败或取消后释放出站连接。 */
    async open(url: string, signal: AbortSignal): Promise<ProviderHttpResponse> {
      const transport = transportFor(signal)
      let response: ProviderHttpResponse
      try {
        response = await transport.request({ url, method: 'GET', headers: { 'User-Agent': 'Gugu-web/1.0' }, timeoutMs: 30_000 }, signal)
      } catch (error) {
        await transport.close()
        throw error
      }
      let closing: Promise<void> | undefined
      function close(reason?: unknown) {
        closing ??= Promise.resolve().then(() => response.cancel(reason)).finally(() => transport.close())
        return closing
      }
      const abort = () => { void close(signal.reason).catch(() => undefined) }
      if (signal.aborted) {
        await close(signal.reason)
        signal.throwIfAborted()
      }
      signal.addEventListener('abort', abort, { once: true })
      const release = (reason?: unknown) => {
        signal.removeEventListener('abort', abort)
        return close(reason)
      }
      return {
        status: response.status, headers: response.headers,
        body: (async function* () { try { yield* response.body } finally { await release() } })(),
        cancel: release,
      }
    },
  }
}
