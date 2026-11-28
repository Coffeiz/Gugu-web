import { afterEach, describe, expect, it } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { createCanvasRagSource, createNoteRagSource, createSqlRagRebuildWorker, createSqlRagPersistentIndexReader } from '../../src/agent/rag/index.js'
import { enqueueMindRagIndex } from '../../src/mind/rag-index-job.js'
import { createSqlMindCanvasReader } from '../../src/mind/canvas-read.js'
import { createSqlMindNoteMutator } from '../../src/mind/note-mutations-sql.js'
import { createSqlMindNoteReader } from '../../src/mind/note-read.js'
import { applyCanvasEdits } from '../../src/mind/canvas-edits.js'
import { tablesSql, type Database } from '../../src/data/schema.js'

const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

function setup() {
  const file = new SQLite(':memory:')
  const ddl = tablesSql('sqlite')
  file.exec(`${ddl.projects};${ddl.mindNodes};${ddl.mindMaps};${ddl.mindItems};${ddl.mindRelations};${ddl.ragJobs};${ddl.ragIndexEntries};${ddl.ragIndexIndexes.join(';')}`)
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: file }) })
  return { file, db }
}

async function addNote(db: Kysely<Database>, user: string, content: string) {
  await db.insertInto('mind_nodes').values({
    user_id: user.replaceAll('-', ''), kind: 'note', title: '测试便签', content_md: content,
    content_plain: content, color: null, ref_type: null, ref_id: null, ref_snapshot: null,
    origin: 'user', indexed_at: null, indexed_hash: 'v1', version: 1,
    captured_at: '2026-11-15 00:00:00', created_at: '2026-11-15 00:00:00',
    updated_at: '2026-11-15 00:00:00', deleted_at: null,
  }).execute()
}

