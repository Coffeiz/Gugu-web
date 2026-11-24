import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createPostgresFileUpdateOperations } from '../../../src/modules/files/store.js'

const owner = '11111111-1111-4111-8111-111111111111'
const sourceKey = `${owner}/个人文件/笔记.md`
const targetKey = `${owner}/个人文件/新笔记.md`

test('确认 COMMIT 已提交但响应丢失后保留数据库新路径和文件，并返回成功', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'file-update-commit-unknown-'))
  const source = path.join(root, ...sourceKey.split('/'))
  const target = path.join(root, ...targetKey.split('/'))
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, '合成正文')

  const before: Record<string, unknown> = {
    user_id: owner, display_name: '笔记', ext: 'md', space: 'personal',
    workspace_directory_id: null, project_id: null, stage_name: '',
    mind_map_id: null, path: sourceKey, version: 1, size: '12 B', size_bytes: 12,
    mime_type: 'text/markdown', created_at: new Date('2026-01-01T00:00:00Z'),
    deleted_at: null, img_width: null, img_height: null,
  }
  let durable = { ...before }
  let pending: Record<string, unknown> | null = null
  let commitCount = 0

  const query = async <Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<Row>> => {
    const statement = sql.trim()
    let rows: Record<string, unknown>[] = []
    if (statement === 'BEGIN') pending = { ...durable }
    else if (statement.startsWith('SELECT * FROM files')) rows = pending ? [{ ...pending }] : []
    else if (statement.startsWith('SELECT pg_advisory_xact_lock')) rows = [{}]
    else if (statement.startsWith('SELECT 1 FROM files')) rows = []
    else if (statement.startsWith('UPDATE files SET display_name=')) {
      assert.ok(pending)
      pending = { ...pending, display_name: values[3], ext: values[4], stage_name: values[5],
        project_id: values[6], workspace_directory_id: values[7],
        space: values[8], path: values[9], version: 2 }
      rows = [{ ...pending }]
    } else if (statement === 'COMMIT') {
      commitCount += 1
      durable = { ...(pending ?? durable) }
      pending = null
      throw new Error('模拟数据库已提交但 COMMIT 响应丢失')
    } else if (statement === 'ROLLBACK') pending = null
    else if (statement.startsWith('SELECT p.name project_name')) rows = []
    else if (statement.startsWith('SELECT path,version FROM files')) rows = [{ path: durable.path, version: durable.version }]
    else throw new Error(`测试桩未识别 SQL: ${statement.slice(0, 48)}`)
    return { rows, rowCount: rows.length } as unknown as QueryResult<Row>
  }
  const client = { query, release() {} } as unknown as PoolClient
  const pool = { connect: async () => client, query } as unknown as Pool
  const events: string[] = []

  try {
    const operations = createPostgresFileUpdateOperations(pool, {
      storageRoot: root,
      async publishChanged(event) { events.push(event.entityId) },
    })
    const result = await operations.update(owner, sourceKey, {
      version: 1, displayName: '新笔记', folderPathSet: false, projectSet: false, workspaceDirectorySet: false,
    }, { idempotencyKey: null, undoContextId: null, clientId: 'test' }) as { displayName: string; version: number }

    assert.equal(commitCount, 1)
    assert.equal(result.displayName, '新笔记')
    assert.equal(result.version, 2)
    assert.equal(durable.path, targetKey)
    assert.equal(await readFile(target, 'utf8'), '合成正文')
    await assert.rejects(readFile(source), { code: 'ENOENT' })
    assert.deepEqual(events, [targetKey])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('无法核实 COMMIT 结果时保留原路径和目标路径中的文件副本', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'file-update-commit-unverified-'))
  const source = path.join(root, ...sourceKey.split('/'))
  const target = path.join(root, ...targetKey.split('/'))
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, '合成正文')

  let durable: Record<string, unknown> = {
    user_id: owner, display_name: '笔记', ext: 'md', space: 'personal',
    workspace_directory_id: null, project_id: null, stage_name: '',
    mind_map_id: null, path: sourceKey, version: 1, size: '4 B', size_bytes: 8,
    mime_type: 'text/markdown', created_at: new Date('2026-01-01T00:00:00Z'),
    deleted_at: null, img_width: null, img_height: null,
  }
  let pending: Record<string, unknown> | null = null
  const query = async <Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<Row>> => {
    const statement = sql.trim()
    let rows: Record<string, unknown>[] = []
    if (statement === 'BEGIN') pending = { ...durable }
    else if (statement.startsWith('SELECT * FROM files')) rows = pending ? [{ ...pending }] : []
    else if (statement.startsWith('SELECT pg_advisory_xact_lock')) rows = [{}]
    else if (statement.startsWith('SELECT 1 FROM files')) rows = []
    else if (statement.startsWith('SELECT p.name project_name')) rows = []
    else if (statement.startsWith('UPDATE files SET display_name=')) {
      assert.ok(pending)
      pending = { ...pending, display_name: values[3], ext: values[4], stage_name: values[5],
        project_id: values[6], workspace_directory_id: values[7],
        space: values[8], path: values[9], version: 2 }
      rows = [{ ...pending }]
    } else if (statement === 'COMMIT') {
      durable = { ...(pending ?? durable) }
      pending = null
      throw new Error('模拟数据库已提交但 COMMIT 响应丢失')
    } else if (statement === 'ROLLBACK') pending = null
    else if (statement.startsWith('SELECT path,version FROM files')) throw new Error('模拟核实连接暂时不可用')
    else throw new Error(`测试桩未识别 SQL: ${statement.slice(0, 48)}`)
    return { rows, rowCount: rows.length } as unknown as QueryResult<Row>
  }
  const client = { query, release() {} } as unknown as PoolClient
  const pool = { connect: async () => client, query } as unknown as Pool

  try {
    const operations = createPostgresFileUpdateOperations(pool, { storageRoot: root, async publishChanged() {} })
    await assert.rejects(operations.update(owner, 1, {
      version: 1, displayName: '新笔记', folderPathSet: false, projectSet: false, workspaceDirectorySet: false,
    }, { idempotencyKey: null, undoContextId: null, clientId: null }), /提交结果暂时无法确认/)

    assert.equal(durable.path, targetKey)
    assert.equal(await readFile(source, 'utf8'), '合成正文')
    assert.equal(await readFile(target, 'utf8'), '合成正文')
  } finally { await rm(root, { recursive: true, force: true }) }
})
