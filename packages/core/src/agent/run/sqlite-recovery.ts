import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import type { CanonicalRunContext, RunCheckpoint, RunEvent, RunIdentity, ToolCall, ToolResult } from '../models.js'
import { projectPersistentToolResult, sealDisplayTimeline } from '../core.js'
import { terminalRunStates } from './lifecycle.js'
import { createSqliteAgentRunCoordination } from './sqlite-coordination.js'
import { writeSqliteAgentHistory } from './sqlite-history.js'
import { loadSqliteAgentRunSecret } from './sqlite-secret.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from './sqlite-store.js'

/** 等待用户时无需访问模型即可收尾取消或过期的运行。 */
export async function settleClosedSqliteInteraction(db: Kysely<Database>, path: string, identity: RunIdentity, now = new Date()) {
  const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
  const at = now.toISOString()
  const { rows } = await sql`SELECT 1 FROM agent_run_checkpoints c
    WHERE c.user_id=${owner} AND c.session_id=${identity.sessionId} AND c.run_id=${identity.runId}
      AND c.status='waiting' AND (
        EXISTS (SELECT 1 FROM agent_run_controls d
          WHERE d.user_id=c.user_id AND d.session_id=c.session_id AND d.run_id=c.run_id AND d.cancel_requested=1)
        OR EXISTS (SELECT 1 FROM agent_interaction_bindings b
          JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
          WHERE b.user_id=c.user_id AND b.session_id=c.session_id AND b.run_id=c.run_id
            AND (p.status='expired' OR (p.status='active' AND p.expires_at<=${at})))
      )`.execute(db)
  if (!rows.length) return false
  const leases = createSqliteAgentRunLeasePort(db)
  const lease = await leases.acquire(identity)
  if (!lease) return false
  try {
    const secret = await loadSqliteAgentRunSecret(db, path)
    let disposition: 'cancelled' | 'expired' = 'cancelled'
    const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, {
      async writeHistory(tx, run, history, checkpoint) {
        await writeSqliteAgentHistory(tx, run, history, checkpoint)
        await sql`UPDATE interaction_prompts SET status=${disposition},resolved_at=${at}
          WHERE user_id=${owner} AND session_id=${identity.sessionId} AND status IN ('active','expired')
            AND id IN (SELECT prompt_id FROM agent_interaction_bindings
              WHERE user_id=${owner} AND session_id=${identity.sessionId} AND run_id=${identity.runId})`.execute(tx)
      },
    })
    const previous = await store.read(identity)
    if (previous?.status !== 'waiting' || !previous.context || !previous.pending) return false
    const { rows: [closure] } = await sql<{ cancelled: number; expired: number }>`
      SELECT COALESCE(c.cancel_requested,0) AS cancelled, EXISTS (
        SELECT 1 FROM agent_interaction_bindings b
        JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
        WHERE b.user_id=a.user_id AND b.session_id=a.session_id AND b.run_id=a.run_id
          AND b.interaction_id=${previous.pending.id} AND b.tool_call_id=${previous.pending.toolCall.id}
          AND (p.status='expired' OR (p.status='active' AND p.expires_at<=${at}))
      ) AS expired
      FROM agent_run_admissions a
      LEFT JOIN agent_run_controls c ON c.user_id=a.user_id AND c.session_id=a.session_id AND c.run_id=a.run_id
      WHERE a.user_id=${owner} AND a.session_id=${identity.sessionId} AND a.run_id=${identity.runId}`.execute(db)
    if (!closure?.cancelled && !closure?.expired) return false
    disposition = closure.cancelled ? 'cancelled' : 'expired'
    const status = disposition === 'cancelled' ? 'cancelled' : 'failed'
    const errorCode = disposition === 'expired' ? 'interaction_expired' : null
    const sequence = previous.sequence + 1
    const sealedTools = previous.displayTimeline
      .filter(item => item.kind === 'tool' && ['queued', 'running', 'waiting'].includes(item.toolStatus ?? ''))
      .map(item => ({ ...item, toolStatus: 'cancelled', updatedAt: at }))
    const text = previous.displayTimeline.filter(item => item.kind === 'assistant' && item.text).map(item => item.text).join('\n\n')
    const event: RunEvent = { id: randomUUID(), identity, sequence, round: previous.round, type: 'final',
      payload: { status, errorCode, text: errorCode ? '这次交互已过期，请重新告诉我你的选择。' : text, sealedTools } }
    await store.commit({
      identity, lease, expectedVersion: previous.version, events: [event], interactionReceipt: null,
      checkpoint: { ...previous, version: previous.version + 1, sequence, status, phase: 'idle', errorCode,
        displayTimeline: previous.displayTimeline.map(item => sealedTools.find(tool => tool.eventId === item.eventId) ?? item),
        text, pending: null, queuedInteractions: [], resolution: null, resolutionClosure: null },
      history: { outcome: 'interruption', context: previous.context, text },
    })
    return true
  } finally { await leases.release(identity, lease) }
}

