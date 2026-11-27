// 使用合成语料和同一份快照，比较重建与增量更新的词法检索。
import assert from 'node:assert/strict'
import { createRagLexicalCorpusCache } from '../src/agent/rag/lexical-index.js'
import { configureRagJieba } from '../src/agent/rag/tokenizer.js'
import { getAgentRagJieba } from '../src/agent/rag/node-jieba.js'
import { createScopedRagSearch } from '../src/agent/rag/scoped-search.js'

const jieba = getAgentRagJieba()
let cuts = 0
configureRagJieba({ cut(text) { cuts++; return jieba.cut(text) } })
const documents = Array.from({ length: 22_000 }, (_, i) => ({
  id: String(i), source_type: 'conversation', scope_type: 'owner', scope_id: '',
  text: '云雀项目验收记录设备采购进度周例会问题与接口测试报告。'.repeat(5) + ' 合成编号 ' + i,
  metadata: { kind: 'message', message_id: i + 1 },
}))

const outputs = []
for (const optimized of [false, true]) {
  let current = documents
  let revision = 1
  cuts = 0
  const search = createScopedRagSearch({
    index: { async snapshotForScope() { return { documents: structuredClone(current), revision: String(revision), watermark: null } } },
    authorize: async () => true,
    ...(optimized ? { lexicalCorpus: createRagLexicalCorpusCache() } : {}),
  })
  const measurements = []
  for (let round = 0; round < 11; round++) {
    if (round >= 6) {
      revision++
      current = [...current.slice(1), { ...documents[0], id: 'new-' + round, text: '云雀项目验收 已交付 ' + round,
        metadata: { kind: 'message', message_id: documents.length + round } }]
    }
    const start = performance.now()
    const result = await search('synthetic-owner', { scope_type: 'owner' }, '项目验收 设备', {
      sourceTypes: ['conversation'], limit: 5, beforeMessageId: documents.length + round + 1,
    })
    const output = [result.results, result.fusion]
    if (optimized) assert.deepEqual(output, outputs[round])
    else outputs.push(output)
    measurements.push({ ms: Math.round(performance.now() - start), lexical: result.diagnostics.stage_ms.lexical_retrieval_ms })
  }
  const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
  const summarize = rows => ({ ms: median(rows.map(row => row.ms)), lexical: median(rows.map(row => row.lexical)) })
  console.log({ optimized, cold: measurements[0], warm: summarize(measurements.slice(1, 6)),
    changes: summarize(measurements.slice(6)), cuts })
}
