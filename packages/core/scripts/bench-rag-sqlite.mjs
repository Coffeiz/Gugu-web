// 在临时 SQLite 数据库中对照快照读取和元数据更新。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../dist/data/sqlite.js'
import { createSqlRagPersistentIndexReader } from '../dist/agent/rag/persistent-index.js'
import { createSqlRagPersistentIndexWriter } from '../dist/agent/rag/persistent-writer.js'
import { createRagLexicalCorpusCache } from '../dist/agent/rag/lexical-index.js'
import { configureRagJieba } from '../dist/agent/rag/tokenizer.js'
import { getAgentRagJieba } from '../dist/agent/rag/node-jieba.js'

const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-sqlite-ab-'))
let runtime
try {
  const path = join(directory, 'fixture.db')
  await initializeSqlite(path)
  const opened = await openSqliteRuntime(path)
  runtime = opened.runtime
  const { db } = runtime
  const owner = opened.ownerId.replaceAll('-', '')
  const text = '云雀项目设备采购计划、验收记录、接口测试和周报。'.repeat(12)
  await sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<88000)
    INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,document_id,document_version,content,content_hash,metadata_json,indexed_at,deleted_at)
    SELECT ${owner},'conversation',CAST(x AS TEXT),CAST(x AS TEXT),'v1',${text}||x,'synthetic',
      json_object('kind','message','message_id',x,'context_current',${text}||x),'2026-01-01 00:00:00',
      CASE WHEN x>22000 THEN '2026-01-01 00:00:00' END FROM n`.execute(db)

  const baseline = createSqlRagPersistentIndexReader(db, 'sqlite')
  const optimized = createSqlRagPersistentIndexReader(db, 'sqlite', { cacheSqliteOwner: true })
  const read = reader => reader.snapshotForScope(opened.ownerId, { scope_type: 'owner' })
  const timed = async reader => {
    const start = performance.now()
    const snapshot = await read(reader)
    return { ms: Math.round(performance.now() - start), snapshot }
  }
  await read(optimized)
  const timings = { baseline: [], optimized: [] }
  for (let i = 0; i < 5; i++) {
    const first = i % 2 ? optimized : baseline
    const second = first === baseline ? optimized : baseline
    const a = await timed(first), b = await timed(second)
    assert.deepEqual(a.snapshot, b.snapshot)
    timings.baseline.push(first === baseline ? a.ms : b.ms)
    timings.optimized.push(first === optimized ? a.ms : b.ms)
  }
  console.log({ warmSnapshotMs: timings })

  const writer = createSqlRagPersistentIndexWriter(db, 'sqlite')
  const initial = await read(optimized)
  // 合成种子的哈希先由正式写入器补齐。
  await writer.replaceSource(opened.ownerId, 'conversation', initial.documents)
  const ready = await read(optimized)
  const rebuildStarted = performance.now()
  const rebuild = await writer.replaceSource(opened.ownerId, 'conversation', ready.documents)
  const rebuildMs = Math.round(performance.now() - rebuildStarted)
  const after = await timed(optimized)
  assert.deepEqual(rebuild, { inserted: 0, updated: 0, deleted: 0 })
  assert.deepEqual(after.snapshot, ready)
  console.log({ identicalRebuildMs: rebuildMs, rows: ready.documents.length, writes: rebuild.updated, nextSnapshotMs: after.ms })

  const jieba = getAgentRagJieba()
  let cuts = 0
  configureRagJieba({ cut(text) { cuts++; return jieba.cut(text) } })
  const cache = createRagLexicalCorpusCache()
  const original = await read(optimized)
  cache(owner, original.revision, original.documents)
  await sql`UPDATE knowledge_index_entries SET source_updated_at='2026-01-01 00:00:01'
    WHERE owner_user_id=${owner} AND deleted_at IS NULL`.execute(db)
  const changed = await read(optimized)
  assert.notEqual(changed.documents[0].updated_at, original.documents[0].updated_at)
  cuts = 0
  const start = performance.now()
  const index = cache(owner, changed.revision, changed.documents)
  const elapsed = Math.round(performance.now() - start)
  assert.equal(cuts, 0)
  const fresh = createRagLexicalCorpusCache()(owner, changed.revision, changed.documents)
  const query = candidate => candidate.search(owner, '云雀项目设备采购', 10, ['conversation'])
  assert.deepEqual(query(index).results, query(fresh).results)
  console.log({ metadataSyncMs: elapsed, repeatedDocumentCuts: 0, freshDocumentCuts: cuts })
} finally {
  await runtime?.close()
  await rm(directory, { recursive: true })
}
