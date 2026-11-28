import { createHash, randomUUID } from 'node:crypto'
import type { safeStorage } from 'electron'
import { imPendingAskDueAt, isImPendingAskReady, type ImPendingAskResume, type ImPendingAskScope,
  pumpImPendingAsks, type ImPendingAskStore } from '@gugu/gateway'
import { createEncryptedDesktopStore } from '../../../auth/store.js'

type Entry = ImPendingAskResume & { startedAt: number; latestActivityMs: number; leaseUntil: number }
type Cancellation = { scope: ImPendingAskScope; eventMs: number; expiresAt: number }
type State = { entries: Entry[]; cancellations: Cancellation[] }
const capacity = 100
const cancellationCapacity = 1_000
const cancellationTtlMs = 7 * 24 * 60 * 60_000
const maxPayloadBytes = 256_000
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(value)
const validTime = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
function scopeKey(scope: ImPendingAskScope): string { return createHash('sha256').update(JSON.stringify(scope)).digest('hex') }
function parseState(value: unknown): State {
  if (!isObject(value) || !Array.isArray(value.entries) || value.entries.length > capacity
    || !Array.isArray(value.cancellations) || value.cancellations.length > cancellationCapacity
    || !value.entries.every(item => isObject(item) && isObject(item.scope) && isObject(item.trigger)
      && identifier(item.resumeId) && validTime(item.latestAskMs) && validTime(item.startedAt)
      && validTime(item.latestActivityMs) && Number.isSafeInteger(item.leaseUntil)
      && identifier(item.scope.ownerId) && identifier(item.scope.botId) && identifier(item.scope.groupId)
      && ['qq', 'feishu', 'telegram'].includes(String(item.scope.platform))
      && identifier(item.trigger.eventId) && identifier(item.trigger.senderId) && identifier(item.trigger.platformMessageId)
      && validTime(item.trigger.eventMs) && isObject(item.trigger.payload)
      && Buffer.byteLength(JSON.stringify(item.trigger.payload)) <= maxPayloadBytes)
    || !value.cancellations.every(item => isObject(item) && isObject(item.scope)
      && identifier(item.scope.ownerId) && identifier(item.scope.botId) && identifier(item.scope.groupId)
      && ['qq', 'feishu', 'telegram'].includes(String(item.scope.platform))
      && validTime(item.eventMs) && validTime(item.expiresAt)))
    throw new Error('桌面 IM 延迟状态无效')
  return value as unknown as State
}

