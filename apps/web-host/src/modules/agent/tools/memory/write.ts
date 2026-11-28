import { createHash, randomBytes } from 'node:crypto'
import type { Transaction } from 'kysely'
import { CoreError } from '@gugu/core'
import { dataContext } from '@gugu/core/contracts'
import { embedRagQuery, enqueueAgentRagRebuildInTransaction, invalidateAgentMemoryRagInTransaction,
  type RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import { stableJson, type ToolResult } from '@gugu/core/agent'
import { createUserPatternVectorRefresher } from '@gugu/core/byok/vector-rebuild'
import type { Database, SqlDataRuntime } from '@gugu/core/data'
import type { ProviderTransport } from '@gugu/core/providers'
import type { MemoryRow, RememberInput, RememberMemoryPort } from '@gugu/core/tools'
import { PROFILE_TYPES } from '@gugu/core/tools'
import { openLocalFile, removeLocalTree, writeLocalFile } from '@gugu/fs/node'
import { lockOwnerMemory, lockOwnerMemoryArchive } from '../../../../shared/owner-memory-lock.js'
import { createLocalUserMemoryVectorStore } from '../../memory/store.js'

type Identity = Parameters<RememberMemoryPort['reconcile']>[0]
type Plan = { before: string; after: string; archiveRevision: string | null; added: number; removed: number; staleVectorIds: string[] }
type Final = { success: boolean; added: number; removed: number }
class InvalidMemorySnapshot extends Error {}
const missingReceipt = new Error('记忆写入尚无持久计划')
const digest = (text: string | null) => createHash('sha256').update(text === null ? 'absent:' : 'present:' + text).digest('hex')
const profileTypes = new Set<string>(PROFILE_TYPES)
const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)

function parseRows(raw: string | null, target: RememberInput['target']): MemoryRow[] {
  if (!raw?.trim()) return []
  let items: unknown
  try { items = JSON.parse(raw) } catch { throw new InvalidMemorySnapshot('记忆文件无法读取，请先修复') }
  if (!Array.isArray(items)) throw new InvalidMemorySnapshot('记忆文件无法读取，请先修复')
  return items.flatMap(item => {
    const text = typeof item === 'string' && target === 'profile' ? item.trim()
      : object(item) && typeof item.text === 'string' ? item.text.trim() : ''
    if (!text) return []
    if (target === 'pattern') return [{ ...item, text }]
    const rawType = object(item) && typeof item.type === 'string' ? item.type.trim() : ''
    return [{ type: profileTypes.has(rawType) ? rawType : 'note', text, ts: object(item) ? item.ts ?? null : null }]
  })
}

/**
 * Node 使用 owner 锁串行化文件发布；档案、待发布正文与向量均留在授权文件根。
 */
