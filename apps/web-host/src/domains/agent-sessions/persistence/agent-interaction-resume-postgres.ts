import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import type { InteractionActionRecord, InteractionPromptRecord } from '@gugu/core/agent/interactions/consume-action'
import type { InteractionResolution, RunCheckpoint, RunEvent, RunIdentity } from '@gugu/core/agent'

interface CheckpointReader<C> { readForUpdate(client: PoolClient, identity: RunIdentity): Promise<RunCheckpoint<C> | null> }
interface ResumeRow { user_id: string; session_id: number; run_id: string; prompt_id: number; interaction_id: string; receipt: string; schema_json: unknown; kind: string; claim_token?: string }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

export interface AgentInteractionResumeClaim {
  identity: RunIdentity
  promptId: number
  claimToken: string
  receipt: string
  resolution: InteractionResolution
}

/** dispatch 已持有 owner/session 锁时，才可为 waiting checkpoint 认领已解析的 prompt。 */
export async function claimInteractionResumeLocked(client: PoolClient, identity: RunIdentity, leaseSeconds = 30): Promise<AgentInteractionResumeClaim | null> {
  if (!identity.ownerId || !/^[1-9]\d*$/.test(identity.sessionId) || !identity.runId || identity.runId.length > 128
    || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new TypeError('交互恢复 claim 参数无效')
  const sessionId = Number(identity.sessionId)
  await client.query(`UPDATE agent_interaction_resumes r SET completed_at=COALESCE(r.completed_at,clock_timestamp()),claim_token=NULL,claim_expires_at=NULL
    WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.completed_at IS NULL
      AND EXISTS (SELECT 1 FROM agent_run_interaction_receipts x WHERE x.user_id=r.user_id AND x.session_id=r.session_id AND x.run_id=r.run_id AND x.receipt=r.receipt)`,
  [identity.ownerId, sessionId, identity.runId])
  const token = randomUUID()
  const result = await client.query<ResumeRow>(`WITH candidate AS (
      SELECT r.user_id,r.session_id,r.run_id,r.prompt_id FROM agent_interaction_resumes r
      JOIN interaction_prompts p ON p.id=r.prompt_id AND p.user_id=r.user_id AND p.session_id=r.session_id
      WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.completed_at IS NULL
        AND p.status='resolved' AND (r.claim_expires_at IS NULL OR r.claim_expires_at<=clock_timestamp())
      ORDER BY r.created_at,r.prompt_id FOR UPDATE OF r SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE agent_interaction_resumes r SET claim_token=$4,claim_expires_at=clock_timestamp()+($5*interval '1 second')
      FROM candidate c WHERE r.user_id=c.user_id AND r.session_id=c.session_id AND r.run_id=c.run_id AND r.prompt_id=c.prompt_id
      RETURNING r.*
    ) SELECT r.user_id,r.session_id,r.run_id,r.prompt_id,r.interaction_id,r.receipt,r.claim_token,p.schema_json,p.kind
      FROM claimed r JOIN interaction_prompts p ON p.id=r.prompt_id AND p.user_id=r.user_id AND p.session_id=r.session_id AND p.status='resolved'`,
  [identity.ownerId, sessionId, identity.runId, token, leaseSeconds])
  const row = result.rows[0]
  if (!row) return null
  const schema = record(row.schema_json), answer = record(schema.resolved_result)
  // HTTP 保留选项回执 selected，Core 使用 answered 恢复选择和问答。
  const status = answer.status === 'selected' && (row.kind === 'choice' || row.kind === 'question')
    ? 'answered' : answer.status
  if (status !== 'confirmed' && status !== 'cancelled' && status !== 'answered') throw new Error('交互恢复结果无效')
  return {
    identity: { ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id },
    promptId: row.prompt_id,
    claimToken: row.claim_token ?? token,
    receipt: row.receipt,
    resolution: { interactionId: row.interaction_id, receiptId: row.receipt, status,
      value: row.kind === 'confirm' ? null : answer },
  }
}

/** 交互激活器在创建 prompt 的同一事务调用；无绑定的旧 prompt 不允许恢复。 */
export async function bindInteractionPrompt(client: PoolClient, identity: RunIdentity, promptId: number, interactionId: string, toolCallId: string): Promise<void> {
  if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(promptId) || promptId < 1 || !interactionId || !toolCallId || interactionId.length > 200 || toolCallId.length > 200) throw new TypeError('交互绑定无效')
  const result = await client.query(`INSERT INTO agent_interaction_bindings (user_id, session_id, run_id, prompt_id, interaction_id, tool_call_id)
    SELECT p.user_id, p.session_id, $3, p.id, $4, $5 FROM interaction_prompts p
    WHERE p.id=$1 AND p.user_id=$2 AND p.session_id=$6
    ON CONFLICT (prompt_id) DO UPDATE SET prompt_id=EXCLUDED.prompt_id
      WHERE agent_interaction_bindings.user_id=EXCLUDED.user_id AND agent_interaction_bindings.session_id=EXCLUDED.session_id
        AND agent_interaction_bindings.run_id=EXCLUDED.run_id AND agent_interaction_bindings.interaction_id=EXCLUDED.interaction_id AND agent_interaction_bindings.tool_call_id=EXCLUDED.tool_call_id
    RETURNING prompt_id`, [promptId, identity.ownerId, identity.runId, interactionId, toolCallId, Number(identity.sessionId)])
  if (result.rowCount !== 1) throw new Error('交互绑定无效')
}

