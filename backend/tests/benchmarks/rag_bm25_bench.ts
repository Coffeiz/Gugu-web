/** TypeScript BM25 基准，使用生产 lexical worker 的同一实现。 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

type Index = {
  lengths: number[]
  postings: Map<string, Map<number, number>>
  averageLength: number
}

function build(path: string): Index {
  const lengths: number[] = []
  const postings = new Map<string, Map<number, number>>()
  let totalLength = 0
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (let docId = 0; docId < lines.length; docId += 1) {
    const terms = lines[docId].split('\t')[1]?.split(/\s+/).filter(Boolean) ?? []
    const frequencies = new Map<string, number>()
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    const length = [...frequencies.values()].reduce((sum, value) => sum + value, 0)
    lengths.push(length)
    totalLength += length
    for (const [term, frequency] of frequencies) {
      const posting = postings.get(term) ?? new Map<number, number>()
      posting.set(docId, frequency)
      postings.set(term, posting)
    }
  }
  return { lengths, postings, averageLength: lengths.length ? totalLength / lengths.length : 0 }
}

function search(index: Index, query: string, limit: number): Array<[number, number]> {
  const scores = new Map<number, number>()
  const terms = new Set(query.split(/\s+/).filter(Boolean))
  const total = index.lengths.length
  for (const term of terms) {
    const posting = index.postings.get(term)
    if (!posting) continue
    const documentFrequency = posting.size
    const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5))
    for (const [docId, frequency] of posting) {
      const length = Math.max(1, index.lengths[docId])
      const norm = frequency + 1.2 * (1 - 0.75 + 0.75 * length / Math.max(1, index.averageLength))
      const score = idf * frequency * 2.2 / norm
      scores.set(docId, (scores.get(docId) ?? 0) + score)
    }
  }
  return [...scores.entries()]
    .sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || leftId - rightId)
    .slice(0, limit)
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.round((sorted.length - 1) * fraction)]
}

const corpus = process.argv[2]
const queryPath = process.argv[3]
const iterations = Number(process.argv[4] ?? 20)
if (!corpus || !queryPath) throw new Error('用法：rag_bm25_bench <corpus.tsv> <queries.txt> [iterations]')
const queries = readFileSync(queryPath, 'utf8').split('\n').filter(Boolean)
const cold: number[] = []
let documentCount = 0
for (let iteration = 0; iteration < 10; iteration += 1) {
  const started = performance.now()
  const index = build(corpus)
  documentCount = index.lengths.length
  cold.push(performance.now() - started)
}
const index = build(corpus)
const warm: number[] = []
let checksum = 0
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const started = performance.now()
  for (const query of queries) checksum += search(index, query, 10).length
  warm.push((performance.now() - started) / queries.length)
}
console.log(`ts_docs=${documentCount}`)
console.log(`ts_cold_mean_ms=${(cold.reduce((sum, value) => sum + value, 0) / cold.length).toFixed(4)}`)
console.log(`ts_cold_p50_ms=${percentile(cold, 0.5).toFixed(4)}`)
console.log(`ts_cold_p95_ms=${percentile(cold, 0.95).toFixed(4)}`)
console.log(`ts_warm_query_mean_ms=${(warm.reduce((sum, value) => sum + value, 0) / warm.length).toFixed(4)}`)
console.log(`ts_warm_query_p50_ms=${percentile(warm, 0.5).toFixed(4)}`)
console.log(`ts_warm_query_p95_ms=${percentile(warm, 0.95).toFixed(4)}`)
console.log(`ts_mean_result_count=${(checksum / (iterations * queries.length)).toFixed(2)}`)
console.log(`ts_checksum=${checksum}`)
