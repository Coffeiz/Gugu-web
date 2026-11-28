import { setTimeout as delay } from 'node:timers/promises'
import type { createILinkClient } from './client.js'

export const WECHAT_TICKET_TTL_MS = 24 * 3600 * 1000
export const WECHAT_TICKET_RETRY_MS = 2000
export const WECHAT_TICKET_MAX_RETRY_MS = 3600 * 1000
export type WechatTicketResult = { readonly status: 'ready'; readonly ticket: string; readonly stale: boolean }
  | { readonly status: 'unavailable'; readonly reason: 'empty_ticket' | 'api_failed' | 'closed' }
interface CacheEntry { ticket: string; next: number; retry: number; failed: boolean }
export interface WechatTypingOptions {
  now?(): number
  random?(): number
  fetchTimeoutMs?: number
  keepaliveMs?: number
  stopTimeoutMs?: number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  report?(code: 'ticket-unavailable' | 'typing-unavailable' | 'typing-revoked' | 'typing-stop-unavailable'): void
}
const notify = (options: WechatTypingOptions, code: Parameters<NonNullable<WechatTypingOptions['report']>>[0]) => { try { options.report?.(code) } catch { /* 诊断不影响消息与资源清理。 */ } }

/** 每可信Bot/client一个实例；ticket仅在内存，调用者取消不写失败缓存。 */
export function createWechatTypingTicketCache(client: Pick<ReturnType<typeof createILinkClient>, 'getConfig'>, options: WechatTypingOptions = {}) {
  const entries = new Map<string, CacheEntry>(), lifetime = new AbortController()
  const flights = new Map<string, { controller: AbortController; promise: Promise<WechatTicketResult>; waiters: number }>()
  const pendingFlights = new Set<{ controller: AbortController; promise: Promise<WechatTicketResult>; waiters: number }>()
  const now = options.now ?? Date.now, random = options.random ?? Math.random, timeoutMs = options.fetchTimeoutMs ?? 500
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new TypeError('微信typing预算无效')
  const projected = (entry: CacheEntry): WechatTicketResult => entry.ticket ? { status: 'ready', ticket: entry.ticket, stale: entry.failed }
    : { status: 'unavailable', reason: entry.failed ? 'api_failed' : 'empty_ticket' }
  const write = (user: string, value: CacheEntry) => { entries.delete(user); entries.set(user, value); if (entries.size > 10000) entries.delete(entries.keys().next().value!) }
  async function fetch(user: string, context: string, controller: AbortController): Promise<WechatTicketResult> {
    const deadline = new AbortController(), signal = AbortSignal.any([lifetime.signal, controller.signal, deadline.signal])
    const time = now(), previous = entries.get(user)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([client.getConfig(user, context, signal), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { deadline.abort(); reject(new Error('微信typing配置超时')) }, timeoutMs)
      })])
      signal.throwIfAborted()
      const ticket = response.typing_ticket ?? ''
      if (response.ret !== undefined && response.ret !== null && response.ret !== 0 || typeof ticket !== 'string' || ticket.length > 16384) throw new Error('微信typing配置不可用')
      const jitter = random()
      if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error('微信typing时钟不可用')
      const entry = { ticket, next: time + WECHAT_TICKET_TTL_MS * (0.5 + 0.5 * jitter), retry: WECHAT_TICKET_RETRY_MS, failed: false }
      write(user, entry); return projected(entry)
    } catch {
      if (lifetime.signal.aborted || controller.signal.aborted) throw new Error('微信typing配置请求已取消')
      const retry = previous ? Math.min(previous.retry * 2, WECHAT_TICKET_MAX_RETRY_MS) : WECHAT_TICKET_RETRY_MS
      // Python实际保留之前成功取得的ticket；不能用空字符串覆盖旧值。
      const entry = { ticket: previous?.ticket ?? '', next: time + retry, retry, failed: true }
      write(user, entry); notify(options, 'ticket-unavailable'); return projected(entry)
    } finally { if (timer) clearTimeout(timer) }
  }
  return {
    async get(user: string, context = '', signal?: AbortSignal): Promise<WechatTicketResult> {
      signal?.throwIfAborted()
      if (lifetime.signal.aborted) return { status: 'unavailable', reason: 'closed' }
      if (!user || user.length > 512 || typeof context !== 'string' || context.length > 8192) return { status: 'unavailable', reason: 'api_failed' }
      const entry = entries.get(user)
      if (entry && now() < entry.next) return projected(entry)
      let flight = flights.get(user)
      if (!flight) {
        const controller = new AbortController(), pending = { controller, waiters: 0, promise: undefined as unknown as Promise<WechatTicketResult> }
        pending.promise = fetch(user, context, controller).finally(() => { if (flights.get(user) === pending) flights.delete(user); pendingFlights.delete(pending) })
        void pending.promise.catch(() => undefined); flights.set(user, pending); pendingFlights.add(pending); flight = pending
      }
      flight.waiters++
      let abort: (() => void) | undefined
      try {
        const cancelled = new Promise<never>((_resolve, reject) => { if (signal) { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() } })
        const result = await Promise.race([flight.promise, cancelled]); signal?.throwIfAborted(); return result
      } finally {
        if (abort) signal?.removeEventListener('abort', abort)
        if (--flight.waiters === 0 && flights.get(user) === flight) { flight.controller.abort(); flights.delete(user) }
      }
    },
    async close(): Promise<void> { lifetime.abort(); for (const flight of pendingFlights) flight.controller.abort(); await Promise.allSettled([...pendingFlights].map(flight => flight.promise)); entries.clear() },
  }
}

