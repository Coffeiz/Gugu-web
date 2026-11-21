import type { DesktopMemoryFiles } from './desktop-files.js'
import { splitUserMemoryVectorChunks, userMemoryVectorChunkKey } from '../../byok/vector-rebuild.js'
import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../data/schema.js'
import { stableJson } from '../context/history/canonical-history.js'
import type { RunIdentity, ToolResult } from '../models.js'
import { sqliteAgentRunScope } from '../run/sqlite-store.js'
import type { MemorySearchPort, RememberMemoryPort } from '../tools/memory.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import { loadAgentMemoryContext, type AgentMemoryVectorSearchPort } from './context.js'
import { createMemorySearch, MemorySearchAccessError } from '../rag/memory-search.js'
import { configureRagJieba } from '../rag/tokenizer.js'
import type { RagQueryEmbeddingSettings } from '../rag/query-embedding.js'
import type { RagDocument } from '../rag/contracts.js'
import type { RagVectorSource } from '../rag/vector-reader.js'
import { enqueueAgentRagRebuildInTransaction, invalidateAgentMemoryRagInTransaction } from '../rag/rebuild-worker.js'
import { embedRagQuery } from '../rag/query-embedding.js'
import { createNodeProviderTransport, desktopTransportOptions, type NodeProviderTransportOptions } from '../providers/transport/node.js'
import type { ProviderTransport } from '../providers/contracts.js'
import { getAgentRagJieba } from '../rag/node-jieba.js'
import { applyRememberEdit, type MemoryRow } from './remember.js'

type CallIdentity = Parameters<RememberMemoryPort['mutate']>[0]
type MemoryInput = Parameters<RememberMemoryPort['mutate']>[1]

function rejected(error: string): ToolResult {
  return { kind: 'completed', successful: false, mutated: false, value: { error } }
}

function parseRows(body: string | undefined): MemoryRow[] {
  if (body === undefined) return []
  const rows: unknown = JSON.parse(body)
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.text !== 'string'))
    throw new Error('个人记忆数据无效')
  return rows
}

async function captureMemory(db: Kysely<Database>, ownerId: string, signal: AbortSignal, disk?: DesktopMemoryFiles) {
  signal.throwIfAborted()
  const { files: snapshot, revision } = await readSqliteAgentMemorySnapshot(db, ownerId, signal, disk)
  const rows = Object.entries(snapshot).map(([target, body]) => ({ target, body }))
  const jsonTargets = new Set(['profile', 'pattern'])
  const files = new Map(rows.map(row => [`${ownerId}/.agent/memories/${row.target}.${['daily', 'memory'].includes(row.target) ? 'md' : 'json'}`,
    jsonTargets.has(row.target) ? JSON.stringify(parseRows(row.body)) : row.body]))
  return {
    files: Object.fromEntries(rows.map(row => [row.target, row.body])),
    patterns: parseRows(rows.find(row => row.target === 'pattern')?.body),
    revision,
    storage: {
      async readText(input: Parameters<import('./context.js').AgentMemoryContextStorage['readText']>[0]) {
        input.signal?.throwIfAborted()
        return input.ownerId === ownerId ? files.get(input.key)?.slice(0, input.maxChars) ?? null : null
      },
    },
  }
}

/** 返回反思写入前的 SQLite 记忆快照；只读取固定的个人记忆目标。 */
export async function readSqliteAgentMemorySnapshot(db: Kysely<Database>, ownerId: string, signal?: AbortSignal, disk?: DesktopMemoryFiles) {
  signal?.throwIfAborted()
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const { rows } = await sql<{ target: string; body: string }>`SELECT target,body FROM desktop_agent_memory
    WHERE user_id=${owner}
    UNION ALL
    SELECT target,body FROM desktop_agent_memory_documents WHERE user_id=${owner}
    ORDER BY target`.execute(db)
  const files = { ...(disk?.ownerId === ownerId ? await disk.readAll() : {}), ...Object.fromEntries(rows.map(row => [row.target, row.body])) }
  signal?.throwIfAborted()
  return { files, revision: createHash('sha256').update(stableJson(files)).digest('hex') }
}

