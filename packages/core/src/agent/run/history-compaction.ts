import { createHash, randomUUID } from 'node:crypto'
import { isCompactedSummaryMessage, stableJson } from '../context/history/canonical-history.js'
import { unwrapCompactedSummary, validateCompactSummary } from '../context/compaction.js'
import { updateBaselineSnapshot } from '../context/prepare.js'
import type { CanonicalRunContext, CompactionResult } from '../models.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

export interface HistoryCompactionRow {
  id: string; role: string; content: string; content_json: unknown; effective: string | number
}

/** 与历史会话基线使用同一 SHA-256 格式。 */
export function canonicalBaselineHash(rows: readonly Omit<HistoryCompactionRow, 'effective'>[]): string {
  return digest(rows.map(row => ({ id: Number(row.id), role: row.role, content: row.content_json ?? row.content ?? '' })))
}

/**
 * 手动整理只能替换此前读取且仍未变化的完整历史前缀。
 * 调用者在持有会话锁的事务内读取当前历史。
 */
export function projectManualHistoryCompaction(result: CompactionResult, before: readonly HistoryCompactionRow[],
  current: readonly HistoryCompactionRow[], previousBaseline: number) {
  if (!result.changed) return null
  const ids = result.coversUntilMessageIds
  const covered = before.filter(row => row.role !== 'summary').slice(0, ids.length)
  const baseline = Number(covered.at(-1)?.effective)
  const summaries = result.messages.filter(isCompactedSummaryMessage)
  if (!ids.length || result.coversUnpersisted || ids.some((id, index) => covered[index]?.id !== id)
    || stableJson(current.slice(0, ids.length)) !== stableJson(covered)
    || !Number.isSafeInteger(baseline) || baseline <= previousBaseline
    || Number(current[ids.length]?.effective ?? Infinity) <= baseline
    || summaries.length !== 1 || typeof summaries[0]!.content !== 'string')
    throw new Error('手动压缩的历史覆盖边界无效')
  const summary = unwrapCompactedSummary(summaries[0]!.content)
  if (!validateCompactSummary(summary)) throw new Error('手动压缩摘要无效')
  return { summary, baseline, hash: canonicalBaselineHash(covered) }
}

/** 调用者在事务内核对当前快照及基线，并提供按有效序号排列的完整历史前缀。 */
export function projectDurableHistoryCompaction(context: CanonicalRunContext, rows: readonly HistoryCompactionRow[], anchorSeq: string | number | undefined) {
  const result = context.compactions.at(-1)!.result
  const ids = context.compactions.flatMap(item => item.result.coversUntilMessageIds)
  if (context.compactions.some(item => !item.result.changed)
    || !ids.length || new Set(ids).size !== ids.length || !context.sourceEffects
    || ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))
    throw new Error('Agent 压缩覆盖边界无效')
  const covered = rows.slice(0, ids.length)
  // 模型按平台时间恢复消息，压缩水位按数据库序号推进；验证完整前缀成员及锚点。
  const coveredIds = new Set(ids)
  if (covered.length !== ids.length || covered.some(row => !coveredIds.has(row.id)))
    return null
  const baseline = Number(covered.at(-1)!.effective)
  if (rows[ids.length] && Number(rows[ids.length]!.effective) <= baseline)
    return null
  if (!Number.isSafeInteger(baseline) || baseline <= context.historyBaseline!.baselineSeq)
    throw new Error('Agent 压缩水位无效')
  // 复用摘要只能推进到当前用户消息之前，避免把本轮原文从后续上下文移除。
  if (anchorSeq !== undefined && baseline >= Number(anchorSeq)) return null
  const candidates = result.messages.filter(isCompactedSummaryMessage)
  if (candidates.length !== 1 || typeof candidates[0]!.content !== 'string') throw new Error('Agent 压缩摘要无效')
  const summary = unwrapCompactedSummary(candidates[0]!.content)
  if (!validateCompactSummary(summary)) throw new Error('Agent 压缩摘要无效')
  const hash = canonicalBaselineHash(covered)
  const snapshot = updateBaselineSnapshot(context.sourceEffects.sessionSnapshot.state, [{ role: 'summary', content: summary }],
    { digest, nextId: randomUUID, now: Date.now }, { baselineMessageSeq: baseline })
  return { summary, baseline, hash, snapshot }
}