/** 实际ON/OFF协议；每次ON授权复核，停止排空ON后才以独立边界发送OFF。 */
export function createWechatTypingIndicator(options: WechatTypingOptions & {
  client: Pick<ReturnType<typeof createILinkClient>, 'sendTyping'>
  userId: string
  ticket: string
  authorize(): Promise<boolean>
}) {
  const sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) })
  const interval = options.keepaliveMs ?? 5000, offTimeout = options.stopTimeoutMs ?? 5000
  if (!options.userId || !options.ticket || typeof options.authorize !== 'function' || !Number.isFinite(interval) || interval <= 0 || !Number.isFinite(offTimeout) || offTimeout <= 0)
    throw new TypeError('微信typing状态未完整配置')
  let controller: AbortController | undefined, task: Promise<void> | undefined, stopping: Promise<'stopped' | 'unknown'> | undefined
  let off: Promise<'stopped' | 'unknown'> | undefined, attempted = false, running = false
  function offOnce(): Promise<'stopped' | 'unknown'> {
    if (off) return off
    if (!attempted) return Promise.resolve('stopped')
    off = (async () => {
      const deadline = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([options.client.sendTyping(options.userId, options.ticket, 2, deadline.signal), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { deadline.abort(); reject(new Error('微信typing停止超时')) }, offTimeout)
        })]); return 'stopped' as const
      } catch { notify(options, 'typing-stop-unavailable'); return 'unknown' as const }
      finally { if (timer) clearTimeout(timer); deadline.abort() }
    })()
    return off
  }
  return {
    isRunning(): boolean { return running },
    async start(): Promise<void> {
      if (running) return
      if (stopping) await stopping
      if (running) return
      running = true
      controller = new AbortController(); stopping = undefined; off = undefined; attempted = false
      const signal = controller.signal
      task = (async () => {
        let revoked = false
        try {
          while (!signal.aborted) {
            let authorized = false
            try { authorized = await options.authorize() } catch { /* 复核失败与撤权一样停止。 */ }
            if (!authorized) { revoked = true; notify(options, 'typing-revoked'); break }
            signal.throwIfAborted(); attempted = true
            try { await options.client.sendTyping(options.userId, options.ticket, 1, signal) }
            catch { if (!signal.aborted) notify(options, 'typing-unavailable') }
            if (!signal.aborted) await sleep(interval, signal)
          }
        } catch { /* stop取消sleep/HTTP是正常退出；不传播平台错误。 */ }
        finally { if (revoked) await offOnce(); running = false }
      })()
    },
    stop(): Promise<'stopped' | 'unknown'> {
      if (stopping) return stopping
      stopping = (async () => { controller?.abort(); await task; return offOnce() })()
      return stopping
    },
  }
}
