import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { RagDocument } from '../../../src/agent/rag/contracts.js'
import { createScopedRagSearch } from '../../../src/agent/rag/scoped-search.js'
import { configureRagJieba } from '../../../src/agent/rag/tokenizer.js'

beforeAll(() => configureRagJieba({ cut: text => [text] }))

const document: RagDocument = {
  id: 'memory:fact:0', source_id: 'fact', source_type: 'memory', title: '项目进度',
  content: '项目进度已经更新', text: '项目进度\n项目进度已经更新', scope_type: 'owner', scope_id: '',
  document_version: 'v1', parent_id: 'fact', chunk_index: 0, chunk_count: 1,
}

function setup(embed: (owner: string, query: string, signal?: AbortSignal) => Promise<readonly number[]>, documents = [document], memoryVectors?: string) {
  const authorize = vi.fn(async () => true)
  const source = vi.fn(async (kind: string) => kind === 'memory' ? memoryVectors ?? null : null)
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

  it('reads 1.7.7 memory vectors after persistent IDs are namespaced by authorized scope', async () => {
    const namespaced = {
      ...document,
      id: 'memory:memory:profile:profile:0:scope:ab12:0',
      parent_id: 'memory:profile:profile:0:scope:ab12',
      metadata: { memory_parent_id: 'memory:profile:profile:0' },
    }
    const legacyVectors = JSON.stringify({
      'rag:memory:profile:profile:0:v1:0': { v: [0, 1], t: 'embed-v1' },
    })
    const ports = setup(async () => [0, 1], [namespaced], legacyVectors)

    const result = await ports.search('owner-a', { scope_type: 'owner', scope_id: '' }, '项目进度', {
      sourceTypes: ['memory'], limit: 5,
    })

    expect(result.fusion).toBe('hybrid-rrf')
    expect(result.vectorDocCount).toBe(1)
    expect(result.results[0]?.document.id).toBe(namespaced.id)
    expect(ports.source).toHaveBeenCalledWith('memory', undefined)
  })
})
