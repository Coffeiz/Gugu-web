import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import Fastify from 'fastify'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createMemoryClearer } from '../../../../../packages/core/src/agent/memory-clear.js'
import { buildDocuments } from '../../../../../packages/core/src/agent/rag/adapters/base.js'
import { createSqlRagPersistentIndexReader } from '../../../../../packages/core/src/agent/rag/persistent-index.js'
import { createSqlRagPersistentIndexWriter } from '../../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createSqlRagRebuildWorker, enqueueAgentRagRebuild, invalidateAgentMemoryRag } from '../../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { registerMemoryClearRoute } from '../../../src/modules/agent/memory.js'

test('清除记忆只删除认证 owner 的 .agent 树并递增上下文版本', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-memory-clear-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  const ownerData = path.join(root, owner, '.agent', 'memories', 'memory.json')
  const otherData = path.join(root, other, '.agent', 'memories', 'memory.json')
  await mkdir(path.dirname(ownerData), { recursive: true })
  await mkdir(path.dirname(otherData), { recursive: true })
  await writeFile(ownerData, 'synthetic owner memory')
  await writeFile(otherData, 'synthetic other memory')
  const revisions: string[] = []
  const clear = createMemoryClearer({
    invalidateMemoryIndex: async () => {},
    clearOwner: async id => { await rm(path.join(root, id, '.agent'), { recursive: true, force: true }) },
    enqueueMemoryRebuild: async () => {},
    bumpContextRevision: async (id, resource) => { revisions.push(`${id}:${resource}`) },
  })
  const app = Fastify()
  registerMemoryClearRoute(app, {
    requireUser: async request => {
      if (request.headers.authorization !== 'owner') throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
    },
    ownerIdFromRequest: () => owner,
    clear,
  })
  try {
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/agent/memory' })).statusCode, 401)
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/agent/memory', headers: { authorization: 'owner' } })
    assert.equal(response.statusCode, 204, response.body)
    await assert.rejects(readFile(ownerData), { code: 'ENOENT' })
    assert.equal(await readFile(otherData, 'utf8'), 'synthetic other memory')
    assert.deepEqual(revisions, [`${owner}:memory`])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('文件清理失败时保留错误且不递增上下文版本', async () => {
  const clear = createMemoryClearer({
    invalidateMemoryIndex: async () => {},
    clearOwner: async () => { throw new Error('synthetic storage failure') },
    enqueueMemoryRebuild: async () => { assert.fail('文件清理失败时不应创建重建任务') },
    bumpContextRevision: async () => { assert.fail('不应为失败的清理发布上下文版本') },
  })
  await assert.rejects(clear('00000000-0000-4000-8000-000000000001'), /synthetic storage failure/)
})

test('记忆文件清理失败时也先撤回旧索引并 fence 正在运行的重建', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-memory-rag-invalidate-'))
  const database = path.join(root, 'core.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  try {
    const documents = buildDocuments({
      id: 'profile', source_type: 'memory', title: '合成记忆', content: '清理失败也不能继续搜索旧正文',
      document_version: 'memory-v1', scope: { scope_type: 'owner', scope_id: ownerId },
    })
    await createSqlRagPersistentIndexWriter(runtime.db, 'sqlite').replaceSource(ownerId, 'memory', documents)
    await enqueueAgentRagRebuild(runtime.db, 'sqlite', ownerId, 'memory')
    let releaseRead!: () => void
    let markReadStarted!: () => void
    const sourceReadStarted = new Promise<void>(resolve => { markReadStarted = resolve })
    const allowWrite = new Promise<void>(resolve => { releaseRead = resolve })
    const worker = createSqlRagRebuildWorker(runtime.db, 'sqlite', {
      memory: async () => { markReadStarted(); await allowWrite; return documents },
    })
    const inFlightRebuild = worker()
    await sourceReadStarted
    const before = await runtime.db.selectFrom('rag_index_jobs').select(['generation', 'status'])
      .where('source_type', '=', 'memory').executeTakeFirstOrThrow()
    assert.equal(before.status, 'running')

    const clear = createMemoryClearer({
      invalidateMemoryIndex: id => invalidateAgentMemoryRag(runtime.db, 'sqlite', id),
      clearOwner: async () => { throw new Error('synthetic storage failure') },
      enqueueMemoryRebuild: async () => { assert.fail('文件删除失败后不应启动可能读到旧文件的重建') },
      bumpContextRevision: async () => { assert.fail('文件删除失败时不应发布上下文版本') },
    })
    await assert.rejects(clear(ownerId), /synthetic storage failure/)
    releaseRead()
    assert.equal(await inFlightRebuild, 'superseded')

    assert.deepEqual((await createSqlRagPersistentIndexReader(runtime.db, 'sqlite').snapshot(ownerId)).documents, [])
    const after = await runtime.db.selectFrom('rag_index_jobs').select(['generation', 'completed_generation', 'status', 'lease_until'])
      .where('source_type', '=', 'memory').executeTakeFirstOrThrow()
    assert.deepEqual(after, {
      generation: Number(before.generation) + 1,
      completed_generation: Number(before.generation) + 1,
      status: 'ready',
      lease_until: null,
    })
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('清除记忆经路由排入 owner 全量重建并从持久索引移除旧正文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-memory-rag-clear-'))
  const database = path.join(root, 'core.db')
  const storage = path.join(root, 'storage')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  const memoryPath = path.join(storage, ownerId, '.agent', 'memories', 'memory.json')
  await mkdir(path.dirname(memoryPath), { recursive: true })
  await writeFile(memoryPath, 'synthetic memory')
  try {
    const documents = buildDocuments({
      id: 'profile', source_type: 'memory', title: '合成记忆', content: '旧的私人记忆正文',
      document_version: 'memory-v1', scope: { scope_type: 'owner', scope_id: ownerId },
    })
    const writer = createSqlRagPersistentIndexWriter(runtime.db, 'sqlite')
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite')
    await writer.replaceSource(ownerId, 'memory', documents)
    await assert.rejects(enqueueAgentRagRebuild(runtime.db, 'sqlite', ownerId, 'journal'), /RAG 索引来源无效/)
    await enqueueAgentRagRebuild(runtime.db, 'sqlite', ownerId, 'memory')

    const clear = createMemoryClearer({
      invalidateMemoryIndex: id => invalidateAgentMemoryRag(runtime.db, 'sqlite', id),
      clearOwner: id => rm(path.join(storage, id, '.agent'), { recursive: true, force: true }),
      enqueueMemoryRebuild: id => enqueueAgentRagRebuild(runtime.db, 'sqlite', id, 'memory'),
      bumpContextRevision: async () => {},
    })
    const app = Fastify()
    registerMemoryClearRoute(app, { requireUser: async () => {}, ownerIdFromRequest: () => ownerId, clear })
    try {
      const response = await app.inject({ method: 'DELETE', url: '/api/v1/agent/memory' })
      assert.equal(response.statusCode, 204, response.body)
      await assert.rejects(readFile(memoryPath), { code: 'ENOENT' })
      assert.deepEqual((await reader.snapshot(ownerId)).documents, [])
      const queued = await runtime.db.selectFrom('rag_index_jobs').select(['source_id', 'status', 'generation'])
        .where('source_type', '=', 'memory').executeTakeFirst()
      assert.deepEqual(queued, { source_id: '', status: 'queued', generation: 3 })

      const rebuild = createSqlRagRebuildWorker(runtime.db, 'sqlite', { memory: async () => [] })
      assert.equal(await rebuild(), 'ready')
      assert.deepEqual((await reader.snapshot(ownerId)).documents, [])
      const indexed = await runtime.db.selectFrom('knowledge_index_entries').select(['deleted_at'])
        .where('source_type', '=', 'memory').executeTakeFirst()
      assert.notEqual(indexed?.deleted_at, null)
    } finally {
      await app.close()
    }
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('memory 墓碑更新失败时重建任务也回滚且旧索引保持可读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-memory-rag-rollback-'))
  const database = path.join(root, 'core.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  try {
    const documents = buildDocuments({
      id: 'profile', source_type: 'memory', title: '合成记忆', content: '墓碑事务失败时仍可读',
      document_version: 'memory-v1', scope: { scope_type: 'owner', scope_id: ownerId },
    })
    await createSqlRagPersistentIndexWriter(runtime.db, 'sqlite').replaceSource(ownerId, 'memory', documents)
    await sql`CREATE TRIGGER fail_memory_index_tombstone BEFORE UPDATE ON knowledge_index_entries
      BEGIN SELECT RAISE(ABORT, 'synthetic tombstone failure'); END`.execute(runtime.db)

    await assert.rejects(enqueueAgentRagRebuild(runtime.db, 'sqlite', ownerId, 'memory'))
    const job = await runtime.db.selectFrom('rag_index_jobs').select('id')
      .where('source_type', '=', 'memory').executeTakeFirst()
    assert.equal(job, undefined)
    const snapshot = await createSqlRagPersistentIndexReader(runtime.db, 'sqlite').snapshot(ownerId)
    assert.deepEqual(snapshot.documents.map(document => document.content), ['墓碑事务失败时仍可读'])
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})
