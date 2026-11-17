import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { configureRagJieba } from '../../../src/agent/rag/tokenizer.js'
import { rankCandidates } from '../../../src/agent/rag/ranking/rank-candidates.js'
import { queryMatch, SCORING_THRESHOLDS, sourceQualityV4, V4_LOW_SCORE_THRESHOLD, V4_PREFERRED_THRESHOLD } from '../../../src/agent/rag/ranking/confidence.js'
import { CONTRIBUTION_EXPONENT } from '../../../src/agent/rag/ranking/idf-rescore.js'
import type { RagDocument, RagRankCandidate } from '../../../src/agent/rag/contracts.js'

function candidate(id: string, sourceType: string, rawScore: number, text: string, document: Partial<RagDocument> = {}, fields: Partial<RagRankCandidate> = {}): RagRankCandidate {
  return {
    id, source_type: sourceType, raw_score: rawScore, fusion: 'bm25', ...fields,
    document: { id, text, content: text, source_type: sourceType, source_id: id, title: id,
      scope_type: 'owner', scope_id: '', document_version: '1', parent_id: id, chunk_index: 0,
      chunk_count: 1, metadata: {}, ...document },
  }
}

beforeAll(() => configureRagJieba({ cut: text => [text] }))

describe('1.7.7 RAG candidate scoring behavior', () => {
  it('does not use locale-sensitive Turkish I folding to create a Python-incompatible confidence match', () => {
    const row = candidate('file:turkish-i', 'file', 1, 'ıstanbul')
    expect(queryMatch('Istanbul', row.document)).toBe(0)
  })

  it('keeps production thresholds, IDF contribution exponent and source quality weights', () => {
    expect(V4_PREFERRED_THRESHOLD).toBe(0.55)
    expect(V4_LOW_SCORE_THRESHOLD).toBe(0.35)
    expect(CONTRIBUTION_EXPONENT).toBe(1.5)
    expect(sourceQualityV4('knowledge')).toBe(1)
    for (const source of ['memory', 'project', 'file', 'journal', 'note', 'calendar']) {
      expect(sourceQualityV4(source)).toBe(0.8)
    }
    for (const source of ['canvas', 'conversation', 'scheduled_task', 'unknown']) {
      expect(sourceQualityV4(source)).toBe(0.6)
    }
    expect(SCORING_THRESHOLDS['confidence-v1'].preferred).toBe(0.55)
  })

  it('uses confidence-v4 by default and returns only candidates within the selected confidence band', () => {
    const candidates = [
      candidate('k:1', 'knowledge', 10, '蒙扎赛道 t6 弯道名称知识正文'),
      candidate('c:1', 'conversation', 6, '蒙扎 t6 聊天记录'),
      candidate('m:1', 'memory', 4, '完全无关的生活碎片内容'),
    ]
    const { results, diagnostics } = rankCandidates('蒙扎 t6 弯道', candidates, { limit: 2, selectionMode: 'confidence' })
    expect(diagnostics.scoring_version).toBe('confidence-v4')
    expect(diagnostics.preferred_threshold).toBe(0.55)
    expect(diagnostics.threshold).toBe(0.35)
    expect(diagnostics.accepted_count).toBeGreaterThanOrEqual(1)
    expect(diagnostics.accepted_count).toBeLessThanOrEqual(2)
    for (const result of results) {
      expect(result.confidence).toBeLessThanOrEqual(result.source_quality + 1e-9)
      expect(result.confidence).toBeGreaterThanOrEqual(diagnostics.threshold)
    }
    if ((diagnostics.top_confidence ?? 0) >= 0.55) {
      expect(results.every(result => result.confidence >= 0.55)).toBe(true)
    }
  })

  it('retains the explicit confidence-v1 rollback semantics and blocks zero-match candidates', () => {
    const v1 = rankCandidates('蒙扎 t6 弯道', [
      candidate('k:1', 'knowledge', 10, '蒙扎赛道 t6 弯道名称知识正文'),
      candidate('c:1', 'conversation', 6, '蒙扎 t6 聊天记录'),
    ], { limit: 2, selectionMode: 'confidence', scoringVersion: 'confidence-v1' })
    expect(v1.diagnostics.scoring_version).toBe('confidence-v1')
    expect(v1.diagnostics.preferred_threshold).toBe(0.55)

    for (const scoringVersion of ['confidence-v1', 'confidence-v4'] as const) {
      const miss = rankCandidates('毫不相干的查询词', [candidate('c:2', 'conversation', 9, '今天吃了个汉堡')], {
        limit: 2, selectionMode: 'confidence', scoringVersion,
      })
      expect(miss.diagnostics.top_confidence).toBeLessThanOrEqual(0.34)
      expect(miss.results).toEqual([])
    }
  })

  it('keeps v4 confidence bounded when full-index statistics drive IDF rescoring', () => {
    const statistics = { documentCount: 100, averageLength: 6,
      documentFrequency: new Map([['缓存', 5], ['部署', 20]]), source: 'full_ts_index' as const }
    const { results, diagnostics } = rankCandidates('缓存 部署', [
      candidate('f:1', 'file', 10, '缓存文件的部署结论'),
      candidate('f:2', 'file', 6, '缓存文件的架构说明'),
    ], { limit: 5, selectionMode: 'confidence', corpusStatistics: statistics })
    expect(diagnostics.top_confidence).toBeLessThanOrEqual(1)
    for (const result of results) expect(result.confidence).toBeLessThanOrEqual(result.source_quality + 1e-9)
  })

  it('matches the Python preferred-band golden and excludes unrelated content', () => {
    const { results, diagnostics } = rankCandidates('缓存', [
      candidate('file:1', 'file', 10, '缓存索引说明'),
      candidate('file:2', 'file', 5, '完全不同的内容'),
      candidate('memory:1', 'memory', 1, '缓存使用规则'),
    ], { maxChars: 1000 })

    expect(results.map(item => item.id)).toEqual(['file:1'])
    expect(results[0]?.confidence).toBe(0.8)
    expect(results[0]?.source_quality).toBe(0.8)
    expect(results[0]?.normalized_score).toBe(1)
    expect(diagnostics.rejected_low_score).toBe(1)
    expect(diagnostics.rejected_not_preferred).toBe(1)
  })

  it('matches Python top-k behavior by bypassing confidence and diversity gates', () => {
    const rows = Array.from({ length: 5 }, (_, index) => candidate(
      `memory:${index}`, 'memory', 5 - index, `缓存相关记录 ${index} 的具体内容`, { parent_id: 'shared' },
    ))

    const { results, diagnostics } = rankCandidates('毫不相干', rows, { selectionMode: 'top_k', maxChars: 1000 })

    expect(results).toHaveLength(5)
    expect(diagnostics.rejected_low_score).toBe(0)
    expect(diagnostics.rejected_parent).toBe(0)
    expect(diagnostics.rejected_source).toBe(0)
    expect(diagnostics.rejected_similarity).toBe(0)
  })

  it('excludes prior history by canonical content hash and reports eligible source counts', () => {
    const oldText = '壮志凌云独行侠的正文内容'
    const old = candidate('old', 'file', 10, `片名\n摘要\n${oldText}`, { content: oldText, title: '片名', summary: '摘要' })
    const fresh = candidate('fresh', 'file', 5, '另一部电影正文')
    const hash = createHash('sha256').update(oldText).digest('hex')

    const { results, diagnostics } = rankCandidates('壮志凌云', [old, fresh], {
      selectionMode: 'top_k', excludeContentHashes: [hash], maxChars: 1000,
    })

    expect(results.map(item => item.id)).toEqual(['fresh'])
    expect(diagnostics.source_diagnostics.file).toEqual({ candidate_count: 2, eligible_count: 1, accepted_count: 1 })
  })

  it('aggregates citations for duplicate content and counts the duplicate rejection', () => {
    const first = candidate('file:1', 'file', 2, '共同内容', { title: '文件来源', metadata: { source_id: 'file-1' } })
    const second = candidate('canvas:1', 'canvas', 1, '共同内容', { title: '画布来源', metadata: { source_id: 'canvas-1' } })

    const { results, diagnostics } = rankCandidates('共同', [first, second], { selectionMode: 'top_k', maxChars: 1000 })

    expect(results).toHaveLength(1)
    expect(results[0]?.citations.map(item => item.source_id)).toEqual(['file-1', 'canvas-1'])
    expect(diagnostics.rejected_duplicate).toBe(1)
    expect(diagnostics.source_diagnostics.canvas?.accepted_count).toBe(0)
  })

  it('truncates contextual output to the UTF-16 budget while keeping citation identity', () => {
    const row = candidate('note:1', 'note', 1, '查询内容后续正文', { context_text: '注入上下文需要截断' })

    const { results, diagnostics } = rankCandidates('查询', [row], { selectionMode: 'top_k', maxChars: 6 })

    expect(results[0]?.text).toBe('注入上下文需')
    expect(diagnostics.output_chars).toBe(6)
    expect(results[0]?.citation.chunk_id).toBe('note:1:1:0')
  })

  it('preserves context whitespace when it fits within the output budget', () => {
    const row = candidate('note:space', 'note', 1, '缓存正文', { context_text: '  缓存上下文  ' })

    const { results, diagnostics } = rankCandidates('缓存', [row], { selectionMode: 'top_k', maxChars: 100 })

    expect(results[0]?.text).toBe('  缓存上下文  ')
    expect(diagnostics.output_chars).toBe('  缓存上下文  '.length)
  })

  it('accepts the exact Python preferred-confidence threshold boundary', () => {
    const { results, diagnostics } = rankCandidates('缓存查询', [
      candidate('knowledge:top', 'knowledge', 1, '缓存查询'),
      candidate('knowledge:boundary', 'knowledge', 0.4, '缓存查询次项'),
      candidate('knowledge:floor', 'knowledge', 0, '缓存查询底项'),
    ], { maxChars: 100 })

    expect(results.find(item => item.id === 'knowledge:boundary')?.confidence).toBe(0.55)
    expect(diagnostics.rejected_not_preferred).toBe(0)
  })

  it('uses the low-confidence band only when the preferred band is empty', () => {
    const { results, diagnostics } = rankCandidates('缓存', [
      candidate('canvas:1', 'canvas', 1, '缓存相关知识', {}, { fused_score: 0.8 }),
      candidate('canvas:2', 'canvas', 2, '无关内容', {}, { fused_score: 1 }),
    ], { maxChars: 1000 })

    expect(results).toHaveLength(1)
    expect(results[0]!.confidence).toBeGreaterThanOrEqual(0.35)
    expect(results[0]!.confidence).toBeLessThan(0.55)
    expect(diagnostics.rejected_low_score).toBe(1)
  })

  it('matches the Python confidence-v1 golden while retaining knowledge confidence weighting', () => {
    const { results, diagnostics } = rankCandidates('缓存', [
      candidate('knowledge:1', 'knowledge', 2, '缓存相关知识', { metadata: { confidence: 'confirmed' } }),
    ], { scoringVersion: 'confidence-v1', maxChars: 1000 })

    expect(results).toHaveLength(1)
    expect(results[0]?.normalized_score).toBe(2 / 3)
    expect(results[0]?.source_quality).toBe(0.8)
    expect(results[0]?.confidence).toBe(0.7766666666666667)
    expect(diagnostics.scoring_version).toBe('confidence-v1')
  })

  it('applies parent caps before source caps in confidence mode', () => {
    const rows = ['shared', 'shared', 'shared', 'other-a', 'other-b'].map((parent, index) => candidate(
      `file:${index + 1}`, 'file', 1, `缓存规则第${index + 1}组独立内容`, { parent_id: parent }, { fused_score: 1 },
    ))

    const { results, diagnostics } = rankCandidates('缓存', rows, { maxPerParent: 1, maxPerSource: 2, maxChars: 1000 })

    expect(results.map(item => item.id)).toEqual(['file:1', 'file:4'])
    expect(diagnostics.rejected_parent).toBe(2)
    expect(diagnostics.rejected_source).toBe(1)
  })

  it('rejects near-duplicate token sets in confidence mode', () => {
    const shared = '缓存 alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
    const { results, diagnostics } = rankCandidates('缓存', [
      candidate('file:1', 'file', 1, shared, {}, { fused_score: 1 }),
      candidate('file:2', 'file', 1, `${shared} mu`, {}, { fused_score: 1 }),
    ], { maxChars: 1000 })

    expect(results.map(item => item.id)).toEqual(['file:1'])
    expect(diagnostics.rejected_similarity).toBe(1)
  })
})
