import { throwIfCancelled } from '../errors.js'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { once } from 'node:events'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createHash, X509Certificate } from 'node:crypto'
import type { ProviderHttpRequest, ProviderHttpResponse, ProviderTransport, ProviderTransportFactory } from '../contracts.js'
import { classifyProviderError, ProviderError } from '../errors.js'
import { resolvePinnedTarget } from './network.js'
import type { AddressResolver } from './network.js'
import { openProxyTunnel, proxyFor, proxyOptionsFromEnvironment } from './proxy.js'
import type { ProviderProxyOptions } from './proxy.js'
export { proxyOptionsFromEnvironment } from './proxy.js'

export interface NodeProviderTransportOptions {
  readonly resolve?: AddressResolver
  /** Host 明确准许本地服务；普通云/BYOK请求即使指向本地也不能继承这个开关。 */
  readonly allowLocal?: boolean
  readonly connectTimeoutMs?: number
  readonly poolTimeoutMs?: number
  readonly writeTimeoutMs?: number
  readonly maxSockets?: number
  readonly idleTimeoutMs?: number
  readonly proxy?: ProviderProxyOptions
  readonly ca?: string
  /** 搜索等受控出口可显式禁用环境代理/CA；普通模型客户端默认遵循环境。 */
  readonly trustEnvironment?: boolean
  readonly environment?: () => Readonly<Record<string, string | undefined>>
}

function environmentCa(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const files: string[] = []
  if (environment.SSL_CERT_FILE) files.push(environment.SSL_CERT_FILE)
  for (const directory of (environment.SSL_CERT_DIR ?? '').split(delimiter).filter(Boolean))
    for (const name of readdirSync(directory).sort()) if (/\.(pem|crt)$/i.test(name) || /^[a-f0-9]{8}\.\d+$/i.test(name)) files.push(join(directory, name))
  if (files.length > 4096) throw new ProviderError('input_rejected')
  const certificates = new Set<string>()
  let bytes = 0
  for (const file of files) {
    const stat = statSync(file)
    bytes += stat.size
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw new ProviderError('input_rejected')
    const content = readFileSync(file, 'utf8'), blocks = content.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    if (!blocks?.length) throw new ProviderError('input_rejected')
    for (const block of blocks) { new X509Certificate(block); certificates.add(block) }
  }
  if (!certificates.size && (environment.SSL_CERT_FILE || environment.SSL_CERT_DIR)) throw new ProviderError('input_rejected')
  return certificates.size ? [...certificates].join('\n') : undefined
}

/** CA和代理从同一环境快照解析；错误不回显路径或代理凭据。 */
function networkSnapshot(options: NodeProviderTransportOptions): NodeProviderTransportOptions {
  try {
    const environment = options.trustEnvironment === false ? {} : (options.environment?.() ?? process.env)
    if (options.ca !== undefined && !options.ca.trim()) throw new ProviderError('input_rejected')
    const ca = options.ca ?? environmentCa(environment)
    const selected = options.proxy ?? proxyOptionsFromEnvironment(environment)
    const proxy = { ...selected }
    for (const key of ['http', 'https', 'all'] as const) if (proxy[key]) proxy[key] = { ...proxy[key]!, ...(proxy[key]!.ca === undefined && ca ? { ca } : {}) }
    return { ...options, proxy, ca, trustEnvironment: false, environment: undefined }
  } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('input_rejected') }
}

/** 每次Run取真实网络配置快照；身份只含哈希，创建动作使用同一份代理与证书。 */
export function createNodeProviderTransportFactory(options: NodeProviderTransportOptions = {}): ProviderTransportFactory {
  return { snapshot: () => {
    const effective = networkSnapshot(options)
    const { environment: _environment, resolve: _resolve, ...identity } = effective
    return { networkIdentity: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), create: () => new NodeProviderTransport(effective) }
  } }
}

