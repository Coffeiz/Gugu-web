import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { agentDispatchSource, decryptAgentDispatchInput, type ImAgentDispatchInput } from '../../agent/run/dispatch.js'

/** IM收据仅作为候选索引；真正执行前仍解密验证v3来源，Web任务没有消费资格。 */
export function createImHostScans(options: { pool: Pick<Pool, 'query'>; secretKey: string; concurrency?: number;
  diagnose?(code: 'dispatch_unavailable', error: unknown): void
  kick(ownerId: string, sessionId: string): Promise<void>
  recover(identity: RunIdentity, input: ImAgentDispatchInput, signal: AbortSignal): Promise<void> }) {
  const capacity = options.concurrency ?? 1
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32) throw new Error('IM 调度并发配置无效')
  const running = new Map<string, Promise<void>>()
  let closing = false, failed = false
  // 仅轮询公平性水位；绝不替代或推进每个Run的持久投递cursor。
  let dispatchAfter = '0', deliveryAfter = '0'
  const advance = (value: string) => {
    if (!/^[1-9]\d*$/.test(value)) throw new Error('IM 扫描顺序无效')
    return value
  }
  return {
    health: () => ({ active: running.size, closing, failed }),
    async scanDispatch(signal: AbortSignal) {
      signal.throwIfAborted()
      if (closing) return
      if (failed) { failed = false; throw new Error('IM 调度后台执行失败') }
      if (running.size >= capacity) return
      const rows = await options.pool.query<{ user_id: string; session_id: number; run_id: string; nonce: Buffer; payload: Buffer; scan_sequence: string }>(`SELECT * FROM (
        SELECT DISTINCT ON (d.user_id,d.session_id) d.user_id::text,d.session_id,d.run_id,d.nonce,d.payload,d.sequence::text AS scan_sequence,d.sequence
        FROM agent_run_dispatch d LEFT JOIN agent_run_checkpoints c ON c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id
        WHERE d.sequence>$1::bigint AND d.state IN ('selected','queued') AND d.blocked_reason IS DISTINCT FROM 'version_conflict'
          AND (c.status IS NULL OR c.status IN ('preparing','running') OR c.status='waiting' AND d.cancel_requested IS TRUE)
          AND EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=d.user_id AND r.session_id=d.session_id AND r.run_id=d.run_id AND r.state='dispatched')
        ORDER BY d.user_id,d.session_id,d.sequence) candidates ORDER BY sequence LIMIT 128`, [dispatchAfter])
      if (!rows.rows.length) dispatchAfter = '0'
      for (const row of rows.rows) {
        signal.throwIfAborted()
        if (closing || running.size >= capacity) break
        dispatchAfter = advance(row.scan_sequence)
        const identity = { ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id }
        const input = decryptAgentDispatchInput(options.secretKey, identity, row.nonce, row.payload)
        if (agentDispatchSource(input) !== 'im') continue
        const key = JSON.stringify([identity.ownerId, identity.sessionId])
        if (running.has(key)) continue
        let task: Promise<void>
        task = options.kick(identity.ownerId, identity.sessionId).catch(error => {
          failed = true
          try { options.diagnose?.('dispatch_unavailable', error) } catch { /* 诊断不影响下一轮扫描。 */ }
        }).finally(() => { if (running.get(key) === task) running.delete(key) })
        running.set(key, task)
      }
    },
    async recoverDeliveries(signal: AbortSignal) {
      signal.throwIfAborted()
      if (closing) return
      const rows = await options.pool.query<{ user_id: string; session_id: number; run_id: string; nonce: Buffer; payload: Buffer; scan_sequence: string }>(`SELECT d.user_id::text,d.session_id,d.run_id,d.nonce,d.payload,d.sequence::text AS scan_sequence
        FROM agent_run_dispatch d JOIN agent_run_checkpoints c ON c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id
        LEFT JOIN gugu_im_run_delivery delivery ON delivery.user_id=d.user_id AND delivery.session_id=d.session_id AND delivery.run_id=d.run_id
        WHERE d.sequence>$1::bigint AND c.status IN ('waiting','completed','failed','cancelled','unknown')
          AND EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=d.user_id AND r.session_id=d.session_id AND r.run_id=d.run_id AND r.state='dispatched')
          AND EXISTS(SELECT 1 FROM agent_run_events e WHERE e.user_id=d.user_id AND e.session_id=d.session_id AND e.run_id=d.run_id AND e.sequence>COALESCE(delivery.cursor,0))
        ORDER BY d.sequence LIMIT 32`, [deliveryAfter])
      if (!rows.rows.length) deliveryAfter = '0'
      let failure: { cause: unknown } | undefined
      for (const row of rows.rows) {
        signal.throwIfAborted()
        if (closing) return
        deliveryAfter = advance(row.scan_sequence)
        try {
          const identity = { ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id }
          const input = decryptAgentDispatchInput(options.secretKey, identity, row.nonce, row.payload)
          if (agentDispatchSource(input) !== 'im' || input.v !== 3 || input.source !== 'im') continue
          await options.recover(identity, input, signal)
        } catch (error) { if (signal.aborted) signal.throwIfAborted(); failure ??= { cause: error } }
      }
      if (failure) throw new Error('IM 出站恢复尚未完成', failure)
    },
    async close() { closing = true; await Promise.allSettled([...running.values()]) },
  }
}
