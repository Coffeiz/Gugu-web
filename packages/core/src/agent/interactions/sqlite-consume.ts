import { createHash, randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import type { InteractionResolution, RunIdentity } from '../models.js'
import { consumeInteractionAction, InteractionConsumeError, type InteractionActionRecord, type InteractionPromptRecord } from './consume-action.js'
import { resolvedSecretPromptResult } from './secrets.js'
import { consumeInteractionText, InteractionTextError } from './consume-text.js'

import { createMcpServerConfigLister, type McpStoredServer } from '../../mcp/server-list.js'
import type { McpEnvelopeCrypto } from '../../mcp/server-mutations.js'
import { stableJson } from '../context/history/canonical-history.js'
import { createSecretInteractionConsumer } from './consume-secret.js'

export function sqliteMcpCredentialVersion(row: McpStoredServer): string {
  return createHash('sha256').update(stableJson(row)).digest('hex')
}

async function consumeSecretInTransaction(tx: Transaction<Database>, prompt: InteractionPromptRecord,
  owner: string, runId: string, interactionId: string, values: Record<string, string> | null,
  encrypt: McpEnvelopeCrypto['encrypt']) {
  const bound = sql`user_id=${owner} AND session_id=${prompt.sessionId}
    AND run_id=${runId} AND interaction_id=${interactionId}`
  const { rows: [intent] } = await sql<{ server_id: string; configuration_version: string }>`
    SELECT server_id,configuration_version FROM desktop_agent_credential_intents
    WHERE ${bound} AND expires_at>${Date.now()}`.execute(tx)
  const context = prompt.schema.context as { secret_target?: { server_id?: unknown; configuration_version?: unknown } } | undefined
  if (!intent || context?.secret_target?.server_id !== intent.server_id
    || context.secret_target.configuration_version !== intent.configuration_version)
    throw new CoreError('conflict', '凭据填写意图已失效')
  const list = createMcpServerConfigLister<Database>(tx, 'sqlite')
  const consume = createSecretInteractionConsumer({
    encrypt: fields => encrypt(JSON.stringify(fields)),
    store: { transaction: run => run({
      async getOwnedPrompt() { return prompt },
      async getOwnedMcpServer(ownerId, id) {
        const [row] = await list(ownerId, tx, id)
        return row ? { id: row.id, scope: row.scope, configurationVersion: sqliteMcpCredentialVersion(row),
          credentialSlots: Array.isArray(row.credential_slots) ? row.credential_slots : [] } : null
      },
      async updateCredentials(_ownerId, id, envelope) {
        await sql`UPDATE user_mcp_servers SET encrypted_credentials=${envelope.ciphertext},
          credentials_nonce=${envelope.nonce},encrypted_credentials_key=${envelope.encryptedDataKey},
          credentials_key_version=${envelope.keyVersion},updated_at=CURRENT_TIMESTAMP
          WHERE id=${id} AND user_id=${owner} AND scope='user'`.execute(tx)
      },
      async invalidateToolSnapshot() {
        await sql`DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=${owner}`.execute(tx)
      },
      async resolvePrompt(_prompt, schema, at) {
        prompt.schema = schema
        prompt.status = 'resolved'
        prompt.resolvedAt = at
        await sql`UPDATE interaction_prompts SET status='resolved',schema_json=${JSON.stringify(schema)},
          resolved_at=${at.toISOString()} WHERE id=${prompt.id} AND user_id=${owner}`.execute(tx)
      },
      async clearSecretStaging() {
        await sql`DELETE FROM desktop_agent_credential_intents WHERE ${bound}`.execute(tx)
      },
      // SQLite 将续跑回执保留在已绑定的提示行内。
      async enqueueResume() {},
    }) },
  })
  await consume({ ownerId: prompt.ownerId, sessionId: prompt.sessionId, promptId: prompt.id, values })
  return { result: readSavedAnswer(prompt) }
}

type Reply = { token: string; selectedOptionIds?: string[]; customAnswer?: string } | { text: string } | { secrets: Record<string, string> | null }

export function consumeSqliteInteractionText(
  db: Kysely<Database>, identity: RunIdentity, promptId: number, text: string, eventId: string,
) {
  return consumeSqliteInteraction(db, identity, promptId, { text }, eventId)
}

export async function consumeSqliteInteractionChoice(
  db: Kysely<Database>, identity: RunIdentity, promptId: number, token: string, eventId: string,
) {
  return consumeSqliteInteraction(db, identity, promptId, { token }, eventId)
}

/** 在同一事务消费回复并保留恢复数据。 */
export async function consumeSqliteInteraction(
  db: Kysely<Database>, identity: RunIdentity, promptId: number, reply: Reply | null, eventId: string,
  pending?: { id: string; version: number }, encryptSecret?: McpEnvelopeCrypto['encrypt'],
  authorize?: (tx: Transaction<Database>) => Promise<boolean>,
): Promise<{ resolution: InteractionResolution | null; awaitingText: boolean }> {
  const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
  const unavailable = async (): Promise<never> => { throw new CoreError('conflict', '桌面交互命令尚未接入') }
  return db.transaction().execute(async tx => {
    if (authorize) {
      await sql`UPDATE interaction_prompts SET id=id WHERE 0`.execute(tx)
      if (!await authorize(tx)) throw new CoreError('conflict', '子运行确认授权已失效')
    }
    const { rows: [row] } = await sql<{
      interaction_id: string; tool_call_id: string; kind: string; status: string; schema_json: string; expires_at: string; resolved_at: string | null
    }>`SELECT b.interaction_id,b.tool_call_id,p.kind,p.status,p.schema_json,p.expires_at,p.resolved_at
      FROM agent_interaction_bindings b
      JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
      JOIN agent_run_checkpoints c ON c.user_id=b.user_id AND c.session_id=b.session_id AND c.run_id=b.run_id
      WHERE b.user_id=${owner} AND b.session_id=${identity.sessionId} AND b.run_id=${identity.runId}
        AND b.prompt_id=${promptId} AND c.status='waiting'
        ${pending ? sql`AND b.interaction_id=${pending.id} AND c.version=${pending.version}` : sql``}`.execute(tx)
    if (!row) throw new CoreError('not_found', '等待回复的交互不存在')
    const prompt: InteractionPromptRecord = {
      id: promptId, ownerId: identity.ownerId, sessionId: Number(identity.sessionId), kind: row.kind,
      status: row.status, schema: JSON.parse(row.schema_json), expiresAt: new Date(row.expires_at),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    }
    let action: InteractionActionRecord | undefined
    async function commit() {
      await sql`UPDATE interaction_prompts SET status=${prompt.status},schema_json=${JSON.stringify(prompt.schema)},
        resolved_at=${prompt.resolvedAt?.toISOString() ?? null} WHERE id=${promptId} AND user_id=${owner}`.execute(tx)
      if (action) await sql`UPDATE interaction_actions SET status=${action.status},consumed_at=${action.consumedAt?.toISOString() ?? null},
        consumed_event_id=${action.consumedEventId} WHERE id=${action.id} AND prompt_id=${promptId}`.execute(tx)
    }

    const options = { ownerId: identity.ownerId, promptId, eventId }
    const shared = { getOwnedPrompt: async () => prompt, commit }
    const retry = prompt.schema.desktop_text_event_id === eventId && prompt.schema.resolved_result as Record<string, unknown> | undefined
    const consume = !reply
      ? Promise.resolve({ result: readSavedAnswer(prompt) })
      : 'secrets' in reply
      ? encryptSecret
        ? consumeSecretInTransaction(tx, prompt, owner, identity.runId, row.interaction_id, reply.secrets, encryptSecret)
        : Promise.reject(new CoreError('conflict', '凭据提交不可用'))
      : 'text' in reply
      ? retry && retry.text === reply.text.trim()
        ? Promise.resolve({ result: retry })
        : prompt.status !== 'active'
          ? Promise.reject(new CoreError('conflict', '交互已结束'))
          : consumeInteractionText({
            transaction: run => run({
              ...shared,
              async enqueueResume() {
                // 结果与请求标识一并写入提示，续跑收据由绑定的提示 ID 派生。
                prompt.schema.desktop_text_event_id = eventId
              },
            }),
          }, { ...options, text: reply.text })
      : consumeInteractionAction({
      transaction: run => run({
        ...shared,
        async lockAction(id, hash) {
          const { rows: [saved] } = await sql<{
            id: number; action_type: string; option_id: string; context_json: string; status: string
            expires_at: string; consumed_at: string | null; consumed_event_id: string | null
          }>`SELECT id,action_type,option_id,context_json,status,expires_at,consumed_at,consumed_event_id
            FROM interaction_actions WHERE prompt_id=${id} AND token_hash=${hash}`.execute(tx)
          if (!saved) return null
          action = { id: saved.id, promptId: id, tokenHash: hash, actionType: saved.action_type, optionId: saved.option_id,
            context: JSON.parse(saved.context_json), status: saved.status, expiresAt: new Date(saved.expires_at),
            consumedAt: saved.consumed_at ? new Date(saved.consumed_at) : null, consumedEventId: saved.consumed_event_id }
          return action
        },
        applyCommandAction: unavailable,
        redeemConfirmation: unavailable,
      }),
    }, { ...options, token: reply.token, selectedOptionIds: reply.selectedOptionIds, customAnswer: reply.customAnswer, allowDuplicateEvent: true })
    const result = await consume.catch(error => {
      if ((error instanceof InteractionConsumeError || error instanceof InteractionTextError) && error.code === 'interaction_expired') return error
      throw error
    })
    if (result instanceof InteractionConsumeError || result instanceof InteractionTextError) return result
    const answer = result.result
    const status = answer.status
    if (status === 'awaiting_text') return { resolution: null, awaitingText: true }
    let receiptId = `desktop-prompt:${promptId}`
    if (row.kind === 'confirm' && status === 'confirmed') {
      const { rows: [approved] } = await sql<{ receipt_id: string }>`UPDATE desktop_agent_confirmation_intents
        SET receipt_id=COALESCE(receipt_id,${randomUUID()})
        WHERE user_id=${owner} AND session_id=${identity.sessionId} AND run_id=${identity.runId}
          AND interaction_id=${row.interaction_id} AND tool_call_id=${row.tool_call_id}
          AND expires_at>${Date.now()} AND claimed_at IS NULL
        RETURNING receipt_id`.execute(tx)
      if (!approved) throw new CoreError('conflict', '确认意图已失效')
      receiptId = approved.receipt_id
    }
    const resolution: InteractionResolution = {
      interactionId: row.interaction_id, receiptId,
      status: status === 'cancelled' ? 'cancelled' : status === 'confirmed' ? 'confirmed' : 'answered',
      value: row.kind === 'confirm' ? null : answer,
    }
    return { resolution, awaitingText: false }
  }).then(result => {
    if (result instanceof InteractionConsumeError || result instanceof InteractionTextError) throw result
    return result
  })
}

function readSavedAnswer(prompt: InteractionPromptRecord): Record<string, unknown> {
  const result = prompt.schema.resolved_result
  if (prompt.status !== 'resolved' || !['choice', 'question', 'confirm', 'form'].includes(prompt.kind)
    || !result || typeof result !== 'object' || Array.isArray(result))
    throw new CoreError('conflict', '交互尚未保存可恢复的回复')
  const answer = result as Record<string, unknown>
  if (prompt.kind === 'form') {
    const context = prompt.schema.context as { secret_target?: { kind?: unknown } } | undefined
    if (context?.secret_target?.kind !== 'mcp_credentials' || answer.kind !== 'form'
      || answer.prompt_id !== prompt.id || !['answered', 'cancelled'].includes(String(answer.status)))
      throw new CoreError('conflict', '凭据回复无法恢复')
    // 从固定字段重建回执，避免把存储中的表单值带回模型。
    return answer.status === 'answered' ? resolvedSecretPromptResult(prompt.id)
      : { kind: 'form', status: 'cancelled', prompt_id: prompt.id, option_id: 'cancel', value: null, text: '已取消凭据输入' }
  }
  const statuses = prompt.kind === 'confirm' ? ['confirmed', 'cancelled'] : ['selected', 'answered', 'cancelled']
  if (!statuses.includes(String(answer.status)) || answer.prompt_id !== prompt.id)
    throw new CoreError('conflict', '交互回复无法恢复')
  return answer
}
