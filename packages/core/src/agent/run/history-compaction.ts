import { createHash, randomUUID } from 'node:crypto'
import { isCompactedSummaryMessage, stableJson } from '../context/history/canonical-history.js'
import { contentText, deterministicSummary, formatCompactedSummary, unwrapCompactedSummary, validateCompactSummary } from '../context/compaction.js'
import { updateBaselineSnapshot } from '../context/prepare.js'
import { protectedMessageIds } from '../context/history/retention.js'
import type { CanonicalMessage, CanonicalRunContext, Json } from '../models.js'
import type { CompactionPort } from '../ports.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

export interface HistoryCompactionRow {
  id: string; role: string; content: string; content_json: unknown; effective: string | number
  runId?: string | null; roundId?: string | null; canonicalBatchId?: string | null
  coversUntilSeq?: number | string | null
}

/** 与历史会话基线使用同一 SHA-256 格式。 */
export function canonicalBaselineHash(rows: readonly Omit<HistoryCompactionRow, 'effective'>[]): string {
  return digest(rows.map(row => ({ id: Number(row.id), role: row.role, content: row.content_json ?? row.content ?? '' })))
}

/** 按持久顺序整理旧历史，保留最近 Run 的最后十轮和完整锚点分组。 */
export function selectHistoryCompactionPrefix<Row extends HistoryCompactionRow>(
  rows: readonly Row[], previousBaseline: number, options?: { anchorSeq?: number; runId?: string },
) {
  const summary = rows.filter(row => row.role === 'summary').reduce<Row | undefined>((latest, row) =>
    !latest || Number(row.effective) >= Number(latest.effective) ? row : latest, undefined)
  const effectiveBaseline = Math.max(previousBaseline, Number(summary?.coversUntilSeq ?? 0))
  let anchor = options?.anchorSeq ?? Infinity
  if (options?.runId) {
    for (const row of rows) {
      if (row.role !== 'summary' && row.runId === options.runId) anchor = Math.min(anchor, Number(row.effective))
    }
  }
  const history = rows.filter(row => row.role !== 'summary' && Number(row.effective) > effectiveBaseline && Number(row.effective) < anchor)
  const protectedIds = protectedMessageIds(history)
  const split = history.findIndex(row => protectedIds.has(row.id))
  let end = split < 0 ? history.length : split
  while (end > 0 && Number(history[end - 1]?.effective) === Number(history[end]?.effective)) end--
  const covered = history.slice(0, end)
  const baseline = Number(covered.at(-1)?.effective)
  if (!Number.isSafeInteger(baseline) || baseline <= effectiveBaseline) return null
  return { covered, baseline, previous: summary?.content ?? null }
}

/** 只有摘要精确覆盖待提交前缀时才能复用，防止把保留轮次或本轮正文写入历史摘要。 */
export function reusableHistorySummary(context: CanonicalRunContext, covered: readonly HistoryCompactionRow[]): string {
  const latest = context.compactions.at(-1)?.result
  const coveredIds = context.compactions.flatMap(item => item.result.coversUntilMessageIds)
  if (!latest || context.compactions.some(item => !item.result.changed || item.result.coversUnpersisted !== false)
    || coveredIds.length !== covered.length || new Set(coveredIds).size !== covered.length) return ''
  const proof = new Set(coveredIds)
  if (covered.some(row => !proof.has(row.id))) return ''
  const summaries = latest.messages.filter(isCompactedSummaryMessage)
  if (summaries.length !== 1 || typeof summaries[0]!.content !== 'string') return ''
  const summary = unwrapCompactedSummary(summaries[0]!.content)
  return validateCompactSummary(summary) ? summary : ''
}

export function historyCompactionMessages(covered: readonly HistoryCompactionRow[]): CanonicalMessage[] {
  return covered.flatMap(row => {
    const content = contentText((row.content_json ?? row.content) as Json).trim()
    return content ? [{ role: row.role === 'user' ? 'user' : 'assistant', content }] : []
  })
}

export function emergencyHistorySummary(messages: readonly CanonicalMessage[], previous: string | null): string {
  return messages.length ? deterministicSummary(messages.map(message =>
    `${message.role === 'user' ? '用户' : '咕咕'}：${message.content}`), previous) : ''
}

export async function summarizeHistoryPrefix<Wire>(
  plan: NonNullable<ReturnType<typeof selectHistoryCompactionPrefix>>, port: CompactionPort<Wire>, signal: AbortSignal,
): Promise<string> {
  const messages = historyCompactionMessages(plan.covered)
  if (!messages.length) return ''
  const generated = await port.summarize({
    history: messages, compressible: messages, requestPrefix: [], projection: null,
    previousSummary: plan.previous ? formatCompactedSummary(plan.previous) : null, preserveLatestUser: false,
  }, signal)
  signal.throwIfAborted()
  const summary = validateCompactSummary(generated) ? generated : emergencyHistorySummary(messages, plan.previous)
  return validateCompactSummary(summary) ? summary : ''
}

/** 手动整理只提交在会话锁下仍与摘要输入一致的历史。 */
export function projectManualHistoryCompaction(summary: string, before: readonly HistoryCompactionRow[],
  current: readonly HistoryCompactionRow[], previousBaseline: number) {
  const plan = selectHistoryCompactionPrefix(before, previousBaseline)
  if (!plan || !validateCompactSummary(summary) || stableJson(current) !== stableJson(before))
    throw new Error('手动压缩的历史覆盖边界无效')
  return { summary, baseline: plan.baseline, hash: canonicalBaselineHash(plan.covered) }
}

export interface PreparedHistorySummary {
  prefixHash: string
  baseline: number
  previous: string | null
  summary: string
}

/** 事务内根据同一范围复核预生成摘要，失配时仅使用可信历史的有界摘要。 */
export function projectDurableHistoryCompaction(context: CanonicalRunContext, rows: readonly HistoryCompactionRow[], anchorSeq: string | number | undefined, prepared?: PreparedHistorySummary) {
  const snapshotState = context.sourceEffects?.sessionSnapshot.state
  const anchor = Number(anchorSeq)
  if (!context.historyBaseline || !snapshotState || !Number.isSafeInteger(anchor)
    || (!context.overflowTrimmed && !context.compactions.some(item => item.result.changed))) return null
  const plan = selectHistoryCompactionPrefix(rows, context.historyBaseline.baselineSeq, { anchorSeq: anchor, runId: context.identity.runId })
  if (!plan) return null
  const { covered, baseline, previous } = plan
  const hash = canonicalBaselineHash(covered)
  const generated = prepared?.prefixHash === hash && prepared.baseline === baseline && prepared.previous === previous ? prepared.summary : ''
  const summary = reusableHistorySummary(context, covered)
    || (validateCompactSummary(generated) ? generated : emergencyHistorySummary(historyCompactionMessages(covered), previous))
  if (!validateCompactSummary(summary)) return null
  const snapshot = updateBaselineSnapshot(snapshotState, [{ role: 'summary', content: summary }],
    { digest, nextId: randomUUID, now: Date.now }, { baselineMessageSeq: baseline })
  return { summary, baseline, hash, snapshot }
}