export function createLocalAgentRememberPort(options: {
  core: SqlDataRuntime
  storageRoot: string
  authorize(tx: Transaction<Database>, identity: Identity, signal: AbortSignal): Promise<boolean>
  embedding?: {
    resolve(ownerId: string, signal: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
}): RememberMemoryPort {
  const { core, storageRoot } = options
  if (core.backend !== 'postgres' || !core.receipts) throw new Error('记忆写入需要 PostgreSQL 持久收据')
  const vectorStore = createLocalUserMemoryVectorStore(storageRoot)
  async function lockArchive(tx: Transaction<Database>, owner: string) {
    const archive = await lockOwnerMemoryArchive(tx, owner)
    if (!archive) throw new InvalidMemorySnapshot('记忆写入授权已失效')
    return archive
  }

  const withSourceLock = <T>(owner: string, operation: () => Promise<T>) =>
    core.db.transaction().execute(async tx => {
      await lockOwnerMemory(tx, owner)
      if ((await lockArchive(tx, owner)).busy) throw new Error('档案迁移期间不能更新记忆')
      return operation()
    })

  async function refreshPatternVectors(owner: string, signal: AbortSignal) {
    const embedding = options.embedding
    if (!embedding) return
    const settings = await embedding.resolve(owner, signal)
    signal.throwIfAborted()
    if (!settings) return
    const modelTag = `${settings.provider}:${settings.model}:${settings.dimensions || 'default'}`
    // 每次刷新拥有独立 transport，结束后释放连接。
    const transport = embedding.createTransport(settings)
    try {
      await createUserPatternVectorRefresher({
        ...vectorStore, withSourceLock,
        async embed(_ownerId, text, embedSignal) {
          const result = await embedRagQuery(settings, text, transport, embedSignal)
          return result.outcome === 'success' ? result.vector : null
        },
      })(owner, modelTag, signal)
    } finally { await transport.close?.() }
  }

  async function read(key: string, fatal = true) {
    const file = await openLocalFile(storageRoot, key)
    if (!file) return null
    try {
      if (file.size > 50_000_000) throw new InvalidMemorySnapshot('记忆文件超出读取限制')
      const bytes = await file.handle.readFile()
      if (bytes.length > 50_000_000) throw new InvalidMemorySnapshot('记忆文件超出读取限制')
      return new TextDecoder('utf-8', { fatal }).decode(bytes)
    } finally { await file.handle.close() }
  }

  function coordinates(identity: Identity, phase: 'plan' | 'finish') {
    const context = dataContext(identity.ownerId)
    const method = `agent.memory.remember.${phase}`
    const hash = digest(stableJson([method, context.ownerId, identity.sessionId, identity.runId, identity.roundId, identity.toolCallId]))
    return { context, method, id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}` }
  }

  async function readExisting(base: string, raw: string | null, target: RememberInput['target']) {
    if (raw !== null || target === 'profile') return parseRows(raw, target)
    const previous = await read(`${base}facts.json`)
    if (previous?.trim()) {
      try { return parseRows(previous, 'pattern') }
      catch (error) { if (!(error instanceof InvalidMemorySnapshot)) throw error }
    }
    const markdown = await read(`${base}facts.md`)
    return (markdown ?? '').split(/\r?\n/u).flatMap(line => {
      const text = line.trim().replace(/^-+/u, '').trim()
      return text ? [{ id: randomBytes(3).toString('hex'), text, kind: 'observed', conf: 0.75, imp: 3, ts: Date.now() / 1000 }] : []
    })
  }

  async function pruneVectors(base: string, staged: string, stale: readonly string[]) {
    const key = `${base}pattern_vec.json`
    const raw = await read(key, false)
    if (raw === null) return
    let cache: unknown
    try { cache = JSON.parse(raw) } catch { cache = null }
    const active = new Set(parseRows(staged, 'pattern').map(row => row.id))
    const staleIds = new Set(stale)
    const retained = object(cache) ? Object.fromEntries(Object.entries(cache).filter(([id]) => active.has(id) && !staleIds.has(id))) : {}
    if (!object(cache) || Object.keys(cache).length !== Object.keys(retained).length)
      await writeLocalFile(storageRoot, key, JSON.stringify(retained))
  }

  const failure = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })

  async function finish(identity: Identity, input: RememberInput, plan: Plan, stagedKey: string, signal = new AbortController().signal): Promise<ToolResult> {
    const { context, method, id } = coordinates(identity, 'finish')
    const owner = context.ownerId, base = `${owner}/.agent/memories/`
    const receipt = await core.operationWithTransaction<Final>(context, id, method, { ...input }, async tx => {
      await lockOwnerMemory(tx, owner)
      const archive = await lockArchive(tx, owner)
      if (archive.busy || !await options.authorize(tx, identity, signal)) throw new Error('记忆发布暂不可用')
      signal.throwIfAborted()
      const key = `${base}${input.target}.json`
      const current = digest(await read(key))
      const matches = current === plan.after || (archive.revision === plan.archiveRevision && current === plan.before)
      if (matches && current !== plan.after) {
        const staged = await read(stagedKey)
        if (staged === null || digest(staged) !== plan.after) throw new InvalidMemorySnapshot('记忆写入暂存版本已变化')
        if (input.target === 'pattern') await pruneVectors(base, staged, plan.staleVectorIds)
        await writeLocalFile(storageRoot, key, staged)
      }
      await enqueueAgentRagRebuildInTransaction(tx, core.backend, owner, 'memory')
      return { success: matches, added: plan.added, removed: plan.removed }
    })
    await removeLocalTree(storageRoot, stagedKey).catch(() => undefined)
    if (!receipt.result.success) return failure('记忆文件已变化，请重新读取后再试')
    if (input.target === 'pattern' && options.embedding && !signal.aborted) {
      try {
        const allowed = await core.db.transaction().execute(tx => options.authorize(tx, identity, signal))
        if (allowed && !signal.aborted) await refreshPatternVectors(owner, signal)
      } catch {
        // 向量补齐失败时保留已提交的档案与重建调度，沿用 Python 的尽力同步。
      }
    }
    return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: {
      success: true, target: input.target, added: receipt.result.added, removed: receipt.result.removed,
      ...(input.text ? { remembered: input.text } : {}),
    } }
  }

  return {
    async mutate(identity, input, signal, edit) {
      const { context, method, id } = coordinates(identity, 'plan')
      const owner = context.ownerId, base = `${owner}/.agent/memories/`, stagedKey = `${base}.remember/${id}.json`
      try {
        const receipt = await core.operationWithTransaction<Plan>(context, id, method, { ...input }, async tx => {
          await lockOwnerMemory(tx, owner)
          signal.throwIfAborted()
          if (!await options.authorize(tx, identity, signal)) throw new InvalidMemorySnapshot('记忆写入授权已失效')
          const archive = await lockArchive(tx, owner)
          if (archive.busy) throw new InvalidMemorySnapshot('档案迁移期间不能更新记忆')
          const raw = await read(`${base}${input.target}.json`)
          const before = await readExisting(base, raw, input.target)
          let next: ReturnType<typeof edit>
          try { next = edit(before) }
          catch { throw new InvalidMemorySnapshot('记忆修改未完成，当前内容未更改') }
          if (!input.text && input.remove.length && next.value.removed === 0
            && stableJson(before) === stableJson(next.rows)) {
            return { before: digest(raw), after: digest(raw), archiveRevision: archive.revision,
              added: 0, removed: 0, staleVectorIds: [] }
          }
          const after = JSON.stringify(next.rows, null, 2)
          const retained = new Map(next.rows.map(row => [row.id, row.text]))
          const staleVectorIds = input.target === 'pattern' ? before.flatMap(row =>
            typeof row.id === 'string' && retained.get(row.id) !== row.text ? [row.id] : []) : []
          signal.throwIfAborted()
          await writeLocalFile(storageRoot, stagedKey, after)
          await invalidateAgentMemoryRagInTransaction(tx, core.backend, owner, input.target)
          return { before: digest(raw), after: digest(after), archiveRevision: archive.revision,
            added: next.value.added, removed: next.value.removed, staleVectorIds }
        }, { signal })
        if (signal.aborted) return { kind: 'unknown' }
        return await finish(identity, input, receipt.result, stagedKey, signal)
      } catch (error) {
        if (error instanceof InvalidMemorySnapshot || error instanceof CoreError && error.code === 'conflict') return failure(error.message)
        signal.throwIfAborted()
        return { kind: 'unknown' }
      }
    },
    async reconcile(identity, input) {
      const { context, method, id } = coordinates(identity, 'plan')
      try {
        const plan = await core.operationWithTransaction<Plan>(context, id, method, { ...input }, async () => { throw missingReceipt })
        return await finish(identity, input, plan.result, `${context.ownerId}/.agent/memories/.remember/${id}.json`)
      } catch (error) {
        if (error instanceof CoreError && error.code === 'conflict') return failure(error.message)
        return { kind: 'unknown' }
      }
    },
  }
}
