import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { CanonicalRunContext, InteractionResolution, RunIdentity } from '@gugu/core/agent'
import { createAgentDispatchWorker } from '@gugu/core/agent'
import { agentDispatchSource, decryptAgentDispatchInput, type AgentDispatchLease, type createPostgresAgentDispatch } from '../../agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createPostgresInteractionResumeQueue } from '../../agent-sessions/persistence/agent-interaction-resume-postgres.js'
import { lockAgentRunSession } from '../../agent-sessions/persistence/agent-run-startup-postgres.js'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import type { createPostgresAgentRunStore } from '../../agent-sessions/persistence/agent-run-store-postgres.js'
import type { createImAgentReconstructor } from './agent-reconstructor.js'

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const terminal = new Set(['completed', 'cancelled', 'failed', 'unknown'])
/** 只认领具有真实IM入站收据的交互；waiting通过原Run的实际调度fence恢复，不抢Web消费者。 */
export function createImInteractionRecovery(options: { pool: Pick<Pool, 'query' | 'connect'>; secretKey: string;
  dispatch: ReturnType<typeof createPostgresAgentDispatch>
  store: Pick<ReturnType<typeof createPostgresAgentRunStore<CanonicalRunContext>>, 'read' | 'readForUpdate'>
  reconstruct: ReturnType<typeof createImAgentReconstructor>
  invalidateCredential(ownerId: string, serverId: string): Promise<void>
}) {
  const queue = createPostgresInteractionResumeQueue(options.pool)
  let closing = false
  async function acquire(identity: RunIdentity, cancelledOnly: boolean, receipt?: { promptId: number; interactionId: string; receipt: string }) {
    return withPostgresTransaction(options.pool, async client => {
      if (!await lockAgentRunSession(client, identity)) return null
      const selected = await client.query('SELECT 1 FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state=\'selected\' AND run_id<>$3', [identity.ownerId, identity.sessionId, identity.runId])
      if (selected.rowCount) return null
      const rows = await client.query<{ nonce: Buffer; payload: Buffer; leased: boolean; cancel_requested: boolean }>(`SELECT nonce,payload,cancel_requested,lease_expires_at>clock_timestamp() AS leased
        FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state IN ('done','selected') FOR UPDATE`, [identity.ownerId, identity.sessionId, identity.runId])
      const row = rows.rows[0]
      if (!row || row.leased || cancelledOnly && !row.cancel_requested) return null
      const input = decryptAgentDispatchInput(options.secretKey, identity, row.nonce, row.payload)
      if (agentDispatchSource(input) !== 'im' || input.v !== 3 || input.source !== 'im') return null
      if ((await client.query(`SELECT 1 FROM agent_run_leases WHERE user_id=$1 AND session_id=$2 AND expires_at>clock_timestamp()`, [identity.ownerId, identity.sessionId])).rowCount) return null
      const checkpoint = await options.store.readForUpdate(client, identity)
      if (!checkpoint || checkpoint.status !== 'waiting') return null
      let item: { identity: RunIdentity; promptId: number; claimToken: string; resolution: InteractionResolution; secretServerId: string | null } | undefined
      if (receipt) {
        const resumed = await client.query<{ schema_json: unknown; kind: string; tool_call_id: string }>(`SELECT p.schema_json,p.kind,b.tool_call_id FROM agent_interaction_resumes r
          JOIN interaction_prompts p ON p.id=r.prompt_id AND p.user_id=r.user_id AND p.session_id=r.session_id
          JOIN agent_interaction_bindings b ON b.prompt_id=p.id AND b.user_id=p.user_id AND b.session_id=p.session_id AND b.run_id=r.run_id AND b.interaction_id=r.interaction_id
          WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.prompt_id=$4 AND r.receipt=$5
            AND r.completed_at IS NULL AND (r.claim_expires_at IS NULL OR r.claim_expires_at<=clock_timestamp()) AND p.status='resolved'
          FOR UPDATE OF r SKIP LOCKED`, [identity.ownerId, identity.sessionId, identity.runId, receipt.promptId, receipt.receipt])
        const found = resumed.rows[0]
        if (!found || checkpoint.pending?.id !== receipt.interactionId || checkpoint.pending.toolCall.id !== found.tool_call_id) return null
        const schema = object(found.schema_json), answer = object(schema.resolved_result), target = object(object(schema.context).secret_target)
        if (schema.source !== 'agent' || object(schema.context).tool_name !== checkpoint.pending.toolCall.name
          || (checkpoint.pending.kind === 'confirmation') !== (found.kind === 'confirm')
          || (checkpoint.pending.kind === 'credential') !== (Array.isArray(schema.secret_fields) && schema.secret_fields.length > 0)) return null
        const status = answer.status === 'confirmed' ? 'confirmed' : answer.status === 'cancelled' ? 'cancelled' : 'answered'
        const secretServerId = Array.isArray(schema.secret_fields) && schema.secret_fields.length && status === 'answered'
          && target.kind === 'mcp_credentials' && typeof target.server_id === 'string' ? target.server_id : null
        const claimToken = randomUUID()
        const claimed = await client.query(`UPDATE agent_interaction_resumes SET claim_token=$6,claim_expires_at=clock_timestamp()+interval '30 seconds'
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND prompt_id=$4 AND receipt=$5 RETURNING prompt_id`,
        [identity.ownerId, identity.sessionId, identity.runId, receipt.promptId, receipt.receipt, claimToken])
        if (claimed.rowCount !== 1) throw new Error('IM 交互恢复认领失败')
        item = { identity, promptId: receipt.promptId, claimToken, secretServerId,
          resolution: { interactionId: receipt.interactionId, receiptId: receipt.receipt, status, value: found.kind === 'confirm' || secretServerId ? null : answer } }
      }
      const token = randomUUID()
      const updated = await client.query<{ fence: string | number }>(`UPDATE agent_run_dispatch SET state='selected',token=$4,fence=fence+1,
        lease_expires_at=clock_timestamp()+interval '30 seconds',blocked_reason=NULL
        WHERE user_id=$1 AND session_id=$2 AND run_id=$3 RETURNING fence`, [identity.ownerId, identity.sessionId, identity.runId, token])
      const fence = Number(updated.rows[0]?.fence)
      if (!Number.isSafeInteger(fence) || fence < 1) throw new Error('IM 交互调度认领失败')
      return { lease: { identity, input, token, fence, mode: 'resume', cancelRequested: row.cancel_requested } satisfies AgentDispatchLease, item }
    })
  }
  async function execute(lease: AgentDispatchLease, resolution?: InteractionResolution) {
    const worker = createAgentDispatchWorker<CanonicalRunContext, AgentDispatchLease>({ dispatch: { ...options.dispatch,
      async settleExpired() { return false }, async claim() { return lease } }, failStart: options.dispatch.failStart,
      async reconstruct(candidate) {
        const runtime = await options.reconstruct(candidate)
        if (!runtime) return null
        return { ...runtime, harness: { start: runtime.harness.start,
          resume: identity => runtime.harness.resume(identity, resolution) } }
      },
    })
    return worker.runOnce(lease.identity.ownerId, lease.identity.sessionId)
  }
  return {
    async pump(signal: AbortSignal) {
      signal.throwIfAborted(); if (closing) return
      // waiting已释放调度项时，精确持久取消仍需重新取得原Run租约以提交取消终态。
      const cancelled = await options.pool.query<{ user_id: string; session_id: number; run_id: string }>(`SELECT d.user_id::text,d.session_id,d.run_id
        FROM agent_run_dispatch d JOIN agent_run_checkpoints c USING(user_id,session_id,run_id)
        WHERE d.cancel_requested IS TRUE AND d.state IN ('done','selected') AND c.status='waiting'
          AND EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=d.user_id AND r.session_id=d.session_id AND r.run_id=d.run_id AND r.state='dispatched') ORDER BY d.sequence LIMIT 8`)
      for (const row of cancelled.rows) {
        signal.throwIfAborted(); if (closing) return
        const claimed = await acquire({ ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id }, true)
        if (claimed) await execute(claimed.lease)
      }
      const rows = await options.pool.query<{ user_id: string; session_id: number; run_id: string; prompt_id: number; interaction_id: string; receipt: string; nonce: Buffer; payload: Buffer }>(`SELECT r.user_id::text,r.session_id,r.run_id,r.prompt_id,r.interaction_id,r.receipt,d.nonce,d.payload
        FROM agent_interaction_resumes r JOIN agent_run_dispatch d USING(user_id,session_id,run_id) WHERE r.completed_at IS NULL AND (r.claim_expires_at IS NULL OR r.claim_expires_at<=clock_timestamp())
          AND EXISTS(SELECT 1 FROM gugu_im_inbound_receipts inbound WHERE inbound.user_id=r.user_id AND inbound.session_id=r.session_id AND inbound.run_id=r.run_id AND inbound.state='dispatched')
        ORDER BY r.created_at,r.prompt_id LIMIT 16`)
      for (const row of rows.rows) {
        signal.throwIfAborted(); if (closing) return
        const identity = { ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id }
        if (agentDispatchSource(decryptAgentDispatchInput(options.secretKey, identity, row.nonce, row.payload)) !== 'im') continue
        // 已消费的原收据不能因Run后来再次waiting而重放旧回答。
        const state = await options.store.read(identity)
        if (terminal.has(state?.status ?? '')) {
          await options.pool.query(`UPDATE agent_interaction_resumes r SET completed_at=COALESCE(completed_at,clock_timestamp()),claim_token=NULL,claim_expires_at=NULL
            WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND prompt_id=$4 AND receipt=$5
              AND EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=r.user_id AND c.session_id=r.session_id AND c.run_id=r.run_id AND c.status IN ('completed','cancelled','failed','unknown'))`,
          [identity.ownerId, identity.sessionId, identity.runId, row.prompt_id, row.receipt]); continue
        }
        if (await queue.isConsumed(identity, row.receipt)) { await queue.completeIfConsumed(identity, row.receipt); continue }
        const claimed = await acquire(identity, false, { promptId: row.prompt_id, interactionId: row.interaction_id, receipt: row.receipt })
        if (!claimed?.item) continue
        const item = claimed.item
        try {
          if (item.secretServerId) await options.invalidateCredential(identity.ownerId, item.secretServerId)
          await execute(claimed.lease, item.resolution)
          const after = await options.store.read(identity)
          if (after && (terminal.has(after.status) || after.status === 'waiting' && await queue.isConsumed(identity, row.receipt)))
            await queue.finishClaim(identity, item.promptId, item.claimToken)
        } finally { await queue.releaseClaim(identity, item.promptId, item.claimToken) }
      }
    },
    close() { closing = true },
  }
}