function embeddingTransport(settings: RagQueryEmbeddingSettings, resolveProxy?: NodeProviderTransportOptions['resolveProxy']) {
  const allowLocal = settings.allowLocal === true && ['local', 'ollama'].includes(settings.provider.trim().toLowerCase())
  return createNodeProviderTransport(desktopTransportOptions(allowLocal, resolveProxy))
}

function memoryEmbeddingVersion(settings: RagQueryEmbeddingSettings) {
  return createHash('sha256').update(stableJson([
    settings.provider, settings.baseUrl, settings.model, settings.dimensions, settings.multimodal === true,
  ])).digest('hex')
}

function memoryVectorKey(ownerId: string, version: string, text: string) {
  return createHash('sha256').update(stableJson([ownerId, version, text.trim()])).digest('hex')
}

async function fillMemoryVectors<T>(
  candidates: Iterable<T>, signal: AbortSignal | undefined,
  fill: (candidate: T, batchSignal: AbortSignal) => Promise<void>,
) {
  // 正文补算共用一个截止时间，保留截止前完成的向量。
  const deadline = AbortSignal.timeout(4_000)
  const batchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  for (const candidate of candidates) {
    signal?.throwIfAborted()
    if (deadline.aborted) break
    try { await fill(candidate, batchSignal) }
    catch (error) {
      signal?.throwIfAborted()
      if (error !== deadline.reason || !deadline.aborted) throw error
      break
    }
  }
  signal?.throwIfAborted()
}

export function createSqliteAgentMemoryVectorSearch(ownerId: string, patterns: MemoryRow[], settings: RagQueryEmbeddingSettings,
  createTransport: (settings: RagQueryEmbeddingSettings) => ProviderTransport = embeddingTransport,
  memory = '', disk?: DesktopMemoryFiles): AgentMemoryVectorSearchPort & {
    embedDocument(text: string, signal: AbortSignal): Promise<readonly number[]>
    close(): Promise<void>
  } {
  const version = memoryEmbeddingVersion(settings)
  let transport: ProviderTransport | undefined
  let patternVectors: Promise<Record<string, { v: number[]; t: string }>> | undefined
  const client = () => transport ??= createTransport(settings)
  async function embedDocument(text: string, signal: AbortSignal) {
    const cache = disk?.ownerId === ownerId ? disk : undefined
    const key = memoryVectorKey(ownerId, version, text)
    signal.throwIfAborted()
    const cached = (await cache?.readMemoryVectors([key]).catch(() => null))?.get(key)
    signal.throwIfAborted()
    if (cached && (!settings.dimensions || cached.length === settings.dimensions)) return cached
    const result = await embedRagQuery(settings, text, client(), signal, cache ? undefined : ownerId)
    if (result.outcome !== 'success') return []
    signal.throwIfAborted()
    await cache?.writeMemoryVector(key, result.vector).catch(() => {})
    signal.throwIfAborted()
    return result.vector
  }
  return {
    embedDocument,
    async embed(candidateOwner, query, signal) {
      signal?.throwIfAborted()
      if (candidateOwner !== ownerId) throw new MemorySearchAccessError('RAG 检索未授权')
      const result = await embedRagQuery(settings, query, client(), signal ?? new AbortController().signal, ownerId)
      signal?.throwIfAborted()
      return result.outcome === 'success' && result.vector.length ? { vector: result.vector, modelTag: version } : null
    },
    async read(candidateOwner, kind, signal) {
      signal?.throwIfAborted()
      if (candidateOwner !== ownerId) throw new MemorySearchAccessError('RAG 检索未授权')
      if (kind === 'memory') {
        const chunks = splitUserMemoryVectorChunks(memory)
        // 聊天热路径限制补算量。更大的正文继续使用共享的最近记忆规则。
        if (chunks.length > 32) return {}
        const vectors: Record<string, { v: number[]; t: string }> = {}
        await fillMemoryVectors(new Set(chunks), signal, async (chunk, batchSignal) => {
          const vector = await embedDocument(chunk, batchSignal)
          if (vector.length) vectors[userMemoryVectorChunkKey(chunk)] = { v: vector, t: version }
        })
        return vectors
      }
      return patternVectors ??= Promise.all(patterns.slice(-8).map(async (pattern, offset) => {
        signal?.throwIfAborted()
        const result = await embedRagQuery(settings, pattern.text, client(), signal ?? new AbortController().signal, ownerId)
        signal?.throwIfAborted()
        const id = typeof pattern.id === 'string' && pattern.id ? pattern.id : `pattern:${patterns.length - Math.min(patterns.length, 8) + offset}`
        return [id, result.outcome === 'success' && result.vector.length ? { v: result.vector, t: version } : null] as const
      })).then(rows => Object.fromEntries(rows.filter((row): row is readonly [string, { v: number[]; t: string }] => row[1] !== null)))
    },
    async close() { await transport?.close?.() },
  }
}

