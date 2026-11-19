import type { Pool, PoolClient } from 'pg'
import { CoreError } from '@gugu/core'
import { createSecretInteractionConsumer, type SecretInteractionTransaction } from '@gugu/core/agent/interactions/consume-secret'
import { type InteractionActionRecord, type InteractionPromptRecord } from '@gugu/core/agent/interactions/consume-action'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { mcpCredentialConfigurationVersionSql } from './agent-trusted-prompt-descriptions.js'

export interface SecretEnvelope { ciphertext: string; nonce: string; encryptedDataKey: string; keyVersion: number }
export interface SecretInteractionPorts {
  encrypt(values: Record<string, string>): SecretEnvelope | Promise<SecretEnvelope>
  enqueue(client: PoolClient, prompt: InteractionPromptRecord, action: InteractionActionRecord): Promise<void>
  /** 持久清除共享工具快照，与凭据替换同事务提交。 */
  invalidate(client: PoolClient, ownerId: string, serverId: string): Promise<void>
}

export class SecretInteractionError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = 'SecretInteractionError' }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorStatus(error: CoreError): 400 | 404 | 409 {
  return error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400
}

/** PostgreSQL 只提供锁与事务；owner、凭据槽位、敏感值及终态规则由共享 Core 用例执行。 */
export function createPostgresSecretInteraction(pool: Pick<Pool, 'connect'>, ports: SecretInteractionPorts) {
  return (ownerId: string, promptId: number, values: Record<string, string> | null) =>
    withPostgresTransaction(pool, client => consumeSecretInteractionLocked(client, ports, ownerId, promptId, values))
}

export async function consumeSecretInteractionLocked(client: PoolClient, ports: SecretInteractionPorts, ownerId: string, promptId: number, values: Record<string, string> | null) {
  if (!ports || typeof ports.encrypt !== 'function' || typeof ports.enqueue !== 'function' || typeof ports.invalidate !== 'function') throw new TypeError('凭据交互服务未完整配置')

  const store = {
    transaction<T>(run: (tx: SecretInteractionTransaction) => Promise<T>) {
      return run({
        async getOwnedPrompt(ownerId, promptId) {
          const result = await client.query<Record<string, unknown>>(
            'SELECT id,user_id,session_id,kind,status,expires_at,schema_json FROM interaction_prompts WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [promptId, ownerId],
          )
          const row = result.rows[0]
          if (!row) return null
          return {
            id: Number(row.id), ownerId: String(row.user_id), sessionId: Number(row.session_id),
            kind: String(row.kind), status: String(row.status), expiresAt: new Date(row.expires_at as string | number | Date),
            schema: record(row.schema_json),
          }
        },
        async getOwnedMcpServer(ownerId, serverId) {
          const result = await client.query<Record<string, unknown>>(
            `SELECT id,scope,credential_slots,${mcpCredentialConfigurationVersionSql} AS configuration_version
              FROM user_mcp_servers server WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [serverId, ownerId],
          )
          const row = result.rows[0]
          if (!row) return null
          const slots = Array.isArray(row.credential_slots) ? row.credential_slots.map(record) : []
          return { id: String(row.id), scope: String(row.scope), credentialSlots: slots, configurationVersion: String(row.configuration_version) }
        },
        async updateCredentials(ownerId, serverId, envelope) {
          await client.query(
            'UPDATE user_mcp_servers SET encrypted_credentials=$3,credentials_nonce=$4,encrypted_credentials_key=$5,credentials_key_version=$6 WHERE id=$1 AND user_id=$2',
            [serverId, ownerId, envelope.ciphertext, envelope.nonce, envelope.encryptedDataKey, envelope.keyVersion],
          )
        },
        invalidateToolSnapshot: (ownerId, serverId) => ports.invalidate(client, ownerId, serverId),
        async resolvePrompt(prompt, schema, resolvedAt) {
          await client.query(
            'UPDATE interaction_prompts SET status=$3,resolved_at=$4,schema_json=$5 WHERE id=$1 AND user_id=$2',
            [prompt.id, prompt.ownerId, 'resolved', resolvedAt, JSON.stringify(schema)],
          )
        },
        async clearSecretStaging(ownerId, promptId, status) {
          await client.query(
            'UPDATE mcp_secret_inputs SET status=$3,encrypted_payload=\'\',payload_nonce=\'\',encrypted_data_key=\'\' WHERE prompt_id=$1 AND user_id=$2',
            [promptId, ownerId, status],
          )
        },
        async enqueueResume(prompt, action, resolvedAt) {
          const resolvedPrompt: InteractionPromptRecord = { ...prompt, status: 'resolved', resolvedAt }
          const resumeAction: InteractionActionRecord = {
            id: 0, promptId: prompt.id, tokenHash: '', actionType: action.actionType,
            optionId: action.actionType === 'cancel' ? 'cancel' : '', context: action.context,
            status: 'consumed', expiresAt: prompt.expiresAt, consumedAt: resolvedAt, consumedEventId: null,
          }
          await ports.enqueue(client, resolvedPrompt, resumeAction)
        },
      })
    },
  }

  const consume = createSecretInteractionConsumer({ store, encrypt: ports.encrypt })
  try { return await consume({ ownerId, promptId, values }) }
  catch (error) {
    if (error instanceof CoreError) throw new SecretInteractionError(errorStatus(error), error.message)
    throw error
  }
}
