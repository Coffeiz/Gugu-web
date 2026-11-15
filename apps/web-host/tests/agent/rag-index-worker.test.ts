import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { dataContext } from '@gugu/core/contracts'
import { buildDocuments } from '../../../../packages/core/src/agent/rag/adapters/base.js'
import { createSqlRagPersistentIndexReader } from '../../../../packages/core/src/agent/rag/persistent-index.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createSqlRagRebuildWorker } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { enqueueMissingAgentRagBaselines } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { startAgentRagIndexWorker } from '../../src/domains/agent-sessions/rag-rebuild.js'
import { startRagIndexWorker } from '../../src/domains/agent-sessions/rag-index-worker.js'
import { createLocalAgentKnowledgeReadStore } from '../../src/domains/agent-sessions/tools/agent-rag-knowledge-store.js'

const tick = async (count = 1) => {
  for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve))
}

test('RAG 调度器立即运行并串行排空 ready 任务，空队列后按间隔轮询', async () => {
  const results = ['ready', 'superseded', 'idle', 'idle'] as const
  const calls: number[] = []
  const worker = startRagIndexWorker({
    enabled: true,
    intervalMs: 10,
    onError: error => { throw error },
    work: async () => {
      calls.push(calls.length + 1)
      return results[calls.length - 1] ?? 'idle'
    },
  })
  try {
    await tick()
    assert.deepEqual(calls, [1, 2, 3])
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(calls.length >= 4, true)
    assert.deepEqual(calls, calls.map((_, index) => index + 1))
  } finally {
    await worker.stop()
  }
})

test('RAG 调度器处理失败后继续轮询且停止会取消并等待当前调用', async () => {
  const controllerSignals: AbortSignal[] = []
  const failures: unknown[] = []
  let calls = 0
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const worker = startRagIndexWorker({
    enabled: true,
    intervalMs: 10,
    onError: error => failures.push(error),
    work: async signal => {
      calls++
      controllerSignals.push(signal)
      if (calls === 1) throw new Error('synthetic worker failure')
      await current
      signal.throwIfAborted()
      return 'idle'
    },
  })
  await tick(2)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(calls, 2)
  assert.equal(failures.length, 1)
  const stopped = worker.stop()
  await tick()
  assert.equal(controllerSignals[1]?.aborted, true)
  release()
  await stopped
  assert.equal(calls, 2)
})

test('未启用的 RAG 调度器不触发 Worker', async () => {
  let calls = 0
  const worker = startRagIndexWorker({ enabled: false, work: async () => { calls++; return 'ready' }, onError: () => {} })
  await worker.stop()
  assert.equal(calls, 0)
})

test('ready 时排空任务不会并发调用底层 RAG Worker', async () => {
  let active = 0
  let maximum = 0
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const worker = startRagIndexWorker({
    enabled: true,
    intervalMs: 1000,
    onError: error => { throw error },
    work: async () => {
      active++
      maximum = Math.max(maximum, active)
      calls++
      if (calls === 1) await gate
      active--
      return calls <= 2 ? 'ready' : 'idle'
    },
  })
  await tick()
  assert.equal(calls, 1)
  release()
  await tick(2)
  assert.equal(calls, 3)
  assert.equal(maximum, 1)
  await worker.stop()
})

