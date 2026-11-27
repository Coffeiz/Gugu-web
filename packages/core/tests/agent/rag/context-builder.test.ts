import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqlRagPersistentIndexWriter } from '../../../src/agent/rag/persistent-writer.js'
import { createSqlRagPersistentIndexReader } from '../../../src/agent/rag/persistent-index.js'
import { createAgentRagContextBuilder } from '../../../src/agent/rag/context-builder.js'
import { createMemoryRagSource, createSqlMemoryScopeStateReader, createSqlRagRebuildWorker, enqueueMissingAgentRagBaselines } from '../../../src/agent/rag/index.js'
import { createSqliteAgentMemoryRagStorage } from '../../../src/agent/memory/sqlite.js'
import type { RagDocument } from '../../../src/agent/rag/contracts.js'

describe('共享 Agent 自动 RAG 上下文构建器', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

  it('复用持久索引注入上下文、排除历史已注入正文，并遵守宿主授权', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-context-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    const identity = { ownerId, sessionId: '1', runId: randomUUID() }
    const content = 'The project alpha deployment plan is stored here for automatic recall.'
    const document: RagDocument = {
      id: 'project:alpha:0', source_type: 'project', source_id: 'alpha', parent_id: 'project:alpha',
      title: 'Project alpha deployment plan', summary: 'deployment plan', content,
      text: `Project alpha deployment plan\n${content}`, document_version: 'v1', chunk_index: 0,
      chunk_count: 1, scope_type: 'owner', scope_id: '',
    }
    await createSqlRagPersistentIndexWriter(runtime.db, 'sqlite').replaceSource(ownerId, 'project', [document])
    const authorize = vi.fn(async () => true)
    const vectors = vi.fn(async () => null)
    const build = createAgentRagContextBuilder({ core: runtime, identity, enabled: () => true, authorize, vectors })
    const input = {
      ...identity, query: 'project alpha deployment plan', history: [], beforeMessageId: null, snapshotText: '',
    }

    expect(await build(input)).toMatchObject({ injected: false, reason: 'index_warming' })
    expect(vectors).not.toHaveBeenCalled()
    const injected = await vi.waitFor(async () => {
      const result = await build(input)
      expect(result.injected).toBe(true)
      return result
    })
    expect(JSON.stringify(injected.tail)).toContain(content)
    expect(authorize).toHaveBeenCalledWith(identity, { scope_type: 'owner', scope_id: '' }, undefined)

    const contentHash = createHash('sha256').update(content.trim()).digest('hex')
    const excluded = await build({ ...input, history: [{
      ...identity, id: 'history-1', conversationSeq: 1, role: 'user', content: [],
      contentJson: [{ type: 'knowledge-context', content_hashes: [contentHash] }],
      baselineSeq: 0, baselineHash: null, snapshotHash: null,
    }] })
    expect(excluded.injected).toBe(false)
    expect(excluded.reason).toBe('no_hits')

    const authorizedQueries = authorize.mock.calls.length
    const disabled = createAgentRagContextBuilder({ core: runtime, identity, enabled: () => false, authorize })
    expect((await disabled(input)).reason).toBe('disabled')
    expect(authorize).toHaveBeenCalledTimes(authorizedQueries)
  })

  it('SQLite 快照缓存随内容、权限范围和删除更新，回滚不发布变化', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-snapshot-cache-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    const owner = ownerId.replaceAll('-', '')
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite', { cacheSqliteOwner: true })
    const read = () => reader.snapshotForScope(ownerId, { scope_type: 'owner' })
    expect((await read()).documents).toEqual([])
    await sql`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,document_id,document_version,content,content_hash)
      VALUES (${owner},'project','fixture','fixture','v1','初始正文','fixture')`.execute(runtime.db)
    const first = await read()
    expect(first.documents[0]?.content).toBe('初始正文')
    first.documents[0]!.content = '调用方修改'
    const hitTimings = new Set<string>()
    await reader.snapshotForScope(ownerId, { scope_type: 'owner' }, undefined, stage => hitTimings.add(stage))
    expect([...hitTimings]).toEqual(['snapshot_generation_ms', 'snapshot_cache_hit_copy_ms'])
    expect((await read()).documents[0]?.content).toBe('初始正文')
    await expect(runtime.db.transaction().execute(async tx => {
      await sql`UPDATE knowledge_index_entries SET content='未提交正文' WHERE owner_user_id=${owner}`.execute(tx)
      throw new Error('合成回滚')
    })).rejects.toThrow('合成回滚')
    expect((await read()).documents[0]?.content).toBe('初始正文')
    await sql`UPDATE knowledge_index_entries SET content='更新正文' WHERE owner_user_id=${owner}`.execute(runtime.db)
    const missTimings = new Set<string>()
    const changed = await reader.snapshotForScope(ownerId, { scope_type: 'owner' }, undefined, stage => missTimings.add(stage))
    expect(changed.documents[0]?.content).toBe('更新正文')
    expect([...missTimings]).toEqual(['snapshot_generation_ms', 'snapshot_sql_ms', 'snapshot_projection_ms', 'snapshot_cache_store_copy_ms'])
    await sql`UPDATE knowledge_index_entries SET scope_type='group' WHERE owner_user_id=${owner}`.execute(runtime.db)
    expect((await read()).documents).toEqual([])
    await sql`UPDATE knowledge_index_entries SET scope_type='owner' WHERE owner_user_id=${owner}`.execute(runtime.db)
    expect((await read()).documents[0]?.content).toBe('更新正文')
    await sql`DELETE FROM knowledge_index_entries WHERE owner_user_id=${owner}`.execute(runtime.db)
    expect((await read()).documents).toEqual([])
  })

  it('重复构建不推进 SQLite 快照代数，内容、范围和墓碑恢复仍可见', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-noop-rebuild-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    const writer = createSqlRagPersistentIndexWriter(runtime.db, 'sqlite')
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite', { cacheSqliteOwner: true })
    const document: RagDocument = {
      id: 'project:fixture:0', source_type: 'project', source_id: 'fixture', parent_id: 'fixture',
      title: '合成项目', content: '合成正文', text: '合成正文', document_version: 'v1', chunk_index: 0,
      chunk_count: 1, scope_type: 'owner', scope_id: '', updated_at: '2026-01-01T00:00:00.123456Z',
      metadata: { project_id: 'fixture' },
    }
    const read = () => reader.snapshotForScope(ownerId, { scope_type: 'owner' })
    const generation = async () => (await sql<{ generation: number }>`SELECT generation FROM rag_snapshot_generations
      WHERE owner_user_id=${ownerId.replaceAll('-', '')}`.execute(runtime.db)).rows[0]?.generation
    expect(await writer.replaceSource(ownerId, 'project', [document])).toEqual({ inserted: 1, updated: 0, deleted: 0 })
    const first = await read(), firstGeneration = await generation()
    expect(await writer.replaceSource(ownerId, 'project', [structuredClone(document)])).toEqual({ inserted: 0, updated: 0, deleted: 0 })
    expect(await generation()).toBe(firstGeneration)
    expect(await read()).toEqual(first)
    // 首尾空格不影响 content_hash，但仍属于持久正文。
    const changed = { ...document, content: '合成正文 ', metadata: { project_id: 'updated' } }
    expect((await writer.replaceSource(ownerId, 'project', [changed])).updated).toBe(1)
    expect((await read()).documents[0]).toMatchObject({ content: changed.content, metadata: changed.metadata })
    expect(await generation()).not.toBe(firstGeneration)
    expect((await writer.replaceSource(ownerId, 'project', [])).deleted).toBe(1)
    expect((await read()).documents).toEqual([])
    expect((await writer.replaceSource(ownerId, 'project', [changed])).updated).toBe(1)
    expect((await read()).documents[0]?.content).toBe(changed.content)
    expect((await writer.replaceSource(ownerId, 'project', [{ ...changed, scope_type: 'group', scope_id: 'fixture-group' }])).updated).toBe(1)
    expect((await read()).documents).toEqual([])
  })

  it('桌面 SQLite 首次打开会为已有 owner 建立记忆索引', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-baseline-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
    const owner = ownerId.replaceAll('-', ''), timestamp = '2026-11-20 00:00:00.000000'
    await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
      VALUES (1,${owner},'Desktop chat',0,'','desktop',1,${timestamp},${timestamp})`.execute(runtime.db)
    await sql`INSERT INTO desktop_agent_memory(user_id,target,body)
      VALUES (${owner},'profile',${JSON.stringify([{ text: 'The desktop owner prefers concise project status updates.' }])})`.execute(runtime.db)

    const sources = {
      memory: createMemoryRagSource({
        storage: createSqliteAgentMemoryRagStorage(runtime.db),
        scopeState: { getMemoryScopeState: createSqlMemoryScopeStateReader(runtime.db) },
        scopes: async () => [],
      }),
    }
    expect(await enqueueMissingAgentRagBaselines(runtime.db, 'sqlite', Object.keys(sources))).toBe(1)
    expect(await createSqlRagRebuildWorker(runtime.db, 'sqlite', sources)()).toBe('ready')
    const indexed = await createSqlRagPersistentIndexReader(runtime.db, 'sqlite').snapshot(ownerId)
    expect(indexed.documents.some(document => document.content?.includes('prefers concise project status updates'))).toBe(true)
  })
})