/** 必须作为消费事务 beforeCommit；只存恢复引用，回答及凭据不复制进队列。 */
export function createInteractionResumeEnqueuer<C>(store: CheckpointReader<C>) {
  return async (client: PoolClient, prompt: InteractionPromptRecord, action: InteractionActionRecord): Promise<void> => {
    const resolved = record(prompt.schema.resolved_result), toolId = action.context.tool_call_id
    if (resolved.status === 'error') return
    if (typeof toolId !== 'string' || !toolId) throw new Error('该交互不支持恢复原任务')
    const binding = await client.query<{ run_id: string; interaction_id: string; tool_call_id: string }>(`SELECT run_id, interaction_id, tool_call_id FROM agent_interaction_bindings
      WHERE prompt_id = $1 AND user_id = $2 AND session_id = $3 FOR UPDATE`, [prompt.id, prompt.ownerId, prompt.sessionId])
    const found = binding.rows[0]
    if (!found || found.tool_call_id !== toolId) throw new Error('交互绑定不存在或已失效')
    const identity = { ownerId: prompt.ownerId, sessionId: String(prompt.sessionId), runId: found.run_id }
    const checkpoint = await store.readForUpdate(client, identity), pending = checkpoint?.pending
    const secret = Array.isArray(prompt.schema.secret_fields) && prompt.schema.secret_fields.length > 0
    if (checkpoint?.status !== 'waiting' || !pending || pending.id !== found.interaction_id || pending.toolCall.id !== toolId || (pending.kind === 'credential') !== secret) throw new Error('交互状态已失效')
    const interactionId = pending.id
    await client.query(`INSERT INTO agent_interaction_resumes (user_id, session_id, run_id, prompt_id, interaction_id, receipt, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`, [prompt.ownerId, prompt.sessionId, identity.runId, prompt.id, interactionId, `web-prompt:${prompt.id}`])
  }
}

