import { createHash } from 'node:crypto'
import type { ImConversationScope } from '@gugu/gateway'
import { QQ_FACE_PENDING_MS, QQ_REFERENCE_TTL_SECONDS, type QqEmojiRef } from '@gugu/gateway/qq'
import { createEncryptedDesktopStore } from '../../../../auth/store.js'

type Entry = Record<string, unknown>
type Stored = { expires: number; entry: Entry; attachments?: Record<number, string> }
type Face = { expires: number; refs: QqEmojiRef[] }
type State = { references: Record<string, Stored>; queued: Record<string, Face>; paired: Record<string, Face> }

export function createDesktopQqReferences(directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2], now = Date.now) {
  const store = createEncryptedDesktopStore<State>(directory, 'im-qq-references', encryption, value => {
    const state = value as State
    if (!state || !state.references || !state.queued || !state.paired) throw new Error('QQ 本地引用索引格式无效')
    return state
  })
  let pending: Promise<unknown> = Promise.resolve()
  function access<T>(signal: AbortSignal, mutate: boolean, operation: (state: State, time: number) => T) {
    const result = pending.then(async () => {
      signal.throwIfAborted()
      const state = await store.read() ?? { references: {}, queued: {}, paired: {} }
      const time = now()
      for (const entries of [state.references, state.queued, state.paired])
        for (const [key, item] of Object.entries(entries)) if (item.expires <= time) delete entries[key]
      const value = operation(state, time)
      signal.throwIfAborted()
      if (mutate) await store.write(state)
      return value
    })
    pending = result.catch(() => undefined)
    return result
  }
  const key = (scope: ImConversationScope, id: string) => {
    const prefix = createHash('sha256').update(JSON.stringify([
      scope.ownerId, scope.botId, scope.chatType, scope.chatId, scope.platformUserId,
    ])).digest('hex')
    return prefix + createHash('sha256').update(id).digest('hex')
  }
  function cap(entries: Record<string, unknown>, limit: number) {
    const keys = Object.keys(entries)
    for (const id of keys.slice(0, Math.max(0, keys.length - limit))) delete entries[id]
  }
  return {
    remember(scope: ImConversationScope, index: string, entry: Entry, signal: AbortSignal) {
      return access(signal, true, (state, time) => {
        const id = key(scope, index)
        const attachments = state.references[id]?.attachments
        delete state.references[id]
        const { content, sender_id, sender_is_bot } = entry
        state.references[id] = { expires: time + QQ_REFERENCE_TTL_SECONDS * 1000, entry: { content, sender_id, sender_is_bot }, attachments }
        cap(state.references, 2_000)
      })
    },
    read(scope: ImConversationScope, index: string, signal: AbortSignal) {
      return access(signal, false, state => {
        const stored = state.references[key(scope, index)]
        if (!stored) return null
        const indices = Object.keys(stored.attachments ?? {}).map(Number)
        const attachments = Array.from({ length: Math.max(-1, ...indices) + 1 }, () => ({}))
        return { ...stored.entry, attachments }
      })
    },
    rememberAttachments(scope: ImConversationScope, index: string, items: Record<number, string>, signal: AbortSignal) {
      return access(signal, true, state => {
        const source = state.references[key(scope, index)]
        if (source) source.attachments = items
      })
    },
    attachment(scope: ImConversationScope, index: string, fileIndex: number, signal: AbortSignal) {
      return access(signal, false, state => state.references[key(scope, index)]?.attachments?.[fileIndex] ?? null)
    },
    queueFace(scope: ImConversationScope, eventId: string, refs: readonly QqEmojiRef[], signal: AbortSignal) {
      return access(signal, true, (state, time) => {
        const id = key(scope, eventId)
        if (!state.queued[id]) state.queued[id] = { refs: [...refs], expires: time + QQ_FACE_PENDING_MS }
        cap(state.queued, 128)
      })
    },
    takeFace(scope: ImConversationScope, eventId: string, signal: AbortSignal) {
      return access(signal, true, (state, time) => {
        const id = key(scope, eventId)
        const existing = state.paired[id]
        if (existing) return existing.refs
        const queued = Object.keys(state.queued).find(item => item.startsWith(id.slice(0, 64)) && state.queued[item]!.refs.length)
        const refs = queued ? state.queued[queued]!.refs : []
        if (queued) state.queued[queued]!.refs = []
        state.paired[id] = { refs, expires: time + 60_000 }
        cap(state.paired, 128)
        return refs
      })
    },
  }
}
