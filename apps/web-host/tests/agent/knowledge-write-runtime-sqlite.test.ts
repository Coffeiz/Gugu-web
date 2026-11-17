import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createKnowledgeRagSource, enqueueAgentRagRebuild, invalidateAgentKnowledgeRag } from '@gugu/core/agent'
import { buildDocuments } from '../../../../packages/core/src/agent/rag/adapters/base.js'
import { createSqlRagPersistentIndexReader } from '../../../../packages/core/src/agent/rag/persistent-index.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createSqlRagRebuildWorker } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createLocalAgentKnowledgeReadStore } from '../../src/domains/agent-sessions/tools/agent-rag-knowledge-store.js'
import { createLocalAgentKnowledgeWritePort } from '../../src/domains/agent-sessions/tools/agent-knowledge-write.js'

test('knowledge 文件变更先墓碑化旧索引并围栏已经读取旧文件的 Worker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gugu-knowledge-invalidate-'))
  const database = path.join(directory, 'core.sqlite')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  try {
    const documents = buildDocuments({ id: 'knowledge-k1', source_type: 'knowledge', title: '合成知识',
      content: '旧知识内容在修改后必须不可检索', document_version: '1:krevision',
      scope: { scope_type: 'owner', scope_id: ownerId } })
    const writer = createSqlRagPersistentIndexWriter(runtime.db, 'sqlite')
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite')
    await writer.replaceSource(ownerId, 'knowledge', documents)
    await enqueueAgentRagRebuild(runtime.db, 'sqlite', ownerId, 'knowledge')
    let release!: () => void
    let started!: () => void
    const readStarted = new Promise<void>(resolve => { started = resolve })
    const allowCommit = new Promise<void>(resolve => { release = resolve })
    const worker = createSqlRagRebuildWorker(runtime.db, 'sqlite', { knowledge: async () => { started(); await allowCommit; return documents } })
    const inFlight = worker()
    await readStarted
    const before = await (runtime.db as any).selectFrom('rag_index_jobs').select(['generation', 'status'])
      .where('source_type', '=', 'knowledge').executeTakeFirstOrThrow()
    assert.equal(before.status, 'running')
    await invalidateAgentKnowledgeRag(runtime.db, 'sqlite', ownerId)
    release()
    assert.equal(await inFlight, 'superseded')
    assert.deepEqual((await reader.snapshot(ownerId)).documents, [])
    assert.deepEqual(await (runtime.db as any).selectFrom('rag_index_jobs')
      .select(['generation', 'completed_generation', 'status', 'lease_until']).where('source_type', '=', 'knowledge').executeTakeFirst(), {
      generation: Number(before.generation) + 1, completed_generation: Number(before.generation) + 1, status: 'ready', lease_until: null,
    })
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('生产 Host 工具调用写入 owner Markdown 并经持久 Worker 重建知识索引', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gugu-knowledge-write-'))
  const root = path.join(directory, 'storage')
  const database = path.join(directory, 'core.sqlite')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  const entriesDirectory = path.join(root, ownerId, '.agent', 'knowledge', 'entries')
  await mkdir(entriesDirectory, { recursive: true })
  await writeFile(path.join(entriesDirectory, 'legacy-knowledge.md'), `---
id: legacy-knowledge
title: 部署回滚
topic: 生产发布
keywords_json: ["回滚"]
description: 发布异常时使用
scope_json: {"type":"owner","owner_user_id":"${ownerId}","platform":"","bot_id":"","group_id":"","scope_id":"","project_id":""}
source_json: {"type":"user","ref":"","label":"","checked_at":null}
confidence: confirmed
version: 1
parent_id: 
created_at: 1760000000
updated_at: 1760000000
active: true
history_json: []
---
旧回滚正文
`)
  const store = createLocalAgentKnowledgeReadStore(root)
  const identity = { ownerId, sessionId: '1', runId: 'knowledge-write-test' }
  const otherOwner = '00000000-0000-4000-8000-000000000099'
  const registry = createAgentToolRegistry({ core: runtime,
    knowledgeWrites: createLocalAgentKnowledgeWritePort(runtime, root, store),
    authorize: async (current, name) => [ownerId, otherOwner].includes(current.ownerId) && ['save_knowledge', 'update_knowledge'].includes(name),
  })
  const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('知识工具不能执行宿主进程') } }
  try {
    const available = await registry.capabilities(identity)
    assert.deepEqual(available.filter(item => item.name.endsWith('_knowledge')).map(item => item.name).sort(), ['save_knowledge', 'update_knowledge'])
    const saved = await registry.tools.dispatch({ id: 'save-1', name: 'save_knowledge', input: {
      title: '部署回滚', topic: '生产发布', content: '先检查健康探针，再回滚上一版本。', keywords: ['回滚', '健康探针'],
      description: '发布异常时使用', source_type: 'user',
    } }, scope)
    assert.equal(saved.kind === 'completed' && saved.successful, true)
    const result = saved.kind === 'completed' && saved.successful ? saved.value as { id: string; index_status: string } : null
    assert.ok(result?.id)
    assert.equal(result?.index_status, 'queued')

    const marker = await store.exists(`${ownerId}/.agent/knowledge/.timestamps-iso-v1`)
    const raw = await store.read(`${ownerId}/.agent/knowledge/entries/${result!.id}.md`)
    assert.equal(marker, true)
    assert.match(new TextDecoder().decode(raw), /先检查健康探针，再回滚上一版本/u)
    assert.match(new TextDecoder().decode(raw), /created_at: 2025-10-09T08:53:20\.000000Z/u)
    assert.match(new TextDecoder().decode(raw), /旧回滚正文/u)
    const db = runtime.db as any
    assert.deepEqual(await db.selectFrom('rag_index_jobs').select(['status', 'generation'])
      .where('user_id', '=', ownerId.replaceAll('-', '')).where('source_type', '=', 'knowledge').executeTakeFirst(), { status: 'queued', generation: 2 })

    const worker = createSqlRagRebuildWorker(runtime.db, 'sqlite', { knowledge: createKnowledgeRagSource(store) })
    assert.equal(await worker(), 'ready')
    const indexed = await createSqlRagPersistentIndexReader(runtime.db, 'sqlite').snapshot(ownerId)
    assert.equal(indexed.documents.some(document => document.source_type === 'knowledge'
      && document.source_id === result!.id && document.content === '先检查健康探针，再回滚上一版本。'), true)

    const otherIdentity = { ...identity, ownerId: otherOwner }
    const otherScope = { ...scope, identity: otherIdentity }
    const foreignUpdate = await registry.tools.dispatch({ id: 'foreign-update', name: 'update_knowledge', input: {
      knowledge_id: result!.id, content: '另一 owner 不能覆盖此条目。',
    } }, otherScope)
    assert.equal(foreignUpdate.kind === 'completed' && foreignUpdate.successful, false)
    assert.equal(await store.exists(`${otherIdentity.ownerId}/.agent/knowledge/entries/${result!.id}.md`), false)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