function canResumeCheckpoint(checkpoint: RunCheckpoint<CanonicalRunContext>) {
  if (checkpoint.status !== 'running' || !checkpoint.context || checkpoint.remoteStatusUnknown
    || checkpoint.unpersistedToolResult || checkpoint.pending || checkpoint.queuedInteractions?.length
    || checkpoint.replayCall || checkpoint.resolutionClosure) return false

  const serial = checkpoint.inflightCall
  const parallel = checkpoint.inflightCalls ?? []
  if (checkpoint.phase === 'decision') return !serial && parallel.length === 0
  if (checkpoint.phase !== 'tools') return false

  if (!checkpoint.calls?.length || !checkpoint.toolResults) return false
  const receipts = new Map(checkpoint.toolResults.map(item => [item.callId, item.result.kind]))
  if (checkpoint.toolsDispatched)
    return !serial && parallel.length === 0 && checkpoint.calls.every(call => receipts.get(call.id) === 'completed')

  // 共享运行器会继续派发排队调用。桌面启动仅接管已开始的付费搜索和已经落盘的回执。
  const roundId = `${checkpoint.identity.runId}:${checkpoint.round}`
  const started = new Set(checkpoint.displayTimeline.filter(item => item.kind === 'tool'
    && item.roundId === roundId && item.toolStatus === 'running').map(item => item.toolCallId))
  const canReconcile = (call: ToolCall) => started.has(call.id)
    && (call.name === 'deep_research' || call.name === 'similar_image_search')
    && !receipts.has(call.id)
  const inflight = new Set(parallel.filter(call => canReconcile(call) && checkpoint.parallelCallIds?.includes(call.id)).map(call => call.id))
  if (serial && canReconcile(serial) && checkpoint.serialCallIds?.includes(serial.id)) inflight.add(serial.id)
  return inflight.size > 0 && checkpoint.calls.every(call => receipts.get(call.id) === 'completed' || inflight.has(call.id))
}