/** 桌面本地 RAG 的受限记忆文件投影；只映射固定目标，不接受任意路径。 */
export function createSqliteAgentMemoryRagStorage(db: Kysely<Database>, disk?: DesktopMemoryFiles) {
  const files = new Map([
    ['profile.json', 'profile'], ['pattern.json', 'pattern'], ['facts.json', 'facts'],
    ['memory.md', 'memory'], ['daily.md', 'daily'],
  ])
  return {
    async readText(input: { ownerId: string; key: string; maxChars: number; signal?: AbortSignal }): Promise<string | null> {
      input.signal?.throwIfAborted()
      const ownerId = dataContext(input.ownerId).ownerId
      const prefix = `${input.ownerId}/.agent/memories/`
      if (!input.key.startsWith(prefix)) return null
      const target = files.get(input.key.slice(prefix.length))
      if (!target) return null
      const { rows } = await sql<{ body: string }>`SELECT body FROM desktop_agent_memory
        WHERE user_id=${ownerId.replaceAll('-', '')} AND target=${target}
        UNION ALL
        SELECT body FROM desktop_agent_memory_documents
        WHERE user_id=${ownerId.replaceAll('-', '')} AND target=${target} LIMIT 1`.execute(db)
      input.signal?.throwIfAborted()
      return (rows[0]?.body ?? (disk?.ownerId === ownerId ? await disk.readTarget(target) : undefined))?.slice(0, input.maxChars) ?? null
    },
  }
}

function isOwnerLongMemoryDocument(document: RagDocument) {
  return document.source_type === 'memory' && (document.metadata?.memory_source_id ?? document.source_id) === 'memory'
    && document.scope_type === 'owner' && !document.scope_id
}