/** Desktop 持久化适配器：复用 Gateway 的延迟规则，密文落盘并串行更新。 */
export function createDesktopImPendingAskStore(directory: string,
  encryption: Pick<typeof safeStorage, 'isAsyncEncryptionAvailable' | 'decryptStringAsync' | 'encryptStringAsync'>,
  now = Date.now): ImPendingAskStore {
  const store = createEncryptedDesktopStore<State>(directory, 'im-pending-asks', encryption, parseState)
  let pending: Promise<unknown> = Promise.resolve()
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = pending.then(task)
    pending = result.catch(() => {})
    return result
  }
  async function read(): Promise<State> { return await store.read() ?? { entries: [], cancellations: [] } }
  async function update<R>(task: (state: State) => R | Promise<R>): Promise<R> {
    const state = await read()
    state.cancellations = state.cancellations.filter(item => item.expiresAt > now())
    const result = await task(state)
    await store.write(state)
    return result
  }
  const storeApi: ImPendingAskStore = {
    async register(scope, trigger, signal) {
      signal?.throwIfAborted()
      if (!identifier(scope.ownerId) || !identifier(scope.botId) || !identifier(scope.groupId)
        || !['qq', 'feishu', 'telegram'].includes(scope.platform) || !identifier(trigger.eventId)
        || !identifier(trigger.senderId) || !identifier(trigger.platformMessageId) || !validTime(trigger.eventMs)
        || !isObject(trigger.payload) || Buffer.byteLength(JSON.stringify(trigger.payload)) > maxPayloadBytes)
        throw new Error('桌面 IM 延迟请求无效')
      return serialize(() => update(state => {
        const key = scopeKey(scope), current = state.entries.find(entry => scopeKey(entry.scope) === key)
        const cancelledThrough = state.cancellations.find(item => scopeKey(item.scope) === key)?.eventMs ?? 0
        if (cancelledThrough >= trigger.eventMs) return null
        if (!current && state.entries.length >= capacity) throw new Error('桌面 IM 延迟队列已满')
        if (current && current.trigger.eventId === trigger.eventId) return current.resumeId
        if (current && trigger.eventMs < current.latestAskMs) return current.resumeId
        const at = trigger.eventMs
        const entry: Entry = current ?? { scope, trigger, resumeId: '', latestAskMs: at,
          startedAt: at, latestActivityMs: at, leaseUntil: 0 }
        entry.scope = scope
        entry.trigger = trigger
        entry.latestAskMs = at
        entry.latestActivityMs = Math.max(entry.latestActivityMs, at)
        entry.resumeId = randomUUID()
        entry.leaseUntil = 0
        if (!current) state.entries.push(entry)
        return entry.resumeId
      }))
    },
    async observe(scope, event, signal) {
      signal?.throwIfAborted()
      if (!identifier(event.senderId) || !validTime(event.eventMs)
        || event.replyTo !== undefined && !identifier(event.replyTo)) throw new Error('桌面 IM 群活动无效')
      if (event.senderId === event.ownBotId) return
      await serialize(async () => {
        const state = await read()
        const key = scopeKey(scope), index = state.entries.findIndex(entry => scopeKey(entry.scope) === key)
        const entry = state.entries[index]
        const cancels = event.directMention === true || Boolean(entry && event.replyTo !== undefined
          && event.replyTo === entry.trigger.platformMessageId && event.senderId !== entry.trigger.senderId)
        if (cancels) {
          const cancelledThrough = Math.max(event.eventMs, entry?.latestAskMs ?? 0)
          state.cancellations = state.cancellations.filter(item => scopeKey(item.scope) !== key)
          state.cancellations.push({ scope, eventMs: cancelledThrough, expiresAt: now() + cancellationTtlMs })
          if (state.cancellations.length > cancellationCapacity) state.cancellations.shift()
          if (index >= 0) state.entries.splice(index, 1)
          await store.write(state)
          return
        }
        if (!entry) return
        if (event.eventMs > entry.latestActivityMs) {
          entry.latestActivityMs = event.eventMs
          // 让正在授权中的旧 claim 失效；新消息后重新等待群聊安静窗口。
          entry.resumeId = randomUUID()
          entry.leaseUntil = 0
        }
        await store.write(state)
      })
    },
    async cancel(scope, eventMs, signal) {
      signal?.throwIfAborted()
      if (!validTime(eventMs)) throw new Error('桌面 IM 取消时间无效')
      await serialize(async () => {
        const state = await read(), key = scopeKey(scope)
        const latestAskMs = state.entries.find(entry => scopeKey(entry.scope) === key)?.latestAskMs ?? 0
        state.entries = state.entries.filter(entry => scopeKey(entry.scope) !== key)
        state.cancellations = state.cancellations.filter(item => scopeKey(item.scope) !== key)
        state.cancellations.push({ scope, eventMs: Math.max(eventMs, latestAskMs), expiresAt: now() + cancellationTtlMs })
        if (state.cancellations.length > cancellationCapacity) state.cancellations.shift()
        await store.write(state)
      })
    },
    async isCurrent(resume, signal) {
      signal?.throwIfAborted()
      return serialize(async () => (await read()).entries.some(entry => scopeKey(entry.scope) === scopeKey(resume.scope)
        && entry.resumeId === resume.resumeId && entry.latestAskMs === resume.latestAskMs))
    },
    async isCancelled(resume, signal) {
      signal?.throwIfAborted()
      const cancelled = await serialize(async () => (await read()).cancellations.some(item =>
        scopeKey(item.scope) === scopeKey(resume.scope) && item.eventMs >= resume.latestAskMs))
      return cancelled || !(await storeApi.isCurrent(resume, signal))
    },
    async claimDue(limit = 100, signal) {
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('桌面 IM 延迟批次无效')
      return serialize(() => update(state => {
        const at = now(), due: ImPendingAskResume[] = []
        for (let index = state.entries.length - 1; index >= 0; index--) {
          const entry = state.entries[index]!
          if (at >= entry.startedAt + 180_000 && !isImPendingAskReady({ startedAt: entry.startedAt,
            latestAskAt: entry.latestAskMs, latestActivityAt: entry.latestActivityMs }, at)) {
            state.entries.splice(index, 1)
            continue
          }
          if (entry.leaseUntil > at || imPendingAskDueAt({ startedAt: entry.startedAt,
            latestAskAt: entry.latestAskMs, latestActivityAt: entry.latestActivityMs }) > at
            || !isImPendingAskReady({ startedAt: entry.startedAt, latestAskAt: entry.latestAskMs,
              latestActivityAt: entry.latestActivityMs }, at)) continue
          entry.leaseUntil = at + 30_000
          due.push({ scope: entry.scope, trigger: entry.trigger, resumeId: entry.resumeId, latestAskMs: entry.latestAskMs })
          if (due.length >= limit) break
        }
        return due
      }))
    },
    async complete(resume, signal) {
      signal?.throwIfAborted()
      return serialize(() => update(state => {
        const index = state.entries.findIndex(entry => scopeKey(entry.scope) === scopeKey(resume.scope)
          && entry.resumeId === resume.resumeId && entry.latestAskMs === resume.latestAskMs)
        if (index < 0) return false
        state.entries.splice(index, 1)
        return true
      }))
    },
  }
  return storeApi
}

export function startDesktopImPendingAskPump(options: {
  store: ImPendingAskStore
  signal: AbortSignal
  authorize(resume: ImPendingAskResume, signal: AbortSignal): Promise<boolean>
  dispatch(resume: ImPendingAskResume, signal: AbortSignal): Promise<void>
  report?(code: 'pending_ask_dispatch', error: unknown): void
}): () => void {
  let running = false
  const pump = async () => {
    if (running || options.signal.aborted) return
    running = true
    try { await pumpImPendingAsks({ store: options.store, authorize: options.authorize, dispatch: options.dispatch }, options.signal) }
    catch (error) { if (!options.signal.aborted) options.report?.('pending_ask_dispatch', error) }
    finally { running = false }
  }
  const timer = setInterval(() => { void pump() }, 5_000)
  timer.unref()
  void pump()
  return () => clearInterval(timer)
}