/** Node专属入口显式加载；portable Provider索引不依赖Node HTTP/DNS模块。 */
export class NodeProviderTransport implements ProviderTransport {
  readonly #http: HttpAgent
  readonly #https: HttpsAgent
  readonly #closing = new AbortController()
  readonly #limits = new Map<string, { active: number; queue: Set<() => void> }>()
  #closed = false
  readonly options: NodeProviderTransportOptions
  constructor(options: NodeProviderTransportOptions = {}) {
    options = networkSnapshot(options)
    this.options = options
    for (const value of [options.maxSockets, options.connectTimeoutMs, options.poolTimeoutMs, options.writeTimeoutMs, options.idleTimeoutMs])
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new ProviderError('input_rejected')
    const limits = { keepAlive: true, timeout: options.idleTimeoutMs ?? 600_000, maxSockets: options.maxSockets ?? 32, maxFreeSockets: 8 }
    this.#http = new HttpAgent(limits)
    this.#https = new HttpsAgent({ ...limits, ...(options.ca ? { ca: options.ca } : {}) })
    for (const agent of [this.#http, this.#https]) {
      const getName = agent.getName.bind(agent)
      agent.getName = options => `${getName(options)}:${String((options as typeof options & { pinnedAddress?: string }).pinnedAddress ?? '')}`
    }
  }
  async #acquire(origin: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new ProviderError('cancelled')
    let state = this.#limits.get(origin)
    if (!state) { state = { active: 0, queue: new Set() }; this.#limits.set(origin, state) }
    const entry = state
    const release = () => {
      entry.active--
      const next = entry.queue.values().next().value
      if (next) { entry.queue.delete(next); next() }
      if (!entry.active && !entry.queue.size) this.#limits.delete(origin)
    }
    if (entry.active >= (this.options.maxSockets ?? 32)) await new Promise<void>((resolve, reject) => {
      const ready = () => { cleanup(); entry.active++; resolve() }
      const cancel = () => { cleanup(); reject(new ProviderError('cancelled')) }
      const timer = setTimeout(() => { cleanup(); reject(new ProviderError('timeout', { retryable: true, requestStarted: false, timeoutPhase: 'pool' })) }, this.options.poolTimeoutMs ?? 5000)
      timer.unref()
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); entry.queue.delete(ready) }
      entry.queue.add(ready); signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
    else entry.active++
    if (signal.aborted) { release(); throw new ProviderError('cancelled') }
    let released = false
    return () => { if (!released) { released = true; release() } }
  }
  async request(input: ProviderHttpRequest, callerSignal: AbortSignal): Promise<ProviderHttpResponse> {
    const signal = AbortSignal.any([callerSignal, this.#closing.signal])
    if (this.#closed) throw new ProviderError('network', { requestStarted: false })
    throwIfCancelled(signal)
    const { url, target } = await resolvePinnedTarget(input.url, {
      resolve: this.options.resolve, allowLocal: this.options.allowLocal === true && input.allowLocal === true, signal, timeoutMs: this.options.connectTimeoutMs,
    })
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(input.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization'].includes(name.toLowerCase()) || /[\r\n]/.test(name + value))
        throw new ProviderError('input_rejected')
      headers[name] = value
    }
    let body: Uint8Array | AsyncIterable<Uint8Array> | undefined
    if (input.body instanceof Uint8Array || input.body && Symbol.asyncIterator in input.body) body = input.body as Uint8Array | AsyncIterable<Uint8Array>
    else if (input.body !== undefined) {
      body = new TextEncoder().encode(JSON.stringify(input.body))
      if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    }
    if (body instanceof Uint8Array) headers['content-length'] = String(body.byteLength)
    const secure = url.protocol === 'https:'
    const release = await this.#acquire(url.origin, signal)
    try {
    const proxy = proxyFor(url, this.options.proxy)
    const tunnel = proxy ? await openProxyTunnel(proxy, target, url, signal, { resolve: this.options.resolve, timeoutMs: this.options.connectTimeoutMs, ca: this.options.ca }) : null
    const proxyAgent = tunnel ? secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false }) : null
    // 代理隧道按请求关闭；不把不同目标/身份的隧道放入同一个keepalive origin池。
    if (proxyAgent && tunnel) proxyAgent.createConnection = () => tunnel
    return await new Promise<ProviderHttpResponse>((resolve, reject) => {
      let received = false
      let settled = false
      let failure: unknown = null
      const requestOptions = {
        method: input.method, headers, signal,
        pinnedAddress: target.address,
        agent: proxyAgent ?? (secure ? this.#https : this.#http),
        // hostname、Host与TLS SNI仍取原域名，lookup只返回已经校验的固定地址。
        lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: target.address, family: target.family }]) : callback(null, target.address, target.family),
      } satisfies import('node:http').RequestOptions & { pinnedAddress: string }
      const request = (secure ? httpsRequest : httpRequest)(url, requestOptions)
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      let writeTimer: ReturnType<typeof setTimeout> | undefined
      const armWriteTimeout = () => {
        if (writeTimer) clearTimeout(writeTimer)
        writeTimer = setTimeout(() => request.destroy(new ProviderError('timeout', { requestStarted: true, retryable: true, timeoutPhase: 'write' })), this.options.writeTimeoutMs ?? 10_000)
        writeTimer.unref()
      }
      request.once('socket', socket => {
        if (socket.connecting) {
          connectTimer = setTimeout(() => request.destroy(new ProviderError('timeout', { requestStarted: false, retryable: true, timeoutPhase: 'connect' })), this.options.connectTimeoutMs ?? 10_000)
          connectTimer.unref()
          socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer))
        }
      })
      request.setTimeout(input.timeoutMs ?? 300_000, () => request.destroy(new ProviderError('timeout', { requestStarted: true, retryable: true, timeoutPhase: 'read' })))
      request.once('error', error => {
        proxyAgent?.destroy(); tunnel?.destroy()
        release()
        failure = signal.aborted ? new ProviderError('cancelled') : classifyProviderError(error, { requestStarted: received })
        clearTimeout(connectTimer); if (writeTimer) clearTimeout(writeTimer)
        if (!settled) { settled = true; reject(signal.aborted ? new ProviderError('cancelled') : classifyProviderError(error, { requestStarted: received })) }
      })
      request.once('response', response => {
        received = true; settled = true
        clearTimeout(connectTimer)
        if (writeTimer) clearTimeout(writeTimer)
        const resultHeaders: Record<string, string> = {}
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders[name] = Array.isArray(value) ? value.join(', ') : value
        const encoding = resultHeaders['content-encoding']?.trim().toLowerCase()
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null
        if (encoding && encoding !== 'identity' && !decoder) {
          response.destroy(); request.destroy(); proxyAgent?.destroy(); tunnel?.destroy(); release(); reject(new ProviderError('protocol', { requestStarted: true })); return
        }
        if (decoder) {
          response.once('error', error => decoder.destroy(error))
          decoder.once('error', () => response.destroy())
          response.pipe(decoder)
        }
        resolve({
          status: response.statusCode ?? 0, headers: resultHeaders,
          body: (async function* () {
            try { yield* (decoder ?? response) as AsyncIterable<Uint8Array> }
            catch (error) { throw failure ?? error }
            finally { release() }
          })(),
          cancel: () => { decoder?.destroy(); response.destroy(); request.destroy(); proxyAgent?.destroy(); tunnel?.destroy(); release() },
        })
      })
      void (async () => {
        try {
          request.once('finish', () => { if (writeTimer) clearTimeout(writeTimer) })
          if (body instanceof Uint8Array) { armWriteTimeout(); request.end(body) }
          else {
            if (body) for await (const chunk of body) {
              throwIfCancelled(signal)
              if (!request.write(chunk)) {
                armWriteTimeout()
                await once(request, 'drain', { signal })
                if (writeTimer) clearTimeout(writeTimer)
              }
            }
            armWriteTimeout()
            request.end()
          }
        } catch (error) { request.destroy(error instanceof ProviderError ? error : new ProviderError(signal.aborted ? 'cancelled' : 'network')) }
      })()
    })
    } catch (error) { release(); throw error }
  }
  async close(): Promise<void> { this.#closed = true; this.#closing.abort(); this.#http.destroy(); this.#https.destroy() }
}

export function createNodeProviderTransport(options?: NodeProviderTransportOptions): NodeProviderTransport { return new NodeProviderTransport(options) }
