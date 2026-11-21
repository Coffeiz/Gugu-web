import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { RagDocument } from '@gugu/core/agent/rag'
import { createRagLexicalIndex } from '../../../../../packages/core/src/agent/rag/lexical-index.js'
import { configureRagJieba } from '../../../../../packages/core/src/agent/rag/tokenizer.js'
import { getAgentRagJieba } from '../../../src/modules/agent/rag/jieba.js'

type Corpus = {
  owner_id: string
  top_k: number
  documents: Array<{ id: string; source_type: string; scope_type: string; scope_id: string; text: string }>
  queries: Array<{ id: string; query: string; relevant_ids: string[] }>
}

test('共享固定语料保持中文、英文、混合检索相关性与空结果', async () => {
  configureRagJieba(getAgentRagJieba())
  const fixturePath = fileURLToPath(new URL('../../../../../docs/testing/fixtures/rag-relevance-corpus.json', import.meta.url))
  const corpus = JSON.parse(await readFile(fixturePath, 'utf8')) as Corpus
  const index = createRagLexicalIndex(corpus.owner_id)
  const documents: RagDocument[] = corpus.documents.map((item) => ({
    ...item,
    document_version: 'fixture-v1',
    parent_id: item.id,
  }))
  index.replace(corpus.owner_id, 'fixture-v1', documents)

  for (const queryCase of corpus.queries) {
    const result = index.search(corpus.owner_id, queryCase.query, corpus.top_k, [], {
      scope_type: 'owner', scope_id: corpus.owner_id,
    })
    const hitIds = result.results.map((item) => item.id)
    const repeated = index.search(corpus.owner_id, queryCase.query, corpus.top_k, [], {
      scope_type: 'owner', scope_id: corpus.owner_id,
    })
    assert.deepEqual(repeated.results.map((item) => item.id), hitIds, `${queryCase.id}: repeated query changed hit order`)
    assert.ok(result.results.every((item) => item.document?.scope_type === 'owner' && item.document?.scope_id === corpus.owner_id),
      `${queryCase.id}: owner search returned an out-of-scope result`)
    const relevant = new Set(queryCase.relevant_ids)
    const recallAt3 = relevant.size
      ? [...relevant].filter((id) => hitIds.includes(id)).length / relevant.size
      : 1
    const reciprocalRank = hitIds.findIndex((id) => relevant.has(id))
    const mrr = reciprocalRank < 0 ? 0 : 1 / (reciprocalRank + 1)

    assert.equal(recallAt3, 1, `${queryCase.id}: hits=${hitIds.join(',')}`)
    if (relevant.size) assert.equal(mrr, 1, `${queryCase.id}: MRR=${mrr}, hits=${hitIds.join(',')}`)
    else assert.deepEqual(hitIds, [], `${queryCase.id} must return no unrelated candidates`)
  }
})