test('Host 调度器经持久 Worker 消费真实 SQLite 队列并写入正式索引表', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-scheduler-'))
  const path = join(directory, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId.replaceAll('-', '')
    const now = '2026-01-01 00:00:00.000000'
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'rag_index_jobs'): { values(row: Record<string, unknown>): { execute(): Promise<unknown> } }
    }
    await fixtureDb.insertInto('rag_index_jobs').values({
      user_id: owner, source_type: 'project', source_id: '17', pending_source_ids: '["17"]', version: '', operation: 'upsert',
      status: 'queued', generation: 1, completed_generation: 0, attempts: 0, next_attempt_at: now, created_at: now, updated_at: now,
    }).execute()
    const source = async (_sourceOwner: string, sourceId: string | null) => sourceId === '17' ? buildDocuments({
      source_type: 'project', id: '17', source_id: '17', title: '合成项目', content: '调度器测试正文',
      document_version: 'fixture-v1', version_parts: ['project', '17'],
      scope: { scope_type: 'owner', scope_id: '' },
    }) : []
    const rebuild = createSqlRagRebuildWorker(runtime.db, 'sqlite', { project: source })
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite')
    const scheduler = startRagIndexWorker({ enabled: true, intervalMs: 1000, work: rebuild, onError: error => { throw error } })
    try {
      for (let attempt = 0; attempt < 50 && (await reader.snapshot(opened.ownerId)).documents.length === 0; attempt++)
        await new Promise(resolve => setTimeout(resolve, 2))
      const snapshot = await reader.snapshot(opened.ownerId)
      assert.equal(snapshot.documents.length, 1)
      assert.equal(snapshot.documents[0]?.content, '调度器测试正文')
    } finally {
      await scheduler.stop()
    }
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('首次 RAG 启动只为缺少索引和任务的来源建立幂等全量基线', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-baseline-'))
  const path = join(directory, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId.replaceAll('-', '')
    const now = '2026-01-01 00:00:00.000000'
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'rag_index_jobs'): { values(row: Record<string, unknown>): { execute(): Promise<unknown> } }
      selectFrom(table: 'rag_index_jobs'): { select(columns: string[]): { where(column: string, operator: '=', value: string): { execute(): Promise<Record<string, unknown>[]> } } }
    }
    await fixtureDb.insertInto('rag_index_jobs').values({
      user_id: owner, source_type: 'project', source_id: '17', pending_source_ids: '["17"]', version: '', operation: 'upsert',
      status: 'queued', generation: 3, completed_generation: 2, attempts: 1, next_attempt_at: now, created_at: now, updated_at: now,
    }).execute()
    const writer = createSqlRagPersistentIndexWriter(runtime.db, 'sqlite')
    await writer.replaceSource(opened.ownerId, 'calendar', buildDocuments({
      source_type: 'calendar', id: 'event-1', source_id: 'event-1', title: '合成活动', content: '已存在索引',
      document_version: 'fixture-v1', scope: { scope_type: 'owner', scope_id: '' },
    }))

    assert.equal(await enqueueMissingAgentRagBaselines(runtime.db, 'sqlite', ['project', 'calendar', 'conversation']), 1)
    assert.equal(await enqueueMissingAgentRagBaselines(runtime.db, 'sqlite', ['project', 'calendar', 'conversation']), 0)
    const queued = await fixtureDb.selectFrom('rag_index_jobs').select(['source_type', 'source_id', 'pending_source_ids', 'status', 'generation'])
      .where('user_id', '=', owner).execute()
    const baseline = queued.find(row => row.source_type === 'conversation')
    assert.deepEqual(baseline, { source_type: 'conversation', source_id: '', pending_source_ids: '[]', status: 'queued', generation: 1 })
    assert.deepEqual(queued.find(row => row.source_type === 'project'), {
      source_type: 'project', source_id: '17', pending_source_ids: '["17"]', status: 'queued', generation: 3,
    })
    assert.equal(queued.some(row => row.source_type === 'calendar'), false)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('生产 Host RAG 生命周期经共享 Core 项目服务重建正式索引并保留未就绪来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-host-sources-'))
  const path = join(directory, 'core.db')
  const storageRoot = join(directory, 'users')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId.replaceAll('-', '')
    const project = await runtime.transaction(dataContext(opened.ownerId), data => data.projects.create({ name: '来源组项目' }))
    const knowledgeDirectory = join(storageRoot, opened.ownerId, '.agent', 'knowledge')
    const knowledgeEntries = join(knowledgeDirectory, 'entries')
    await mkdir(knowledgeEntries, { recursive: true })
    await writeFile(join(knowledgeDirectory, '.timestamps-iso-v1'), '')
    await writeFile(join(knowledgeEntries, 'knowledge-k1.md'), [
      '---', 'id: knowledge-k1', 'title: 授权知识切片', 'topic: 版本发布', 'keywords_json: ["Node", "灰度"]',
      'description: 需要准备版本切换时参考',
      `scope_json: ${JSON.stringify({ type: 'owner', owner_user_id: opened.ownerId, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' })}`,
      `source_json: ${JSON.stringify({ type: 'user', ref: '', label: '本地知识', checked_at: null })}`,
      'confidence: confirmed', 'version: 2', 'parent_id:', 'created_at: 2026-01-01T00:00:00.000000+00:00',
      'updated_at: 2026-02-03T04:05:06.123456+00:00', 'active: true', '---', '先核对健康探针，再按批次切换流量。', '',
    ].join('\n'))
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'rag_index_jobs'): { values(rows: Record<string, unknown>[]): { execute(): Promise<unknown> } }
      selectFrom(table: 'rag_index_jobs'): { select(column: 'status'): { where(column: 'source_type', operator: '=', value: string): { executeTakeFirst(): Promise<{ status: string } | undefined> } } }
    }
    const now = '2026-01-01 00:00:00.000000'
    const job = (sourceType: string, sourceId: string) => ({ user_id: owner, source_type: sourceType, source_id: sourceId,
      pending_source_ids: JSON.stringify([sourceId]), version: '', operation: 'upsert', status: 'queued', generation: 1,
      completed_generation: 0, attempts: 0, next_attempt_at: now, created_at: now, updated_at: now })
    await fixtureDb.insertInto('rag_index_jobs').values([
      job('project', String(project.id)), job('knowledge', 'knowledge-k1'), job('memory', 'not-ready'),
    ]).execute()

    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite')
    const production = startAgentRagIndexWorker(runtime, {
      enabled: true,
      intervalMs: 1000,
      onError: error => { throw error },
      knowledgeStore: createLocalAgentKnowledgeReadStore(storageRoot),
    })
    try {
      let snapshot = await reader.snapshot(opened.ownerId)
      const ready = () => snapshot.documents.some(document => document.title === '来源组项目')
        && snapshot.documents.some(document => document.source_type === 'knowledge' && document.source_id === 'knowledge-k1')
      for (let attempt = 0; attempt < 50 && !ready(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2))
        snapshot = await reader.snapshot(opened.ownerId)
      }
      assert.equal(snapshot.documents.some(document => document.title === '来源组项目' && document.content?.startsWith('项目：来源组项目')), true)
      assert.equal(snapshot.documents.some(document => document.source_type === 'knowledge'
        && document.source_id === 'knowledge-k1' && document.content === '先核对健康探针，再按批次切换流量。'), true)
      assert.deepEqual(await fixtureDb.selectFrom('rag_index_jobs').select('status').where('source_type', '=', 'knowledge').executeTakeFirst(), { status: 'ready' })
      assert.deepEqual(await fixtureDb.selectFrom('rag_index_jobs').select('status').where('source_type', '=', 'memory').executeTakeFirst(), { status: 'queued' })
    } finally {
      await production.stop()
    }
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Host Memory 来源经可信 owner scope 与旧版 FS 投影重建正式索引表', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-memory-source-'))
  const path = join(directory, 'core.db')
  const storageRoot = join(directory, 'users')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId
    const ownerKey = owner.replaceAll('-', '')
    await runtime.db.schema.createTable('memory_reflection_cursors')
      .addColumn('id', 'integer', column => column.primaryKey().autoIncrement())
      .addColumn('owner_user_id', 'text', column => column.notNull())
      .addColumn('platform', 'text', column => column.notNull())
      .addColumn('bot_id', 'text', column => column.notNull())
      .addColumn('scope_type', 'text', column => column.notNull())
      .addColumn('scope_id', 'text', column => column.notNull())
      .addColumn('scope_version', 'integer')
      .addColumn('updated_at', 'text')
      .execute()
    await runtime.db.schema.createTable('memory_scope_tombstones')
      .addColumn('id', 'integer', column => column.primaryKey().autoIncrement())
      .addColumn('owner_user_id', 'text', column => column.notNull())
      .addColumn('platform', 'text', column => column.notNull())
      .addColumn('bot_id', 'text', column => column.notNull())
      .addColumn('scope_type', 'text', column => column.notNull())
      .addColumn('scope_id', 'text', column => column.notNull())
      .execute()
    const memoryDb = runtime.db as unknown as {
      insertInto(table: 'memory_reflection_cursors' | 'memory_scope_tombstones' | 'rag_index_jobs'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
      selectFrom(table: 'rag_index_jobs'): {
        select(column: 'status'): { where(column: 'source_type', operator: '=', value: string): { executeTakeFirst(): Promise<{ status: string } | undefined> } }
      }
    }
    await memoryDb.insertInto('memory_reflection_cursors').values([
      { owner_user_id: owner, platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'group-live', scope_version: 1, updated_at: '2026-01-01T00:00:00Z' },
      { owner_user_id: owner, platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'group-peer', scope_version: 1, updated_at: '2026-01-01T00:00:00Z' },
      { owner_user_id: owner, platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'group-old', scope_version: 2, updated_at: '2026-01-01T00:00:00Z' },
      { owner_user_id: owner, platform: 'qq', bot_id: 'bot-a', scope_type: 'platform-user', scope_id: 'group-live:member-a', scope_version: 1, updated_at: '2026-01-01T00:00:00Z' },
      { owner_user_id: '08a80873-5266-43b9-a27c-d288b602a9cb', platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'foreign-group', scope_version: 3, updated_at: '2026-01-01T00:00:00Z' },
    ]).execute()
    await memoryDb.insertInto('memory_scope_tombstones').values({ owner_user_id: owner, platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'group-old' }).execute()

    const memoryDirectory = join(storageRoot, owner, '.agent', 'rag', 'memory')
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile:profile:0', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '用户画像', summary: '', content: 'owner memory fact', version: 'profile-v1',
        scope: { owner_user_id: owner, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'foreign:0', parent_document_id: 'memory:profile:foreign:0', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '异主内容', summary: '', content: 'foreign private fact', version: 'profile-v1',
        scope: { owner_user_id: '08a80873-5266-43b9-a27c-d288b602a9cb', scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')
    const groupDirectory = join(storageRoot, owner, '.agent', 'im', 'qq', 'bot-a', 'groups', 'group-live')
    await mkdir(groupDirectory, { recursive: true })
    await writeFile(join(groupDirectory, 'profile.json'), JSON.stringify({ text: 'authorized group fact' }), 'utf8')
    const peerGroupDirectory = join(storageRoot, owner, '.agent', 'im', 'qq', 'bot-a', 'groups', 'group-peer')
    await mkdir(peerGroupDirectory, { recursive: true })
    await writeFile(join(peerGroupDirectory, 'profile.json'), JSON.stringify({ text: 'authorized group fact' }), 'utf8')
    const memberDirectory = join(storageRoot, owner, '.agent', 'im', 'qq', 'bot-a', 'platform-users', 'group-live%3Amember-a')
    await mkdir(memberDirectory, { recursive: true })
    await writeFile(join(memberDirectory, 'profile.json'), JSON.stringify({ text: 'authorized member fact' }), 'utf8')
    const oldGroupDirectory = join(storageRoot, owner, '.agent', 'im', 'qq', 'bot-a', 'groups', 'group-old')
    await mkdir(oldGroupDirectory, { recursive: true })
    await writeFile(join(oldGroupDirectory, 'profile.json'), JSON.stringify({ text: 'tombstoned group fact' }), 'utf8')
    await memoryDb.insertInto('rag_index_jobs').values({
      user_id: ownerKey, source_type: 'memory', source_id: '', pending_source_ids: '[]', version: '', operation: 'upsert',
      status: 'queued', generation: 1, completed_generation: 0, attempts: 0,
      next_attempt_at: '2026-01-01 00:00:00.000000', created_at: '2026-01-01 00:00:00.000000', updated_at: '2026-01-01 00:00:00.000000',
    }).execute()

    const production = startAgentRagIndexWorker(runtime, {
      enabled: true, intervalMs: 1000, onError: error => { throw error }, memoryStorageRoot: storageRoot,
    })
    try {
      let status = await memoryDb.selectFrom('rag_index_jobs').select('status').where('source_type', '=', 'memory').executeTakeFirst()
      for (let attempt = 0; attempt < 100 && status?.status !== 'ready'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2))
        status = await memoryDb.selectFrom('rag_index_jobs').select('status').where('source_type', '=', 'memory').executeTakeFirst()
      }
      assert.deepEqual(status, { status: 'ready' })
      const snapshot = await createSqlRagPersistentIndexReader(runtime.db, 'sqlite').snapshot(owner)
      assert.deepEqual(snapshot.documents.filter(document => document.source_type === 'memory').map(document => [
        document.scope_type, document.scope_id, document.content,
      ]), [
        ['owner', '', 'owner memory fact'],
        ['group', 'group-live', 'authorized group fact'],
        ['group', 'group-peer', 'authorized group fact'],
        ['member', 'group-live:member-a', 'authorized member fact'],
      ])
      const groupDocs = snapshot.documents.filter(document => document.source_type === 'memory' && document.scope_type === 'group')
      assert.equal(new Set(groupDocs.map(document => document.metadata?.memory_source_id)).size, 1)
      assert.equal(new Set(groupDocs.map(document => document.source_id)).size, 2)
      assert.equal(new Set(groupDocs.map(document => document.document_version)).size, 1)
      assert.equal(new Set(groupDocs.map(document => document.parent_id)).size, 2)
      assert.equal(snapshot.documents.filter(document => document.source_type === 'memory' && document.scope_type === 'member').length, 1)
      assert.doesNotMatch(JSON.stringify(snapshot.documents), /foreign private fact|tombstoned group fact|foreign-group/u)
    } finally {
      await production.stop()
    }
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