/** 多 worker 可并发尝试；运行租约和 Core 收据负责互斥与恢复，未确认的条目保留供重试。 */
export function createPostgresInteractionResumeQueue(pool: Pick<Pool, 'query'>) {
  return {
    async pending(limit = 50): Promise<Array<{ identity: RunIdentity; promptId: number; resolution: InteractionResolution }>> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('恢复批量大小无效')
      const result = await pool.query<ResumeRow>(`SELECT r.user_id, r.session_id, r.run_id, r.prompt_id, r.interaction_id, r.receipt, p.schema_json, p.kind
        FROM agent_interaction_resumes r JOIN interaction_prompts p ON p.id = r.prompt_id AND p.user_id = r.user_id AND p.session_id = r.session_id
        WHERE r.completed_at IS NULL AND p.status = 'resolved' ORDER BY r.created_at, r.prompt_id LIMIT $1`, [limit])
      return result.rows.map(row => {
        const result = record(record(row.schema_json).resolved_result)
        const status = result.status === 'confirmed' ? 'confirmed' : result.status === 'cancelled' ? 'cancelled' : 'answered'
        return { identity: { ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id }, promptId: row.prompt_id,
          resolution: { interactionId: row.interaction_id, receiptId: row.receipt, status, value: row.kind === 'confirm' ? null : result } }
      })
    },
    async claim(leaseSeconds = 30): Promise<{ identity: RunIdentity; promptId: number; resolution: InteractionResolution; claimToken: string; secretServerId: string | null } | null> {
      if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) throw new RangeError('恢复认领时间无效')
      const token = randomUUID()
      const result = await pool.query<ResumeRow>(`WITH candidate AS (
          SELECT user_id, session_id, run_id, prompt_id FROM agent_interaction_resumes
          WHERE completed_at IS NULL AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
          ORDER BY created_at, prompt_id FOR UPDATE SKIP LOCKED LIMIT 1
        ), claimed AS (
          UPDATE agent_interaction_resumes r SET claim_token = $1, claim_expires_at = clock_timestamp() + ($2 * interval '1 second')
          FROM candidate c WHERE r.user_id = c.user_id AND r.session_id = c.session_id AND r.run_id = c.run_id AND r.prompt_id = c.prompt_id
          RETURNING r.*
        ) SELECT r.user_id, r.session_id, r.run_id, r.prompt_id, r.interaction_id, r.receipt, r.claim_token, p.schema_json, p.kind
          FROM claimed r JOIN interaction_prompts p ON p.id = r.prompt_id AND p.user_id = r.user_id AND p.session_id = r.session_id AND p.status = 'resolved'`, [token, leaseSeconds])
      const row = result.rows[0]
      if (!row) return null
      const schema = record(row.schema_json), answer = record(schema.resolved_result), target = record(record(schema.context).secret_target)
      const status = answer.status === 'confirmed' ? 'confirmed' : answer.status === 'cancelled' ? 'cancelled' : 'answered'
      const secretServerId = Array.isArray(schema.secret_fields) && status === 'answered' && target.kind === 'mcp_credentials' && typeof target.server_id === 'string' ? target.server_id : null
      return { identity: { ownerId: row.user_id, sessionId: String(row.session_id), runId: row.run_id }, promptId: row.prompt_id, claimToken: token, secretServerId,
        resolution: { interactionId: row.interaction_id, receiptId: row.receipt, status, value: row.kind === 'confirm' || secretServerId ? null : answer } }
    },
    async releaseClaim(identity: RunIdentity, promptId: number, token: string): Promise<void> {
      await pool.query('UPDATE agent_interaction_resumes SET claim_token = NULL, claim_expires_at = NULL WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND prompt_id = $4 AND claim_token = $5 AND completed_at IS NULL', [identity.ownerId, identity.sessionId, identity.runId, promptId, token])
    },
    async finishClaim(identity: RunIdentity, promptId: number, token: string): Promise<boolean> {
      const result = await pool.query(`UPDATE agent_interaction_resumes r SET completed_at = clock_timestamp(), claim_token = NULL, claim_expires_at = NULL
        WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.prompt_id=$4 AND r.claim_token=$5 AND r.completed_at IS NULL
        AND (EXISTS (SELECT 1 FROM agent_run_interaction_receipts x WHERE x.user_id=r.user_id AND x.session_id=r.session_id AND x.run_id=r.run_id AND x.receipt=r.receipt)
          OR EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=r.user_id AND c.session_id=r.session_id AND c.run_id=r.run_id AND c.status IN ('cancelled','failed','completed','unknown')))`, [identity.ownerId, identity.sessionId, identity.runId, promptId, token])
      return result.rowCount === 1
    },
    async isConsumed(identity: RunIdentity, receipt: string): Promise<boolean> {
      const result = await pool.query('SELECT 1 FROM agent_run_interaction_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND receipt=$4', [identity.ownerId, identity.sessionId, identity.runId, receipt])
      return result.rowCount === 1
    },
    async completeIfConsumed(identity: RunIdentity, receipt: string): Promise<boolean> {
      const result = await pool.query(`UPDATE agent_interaction_resumes r SET completed_at = COALESCE(r.completed_at, clock_timestamp())
        WHERE r.user_id = $1 AND r.session_id = $2 AND r.run_id = $3 AND r.receipt = $4
          AND EXISTS (SELECT 1 FROM agent_run_interaction_receipts x WHERE x.user_id = r.user_id AND x.session_id = r.session_id AND x.run_id = r.run_id AND x.receipt = r.receipt)`, [identity.ownerId, identity.sessionId, identity.runId, receipt])
      return result.rowCount === 1
    },
  }
}
export async function deliverInteractionResume(item: { identity: RunIdentity; resolution: InteractionResolution }, queue: Pick<ReturnType<typeof createPostgresInteractionResumeQueue>, 'completeIfConsumed'>, resume: (identity: RunIdentity, resolution: InteractionResolution) => AsyncIterable<RunEvent>): Promise<void> {
  if (await queue.completeIfConsumed(item.identity, item.resolution.receiptId)) return
  for await (const event of resume(item.identity, item.resolution)) {
    if (event.identity.ownerId !== item.identity.ownerId || event.identity.sessionId !== item.identity.sessionId || event.identity.runId !== item.identity.runId) throw new Error('运行身份不匹配')
  }
  await queue.completeIfConsumed(item.identity, item.resolution.receiptId)
}
