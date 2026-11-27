// 合成词料和延迟，不访问用户数据、数据库或真实 Provider。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createScopedRagSearch } from '../dist/agent/rag/scoped-search.js'
import { configureRagJieba } from '../dist/agent/rag/tokenizer.js'
import { getAgentRagJieba } from '../dist/agent/rag/node-jieba.js'

configureRagJieba(getAgentRagJieba())
const documents = Array.from({ length: 1_800 }, (_, i) => {
  const id = String(i)
  const text = i < 5 ? '云雀项目验收进度，接口联调结束并准备交付。'
    : '仓库物品清单与设备维护计划，联络与后续更新记录。'.repeat(2) + id
  return {
    id, parent_id: id, source_id: id, source_type: i < 5 ? 'memory' : 'conversation',
    scope_type: 'owner', scope_id: '', text, content: text, document_version: 'v1', chunk_index: 0, chunk_count: 1,
  }
})
documents.push({
  ...documents[5], id: 'pattern', source_type: 'memory',
  metadata: { memory_source_id: 'pattern', vector_key: 'pattern-key' },
})

for (const scenario of ['无词法命中', '无匹配向量', '存在可用向量']) {
  let requests = 0
  let patternReads = 0
  const search = createScopedRagSearch({
    index: { snapshotForScope: async () => ({ revision: 'fixture', documents, watermark: null }) },
    authorize: async () => true,
    vectors: {
      version: 'v1',
      async embed() {
        requests++
        await delay(1_600)
        return [1, 0]
      },
      async source() {
        return async kind => {
          if (kind === 'pattern') {
            patternReads++
            await delay(1_500)
            return JSON.stringify({ 'pattern-key': { t: 'v1', v: [1, 0] } })
          }
          return kind === 'memory' && scenario === '存在可用向量'
            ? JSON.stringify({ 'rag:0:v1:0': { t: 'v1', v: [1, 0] } }) : null
        }
      },
    },
  })
  const query = scenario === '无词法命中' ? '烘焙面包' : '云雀项目验收进度'
  const times = []
  let output
  let stages
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    const result = await search('fixture-owner', { scope_type: 'owner' }, query, { sourceTypes: ['memory', 'conversation'], limit: 5 })
    times.push(Math.round(performance.now() - start))
    const digest = createHash('sha256').update(JSON.stringify([result.results, result.fusion])).digest('hex')
    if (output) assert.equal(digest, output)
    output = digest
    stages = result.diagnostics.stage_ms
  }
  const sortedTimes = times.toSorted((a, b) => a - b)
  console.log(JSON.stringify({ scenario, times, medianMs: sortedTimes[2], maxMs: sortedTimes.at(-1), requests, patternReads, output, stages }))
}
