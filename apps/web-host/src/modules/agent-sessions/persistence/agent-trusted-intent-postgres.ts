import type { PoolClient } from 'pg'
import type { PendingInteraction, RunIdentity } from '@gugu/core/agent'
import type { ConfirmationBinding } from '@gugu/core/tools'
import type { ConfirmationClaimReference } from '@gugu/core/tools'
import type { Database } from '@gugu/core/data'
import { sql, type Transaction } from 'kysely'
import { decryptByokCredential, encryptByokEnvelope } from '../../agent/model-config/byok.js'
import type { TrustedPromptIntent } from './agent-trusted-prompt-descriptions.js'
import { mcpCredentialConfigurationVersionSql } from './agent-trusted-prompt-descriptions.js'
import { z } from 'zod'

const text = z.string().min(1)
const binding = z.object({ ownerId: text, sessionId: text, runId: text, roundId: text, toolCallId: text, toolName: text, normalizedInputDigest: text }).strict()
const operationSchema = z.object({
  intent: z.object({ schemaVersion: z.literal(2), binding, intentId: text, interactionId: text, operationId: text,
    purpose: z.enum(['action', 'authorization']), action: text, targetsDigest: text, versionsDigest: text,
    authorizationEpoch: text, expiresAt: z.number().finite() }).strict(),
  snapshot: z.object({ targetsDigest: text, versionsDigest: text,
    targetIds: z.record(z.string().trim().min(1), z.array(z.number().int().safe().positive())).optional(),
    targetRefs: z.record(z.string().trim().min(1), z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u))).optional(),
  }).strict().refine(({ targetIds, targetRefs }) => !Object.keys(targetRefs ?? {}).some(kind => Object.hasOwn(targetIds ?? {}, kind))
    && [...Object.values(targetIds ?? {}), ...Object.values(targetRefs ?? {})].some(ids => ids.length > 0)),
}).strict()

function validateOperation(identity: RunIdentity, request: PendingInteraction, intent: TrustedPromptIntent, expiresAt: number): void {
  if (intent.kind !== 'confirmation' || !intent.operation) return
  const parsed = operationSchema.safeParse(intent.operation)
  if (!parsed.success) throw new Error('可信确认意图无效')
  const { intent: operation, snapshot } = parsed.data
  const b = operation.binding
  const targets = { ...snapshot.targetIds, ...snapshot.targetRefs }
  const keys = Object.keys(targets).sort()
  if (b.ownerId !== identity.ownerId || b.sessionId !== identity.sessionId || b.runId !== identity.runId
    || b.toolCallId !== request.toolCall.id || b.toolName !== request.toolCall.name || operation.interactionId !== request.id
    || operation.action !== intent.action || operation.targetsDigest !== snapshot.targetsDigest || operation.versionsDigest !== snapshot.versionsDigest
    || !Number.isFinite(expiresAt) || operation.expiresAt <= Date.now() || operation.expiresAt > expiresAt
    || JSON.stringify(keys) !== JSON.stringify(Object.keys(intent.targets).sort())
    || keys.some(key => JSON.stringify(targets[key]) !== JSON.stringify(intent.targets[key])))
    throw new Error('可信确认意图绑定无效')
}