describe('Mind RAG 持久新鲜度', () => {
  const opened: Array<ReturnType<typeof setup>> = []
  afterEach(async () => { for (const { db } of opened.splice(0)) await db.destroy() })

  it('便签更新在同事务入队，Worker 读取已提交主数据并替换持久投影', async () => {
    const state = setup(); opened.push(state)
    await addNote(state.db, owner, '旧正文')
    const row = await state.db.selectFrom('mind_nodes').select('id').where('user_id', '=', owner.replaceAll('-', '')).executeTakeFirstOrThrow()
    const mutator = createSqlMindNoteMutator(state.db, 'sqlite', () => '2026-11-15T00:01:00Z')
    await mutator.update(owner, Number(row.id), { version: 1, contentMd: '新正文', contentPlain: '新正文', indexedHash: 'v2' }, null)
    const reader = createSqlMindNoteReader(state.db, 'sqlite')
    const worker = createSqlRagRebuildWorker(state.db, 'sqlite', { note: createNoteRagSource(reader) }, () => new Date('2026-11-15T00:02:00Z'))
    expect(await worker()).toBe('ready')
    const indexed = await createSqlRagPersistentIndexReader(state.db, 'sqlite').snapshot(owner)
    expect(indexed.documents.some(item => (item.content ?? '').includes('新正文'))).toBe(true)
    expect(indexed.documents.some(item => (item.content ?? '').includes('旧正文'))).toBe(false)
  })

  it('无变化不入队，事务回滚撤销队列副作用，owner 任务彼此隔离', async () => {
    const state = setup(); opened.push(state)
    await addNote(state.db, owner, '保留正文')
    const row = await state.db.selectFrom('mind_nodes').select('id').where('user_id', '=', owner.replaceAll('-', '')).executeTakeFirstOrThrow()
    const mutator = createSqlMindNoteMutator(state.db, 'sqlite')
    const noChange = await mutator.update(owner, Number(row.id), { version: 1 }, null)
    expect(noChange.changed).toBe(false)
    expect((await sql`SELECT * FROM rag_index_jobs`.execute(state.db)).rows).toHaveLength(0)
    await expect(state.db.transaction().execute(async tx => {
      await enqueueMindRagIndex(tx, 'sqlite', owner.replaceAll('-', ''), 'note', String(row.id), '2026-11-15 00:00:00', 'update')
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    await enqueueMindRagIndex(state.db, 'sqlite', other.replaceAll('-', ''), 'note', '99', '2026-11-15 00:00:00', 'update')
    expect((await sql<{ user_id: string }>`SELECT user_id FROM rag_index_jobs`.execute(state.db)).rows).toEqual([{ user_id: other.replaceAll('-', '') }])
  })

  it('便签删除写墓碑，恢复重新入队且重建清除旧投影', async () => {
    const state = setup(); opened.push(state)
    await addNote(state.db, owner, '待删除正文')
    const row = await state.db.selectFrom('mind_nodes').select('id').where('user_id', '=', owner.replaceAll('-', '')).executeTakeFirstOrThrow()
    await enqueueMindRagIndex(state.db, 'sqlite', owner.replaceAll('-', ''), 'note', String(row.id), '2026-11-15 00:00:00', 'create')
    const reader = createSqlMindNoteReader(state.db, 'sqlite')
    const worker = createSqlRagRebuildWorker(state.db, 'sqlite', { note: createNoteRagSource(reader) })
    expect(await worker()).toBe('ready')
    const mutator = createSqlMindNoteMutator(state.db, 'sqlite')
    await mutator.delete(owner, Number(row.id), null)
    expect(await worker()).toBe('ready')
    expect((await createSqlRagPersistentIndexReader(state.db, 'sqlite').snapshot(owner)).documents).toHaveLength(0)
    await mutator.restore(owner, Number(row.id), null)
    expect(await worker()).toBe('ready')
    expect((await createSqlRagPersistentIndexReader(state.db, 'sqlite').snapshot(owner)).documents).toHaveLength(1)
  })

  it('画布任务以全来源语义重建，删除清除画布投影、恢复后重新建立', async () => {
    const state = setup(); opened.push(state)
    const now = '2026-11-15 00:00:00.000000', user = owner.replaceAll('-', '')
    await state.db.insertInto('mind_maps').values({ user_id: user, title: '投影画布', project_id: null, data_json: '{}', created_at: now, updated_at: now, deleted_at: null }).execute()
    const canvas = await state.db.selectFrom('mind_maps').select('id').executeTakeFirstOrThrow()
    await state.db.insertInto('mind_nodes').values({ user_id: user, kind: 'canvas_note', title: '画布内容', content_md: '画布正文', content_plain: '画布正文', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: 'v1', version: 1, captured_at: now, created_at: now, updated_at: now, deleted_at: null }).execute()
    const node = await state.db.selectFrom('mind_nodes').select('id').executeTakeFirstOrThrow()
    await state.db.insertInto('mind_canvas_items').values({ user_id: user, canvas_id: Number(canvas.id), node_id: Number(node.id), x: 0, y: 0, w: null, h: null, z: 0, collapsed: 0, data_json: '{}', created_at: now, updated_at: now, deleted_at: null }).execute()
    const reader = createSqlMindCanvasReader(state.db, 'sqlite')
    const worker = createSqlRagRebuildWorker(state.db, 'sqlite', { canvas: createCanvasRagSource(reader) })
    await enqueueMindRagIndex(state.db, 'sqlite', user, 'canvas', '', now, 'create')
    expect(await worker()).toBe('ready')
    expect((await createSqlRagPersistentIndexReader(state.db, 'sqlite').snapshot(owner)).documents.some(doc => (doc.content ?? '').includes('画布正文'))).toBe(true)
    await state.db.updateTable('mind_maps').set({ deleted_at: now, updated_at: now }).where('id', '=', Number(canvas.id)).execute()
    await enqueueMindRagIndex(state.db, 'sqlite', user, 'canvas', '', now, 'delete')
    expect(await worker()).toBe('ready')
    expect((await createSqlRagPersistentIndexReader(state.db, 'sqlite').snapshot(owner)).documents).toHaveLength(0)
    await state.db.updateTable('mind_maps').set({ deleted_at: null, updated_at: now }).where('id', '=', Number(canvas.id)).execute()
    await enqueueMindRagIndex(state.db, 'sqlite', user, 'canvas', '', now, 'update')
    expect(await worker()).toBe('ready')
    expect((await createSqlRagPersistentIndexReader(state.db, 'sqlite').snapshot(owner)).documents.some(doc => (doc.content ?? '').includes('画布正文'))).toBe(true)
  })

  it('画布布局编辑只在投影版本变化时入队，批量调用不重复增加 generation', async () => {
    const state = setup(); opened.push(state)
    const now = '2026-11-15 00:00:00.000000', user = owner.replaceAll('-', '')
    await state.db.insertInto('mind_maps').values({ user_id: user, title: '布局测试', project_id: null, data_json: '{}', created_at: now, updated_at: now, deleted_at: null }).execute()
    const canvas = await state.db.selectFrom('mind_maps').select('id').executeTakeFirstOrThrow()
    await state.db.insertInto('mind_nodes').values({ user_id: user, kind: 'canvas_note', title: '布局节点', content_md: '内容', content_plain: '内容', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: 'v1', version: 1, captured_at: now, created_at: now, updated_at: now, deleted_at: null }).execute()
    const node = await state.db.selectFrom('mind_nodes').select('id').executeTakeFirstOrThrow()
    await state.db.insertInto('mind_canvas_items').values({ user_id: user, canvas_id: Number(canvas.id), node_id: Number(node.id), x: 10, y: 20, w: null, h: null, z: 0, collapsed: 0, data_json: '{}', created_at: now, updated_at: now, deleted_at: null }).execute()
    const item = await state.db.selectFrom('mind_canvas_items').select('id').executeTakeFirstOrThrow()
    const edit = (x: number) => state.db.transaction().execute(tx => applyCanvasEdits(tx, 'sqlite', owner, {
      action: 'layout', canvas_id: Number(canvas.id), batched: true, entries: [{ item_id: Number(item.id), x }],
    }, '', new AbortController().signal))

    expect((await edit(10)).mutated).toBe(false)
    expect((await sql`SELECT * FROM rag_index_jobs`.execute(state.db)).rows).toHaveLength(0)
    expect((await edit(50)).mutated).toBe(true)
    const queued = (await sql<{ generation: number; source_type: string }>`SELECT generation,source_type FROM rag_index_jobs`.execute(state.db)).rows
    expect(queued).toEqual([{ generation: 1, source_type: 'canvas' }])
    expect((await edit(50)).mutated).toBe(false)
    expect((await sql<{ generation: number }>`SELECT generation FROM rag_index_jobs`.execute(state.db)).rows).toEqual([{ generation: 1 }])
  })
})