/** SQLite Memory 向量复用同一 Web query/schema/model-version 契约。 */
export async function createSqliteAgentMemoryRagVectors(db: Kysely<Database>, ownerId: string, settings: RagQueryEmbeddingSettings, disk?: DesktopMemoryFiles, resolveProxy?: NodeProviderTransportOptions['resolveProxy']) {
  const { patterns } = await captureMemory(db, ownerId, new AbortController().signal, disk)
  const search = createSqliteAgentMemoryVectorSearch(ownerId, patterns, settings, value => embeddingTransport(value, resolveProxy), undefined, disk)
  const version = memoryEmbeddingVersion(settings)
  return {
    version,
    async warmDocuments(documents: readonly RagDocument[], signal: AbortSignal) {
      if (disk?.ownerId !== ownerId) return
      const candidates = documents.filter(isOwnerLongMemoryDocument).slice(-32)
      await fillMemoryVectors(candidates, signal, async (document, batchSignal) => {
        await search.embedDocument(document.content || document.text, batchSignal)
      })
    },
    async readDocuments(candidateOwner: string, documents: readonly RagDocument[], signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (candidateOwner !== ownerId) throw new MemorySearchAccessError('RAG 检索未授权')
      if (disk?.ownerId !== ownerId) return {}
      const eligible = documents.filter(isOwnerLongMemoryDocument)
      const keys = eligible.map(document => memoryVectorKey(ownerId, version, document.content || document.text))
      const cached = await disk.readMemoryVectors(keys).catch(() => null)
      signal?.throwIfAborted()
      return Object.fromEntries(eligible.flatMap((document, index) => {
        const vector = cached?.get(keys[index]!)
        return vector && (!settings.dimensions || settings.dimensions === vector.length) ? [[document.id, vector]] : []
      }))
    },
    async source(candidateOwner: string, signal?: AbortSignal): Promise<RagVectorSource> {
      signal?.throwIfAborted()
      if (candidateOwner !== ownerId) throw new MemorySearchAccessError('RAG 检索未授权')
      return async (kind, readSignal) => {
        readSignal?.throwIfAborted()
        if (kind !== 'pattern') return null
        return JSON.stringify(await search.read(candidateOwner, kind, readSignal))
      }
    },
    async embed(candidateOwner: string, query: string, signal?: AbortSignal) {
      const result = await search.embed(candidateOwner, query, signal)
      return result?.vector ?? []
    },
    close: () => search.close(),
  }
}

/** 单次读取捕获个人记忆版本，供本轮快照选择和投影共用。 */
export async function readSqliteAgentMemory(db: Kysely<Database>, ownerId: string, query: string, signal: AbortSignal,
  embedding?: RagQueryEmbeddingSettings, disk?: DesktopMemoryFiles, resolveProxy?: NodeProviderTransportOptions['resolveProxy']) {
  const { files, storage, revision, patterns } = await captureMemory(db, ownerId, signal, disk)
  const vectors = embedding ? createSqliteAgentMemoryVectorSearch(ownerId, patterns, embedding, value => embeddingTransport(value, resolveProxy), files.memory, disk) : undefined
  try {
    const memory = await loadAgentMemoryContext({ ownerId, query, signal, now: Date.now(), storage,
      ...(vectors ? { vectorSearch: vectors } : {}) })
    return { memory, revision }
  } finally { await vectors?.close() }
}

export function createSqliteMemorySearch(db: Kysely<Database>, authorize: (identity: RunIdentity) => Promise<boolean>,
  embedding?: RagQueryEmbeddingSettings, disk?: DesktopMemoryFiles, resolveProxy?: NodeProviderTransportOptions['resolveProxy']): MemorySearchPort {
  configureRagJieba(getAgentRagJieba())
  return {
    async search(identity, request, signal) {
      signal.throwIfAborted()
      if (!await authorize(identity)) throw new MemorySearchAccessError('RAG 检索未授权')
      const { storage, revision, patterns } = await captureMemory(db, identity.ownerId, signal, disk)
      const config = request.strategy !== 'bm25' && (!request.source || ['all', 'pattern', 'memory'].includes(request.source))
        ? embedding : undefined
      const vectors = config
        ? createSqliteAgentMemoryVectorSearch(identity.ownerId, patterns, config, value => embeddingTransport(value, resolveProxy), undefined, disk)
        : undefined
      const version = config ? memoryEmbeddingVersion(config) : ''
      const search = createMemorySearch({
        resolveScopes: async (_identity, scope) => scope === 'auto' || scope === 'private_memory'
          ? [{ ownerId: identity.ownerId, type: 'owner', id: identity.ownerId }]
          : [],
        authorize: target => authorize(target),
        snapshot: async () => ({ revision, text: '' }),
        storage: () => ({
          async readText(input) {
            if (input.ownerId === identity.ownerId && input.key === `${identity.ownerId}/.agent/memories/pattern_vec.json` && vectors) {
              if (!await authorize(identity)) throw new MemorySearchAccessError('RAG 检索未授权')
              return JSON.stringify(await vectors.read(identity.ownerId, 'pattern', input.signal ?? signal))
            }
            return storage.readText(input)
          },
        }),
        ...(vectors ? { vectors: async () => ({
          version,
          async readMissing(documents, operationSignal) {
            const result = new Map<string, readonly number[]>()
            const memory = documents.filter(document => document.source_id === 'memory')
            // 检索热路径限制待补算的正文片段数量。
            await fillMemoryVectors(memory.slice(0, 32), operationSignal, async (document, batchSignal) => {
              if (!await authorize(identity)) throw new MemorySearchAccessError('RAG 检索未授权')
              const vector = await vectors.embedDocument(document.content || document.text, batchSignal)
              if (vector.length) result.set(document.id, vector)
            })
            return result
          },
          async embed(text, operationSignal) {
            if (!await authorize(identity)) throw new MemorySearchAccessError('RAG 检索未授权')
            return (await vectors.embed(identity.ownerId, text, operationSignal))?.vector ?? []
          },
        }) } : {}),
        scopeState: { async getMemoryScopeState() { throw new MemorySearchAccessError('桌面会话没有群聊记忆权限') } },
      })
      try { return await search(identity, request, signal) }
      finally { await vectors?.close() }
    },
  }
}

