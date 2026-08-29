/**
 * RAG 评分/过滤 TypeScript 基准。
 * 输入格式与生产 RAG 评分接口一致，避免基准测试混入数据差异。
 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const HARD_CONFIDENCE_FLOOR = 0.35
const PREFERRED_CONFIDENCE = 0.55

type Candidate = {
  sourceType: string
  title: string
  summary: string
  content: string
  textTokens: Set<string>
  fusedScore: number
  normalizedScore: number
  confidence: string
}

function parseCandidate(line: string): Candidate {
  const fields = line.split('\t')
  if (fields.length < 8) throw new Error('候选 TSV 字段不足')
  return {
    sourceType: fields[0],
    title: fields[1],
    summary: fields[2],
    content: fields[3],
    textTokens: new Set(fields[4].split(/\s+/).filter(Boolean)),
    fusedScore: Number(fields[5]),
    normalizedScore: Number(fields[6]),
    confidence: fields[7],
  }
}

function isMeaningful(token: string): boolean {
  return [...token].some((char) => /[\p{L}\p{N}_]/u.test(char))
}

function compact(text: string): string {
  return text.replace(/\s+/gu, '').toLocaleLowerCase()
}

function queryMatch(query: string, candidate: Candidate): number {
  const queryText = query.trim()
  const queryTokens = new Set(queryText.split(/\s+/).filter(isMeaningful))
  if (queryTokens.size === 0) return 0
  const text = `${candidate.title}\n${candidate.summary}\n${candidate.content}`
  const compactQuery = compact(queryText)
  if (compactQuery.length >= 2 && compact(text).includes(compactQuery)) return 1
  let hits = 0
  for (const token of queryTokens) if (candidate.textTokens.has(token)) hits += 1
  return hits / queryTokens.size
}

function sourceQuality(candidate: Candidate): number {
  const base = {
    memory: 0.8,
    file: 0.8,
    knowledge: 0.8,
    project: 0.9,
    canvas: 0.75,
    conversation: 0.65,
    journal: 0.7,
  }[candidate.sourceType] ?? 0.7
  if (candidate.sourceType !== 'knowledge') return base
  return base * ({ confirmed: 1, probable: 0.85, unverified: 0.65, conflict: 0.35 }[candidate.confidence] ?? 0.65)
}

function confidence(query: string, candidate: Candidate): number {
  const match = Math.min(1, queryMatch(query, candidate))
  const fused = candidate.fusedScore || candidate.normalizedScore
  let value = 0.55 * fused + 0.25 * match + 0.2 * sourceQuality(candidate)
  if (match <= 0) value = Math.min(value, HARD_CONFIDENCE_FLOOR - 0.01)
  return Math.min(1, Math.max(0, value))
}

function filterConfidence(query: string, candidates: Candidate[], limit: number): number {
  const scores = candidates.map((candidate) => confidence(query, candidate))
  const preferred = scores.filter((score) => score >= PREFERRED_CONFIDENCE).length
  const fallback = scores.filter((score) => score >= HARD_CONFIDENCE_FLOOR && score < PREFERRED_CONFIDENCE).length
  return Math.min(preferred > 0 ? preferred : fallback, Math.max(1, limit))
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.round((sorted.length - 1) * fraction)]
}

const input = process.argv[2]
const queryPath = process.argv[3]
const iterations = Number(process.argv[4] ?? 20)
if (!input || !queryPath) throw new Error('用法：rag_score_bench <candidates.tsv> <queries.txt> [iterations]')

const candidates = readFileSync(input, 'utf8').split('\n').filter(Boolean).map(parseCandidate)
const queries = readFileSync(queryPath, 'utf8').split('\n').filter(Boolean)
const timings: number[] = []
let acceptedTotal = 0
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const started = performance.now()
  for (const query of queries) acceptedTotal += filterConfidence(query, candidates, 20)
  timings.push((performance.now() - started) / queries.length)
}

console.log(`ts_candidates=${candidates.length}`)
console.log(`ts_queries=${queries.length}`)
console.log(`ts_iterations=${iterations}`)
console.log(`ts_score_filter_mean_ms=${(timings.reduce((sum, value) => sum + value, 0) / timings.length).toFixed(4)}`)
console.log(`ts_score_filter_p50_ms=${percentile(timings, 0.5).toFixed(4)}`)
console.log(`ts_score_filter_p95_ms=${percentile(timings, 0.95).toFixed(4)}`)
console.log(`ts_mean_accepted=${(acceptedTotal / (iterations * queries.length)).toFixed(2)}`)
