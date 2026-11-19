import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { RagDocument } from '../../../src/agent/rag/contracts.js'
import { createMemoryRagSource } from '../../../src/agent/rag/memory-source.js'
import { createScopedRagSearch } from '../../../src/agent/rag/scoped-search.js'
import { configureRagJieba } from '../../../src/agent/rag/tokenizer.js'

beforeAll(() => configureRagJieba({ cut: text => [text] }))

const document: RagDocument = {
  id: 'memory:fact:0', source_id: 'fact', source_type: 'memory', title: '项目进度',
  content: '项目进度已经更新', text: '项目进度\n项目进度已经更新', scope_type: 'owner', scope_id: '',
  document_version: 'v1', parent_id: 'fact', chunk_index: 0, chunk_count: 1,
}

function setup(embed: (owner: string, query: string, signal?: AbortSignal) => Promise<readonly number[]>, documents = [document], memoryVectors?: string | (() => string)) {
  const authorize = vi.fn(async () => true)
  const source = vi.fn(async (kind: string) => kind === 'memory' ? typeof memoryVectors === 'function' ? memoryVectors() : memoryVectors ?? null : null)
  const snapshotForScope = vi.fn(async () => ({ revision: 'rev-1', documents, watermark: null }))
  const index = { snapshotForScope } as unknown as Parameters<typeof createScopedRagSearch>[0]['index']
  const search = createScopedRagSearch({
    index,
    authorize,
    vectors: { version: 'embed-v1', source: async () => source, embed },
  })
  return { search, authorize, source, snapshotForScope }
}

