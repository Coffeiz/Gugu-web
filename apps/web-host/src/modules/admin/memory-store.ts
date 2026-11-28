import { createHash } from 'node:crypto'

import { sql,type Transaction } from 'kysely'

import { z } from 'zod'

import { CoreError,dataContext } from '@gugu/core/contracts'

import type { Database,SqlDataRuntime } from '@gugu/core/data'

import { embedRagQuery,enqueueAgentRagRebuildInTransaction,invalidateAgentMemoryRagInTransaction,type RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'

import { createUserLongMemoryVectorRefresher,createUserPatternVectorRefresher } from '@gugu/core/byok/vector-rebuild'

import type { ProviderTransport } from '@gugu/core/providers'

import {
accountMemoryCleanupFiles,readAccountMemoryCleanupSource,type AccountMemoryCleanupPlan,
} from '@gugu/core/memory/account-cleanup-preview'

import {
publishAccountMemoryCleanup,stageAccountMemoryCleanup,type AccountMemoryCleanupFilesPort,
} from '@gugu/core/memory/account-cleanup-publication'

import { openLocalFile,removeLocalTree,writeLocalFile } from '@gugu/fs/node'

import { lockOwnerMemory,type createOwnerMemoryLock } from '../../shared/owner-memory-lock.js'

import type { createLocalUserMemoryVectorStore } from '../agent/memory/store.js'

const maxMemoryBytes = 50_000_000
const maxPublicationBytes = 6 * maxMemoryBytes
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const checksum = z.string().regex(/^[0-9a-f]{64}$/u)
const fileDigest = z.union([checksum, z.literal('missing')])
const publicationSchema = z.strictObject({
  operationId: z.uuid(), planDigest: checksum,
  before: z.strictObject({
    'pattern.json': fileDigest, 'profile.json': fileDigest, 'memory.md': fileDigest, 'daily.md': fileDigest,
    'pattern_vec.json': fileDigest, 'memory_vec.json': fileDigest, 'facts.json': fileDigest, 'facts.md': fileDigest,
  }),
  changes: z.strictObject({
    'pattern.json': z.string().optional(), 'profile.json': z.string().optional(), 'memory.md': z.string().optional(),
    'daily.md': z.string().optional(), 'pattern_vec.json': z.string().optional(), 'memory_vec.json': z.string().optional(),
  }),
  result: z.strictObject({ touched: z.boolean(), removed: z.int().nonnegative(), moved: z.int().nonnegative(),
    profileEvents: z.int().nonnegative(), daily: z.int().nonnegative() }),
})

async function readFile(root: string, key: string, limit = maxMemoryBytes): Promise<Buffer | null> {
  const file = await openLocalFile(root, key)
  if (!file) return null
  try {
    if (file.size > limit) throw new CoreError('invalid_request', '记忆文件超出读取限制')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of file.handle.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer
      bytes += buffer.length
      if (bytes > limit) throw new CoreError('invalid_request', '记忆文件超出读取限制')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks, bytes)
  } finally { await file.handle.close() }
}