export async function clearSqliteAgentMemory(db: Kysely<Database>, ownerId: string, disk?: DesktopMemoryFiles) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const failure = await db.transaction().execute(async tx => {
    const active = await sql`SELECT 1 FROM conversation_sessions WHERE user_id=${owner}
      AND execution_state IN ('running','waiting','baseline_updating') LIMIT 1`.execute(tx)
    if (active.rows.length) throw new CoreError('busy', '请先结束正在运行的会话')
    await invalidateAgentMemoryRagInTransaction(tx, 'sqlite', ownerId)
    try { if (disk?.ownerId === ownerId) await disk.clear() }
    catch (error) { return { error } } // 落盘出错时仍提交索引墓碑，防止继续召回已清理的内容。
    await sql`DELETE FROM desktop_agent_memory WHERE user_id=${owner}`.execute(tx)
    await sql`DELETE FROM desktop_agent_memory_documents WHERE user_id=${owner}`.execute(tx)
    await sql`DELETE FROM desktop_agent_memory_receipts WHERE user_id=${owner}`.execute(tx)
    await sql`DELETE FROM desktop_agent_reflection_jobs WHERE user_id=${owner}`.execute(tx)
    await sql`UPDATE conversation_sessions SET context_epoch=context_epoch+1,snapshot_expires_at='1970-01-01T00:00:00.000Z'
      WHERE user_id=${owner}`.execute(tx)
    return null
  })
  if (failure) throw failure.error
}

export async function forgetSqliteAgentMemory(db: Kysely<Database>, ownerId: string, query: string,
  revision?: string, disk?: DesktopMemoryFiles,
) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const result = await db.transaction().execute(async tx => {
    const { files } = await readSqliteAgentMemorySnapshot(tx, ownerId, undefined, disk)
    const currentRevision = createHash('sha256').update(stableJson([query, files.profile, files.pattern])).digest('hex')
    if (revision !== undefined && revision !== currentRevision)
      throw new CoreError('conflict', '记忆已变更，请重新发起删除')
    const updates = (['profile', 'pattern'] as const).map(target => {
      const before = parseRows(files[target])
      const { rows } = applyRememberEdit(before, { target, text: '', remove: [query] }, 0, () => '')
      return { target, rows, removed: before.length - rows.length }
    }).filter(({ removed }) => removed > 0)
    const count = updates.reduce((sum, item) => sum + item.removed, 0)
    if (revision !== undefined && count > 0) {
      for (const { target, rows } of updates)
        await sql`INSERT INTO desktop_agent_memory(user_id,target,body) VALUES(${owner},${target},${JSON.stringify(rows)})
          ON CONFLICT(user_id,target) DO UPDATE SET body=excluded.body`.execute(tx)
      await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', ownerId, 'memory')
    }
    return { count, revision: currentRevision }
  })
  if (revision !== undefined && result.count > 0) await disk?.flush().catch(() => { /* SQLite 保留待落盘正文。 */ })
  return result
}

