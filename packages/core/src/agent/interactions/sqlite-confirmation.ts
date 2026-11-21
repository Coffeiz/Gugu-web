import { canonicalAgentToolName } from '../tools/configuration.js'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { sql, type Kysely, type Transaction } from 'kysely'
import { nowUtc } from '../../data/codec.js'
import { services } from '../../data/repositories.js'
import { describeClientDeleteTargets } from '../tools/clients.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import type { PendingInteraction, RunIdentity } from '../models.js'
import { createConfirmationGate, type ConfirmationBinding, type ConfirmationClaimReference, type ConfirmationIntent } from '../tools/confirmation.js'
import { canvasConfirmationLabels } from '../tools/canvas.js'
import { describeCalendarDeleteTargets } from '../tools/calendar.js'
import { describeSkillDeleteTarget } from '../tools/skill-management.js'
import { describeScheduledTaskDeleteTargets } from '../tools/scheduled-tasks.js'
import type { AgentPromptSpec } from './prompt-description.js'

export function createSqliteToolConfirmation(
  db: Kysely<Database>,
  authorize: (db: Kysely<Database>, identity: RunIdentity, signal: AbortSignal) => Promise<boolean>,
  action: 'delete_scheduled_task' | 'delete_event' | 'delete_client' | 'delete_skill' | 'delete_knowledge' | 'remove_mcp_server' | 'update_mcp_server' | 'add_mcp_server' | 'shell' | 'present_file' | 'send_email' | keyof typeof canvasConfirmationLabels,
  describeTarget?: (tx: Transaction<Database>, identity: RunIdentity, input: unknown,
    snapshot: { targetsDigest: string; versionsDigest: string }) => Promise<string>,
) {
  const purpose = 'action'
  const authorizationEpoch = 'desktop-local-v1'
  const owner = (identity: RunIdentity) => dataContext(identity.ownerId).ownerId.replaceAll('-', '')
  const run = (identity: RunIdentity) => sql`user_id=${owner(identity)} AND session_id=${identity.sessionId} AND run_id=${identity.runId}`
  const matches = (binding: ConfirmationBinding) => sql`${run(binding)}
    AND round_id=${binding.roundId} AND tool_call_id=${binding.toolCallId}
    AND tool_name=${binding.toolName} AND input_digest=${binding.normalizedInputDigest} AND action=${action}`

  const gate = createConfirmationGate({
    now: Date.now,
    async authorize(binding, requestedPurpose, requestedAction, signal) {
      return requestedPurpose === purpose && requestedAction === action && canonicalAgentToolName(binding.toolName) === canonicalAgentToolName((action === 'remove_mcp_server' || action === 'update_mcp_server' || action === 'add_mcp_server') ? 'manage_mcp_servers' : action)
        && await authorize(db, binding, signal) ? authorizationEpoch : null
    },
    async prepare(binding, snapshot, signal) {
      const intent: ConfirmationIntent = {
        schemaVersion: 2, binding, intentId: randomUUID(), interactionId: randomUUID(), operationId: randomUUID(),
        purpose, action, targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest,
        authorizationEpoch, expiresAt: Date.now() + 300_000,
      }
      await db.transaction().execute(async tx => {
        if (!await authorize(tx, binding, signal)) throw new CoreError('conflict', '确认权限已失效')
        await sql`INSERT INTO desktop_agent_confirmation_intents
          (user_id,session_id,run_id,interaction_id,intent_id,operation_id,round_id,tool_call_id,tool_name,
           input_digest,action,targets_digest,versions_digest,authorization_epoch,expires_at)
          VALUES (${owner(binding)},${binding.sessionId},${binding.runId},${intent.interactionId},${intent.intentId},
            ${intent.operationId},${binding.roundId},${binding.toolCallId},${binding.toolName},
            ${binding.normalizedInputDigest},${action},${intent.targetsDigest},${intent.versionsDigest},
            ${authorizationEpoch},${intent.expiresAt})`.execute(tx)
      })
      return intent
    },
    async inspect(ref, binding) {
      const { rows: [row] } = await sql<{ targetsDigest: string; versionsDigest: string }>`
        SELECT targets_digest AS "targetsDigest", versions_digest AS "versionsDigest"
        FROM desktop_agent_confirmation_intents WHERE ${matches(binding)} AND intent_id=${ref.intentId}
          AND interaction_id=${ref.interactionId} AND operation_id=${ref.operationId} AND claimed_at IS NULL`.execute(db)
      return row ?? null
    },
    async load(binding, ref) {
      const { rows: [row] } = await sql<{
        intent_id: string; operation_id: string; targets_digest: string; versions_digest: string
        authorization_epoch: string; expires_at: number
      }>`SELECT intent_id, operation_id, targets_digest, versions_digest, authorization_epoch, expires_at
        FROM desktop_agent_confirmation_intents WHERE ${matches(binding)} AND interaction_id=${ref.interactionId}
          AND receipt_id=${ref.receiptId} AND claimed_at IS NULL`.execute(db)
      if (!row) return null
      const shared = { schemaVersion: 2, binding, intentId: row.intent_id, interactionId: ref.interactionId,
        purpose, action, expiresAt: row.expires_at }
      return {
        intent: { ...shared, operationId: row.operation_id, targetsDigest: row.targets_digest,
          versionsDigest: row.versions_digest, authorizationEpoch: row.authorization_epoch },
        receipt: { ...shared, receiptId: ref.receiptId, status: 'approved' },
      }
    },
  }, { purpose, action })

  return {
    gate,
    async claim(tx: Transaction<Database>, ref: ConfirmationClaimReference, signal: AbortSignal) {
      if (ref.purpose !== purpose || ref.action !== action || ref.authorizationEpoch !== authorizationEpoch
        || !await authorize(tx, ref.binding, signal)) return false
      const now = Date.now()
      const { rows } = await sql`UPDATE desktop_agent_confirmation_intents SET claimed_at=${now}
        WHERE ${matches(ref.binding)} AND intent_id=${ref.intentId} AND interaction_id=${ref.interactionId}
          AND operation_id=${ref.operationId} AND receipt_id=${ref.receiptId} AND claimed_at IS NULL
          AND targets_digest=${ref.targetsDigest} AND versions_digest=${ref.versionsDigest}
          AND authorization_epoch=${ref.authorizationEpoch} AND expires_at=${ref.expiresAt} AND expires_at>${now}
        RETURNING intent_id`.execute(tx)
      return rows.length === 1
    },
    async describe(tx: Transaction<Database>, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec> {
      const { rows: [snapshot] } = await sql<{ targetsDigest: string; versionsDigest: string }>`
        SELECT targets_digest AS "targetsDigest", versions_digest AS "versionsDigest" FROM desktop_agent_confirmation_intents
        WHERE ${run(identity)} AND interaction_id=${request.id} AND action=${action} AND tool_name=${request.toolCall.name}
          AND tool_call_id=${request.toolCall.id} AND expires_at>${Date.now()} AND receipt_id IS NULL`.execute(tx)
      if (!snapshot) throw new CoreError('conflict', '确认意图已失效')
      const input = request.toolCall.input
      let summary: string
      if (action === 'shell') {
        if (!input || typeof input !== 'object' || !('command' in input) || typeof input.command !== 'string')
          throw new CoreError('invalid_request', 'Shell 命令无效')
        summary = 'cwd' in input && typeof input.cwd === 'string' && isAbsolute(input.cwd)
          ? `允许此会话在未来 30 分钟执行宿主机命令。\n工作目录：${input.cwd}\n命令：${input.command.trim()}`
          : `在桌面隔离目录内执行命令：${input.command.trim()}`
      } else if (action === 'present_file') {
        if (!input || typeof input !== 'object' || !('file' in input) || typeof input.file !== 'string' || !isAbsolute(input.file))
          throw new CoreError('invalid_request', '本机文件路径无效')
        const actionLabel = 'reference_only' in input && input.reference_only === true ? '引用' : '打开'
        summary = `${actionLabel}本机文件：${input.file}\n允许此会话在未来 30 分钟打开本机文件及执行宿主机 Shell 命令。`
      } else if (action === 'delete_event') {
        summary = await describeCalendarDeleteTargets({ db: tx, backend: 'sqlite' }, identity.ownerId, input, snapshot)
      } else if (action === 'delete_client') {
        summary = await describeClientDeleteTargets(services(tx, owner(identity), 'sqlite', nowUtc), input, snapshot)
      } else if (action === 'delete_skill') {
        summary = await describeSkillDeleteTarget(tx, owner(identity), input, snapshot)
      } else if (action === 'delete_knowledge' || action === 'remove_mcp_server' || action === 'update_mcp_server' || action === 'add_mcp_server') {
        if (!describeTarget) throw new CoreError('conflict', '目标确认不可用')
        summary = await describeTarget(tx, identity, input, snapshot)
      } else if (action === 'delete_scheduled_task') {
        summary = await describeScheduledTaskDeleteTargets(tx, owner(identity), input, snapshot)
      } else if (action === 'send_email') {
        if (!describeTarget) throw new CoreError('conflict', '邮件发送确认不可用')
        summary = await describeTarget(tx, identity, input, snapshot)
      } else {
        summary = canvasConfirmationLabels[action]
      }
      return { kind: 'confirm', title: '请确认操作', body: summary, context: {}, options: [
        { id: 'confirm', label: '确认', actionType: 'confirm' },
        { id: 'cancel', label: '取消', actionType: 'cancel' },
      ], expiresMinutes: 5 }
    },
  }
}
