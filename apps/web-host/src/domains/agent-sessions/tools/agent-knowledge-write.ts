import { dataContext } from '@gugu/core/contracts'
import { invalidateAgentKnowledgeRag, enqueueAgentRagRebuild, parseAgentKnowledgeEntry, serializeAgentKnowledgeEntry } from '@gugu/core/agent'
import type { AgentKnowledgeEntry, AgentKnowledgeReadStore } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { KnowledgeWritePort } from '@gugu/core/tools'
import { writeLocalFile } from '@gugu/fs/node'

const ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/u
const MARKER_CONTENT = 'knowledge-timestamps=iso8601-utc-v1\n'
const migrations = new Map<string, Promise<void>>()

function isoTimestamp(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('知识时间无效')
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('知识时间无效')
  if (typeof value === 'string' && !/(?:Z|[+-]\d\d(?::?\d\d)?)$/iu.test(value)) throw new Error('知识时间无效')
  const millis = typeof value === 'number' ? value * 1000 : Date.parse(value.replace(/([+-]\d\d)$/u, '$1:00'))
  if (!Number.isFinite(millis)) throw new Error('知识时间无效')
  let epochMicros = Math.round(millis * 1000)
  if (typeof value === 'string') {
    const fraction = /\.(\d+)(?=Z|[+-]\d\d(?::?\d\d)?$)/iu.exec(value)?.[1]
    if (fraction) {
      const micros = Number(fraction.slice(0, 6).padEnd(6, '0'))
      const parsedMillis = Number(fraction.slice(0, 3).padEnd(3, '0'))
      epochMicros += micros - parsedMillis * 1000
    }
  }
  const seconds = Math.floor(epochMicros / 1_000_000)
  const fraction = String(epochMicros - seconds * 1_000_000).padStart(6, '0')
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction}Z`
}

function mapTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapTimes)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['created_at', 'updated_at', 'checked_at'].includes(key) && item !== null ? isoTimestamp(item) : mapTimes(item)]))
}

function rewriteTimestamps(raw: Uint8Array): Uint8Array {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  if (!text.startsWith('---\n')) throw new Error('知识文件缺少 frontmatter')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('知识文件 frontmatter 未闭合')
  const lines = text.slice(4, end).split('\n')
  const found = new Set<string>()
  let changed = false
  const rewritten = lines.map(line => {
    const separator = line.indexOf(':')
    if (separator < 0) return line
    const key = line.slice(0, separator).trim(), value = line.slice(separator + 1).trim()
    if (key === 'created_at' || key === 'updated_at') {
      found.add(key)
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { parsed = value }
      const normalized = isoTimestamp(parsed)
      changed ||= normalized !== value
      return `${key}: ${normalized}`
    }
    if (key === 'source_json' || key === 'history_json') {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { throw new Error('知识来源时间元数据无效') }
      const normalized = JSON.stringify(mapTimes(parsed))
      changed ||= normalized !== value
      return `${key}: ${normalized}`
    }
    return line
  })
  if (found.size !== 2) throw new Error('知识文件缺少创建或更新时间')
  return changed ? new TextEncoder().encode(`${text.slice(0, 4)}${rewritten.join('\n')}\n---\n${text.slice(end + 5)}`) : raw
}

/** 知识仍以 Python 兼容 Markdown 为主存储；owner 与存储根只来自可信 Host。 */
export function createLocalAgentKnowledgeWritePort(core: Pick<SqlDataRuntime, 'db' | 'backend'>,
  storageRoot: string, store: AgentKnowledgeReadStore): KnowledgeWritePort {
  if (!storageRoot.trim() || !store || typeof store.exists !== 'function' || typeof store.list !== 'function' || typeof store.read !== 'function')
    throw new TypeError('知识写入 Host 依赖未装配')
  async function ensureTimestampMigration(owner: string): Promise<void> {
    const cacheKey = `${storageRoot}\0${owner}`
    const existing = migrations.get(cacheKey)
    if (existing) return existing
    const migration = (async () => {
      const base = `${owner}/.agent/knowledge/`, prefix = `${base}entries/`, marker = `${base}.timestamps-iso-v1`
      if (await store.exists(marker)) return
      const keys: string[] = []
      let cursor: string | null = null
      const seen = new Set<string>()
      do {
        const page = await store.list(prefix, cursor, 500)
        if (!page || !Array.isArray(page.keys) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('知识存储目录无效')
        for (const key of page.keys) {
          if (typeof key !== 'string' || !key.startsWith(prefix) || !key.endsWith('.md')
            || !ENTRY_ID.test(key.slice(prefix.length, -3))) throw new Error('知识存储目录无效')
          keys.push(key)
        }
        cursor = page.nextCursor
        if (cursor !== null && (!cursor || seen.has(cursor))) throw new Error('知识存储游标无效')
        if (cursor !== null) seen.add(cursor)
      } while (cursor !== null)
      for (const key of keys) await writeLocalFile(storageRoot, key, rewriteTimestamps(await store.read(key)))
      await writeLocalFile(storageRoot, marker, MARKER_CONTENT)
    })()
    migrations.set(cacheKey, migration)
    try { await migration } finally { if (migrations.get(cacheKey) === migration) migrations.delete(cacheKey) }
  }
  return {
    async list(identity, signal) {
      signal.throwIfAborted()
      const owner = dataContext(identity.ownerId).ownerId
      const root = `${owner}/.agent/knowledge/`, prefix = `${root}entries/`
      await ensureTimestampMigration(owner)
      signal.throwIfAborted()
      const keys: string[] = []
      let cursor: string | null = null
      const seen = new Set<string>()
      do {
        signal.throwIfAborted()
        const page = await store.list(prefix, cursor, 500)
        if (!page || !Array.isArray(page.keys) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('知识存储目录无效')
        for (const key of page.keys) {
          if (typeof key !== 'string' || !key.startsWith(prefix) || !ENTRY_ID.test(key.slice(prefix.length).replace(/\.md$/u, '')) || !key.endsWith('.md'))
            throw new Error('知识存储目录无效')
          keys.push(key)
        }
        cursor = page.nextCursor
        if (cursor !== null && (!cursor || seen.has(cursor))) throw new Error('知识存储游标无效')
        if (cursor !== null) seen.add(cursor)
      } while (cursor !== null)
      const entries: AgentKnowledgeEntry[] = []
      for (const key of keys) {
        signal.throwIfAborted()
        try {
          const entry = parseAgentKnowledgeEntry(await store.read(key))
          if (entry.id === key.slice(prefix.length, -3) && entry.scope.owner_user_id.toLowerCase() === owner.toLowerCase()) entries.push(entry)
        } catch {
          // Python KnowledgeStore.list 跳过损坏或不可读的单条记录。
        }
      }
      return entries
    },
    async commit(identity, entry, signal) {
      signal.throwIfAborted()
      const owner = dataContext(identity.ownerId).ownerId
      if (!ENTRY_ID.test(entry.id) || entry.scope.type !== 'owner' || entry.scope.owner_user_id.toLowerCase() !== owner.toLowerCase())
        throw new Error('知识 owner 或标识无效')
      const root = `${owner}/.agent/knowledge/`
      await ensureTimestampMigration(owner)
      signal.throwIfAborted()
      // 先撤回旧投影并推进 generation，保证文件更新失败也不会继续返回旧正文。
      await invalidateAgentKnowledgeRag(core.db, core.backend, owner)
      try { await writeLocalFile(storageRoot, `${root}entries/${entry.id}.md`, serializeAgentKnowledgeEntry(entry)) }
      catch (error) {
        // 即使文件写失败，也重建当前主数据状态；若重新读取仍失败，Worker 会持久重试。
        await enqueueAgentRagRebuild(core.db, core.backend, owner, 'knowledge').catch(() => undefined)
        throw error
      }
      await enqueueAgentRagRebuild(core.db, core.backend, owner, 'knowledge')
    },
  }
}

