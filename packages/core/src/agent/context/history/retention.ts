import type { PersistedHistoryRow } from '../../models.js'

/** 持久历史和无轮次旧记录共用最近完整轮次保留窗口。 */
export const PROTECTED_HISTORY_ROUNDS = 10

export function protectedMessageIds(rows: readonly Pick<PersistedHistoryRow, 'id' | 'runId' | 'roundId' | 'canonicalBatchId'>[], keepRounds = PROTECTED_HISTORY_ROUNDS): Set<string> {
  const keep = Math.max(1, Math.trunc(keepRounds))
  const latestRun = [...rows].reverse().find(row => row.runId)?.runId
  if (!latestRun || !rows.at(-1)?.runId) {
    const units: (typeof rows[number])[][] = []
    for (const row of rows) {
      const previous = units.at(-1)
      if (row.canonicalBatchId != null && previous?.[0]?.canonicalBatchId === row.canonicalBatchId)
        previous.push(row)
      else
        units.push([row])
    }
    return new Set(units.slice(-keep).flat().map(row => row.id))
  }
  const latest = rows.filter(row => row.runId === latestRun)
  const rounds = [...new Set(latest.flatMap(row => /^round-(\d+)$/.exec(row.roundId ?? '')?.[1] ? [Number(row.roundId!.slice(6))] : []))].sort((a, b) => a - b).slice(-keep)
  return new Set(latest.filter(row => rounds.includes(Number(row.roundId?.slice(6)))).map(row => row.id))
}