/** 画像和行为模式沿用 Web 编辑规则；SQLite 事务提交正文和工具收据。 */
export function createSqliteRememberMemory(db: Kysely<Database>, disk?: DesktopMemoryFiles): RememberMemoryPort {
  async function receipt(conn: Kysely<Database>, identity: CallIdentity, input: MemoryInput) {
    const { owner, session, run } = sqliteAgentRunScope(identity)
    const fingerprint = createHash('sha256').update(stableJson(input)).digest('hex')
    const { rows } = await sql<{ fingerprint: string; result: string }>`
      SELECT fingerprint,result FROM desktop_agent_memory_receipts WHERE user_id=${owner} AND session_id=${session}
        AND run_id=${run} AND round_id=${identity.roundId} AND call_id=${identity.toolCallId}`.execute(conn)
    return { owner, session, run, fingerprint, row: rows[0] }
  }
  return {
    async mutate(identity, input, signal, edit) {
      signal.throwIfAborted()
      if (input.text.length > 4000) return rejected('记忆内容过长')
      const result = await db.transaction().execute<ToolResult>(async tx => {
        const { owner, session, run, fingerprint, row } = await receipt(tx, identity, input)
        if (row) return row.fingerprint === fingerprint ? JSON.parse(row.result) as ToolResult : { kind: 'unknown' }
        const authorized = await sql`SELECT 1 FROM conversation_sessions s
          JOIN agent_run_leases l ON l.user_id=s.user_id AND l.session_id=s.id AND l.run_id=s.active_run_id
          LEFT JOIN agent_run_controls c ON c.user_id=l.user_id AND c.session_id=l.session_id AND c.run_id=l.run_id
          WHERE s.user_id=${owner} AND s.id=${session} AND s.active_run_id=${run}
            AND l.expires_at_ms > ${Date.now()} AND coalesce(c.cancel_requested,0)=0`.execute(tx)
        if (!authorized.rows.length) return rejected('当前运行无权写入个人记忆')
        const current = await sql<{ body: string }>`SELECT body FROM desktop_agent_memory
          WHERE user_id=${owner} AND target=${input.target}`.execute(tx)
        let updated: ReturnType<typeof edit>
        try { updated = edit(parseRows(current.rows[0]?.body ?? (disk?.ownerId === identity.ownerId ? await disk.readTarget(input.target) : undefined))) }
        catch { return rejected('记忆修改未完成，当前内容未更改') }
        signal.throwIfAborted()
        const body = JSON.stringify(updated.rows)
        if (Buffer.byteLength(body) > 2_000_000) return rejected('个人记忆容量已满')
        await sql`INSERT INTO desktop_agent_memory(user_id,target,body) VALUES(${owner},${input.target},${body})
          ON CONFLICT(user_id,target) DO UPDATE SET body=excluded.body`.execute(tx)
        await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', identity.ownerId, 'memory')
        const result: ToolResult = { kind: 'completed', successful: true, mutated: true, value: updated.value }
        await sql`INSERT INTO desktop_agent_memory_receipts(user_id,session_id,run_id,round_id,call_id,fingerprint,result)
          VALUES(${owner},${session},${run},${identity.roundId},${identity.toolCallId},${fingerprint},${JSON.stringify(result)})`.execute(tx)
        return result
      })
      await disk?.flush()
      return result
    },
    async reconcile(identity, input) {
      const { row, fingerprint } = await receipt(db, identity, input)
      return row?.fingerprint === fingerprint ? JSON.parse(row.result) as ToolResult : { kind: 'unknown' }
    },
  }
}