describe('scoped RAG embedding fallback', () => {
  it('多个可信scope在同一语料排名与预算，逐scope前后授权且事实过滤先于候选投影', async () => {
    const group = { scope_type: 'group', scope_id: 'room', platform: 'qq', bot_id: '1', group_id: 'room' }
    const member = { ...group, scope_type: 'member', scope_id: 'room:member' }
    const groupDoc = { ...document, id: 'group', source_id: 'group', ...group, content: '项目进度已经更新', text: '项目进度\n项目进度已经更新' }
    const memberDoc = { ...document, id: 'member', source_id: 'member', ...member, content: '项目进度说明', text: '项目进度\n项目进度说明' }
    const authorize = vi.fn(async () => true), filterDocuments = vi.fn(async (docs: readonly RagDocument[]) => docs.filter(doc => doc.id === 'member'))
    const index = { snapshotForScope: vi.fn(async (_owner, scope) => ({ revision: scope.scope_type, documents: scope.scope_type === 'group' ? [groupDoc] : [memberDoc, groupDoc], watermark: null })) } as unknown as Parameters<typeof createScopedRagSearch>[0]['index']
    const result = await createScopedRagSearch({ index, authorize, filterDocuments })('owner-a', [group, member], '项目进度', { sourceTypes: ['memory'], limit: 5 })
    expect(result.results.map(item => item.id)).toEqual(['member'])
    expect(filterDocuments).toHaveBeenCalledTimes(1)
    expect(authorize.mock.calls).toHaveLength(4)
  })

  it('并集中的任一scope撤权即拒绝，过滤端口也不能添加未授权owner文档', async () => {
    const group = { scope_type: 'group', scope_id: 'room', platform: 'qq', bot_id: '1', group_id: 'room' }
    const index = { snapshotForScope: vi.fn(async () => ({ revision: '1', documents: [], watermark: null })) } as unknown as Parameters<typeof createScopedRagSearch>[0]['index']
    const search = createScopedRagSearch({ index, authorize: async () => true, filterDocuments: async () => [document] })
    expect((await search('owner-a', [group], '项目进度', { sourceTypes: ['memory'], limit: 5 })).results).toEqual([])
    const denied = createScopedRagSearch({ index, authorize: async (_owner, scope) => scope.scope_type !== 'owner' })
    await expect(denied('owner-a', [group, { scope_type: 'owner', scope_id: '' }], '项目进度', { sourceTypes: ['memory'], limit: 5 })).rejects.toThrow('未授权')
  })
  it('supports automatic confidence filtering and excludes context hashes already in history', async () => {
    const duplicate = { ...document, id: 'memory:duplicate:0', source_id: 'duplicate', parent_id: 'duplicate' }
    const ports = setup(async () => [], [document, duplicate])
    const contentHash = createHash('sha256').update(document.content!.trim()).digest('hex')
    const result = await ports.search('owner-a', { scope_type: 'owner', scope_id: '' }, '项目进度', {
      sourceTypes: ['memory'], limit: 5, selectionMode: 'confidence', excludeContentHashes: [contentHash],
    })

    expect(result.results).toEqual([])
    expect(result.diagnostics.selection_mode).toBe('confidence')
    expect(result.fusion).toBe('bm25')
  })

  it('preserves owner-scoped BM25 results when query embedding fails', async () => {
    const ports = setup(async () => { throw new Error('synthetic transport failure') })
    const result = await ports.search('owner-a', { scope_type: 'owner', scope_id: '' }, '项目进度', {
      sourceTypes: ['memory'], limit: 5,
    })

    expect(result.fusion).toBe('bm25')
    expect(result.results.map(item => item.document.source_id)).toEqual(['fact'])
    expect(ports.authorize).toHaveBeenCalledTimes(2)
    expect(ports.source).not.toHaveBeenCalled()
  })

  it('keeps cancellation observable instead of converting it into lexical success', async () => {
    const controller = new AbortController()
    const ports = setup(async () => {
      controller.abort(new Error('caller cancelled'))
      throw new Error('embedding cancelled')
    })
    await expect(ports.search('owner-a', { scope_type: 'owner', scope_id: '' }, '项目进度', {
      sourceTypes: ['memory'], limit: 5,
    }, controller.signal)).rejects.toThrow('caller cancelled')
  })

  it('uses matching owner vector versions in hybrid recall and lets the matching vector lead', async () => {
    const lexical = { ...document, id: 'memory:lexical:0', source_id: 'lexical', parent_id: 'lexical',
      title: '项目进度', content: '项目进度 已经更新多次', text: '项目进度\n项目进度 已经更新多次' }
    const semantic = { ...document, id: 'memory:semantic:0', source_id: 'semantic', parent_id: 'semantic',
      title: '项目进度', content: '项目进度', text: '项目进度\n项目进度' }
    const vectors = JSON.stringify({
      'rag:lexical:v1:0': { v: [1, 0], t: 'embed-v1' },
      'rag:semantic:v1:0': { v: [0, 1], t: 'embed-v1' },
    })
    const ports = setup(async () => [0, 1], [lexical, semantic], vectors)
    const result = await ports.search('owner-a', { scope_type: 'owner', scope_id: '' }, '项目进度', {
      sourceTypes: ['memory'], limit: 5,
    })

    expect(result.fusion).toBe('hybrid-rrf')
    expect(result.results[0]?.document.source_id).toBe('semantic')
    expect(ports.source).toHaveBeenCalledWith('memory', undefined)
  })

  it('invalidates the owner vector parse cache when the authorized file content changes', async () => {
    const lexical = { ...document, id: 'memory:lexical:0', source_id: 'lexical', parent_id: 'lexical',
      title: '项目进度', content: '项目进度 已经更新多次', text: '项目进度\n项目进度 已经更新多次' }
    const semantic = { ...document, id: 'memory:semantic:0', source_id: 'semantic', parent_id: 'semantic',
      title: '项目进度', content: '项目进度', text: '项目进度\n项目进度' }
    const vectors = {
      'rag:lexical:v1:0': { v: [1, 0], t: 'embed-v1' },
      'rag:semantic:v1:0': { v: [0, 1], t: 'embed-v1' },
    }
    const ports = setup(async () => [0, 1], [lexical, semantic], () => JSON.stringify(vectors))
    const args = [{ scope_type: 'owner', scope_id: '' }, '项目进度', { sourceTypes: ['memory'], limit: 5 }] as const

    const first = await ports.search('owner-a', ...args)
    vectors['rag:lexical:v1:0'] = { v: [0, 1], t: 'embed-v1' }
    vectors['rag:semantic:v1:0'] = { v: [1, 0], t: 'embed-v1' }
    const second = await ports.search('owner-a', ...args)

    expect(second.results.map(item => item.fused_score)).not.toEqual(first.results.map(item => item.fused_score))
    expect(ports.source).toHaveBeenCalledTimes(6)
  })

  it('reads 1.7.7 memory vectors after persistent IDs are namespaced by authorized scope', async () => {
    const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'
    const parent = 'memory:profile:profile:0'
    const buildSource = createMemoryRagSource({
      storage: { async readText({ key }) {
        if (key !== `${owner}/.agent/rag/memory/index.json`) return null
        return JSON.stringify({ schema_version: 1, documents: [{
          document_id: 'profile:0', parent_document_id: parent, chunk_index: 0, chunk_count: 1,
          source_type: 'memory', source_id: 'profile', title: '项目进度', summary: '',
          content: '项目进度已经更新', version: 'v1',
          scope: { owner_user_id: owner, scope_type: 'owner', scope_id: '' }, metadata: {},
        }] })
      } },
      scopeState: { async getMemoryScopeState() { throw new Error('owner source does not query IM scope state') } },
      async scopes() { return [] },
    })
    const namespaced = await buildSource(owner, null)
    expect(namespaced).toHaveLength(1)
    expect(namespaced[0]?.metadata?.memory_parent_id).toBe(parent)
    const legacyVectors = JSON.stringify({
      [`rag:${parent}:v1:0`]: { v: [0, 1], t: 'embed-v1' },
    })
    const ports = setup(async () => [0, 1], [...namespaced], legacyVectors)

    const result = await ports.search(owner, { scope_type: 'owner', scope_id: '' }, '项目进度', {
      sourceTypes: ['memory'], limit: 5,
    })

    expect(result.fusion).toBe('hybrid-rrf')
    expect(result.vectorDocCount).toBe(1)
    expect(result.results[0]?.document.id).toBe(namespaced[0]?.id)
    expect(ports.source).toHaveBeenCalledWith('memory', undefined)
  })
})
