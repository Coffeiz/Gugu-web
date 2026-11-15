import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { buildDocuments } from '../../../../packages/core/src/agent/rag/adapters/base.js'
import { createSqlRagPersistentIndexReader } from '../../../../packages/core/src/agent/rag/persistent-index.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createSqlRagRebuildWorker } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'

test('损坏的持久索引元数据返回脱敏状态，修复重建后可继续读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-index-corruption-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const documents = buildDocuments({
        id: 'corrupt-source', source_type: 'conversation', title: '合成会话',
        content: '可恢复索引正文', document_version: 'v1',
        scope: { scope_type: 'owner', scope_id: '' },
      })
      const writer = createSqlRagPersistentIndexWriter(runtime.db, 'sqlite')
      const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite')
      await writer.replaceDocument(ownerId, 'conversation', 'corrupt-source', documents)
      await runtime.db.updateTable('knowledge_index_entries')
        .set({ metadata_json: '{PRIVATE_SENTINEL' })
        .where('source_id', '=', 'corrupt-source')
        .execute()

      await assert.rejects(reader.snapshot(ownerId), error => error instanceof Error
        && error.message === 'RAG 索引元数据无效'
        && !error.message.includes('PRIVATE_SENTINEL'))

      const now = '2026-01-01 00:00:00.000000'
      await runtime.db.insertInto('rag_index_jobs').values({
        user_id: ownerId.replaceAll('-', ''), source_type: 'conversation', source_id: 'corrupt-source',
        pending_source_ids: JSON.stringify(['corrupt-source']), version: '', operation: 'upsert',
        status: 'queued', generation: 1, completed_generation: 0, attempts: 0,
        next_attempt_at: now, created_at: now, updated_at: now,
      }).execute()
      const rebuild = createSqlRagRebuildWorker(runtime.db, 'sqlite', {
        conversation: async () => documents,
      })
      assert.equal(await rebuild(new AbortController().signal), 'ready')
      const job = await runtime.db.selectFrom('rag_index_jobs').select('status')
        .where('source_type', '=', 'conversation').executeTakeFirst()
      assert.deepEqual(job, { status: 'ready' })
      const recovered = await reader.snapshot(ownerId)
      assert.deepEqual(recovered.documents.map(document => document.content), ['可恢复索引正文'])
    } finally {
      await runtime.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
