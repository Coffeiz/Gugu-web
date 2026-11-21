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
    const build = createAgentRagContextBuilder({ core: runtime, identity, enabled: () => true, authorize })
    const input = {
      ...identity, query: 'project alpha deployment plan', history: [], beforeMessageId: null, snapshotText: '',
    }

    const injected = await build(input)
    expect(injected.injected).toBe(true)
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