/** 仅在运行时取得数据库独占锁后调用。保留已提交输出，不重放结果未知的调用。 */
export async function settleExclusiveSqliteAgentRuns(db: Kysely<Database>, path: string, ownerId: string,
  reconcile?: (call: ToolCall, identity: RunIdentity & { roundId: string }) => Promise<ToolResult>,
  resume?: (checkpoint: RunCheckpoint<CanonicalRunContext>) => Promise<boolean>,
): Promise<void> {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  await sql`UPDATE desktop_agent_reflection_jobs
    SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
      claimed_at_ms=NULL,last_error='reflection_interrupted'
    WHERE user_id=${owner} AND status='processing'`.execute(db)
  // 独占锁已接管，未绑定运行的整理任务不会再提交；仅释放状态，保留已落库的基线。
  await sql`UPDATE conversation_sessions AS s SET execution_state='idle',active_run_id=NULL
    WHERE s.user_id=${owner} AND (s.source IS NULL OR s.source='web') AND s.execution_state='baseline_updating'
      AND NOT EXISTS (SELECT 1 FROM agent_run_admissions a
        WHERE a.user_id=s.user_id AND a.session_id=s.id AND a.run_id=s.active_run_id)`.execute(db)
  const { rows } = await sql<{ session_id: number; run_id: string }>`
    SELECT a.session_id,a.run_id FROM agent_run_admissions a
    JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id AND s.active_run_id=a.run_id
    WHERE a.user_id=${owner}`.execute(db)
  if (!rows.length) return
  const secret = await loadSqliteAgentRunSecret(db, path)
  const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, { writeHistory: writeSqliteAgentHistory })
  const leases = createSqliteAgentRunLeasePort(db)
  const { failStart } = createSqliteAgentRunCoordination(db, store)
  for (const row of rows) {
    const identity = { ownerId, sessionId: String(row.session_id), runId: row.run_id }
    const previous = await store.read(identity)
    await sql`UPDATE agent_run_leases SET expires_at_ms=0
      WHERE user_id=${owner} AND session_id=${row.session_id} AND run_id=${row.run_id}`.execute(db)
    if (!previous) {
      await failStart(identity)
      continue
    }
    if (terminalRunStates.has(previous.status)) {
      await sql`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle'
        WHERE user_id=${owner} AND id=${row.session_id} AND active_run_id=${row.run_id}`.execute(db)
      continue
    }
    if (previous.status === 'waiting' && previous.pending) {
      if (await settleClosedSqliteInteraction(db, path, identity)) continue
      const { rows: waiting } = await sql`SELECT 1 FROM agent_interaction_bindings b
        JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
        JOIN desktop_agent_run_models m ON m.user_id=b.user_id AND m.session_id=b.session_id AND m.run_id=b.run_id
        LEFT JOIN agent_run_controls c ON c.user_id=b.user_id AND c.session_id=b.session_id AND c.run_id=b.run_id
        WHERE b.user_id=${owner} AND b.session_id=${row.session_id} AND b.run_id=${row.run_id}
          AND b.interaction_id=${previous.pending.id} AND b.tool_call_id=${previous.pending.toolCall.id}
          AND COALESCE(c.cancel_requested,0)=0 AND (p.status='resolved'
            OR (p.status='active' AND p.expires_at>${new Date().toISOString()}))`.execute(db)
      if (waiting.length) continue
    }
    if (resume && canResumeCheckpoint(previous)) {
      try { if (await resume(previous)) continue }
      catch { /* 模型重建失败时由原检查点完成中断结算。 */ }
    }
    const lease = await leases.acquire(identity)
    if (!lease) throw new Error('无法结算上次运行')
    try {
      const sequence = previous.sequence + 1
      const text = previous.displayTimeline.filter(item => item.kind === 'assistant' && item.text).map(item => item.text).join('\n\n')
      const errorCode = 'desktop_run_interrupted'
      // 已派发的调用只读取收据，排队中的调用不会触发查询。
      const roundId = `${identity.runId}:${previous.round}`
      const started = new Set(previous.displayTimeline.filter(item => item.kind === 'tool'
        && item.roundId === roundId && item.toolStatus === 'running').map(item => item.toolCallId))
      const recovered = new Map<string, Extract<ToolResult, { kind: 'completed' }>>()
      const inflight = new Map((previous.inflightCalls ?? []).map(call => [call.id, call]))
      if (previous.inflightCall) inflight.set(previous.inflightCall.id, previous.inflightCall)
      if (reconcile) {
        for (const call of inflight.values()) {
          if (!started.has(call.id)) continue
          try {
            const result = await reconcile(call, { ...identity, roundId })
            if (result.kind === 'completed') recovered.set(call.id, result)
          } catch { /* 查询失败仍保留未知状态，不派发调用。 */ }
        }
      }
      const updatedAt = new Date().toISOString()
      const displayTimeline = sealDisplayTimeline(previous.displayTimeline, updatedAt, item => item.toolStatus === 'running')
        .map(item => {
          const result = item.kind === 'tool' && item.roundId === roundId && item.toolStatus === 'unknown'
            && item.toolCallId ? recovered.get(item.toolCallId) : undefined
          return result ? { ...item, toolStatus: result.successful ? 'success' : 'error',
            toolResult: projectPersistentToolResult(result.value, true) } : item
        })
      const sealedTools = displayTimeline.filter((item, index) => item !== previous.displayTimeline[index])
      const queued = new Set(previous.displayTimeline.filter(item => item.kind === 'tool'
        && item.roundId === roundId && item.toolStatus === 'queued').map(item => item.toolCallId))
      const remoteStatusUnknown = previous.remoteStatusUnknown || previous.phase !== 'tools' || recovered.size === 0
        || [...inflight.keys()].some(id => !recovered.has(id) && !queued.has(id))
        || displayTimeline.some(item => item.kind === 'tool' && item.toolStatus === 'unknown')
      const status = remoteStatusUnknown ? 'unknown' : 'failed'
      const message = remoteStatusUnknown ? '上次桌面运行已中断，远端执行结果无法确认'
        : '上次桌面运行已中断，已恢复工具结果。'

      const event: RunEvent = { id: randomUUID(), identity, sequence, round: previous.round, type: 'final',
        payload: { status, errorCode, text: message, remoteStatusUnknown, sealedTools } }
      await store.commit({
        identity, lease, expectedVersion: previous.version, events: [event], interactionReceipt: null,
        checkpoint: { ...previous, version: previous.version + 1, sequence, status, phase: 'idle', errorCode,
          displayTimeline,
          text, remoteStatusUnknown, pending: null, queuedInteractions: [], resolution: null, resolutionClosure: null },
        history: previous.context ? { outcome: 'interruption', context: previous.context, text } : null,
      })
    } finally { await leases.release(identity, lease) }
  }
}
