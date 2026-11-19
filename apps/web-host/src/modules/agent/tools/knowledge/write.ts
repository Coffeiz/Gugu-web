import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { invalidateAgentKnowledgeRag, enqueueAgentRagRebuild, enqueueAgentRagRebuildInTransaction,
  invalidateAgentKnowledgeRagInTransaction } from '@gugu/core/agent/rag'
import { parseAgentKnowledgeEntry, serializeAgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import type { AgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import type { AgentKnowledgeReadStore } from '@gugu/core/agent/knowledge/overview'
import type { ToolResult } from '@gugu/core/agent'
import type { Database, SqlDataRuntime } from '@gugu/core/data'
import type { KnowledgeDeletePort, KnowledgeWritePort } from '@gugu/core/tools'
import type { Transaction } from 'kysely'
import { writeLocalFile } from '@gugu/fs/node'
import type { createWebAgentToolConfirmation } from '../confirm.js'

const ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/u
const MARKER_CONTENT = 'knowledge-timestamps=iso8601-utc-v1\n'
const migrations = new Map<string, Promise<void>>()

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

async function lockKnowledge(tx: Transaction<Database>, owner: string, backend: SqlDataRuntime['backend']) {
  if (backend === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'agent-knowledge:' + owner}, 0))`.execute(tx)
}

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

/** 知识以 Node Host 授权的 owner Markdown 为主存储；owner 与存储根只来自可信 Host。 */
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
      try {
        await core.db.transaction().execute(async tx => {
          await lockKnowledge(tx, owner, core.backend)
          const key = `${root}entries/${entry.id}.md`
          if (await store.exists(key)) {
            const current = parseAgentKnowledgeEntry(await store.read(key))
            const unchanged = current.version === entry.version
              && digest(serializeAgentKnowledgeEntry(current)) === digest(serializeAgentKnowledgeEntry(entry))
            if (!current.active || current.id !== entry.id || current.scope.owner_user_id !== owner
              || !(unchanged || current.version + 1 === entry.version)) throw new Error('知识条目已变化')
          } else if (entry.version !== 1) throw new Error('知识条目已变化')
          signal.throwIfAborted()
          await writeLocalFile(storageRoot, key, serializeAgentKnowledgeEntry(entry))
        })
      }
      catch (error) {
        // 即使文件写失败，也重建当前主数据状态；若重新读取仍失败，Worker 会持久重试。
        await enqueueAgentRagRebuild(core.db, core.backend, owner, 'knowledge').catch(() => undefined)
        throw error
      }
      await enqueueAgentRagRebuild(core.db, core.backend, owner, 'knowledge')
    },
  }
}

/** 确认认领和删除计划持久化后才发布文件墓碑，重放仅复核该计划中的精确文件版本。 */
export function createLocalAgentKnowledgeDeletePort(core: SqlDataRuntime, storageRoot: string,
  store: AgentKnowledgeReadStore, confirmation: Pick<ReturnType<typeof createWebAgentToolConfirmation>, 'gate' | 'claim'>): KnowledgeDeletePort {
  if (!core.receipts || core.backend !== 'postgres') throw new Error('知识删除持久收据不可用')
  type Identity = Parameters<KnowledgeDeletePort['reconcile']>[0]
  type Plan = { before: string; after: string }
  const noReceipt = new Error('知识删除收据不存在')
  const changed = new Error('知识条目已变化')
  const failed = (): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error: changed.message } })
  const keyFor = (owner: string, id: string) => `${owner}/.agent/knowledge/entries/${id}.md`
  function coordinates(identity: Identity, phase: 'plan' | 'finish') {
    const context = dataContext(identity.ownerId)
    const method = `agent.knowledge.delete.${phase}`
    const hex = digest(JSON.stringify([method, context.ownerId, identity.sessionId, identity.runId, identity.roundId, identity.toolCallId]))
    return { context, method, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` }
  }
  async function read(owner: string, id: string) {
    if (!ENTRY_ID.test(id)) return null
    const key = keyFor(owner, id)
    if (!await store.exists(key)) return null
    const raw = await store.read(key)
    let entry: AgentKnowledgeEntry
    try { entry = parseAgentKnowledgeEntry(raw) } catch { return null }
    if (entry.id !== id || entry.scope.type !== 'owner' || entry.scope.owner_user_id !== owner) return null
    return { entry, version: digest(raw), key }
  }
  const tombstone = (entry: AgentKnowledgeEntry) => serializeAgentKnowledgeEntry({ ...entry, active: false })
  async function finish(identity: Identity, id: string, plan: Plan): Promise<ToolResult> {
    const operation = coordinates(identity, 'finish')
    const owner = operation.context.ownerId
    const receipt = await core.operationWithTransaction(operation.context, operation.id, operation.method, { id }, async tx => {
      await lockKnowledge(tx, owner, core.backend)
      const current = await read(owner, id)
      const needsWrite = current?.entry.active === true && current.version === plan.before
      const alreadyWritten = current?.entry.active === false && current.version === plan.after
      if (needsWrite || alreadyWritten) await invalidateAgentKnowledgeRagInTransaction(tx, core.backend, owner, id)
      if (needsWrite) await writeLocalFile(storageRoot, current.key, tombstone(current.entry))
      // 即使目标已被其它操作修改，也要恢复计划阶段撤回的有效索引。
      await enqueueAgentRagRebuildInTransaction(tx, core.backend, owner, 'knowledge')
      return { success: needsWrite || alreadyWritten, knowledge_id: id }
    })
    return { kind: 'completed', successful: receipt.result.success, mutated: receipt.result.success && !receipt.replayed, value: receipt.result }
  }
  return {
    gate: confirmation.gate,
    async readTarget(identity, id, signal) {
      signal.throwIfAborted()
      const owner = dataContext(identity.ownerId).ownerId
      const current = await read(owner, id)
      signal.throwIfAborted()
      if (!current?.entry.active) return null
      const title = [...current.entry.title.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 200).join('')
      return { knowledgeId: id, snapshot: {
        targetsDigest: digest(JSON.stringify([owner, id])), versionsDigest: current.version, targetRefs: { knowledge_id: [id] },
        displaySummary: `将删除知识条目「${title}」，保留历史但停止检索`,
      } }
    },
    async commit(identity, target, claim, signal) {
      const id = target.knowledgeId
      const operation = coordinates(identity, 'plan')
      const owner = operation.context.ownerId
      try {
        const receipt = await core.operationWithTransaction(operation.context, operation.id, operation.method, { id }, async tx => {
          await lockKnowledge(tx, owner, core.backend)
          const current = await read(owner, id)
          if (!current?.entry.active || current.version !== target.snapshot.versionsDigest
            || !await confirmation.claim(tx, claim, signal)) throw changed
          await invalidateAgentKnowledgeRagInTransaction(tx, core.backend, owner, id)
          return { before: current.version, after: digest(tombstone(current.entry)) }
        }, { signal })
        if (signal.aborted) return { kind: 'unknown' }
        return await finish(identity, id, receipt.result)
      } catch (error) { return error === changed ? failed() : { kind: 'unknown' } }
    },
    async reconcile(identity, id) {
      const operation = coordinates(identity, 'plan')
      try {
        const receipt = await core.operationWithTransaction<Plan>(operation.context, operation.id, operation.method, { id }, async () => { throw noReceipt })
        return await finish(identity, id, receipt.result)
      } catch { return { kind: 'unknown' } }
    },
  }
}

