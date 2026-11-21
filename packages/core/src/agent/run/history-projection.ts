import { createHash, randomUUID } from 'node:crypto'
import { MessageArea, stableJson } from '../context/history/canonical-history.js'
import { sanitizeMediaPayload } from '../context/messages/media.js'
import type { CanonicalRunContext, RunCheckpoint, RunIdentity } from '../models.js'
import type { RunStore } from '../ports.js'

export type CanonicalRunHistory = NonNullable<Parameters<RunStore<CanonicalRunContext>['commit']>[0]['history']>

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

export function projectCanonicalRunHistory(
  identity: RunIdentity, history: CanonicalRunHistory, checkpoint: RunCheckpoint<CanonicalRunContext>, now = Date.now,
) {
  for (const candidate of [history.context.identity, checkpoint.identity]) {
    if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId || candidate.runId !== identity.runId)
      throw new Error('Agent 历史身份不匹配')
  }
  const area = MessageArea.restore({ digest, nextId: randomUUID }, history.context.prepared.area)
  const failed = checkpoint.status === 'failed' || checkpoint.status === 'unknown'
  const delta = area.persistenceDelta(failed ? 'failure' : history.outcome === 'interruption' ? 'interruption' : 'success')
  const anchorEntry = [...area.entries].reverse().find(entry =>
    entry.persistedMessageId != null && ['user', 'reference', 'attachment'].includes(entry.source))
  const groups = delta.batches.map(batch => ({ entries: batch.entries, metadata: batch.metadata }))
  groups.push(...delta.entries.filter(entry => !entry.batchId).map(entry => ({ entries: [entry], metadata: { kind: entry.source } })))
  groups.sort((a, b) => a.entries[0]!.sequence - b.entries[0]!.sequence)
  const batches = groups.map(group => {
    const first = group.entries[0]!
    const metadata = { ...group.metadata, source: first.source, sequence_start: first.sequence,
      sequence_end: group.entries.at(-1)!.sequence, outcome: history.outcome === 'interruption' ? 'interruption' : 'success' }
    return {
      entries: group.entries,
      round: first.roundId || 'round-1',
      digest: digest({ messages: group.entries.map(entry => entry.message), metadata, run_id: identity.runId }).slice(0, 16),
    }
  })
  const outcome = failed ? JSON.stringify({ status: 'failed', runId: identity.runId, errorCode: checkpoint.errorCode }) : null
  const hasDisplay = history.outcome !== 'silent' && Boolean(history.text || checkpoint.files.length || checkpoint.displayTimeline.length)
  const text = checkpoint.status === 'cancelled' && history.text ? `${history.text}\n\n[本轮已中止，以上内容未完成]` : history.text
  const timeline = checkpoint.displayTimeline.map(item => item.kind === 'tool' && (item.toolStatus === 'queued' || item.toolStatus === 'running')
    ? { ...item, toolStatus: 'stopped', updatedAt: new Date(now()).toISOString() } : item)
  return {
    anchorEntry, delta, failed, batches, outcome,
    receipt: digest({ finalized_run: identity.runId }).slice(0, 16),
    display: hasDisplay ? {
      text,
      files: checkpoint.files.length ? JSON.stringify(sanitizeMediaPayload(checkpoint.files)) : null,
      timeline: timeline.length ? JSON.stringify(sanitizeMediaPayload(timeline)) : null,
    } : null,
  }
}
