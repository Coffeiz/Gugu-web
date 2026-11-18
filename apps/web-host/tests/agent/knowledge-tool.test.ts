import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureRagJieba } from '@gugu/core/agent/rag'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createWebOwnerAgentKnowledgeReadPort } from '../../src/domains/agent-sessions/tools/agent-knowledge.js'
import { createLocalAgentKnowledgeReadStore } from '../../src/domains/agent-sessions/tools/agent-rag-knowledge-store.js'
import { getAgentRagJieba } from '../../src/domains/agent-sessions/tools/agent-rag-jieba.js'
import { createOwnerRagVectorSource } from '../../src/domains/agent-sessions/tools/agent-rag-vectors.js'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'

test('Host read_knowledge dispatch reads the owner FS and searches the persistent BM25 index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-knowledge-tool-'))
  const root = join(directory, 'storage')
  const database = join(directory, 'core.sqlite')
  const owner = '00000000-0000-4000-8000-000000000011'
  const identity = { ownerId: owner, sessionId: '1', runId: 'knowledge-test' }
  const ownerRoot = join(root, owner, '.agent', 'knowledge')
  const entry = join(ownerRoot, 'entries', 'k-1.md')
  const source = '---\nid: k-1\ntitle: 发布回滚\ntopic: 发布\ndescription: 回滚边界\nkeywords_json: ["发布", "回滚"]\nconfidence: confirmed\nsource_json: {"type":"user"}\nscope_json: {"type":"owner", "owner_user_id":"00000000-0000-4000-8000-000000000011"}\nversion: 3\nactive: true\ncreated_at: 2026-01-01T00:00:00+00:00\nupdated_at: 2026-01-02T00:00:00+00:00\n---\n保留上一版本'
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await mkdir(join(ownerRoot, 'entries'), { recursive: true })
    await writeFile(join(ownerRoot, '.timestamps-iso-v1'), '')
    await writeFile(entry, source)
    await writeFile(join(ownerRoot, 'vectors.json'), JSON.stringify({
      'rag:k-1:3:krevision:0': { t: 'test-embedding-v1', v: [1, 0] },
    }))
    await initializeSqlite(database)
    runtime = (await openSqliteRuntime(database)).runtime
    await runtime.db.insertInto('knowledge_index_entries').values({
      owner_user_id: owner.replaceAll('-', ''), source_type: 'knowledge', source_id: 'k-1', scope_type: 'owner', scope_id: '',
      platform: '', bot_id: '', group_id: '', document_id: 'knowledge:k-1:0', parent_document_id: 'k-1',
      document_version: '3:krevision', chunk_index: 0, chunk_count: 1, title: '发布回滚',
      summary: '发布；关键词：发布、回滚；回滚边界', content: '保留上一版本', content_hash: 'hash',
      metadata_json: JSON.stringify({ topic: '发布', keywords: '发布、回滚', description: '回滚边界', confidence: 'confirmed', source_type: 'user' }),
      source_updated_at: '2026-01-02T00:00:00.000Z', indexed_at: '2026-01-03T00:00:00.000Z',
    }).execute()
    configureRagJieba(getAgentRagJieba())
    let vectorReads = 0
    let embeddingCalls = 0
    const options = {
      timezone: async () => 'Asia/Shanghai',
      vectors: async (ownerId: string) => {
        return { version: 'test-embedding-v1', source: async (boundOwner: string) => {
          assert.equal(boundOwner, owner)
          vectorReads += 1
          return createOwnerRagVectorSource(root, boundOwner)
        }, embed: async (_boundOwner: string, _query: string) => { embeddingCalls += 1; return [1, 0] } }
      },
    }
    const port = createWebOwnerAgentKnowledgeReadPort(runtime, createLocalAgentKnowledgeReadStore(root), options)
    const tools = createAgentToolRegistry({ core: runtime, knowledge: port,
      authorize: async (current, name) => current.ownerId === owner && name === 'read_knowledge' })
    const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('读取知识不能执行宿主进程') } }
    assert.ok((await tools.capabilities(identity)).some(item => item.name === 'read_knowledge'))
    const exact = await tools.tools.dispatch({ id: 'exact', name: 'read_knowledge', input: { knowledge_id: 'k-1' } }, scope)
    assert.deepEqual(exact.kind === 'completed' && exact.successful ? exact.value : null, {
      success: true,
      entry: { knowledge_id: 'k-1', title: '发布回滚', topic: '发布', description: '回滚边界', keywords: ['发布', '回滚'],
        confidence: 'confirmed', source_type: 'user', scope_type: 'owner', created_at: '2026-01-01T08:00:00+08:00',
        updated_at: '2026-01-02T08:00:00+08:00', content: '保留上一版本', version: 3 },
    })
    const search = await tools.tools.dispatch({ id: 'search', name: 'read_knowledge', input: { keyword: '发布 回滚' } }, scope)
    assert.equal(search.kind, 'completed')
    assert.equal(search.kind === 'completed' && search.successful, true)
    assert.equal(search.kind === 'completed' && (search.value as { strategy: string }).strategy, 'bm25')
    assert.equal(search.kind === 'completed' && (search.value as { entries: Array<{ knowledge_id: string; content: string }> }).entries[0]?.knowledge_id, 'k-1')
    assert.equal(search.kind === 'completed' && (search.value as { entries: Array<{ content: string }> }).entries[0]?.content,
      '发布回滚\n发布；关键词：发布、回滚；回滚边界\n保留上一版本')

    // Python read_knowledge 固定使用 BM25；不能因为 Host 可选 embedding 已配置
    // 就暗中改成 hybrid 或发起额外 Provider 请求。
    assert.equal(vectorReads, 0)
    assert.equal(embeddingCalls, 0)

    const foreignScope = await tools.tools.dispatch({ id: 'foreign-scope', name: 'read_knowledge', input: { keyword: '发布 回滚', scope: 'group' } }, scope)
    assert.equal(foreignScope.kind === 'completed' && foreignScope.successful, false)

    const other = { ...scope, identity: { ...identity, ownerId: '00000000-0000-4000-8000-000000000012' } }
    const foreign = await tools.tools.dispatch({ id: 'foreign', name: 'read_knowledge', input: { knowledge_id: 'k-1' } }, other)
    assert.equal(foreign.kind === 'completed' && foreign.successful, false)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