function receiptId(operation: string, phase: 'stage' | 'publish'): string {
  const key = sha256(`${operation}:${phase}`)
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`
}

/** 文件发布和 RAG 使用真实隔离事务。PostgreSQL 回执提交前保留恢复用的 Local 计划。 */
export function createAccountMemoryCleanupStorage(options: { core: SqlDataRuntime; root: string; now?: () => number }) {
  const { core, root } = options
  const now = options.now ?? (() => Date.now() / 1000)
  if (core.backend !== 'postgres' || !core.receipts || process.platform !== 'linux')
    throw new CoreError('schema_upgrade_required', '记忆维护需要受支持的本地存储和数据库操作回执')

  async function lockOwner(tx: Transaction<Database>, owner: string) {
    await lockOwnerMemory(tx, owner)
    const user = await sql`SELECT id FROM users WHERE id=${owner} FOR NO KEY UPDATE`.execute(tx)
    if (!user.rows.length) throw new CoreError('not_found', '预览中的用户已不存在')
  }

  return {
    async read(ownerId: string) {
      const { ownerId: owner } = dataContext(ownerId)
      return core.db.transaction().execute(async tx => {
        await lockOwner(tx, owner)
        const files = Object.fromEntries(await Promise.all(accountMemoryCleanupFiles.map(async name =>
          [name, await readFile(root, `${owner}/.agent/memories/${name}`)] as const)))
        return readAccountMemoryCleanupSource(files, now())
      })
    },
    async apply(ownerId: string, operationId: string, plan: AccountMemoryCleanupPlan) {
      if (!z.uuid().safeParse(operationId).success) throw new CoreError('invalid_request', '记忆维护操作标识无效')
      const context = dataContext(ownerId)
      const owner = context.ownerId
      const journal = `.account-memory-cleanup/${owner}/${operationId}.json`
      const ports: AccountMemoryCleanupFilesPort = {
        read: name => readFile(root, `${owner}/.agent/memories/${name}`),
        write: (name, content) => writeLocalFile(root, `${owner}/.agent/memories/${name}`, content),
        async loadPublication() {
          const raw = await readFile(root, journal, maxPublicationBytes)
          if (!raw) return null
          try { return publicationSchema.parse(JSON.parse(raw.toString('utf8'))) }
          catch { throw new CoreError('conflict', '记忆维护的恢复记录损坏') }
        },
        async savePublication(value) {
          const text = JSON.stringify(value)
          if (Buffer.byteLength(text) > maxPublicationBytes) throw new CoreError('invalid_request', '记忆维护恢复记录超出存储限制')
          await writeLocalFile(root, journal, text)
        },
      }
      const parameters = { operationId, planDigest: sha256(JSON.stringify(plan)) }
      await core.operationWithTransaction(context, receiptId(operationId, 'stage'), 'admin.memory-cleanup.stage', parameters, async tx => {
        await lockOwner(tx, owner)
        const publication = await stageAccountMemoryCleanup(operationId, plan, ports, now())
        if (publication.result.touched) await invalidateAgentMemoryRagInTransaction(tx, core.backend, owner)
        return { touched: publication.result.touched }
      })
      const { result } = await core.operationWithTransaction(context, receiptId(operationId, 'publish'), 'admin.memory-cleanup.publish', parameters, async tx => {
        await lockOwner(tx, owner)
        const published = await publishAccountMemoryCleanup(operationId, plan, ports, now())
        if (published.touched) await enqueueAgentRagRebuildInTransaction(tx, core.backend, owner, 'memory')
        return published
      })
      await removeLocalTree(root, journal).catch(() => undefined)
      return result
    },
  }
}

/** 正文和 RAG 回执提交后，沿用当前 owner 的受控 Embedding 设置增量补算。 */
export function createAccountMemoryCleanupVectorRefresh(options: {
  store: ReturnType<typeof createLocalUserMemoryVectorStore>
  withSourceLock: ReturnType<typeof createOwnerMemoryLock>
  resolve(owner: string, signal: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
  createTransport(): ProviderTransport
}) {
  return async (owner: string, changed: { pattern: boolean; memory: boolean }) => {
    const { signal } = new AbortController()
    const config = await options.resolve(owner, signal)
    if (!config) return
    const tag = `${config.provider}:${config.model}:${config.dimensions || 'default'}`
    const transport = options.createTransport()
    try {
      const ports = {
        ...options.store, withSourceLock: options.withSourceLock,
        async embed(_owner: string, text: string, signal: AbortSignal) {
          const result = await embedRagQuery(config, text, transport, signal)
          return result.outcome === 'success' ? result.vector : null
        },
      }
      const refreshed = await Promise.allSettled([
        ...(changed.pattern ? [createUserPatternVectorRefresher(ports)(owner, tag, signal)] : []),
        ...(changed.memory ? [createUserLongMemoryVectorRefresher(ports)(owner, tag, signal)] : []),
      ])
      if (refreshed.some(result => result.status === 'rejected')) throw new Error('记忆维护后的向量补算失败')
    } finally { await transport.close?.() }
  }
}