/** 只能由可信工具执行器调用，模型不能写入该服务端意图。 */
export function createPostgresTrustedIntentStore(keyForVersion: (version: number) => string, currentVersion: number) {
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) throw new TypeError('凭据密钥版本无效')
  function sealIntent(identity: RunIdentity, request: PendingInteraction, intent: TrustedPromptIntent, expiresAt: Date) {
    if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId) || !request.id || !request.toolCall.id || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || intent.kind !== request.kind) throw new Error('可信交互状态无效')
    validateOperation(identity, request, intent, expiresAt.getTime())
    const plaintext = JSON.stringify({ identity, interactionId: request.id, toolCallId: request.toolCall.id, intent })
    return encryptByokEnvelope(plaintext, keyForVersion(currentVersion), currentVersion)
  }
  async function loadIntent(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<TrustedPromptIntent | null> {
    const result = await client.query(`SELECT tool_call_id,ciphertext,nonce,encrypted_data_key,key_version,expires_at FROM agent_interaction_intents
      WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND interaction_id=$4 AND expires_at > clock_timestamp()`, [identity.ownerId, identity.sessionId, identity.runId, request.id])
    const row = result.rows[0]
    if (!row || row.tool_call_id !== request.toolCall.id) return null
    const text = decryptByokCredential({ encrypted_value: row.ciphertext, nonce: row.nonce, encrypted_data_key: row.encrypted_data_key, key_version: row.key_version } as never, keyForVersion)
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('可信交互状态无效')
    const stored = value as Record<string, unknown>, saved = stored.identity as Record<string, unknown> | null
    if (!saved || saved.ownerId !== identity.ownerId || saved.sessionId !== identity.sessionId || saved.runId !== identity.runId || stored.interactionId !== request.id || stored.toolCallId !== request.toolCall.id || !stored.intent || typeof stored.intent !== 'object') throw new Error('可信交互身份不匹配')
    const intent = stored.intent as TrustedPromptIntent
    if (intent.kind !== request.kind) throw new Error('可信交互类型不匹配')
    validateOperation(identity, request, intent, new Date(row.expires_at).getTime())
    return intent
  }
  /** 只按完整可信工具绑定恢复确认意图；结果仍需核验用户收据和事务认领。 */
  async function loadOperation(client: PoolClient, expected: ConfirmationBinding, interactionId: string) {
      if (!binding.safeParse(expected).success || !interactionId) return null
      const identity = { ownerId: expected.ownerId, sessionId: expected.sessionId, runId: expected.runId }
      const request: PendingInteraction = { id: interactionId, kind: 'confirmation', toolCall: { id: expected.toolCallId, name: expected.toolName, input: {} } }
      const stored = await loadIntent(client, identity, request)
      if (stored?.kind !== 'confirmation' || !stored.operation) return null
      const actual = stored.operation.intent.binding
      if ((Object.keys(expected) as (keyof ConfirmationBinding)[]).some(key => actual[key] !== expected[key])) return null
      return stored.operation
  }
  async function claimApprovedOperation(
    tx: Transaction<Database>,
    reference: ConfirmationClaimReference,
    signal: AbortSignal,
    /** 必须使用同一事务读取并锁定当前可信授权版本；不能包装成常量 true。 */
    reauthorize: (tx: Transaction<Database>, reference: ConfirmationClaimReference, signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean> {
    if (!binding.safeParse(reference.binding).success || !reference.receiptId || signal.aborted) return false
    if (!await reauthorize(tx, reference, signal) || signal.aborted) return false
    // DELETE 是事务内的一次性 claim：并发执行者会串行争用该行，业务事务回滚时意图恢复。
    // 同一语句验证 owner/run/interaction、真实确认收据、工具调用和确认码，避免先查后删竞态。
    const removed = await sql<{ tool_call_id: string; ciphertext: string; nonce: string; encrypted_data_key: string; key_version: number; expires_at: Date }>`
      DELETE FROM agent_interaction_intents i
      WHERE i.user_id=${reference.binding.ownerId} AND i.session_id=${reference.binding.sessionId}
        AND i.run_id=${reference.binding.runId} AND i.interaction_id=${reference.interactionId}
        AND i.tool_call_id=${reference.binding.toolCallId} AND i.expires_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM agent_run_interaction_receipts x
          WHERE x.user_id=i.user_id AND x.session_id=i.session_id AND x.run_id=i.run_id AND x.receipt=${reference.receiptId})
        AND EXISTS (
          SELECT 1 FROM agent_interaction_resumes r
          JOIN agent_interaction_bindings b ON b.prompt_id=r.prompt_id AND b.user_id=r.user_id AND b.session_id=r.session_id AND b.run_id=r.run_id AND b.interaction_id=r.interaction_id
          JOIN interaction_prompts p ON p.id=r.prompt_id AND p.user_id=r.user_id AND p.session_id=r.session_id
          JOIN interaction_actions a ON a.prompt_id=p.id
          WHERE r.user_id=i.user_id AND r.session_id=i.session_id AND r.run_id=i.run_id
            AND r.interaction_id=i.interaction_id AND r.receipt=${reference.receiptId}
            AND b.tool_call_id=${reference.binding.toolCallId}
            AND p.kind='confirm' AND p.status='resolved' AND p.expires_at > clock_timestamp()
            AND p.schema_json::jsonb->'resolved_result'->>'status'='confirmed'
            AND p.schema_json::jsonb->'resolved_result'->>'option_id'='confirm'
            AND p.schema_json::jsonb->'resolved_result'->>'confirm'='true'
            AND a.status='consumed' AND a.option_id='confirm' AND a.action_type='confirm'
            AND a.expires_at > clock_timestamp()
            AND a.context_json::jsonb->>'tool_call_id'=${reference.binding.toolCallId}
            AND a.context_json::jsonb->>'tool_name'=${reference.binding.toolName}
            AND NULLIF(a.context_json::jsonb->>'confirm_code','') IS NOT NULL
            AND a.context_json::jsonb->>'confirm_code'=p.schema_json::jsonb->'context'->>'confirm_code'
        )
      RETURNING i.tool_call_id,i.ciphertext,i.nonce,i.encrypted_data_key,i.key_version,i.expires_at
    `.execute(tx)
    signal.throwIfAborted()
    const row = removed.rows[0]
    if (!row) return false
    const expiresAt = new Date(row.expires_at).getTime()
    const plaintext = decryptByokCredential({ encrypted_value: row.ciphertext, nonce: row.nonce,
      encrypted_data_key: row.encrypted_data_key, key_version: row.key_version } as never, keyForVersion)
    const value: unknown = JSON.parse(plaintext)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('可信确认意图无效')
    const payload = value as Record<string, unknown>
    const identity = payload.identity as Record<string, unknown> | null
    const stored = payload.intent as TrustedPromptIntent | undefined
    const parsed = operationSchema.safeParse(stored?.kind === 'confirmation' ? stored.operation : null)
    if (!parsed.success || row.tool_call_id !== reference.binding.toolCallId || expiresAt <= Date.now()
      || !identity || identity.ownerId !== reference.binding.ownerId || identity.sessionId !== reference.binding.sessionId
      || identity.runId !== reference.binding.runId || payload.interactionId !== reference.interactionId
      || payload.toolCallId !== reference.binding.toolCallId) throw new Error('可信确认意图绑定无效')
    const { intent } = parsed.data
    const sameBinding = (Object.keys(reference.binding) as (keyof ConfirmationBinding)[]).every(key => intent.binding[key] === reference.binding[key])
    if (!sameBinding || intent.intentId !== reference.intentId || intent.interactionId !== reference.interactionId
      || intent.operationId !== reference.operationId || intent.purpose !== reference.purpose || intent.action !== reference.action
      || intent.targetsDigest !== reference.targetsDigest || intent.versionsDigest !== reference.versionsDigest
      || intent.authorizationEpoch !== reference.authorizationEpoch || intent.expiresAt !== reference.expiresAt
      || intent.expiresAt > expiresAt) throw new Error('可信确认意图绑定无效')
    return true
  }
  return {
    loadIntent,
    loadOperation,
    claimApprovedOperation,
    /** 与创建/更新 MCP 配置及工具收据同事务建立续作意图。 */
    async stageMcpCredential(tx: Transaction<Database>, identity: RunIdentity, request: PendingInteraction, serverId: string) {
      if (request.kind !== 'credential' || request.toolCall.name !== 'manage_mcp_servers') throw new Error('MCP 凭据交互绑定无效')
      const version = await sql<{ version: string }>`SELECT ${sql.raw(mcpCredentialConfigurationVersionSql)} AS version
        FROM user_mcp_servers server WHERE id=${serverId} AND user_id=${identity.ownerId} AND scope='user'
          AND transport='http' AND jsonb_array_length(credential_slots::jsonb)>0 FOR UPDATE`.execute(tx)
      const configurationVersion = version.rows[0]?.version
      if (!configurationVersion || !/^[a-f0-9]{64}$/u.test(configurationVersion)) throw new Error('MCP 凭据配置不存在')
      const expiresAt = new Date(Date.now() + 10 * 60_000)
      const intent = { kind: 'credential' as const, serverId, action: 'mcp_credentials', configurationVersion }
      const envelope = sealIntent(identity, request, intent, expiresAt)
      await sql`INSERT INTO agent_interaction_intents (user_id,session_id,run_id,interaction_id,tool_call_id,ciphertext,nonce,encrypted_data_key,key_version,expires_at)
        VALUES (${identity.ownerId},${identity.sessionId},${identity.runId},${request.id},${request.toolCall.id},${envelope.ciphertext},
          ${envelope.nonce},${envelope.encryptedDataKey},${envelope.keyVersion},${expiresAt})`.execute(tx)
    },
    /** 从同一 owner/run 的已消费确认动作读取收据；不消费业务 claim。 */
    async loadApprovedOperation(client: PoolClient, expected: ConfirmationBinding, interactionId: string, receiptId: string) {
      const operation = await loadOperation(client, expected, interactionId)
      if (!operation || !receiptId) return null
      const result = await client.query<{ expires_at: Date }>(`SELECT LEAST(p.expires_at, a.expires_at) AS expires_at FROM agent_interaction_resumes r
        JOIN agent_interaction_bindings b ON b.prompt_id=r.prompt_id AND b.user_id=r.user_id AND b.session_id=r.session_id AND b.run_id=r.run_id AND b.interaction_id=r.interaction_id
        JOIN interaction_prompts p ON p.id=r.prompt_id AND p.user_id=r.user_id AND p.session_id=r.session_id
        JOIN interaction_actions a ON a.prompt_id=p.id
        WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.interaction_id=$4 AND r.receipt=$5
          AND b.tool_call_id=$6 AND p.kind='confirm' AND p.status='resolved' AND p.expires_at>clock_timestamp()
          AND p.schema_json::jsonb->'resolved_result'->>'status'='confirmed'
          AND p.schema_json::jsonb->'resolved_result'->>'option_id'='confirm'
          AND p.schema_json::jsonb->'resolved_result'->>'confirm'='true'
          AND a.status='consumed' AND a.option_id='confirm' AND a.action_type='confirm' AND a.expires_at>clock_timestamp()
          AND a.context_json::jsonb->>'tool_call_id'=$6
          AND a.context_json::jsonb->>'tool_name'=$7
          AND NULLIF(a.context_json::jsonb->>'confirm_code','') IS NOT NULL
          AND a.context_json::jsonb->>'confirm_code'=p.schema_json::jsonb->'context'->>'confirm_code' LIMIT 1`,
      [expected.ownerId, expected.sessionId, expected.runId, interactionId, receiptId, expected.toolCallId, expected.toolName])
      if (result.rowCount !== 1) return null
      const intent = operation.intent
      const expiresAt = Math.min(intent.expiresAt, new Date(result.rows[0]!.expires_at).getTime())
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
      return { intent, receipt: { schemaVersion: 2 as const, intentId: intent.intentId, interactionId, receiptId,
        binding: intent.binding, purpose: intent.purpose, action: intent.action, status: 'approved' as const, expiresAt } }
    },
    async saveIntent(client: PoolClient, identity: RunIdentity, request: PendingInteraction, intent: TrustedPromptIntent, expiresAt: Date): Promise<void> {
      const encrypted = sealIntent(identity, request, intent, expiresAt)
      const result = await client.query(`INSERT INTO agent_interaction_intents (user_id,session_id,run_id,interaction_id,tool_call_id,ciphertext,nonce,encrypted_data_key,key_version,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [identity.ownerId, identity.sessionId, identity.runId, request.id, request.toolCall.id, encrypted.ciphertext, encrypted.nonce, encrypted.encryptedDataKey, encrypted.keyVersion, expiresAt])
      if (result.rowCount === 0) {
        const previous = await loadIntent(client, identity, request)
        if (!previous || JSON.stringify(previous) !== JSON.stringify(intent)) throw new Error('可信交互状态冲突')
      }
    },
  }
}
