import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import type { Socket } from 'node:net'
import { ProviderError, classifyProviderError } from '../errors.js'
import { resolvePinnedTarget } from './network.js'
import type { AddressResolver, ResolvedAddress } from './network.js'

export interface ProxyEndpoint { readonly url: string; readonly authorization?: string; readonly ca?: string }
export interface ProviderProxyOptions { readonly http?: ProxyEndpoint; readonly https?: ProxyEndpoint; readonly all?: ProxyEndpoint; readonly noProxy?: string }

export function proxyFor(url: URL, options: ProviderProxyOptions | undefined): ProxyEndpoint | undefined {
  if (!options) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const item of (options.noProxy ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)) {
    if (item === '*') return undefined
    let name = item, specifiedPort = ''
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(item)
    if (match) { name = match[1]!.replace(/^\[|\]$/g, ''); specifiedPort = match[2]! }
    if (specifiedPort && specifiedPort !== port) continue
    name = name.replace(/^\*?\./, '')
    if (host === name || host.endsWith('.' + name)) return undefined
  }
  return (url.protocol === 'https:' ? options.https : options.http) ?? options.all
}

/** Host可显式调用的环境适配；凭据移入专用头，不进入最终代理URL或日志。 */
export function proxyOptionsFromEnvironment(env: Readonly<Record<string, string | undefined>>): ProviderProxyOptions {
  function endpoint(value: string | undefined): ProxyEndpoint | undefined {
    if (!value?.trim()) return undefined
    let url: URL
    try { url = new URL(value.trim()) } catch { throw new ProviderError('input_rejected') }
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.search || !url.hostname) throw new ProviderError('unsupported')
    const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password)
    const authorization = username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined
    url.username = ''; url.password = ''
    return { url: url.toString(), ...(authorization ? { authorization } : {}) }
  }
  return { http: endpoint(env.http_proxy ?? env.HTTP_PROXY), https: endpoint(env.https_proxy ?? env.HTTPS_PROXY), all: endpoint(env.all_proxy ?? env.ALL_PROXY), noProxy: env.no_proxy ?? env.NO_PROXY }
}

/** CONNECT目标使用已校验IP，代理不能自行重新解析用户控制的目标域名。 */
export async function openProxyTunnel(proxy: ProxyEndpoint, target: ResolvedAddress, destination: URL, signal: AbortSignal, options: { resolve?: AddressResolver; timeoutMs?: number; ca?: string }): Promise<Socket> {
  const { url, target: proxyTarget } = await resolvePinnedTarget(proxy.url, { resolve: options.resolve, allowLocal: true, signal, timeoutMs: options.timeoutMs })
  if (proxy.authorization && /[\r\n]/.test(proxy.authorization)) throw new ProviderError('input_rejected')
  const host = target.family === 6 ? `[${target.address}]` : target.address
  const address = `${host}:${destination.port || (destination.protocol === 'https:' ? 443 : 80)}`
  const socket = await new Promise<Socket>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'CONNECT', path: address, agent: false, signal,
      headers: { Host: address, ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}) },
      ...(proxy.ca ? { ca: proxy.ca } : {}),
      ...(url.protocol === 'https:' ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
      lookup: (_host, lookupOptions, callback) => lookupOptions.all ? callback(null, [{ address: proxyTarget.address, family: proxyTarget.family }]) : callback(null, proxyTarget.address, proxyTarget.family),
    })
    const timer = setTimeout(() => request.destroy(new ProviderError('timeout', { retryable: true, requestStarted: false })), options.timeoutMs ?? 10_000)
    timer.unref()
    request.once('error', error => { clearTimeout(timer); reject(signal.aborted ? new ProviderError('cancelled') : classifyProviderError(error, { requestStarted: false })) })
    request.once('connect', (response, socket, head) => {
      clearTimeout(timer)
      if (response.statusCode !== 200) { socket.destroy(); reject(new ProviderError(response.statusCode === 407 ? 'authentication' : 'network', { retryable: false, requestStarted: false })); return }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    request.end()
  })
  if (destination.protocol !== 'https:') return socket
  return new Promise<Socket>((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: destination.hostname.replace(/^\[|\]$/g, ''), ...(options.ca ? { ca: options.ca } : {}) })
    const cancel = () => secure.destroy(new ProviderError('cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => secure.destroy(new ProviderError('timeout', { requestStarted: false, retryable: true })), options.timeoutMs ?? 10_000)
    timer.unref()
    secure.once('secureConnect', () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(secure) })
    secure.once('error', error => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(classifyProviderError(error, { requestStarted: false })) })
  })
}
