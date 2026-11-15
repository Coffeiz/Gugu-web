import type { PoolClient } from 'pg'
import type { PendingInteraction, RunIdentity } from '@gugu/core/agent'
import { decryptByokCredential, encryptByokEnvelope } from '../../agent-config/byok.js'
import type { TrustedPromptIntent } from './agent-trusted-prompt-descriptions.js'

/** 只能由可信工具执行器调用，模型不能写入该服务端意图。 */
export function createPostgresTrustedIntentStore(keyForVersion: (version: number) => string, currentVersion: number) {
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) throw new TypeError('凭据密钥版本无效')
  async function loadIntent(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<TrustedPromptIntent | null> {
    const result = await client.query(`SELECT tool_call_id,ciphertext,nonce,encrypted_data_key,key_version FROM agent_interaction_intents
      WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND interaction_id=$4 AND expires_at > clock_timestamp()`, [identity.ownerId, identity.sessionId, identity.runId, request.id])
    const row = result.rows[0]
    if (!row || row.tool_call_id !== request.toolCall.id) return null
    const text = decryptByokCredential({ encrypted_value: row.ciphertext, nonce: row.nonce, encrypted_data_key: row.encrypted_data_key, key_version: row.key_version } as never, keyForVersion)
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('可信交互状态无效')
    const stored = value as Record<string, unknown>, saved = stored.identity as Record<string, unknown> | null
    if (!saved || saved.ownerId !== identity.ownerId || saved.sessionId !== identity.sessionId || saved.runId !== identity.runId || stored.interactionId !== request.id || stored.toolCallId !== request.toolCall.id || !stored.intent || typeof stored.intent !== 'object') throw new Error('可信交互身份不匹配')
    return stored.intent as TrustedPromptIntent
  }
  return {
    loadIntent,
    async saveIntent(client: PoolClient, identity: RunIdentity, request: PendingInteraction, intent: TrustedPromptIntent, expiresAt: Date): Promise<void> {
      if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId) || !request.id || !request.toolCall.id || expiresAt.getTime() <= Date.now() || intent.kind !== request.kind) throw new Error('可信交互状态无效')
      const plaintext = JSON.stringify({ identity, interactionId: request.id, toolCallId: request.toolCall.id, intent })
      const encrypted = encryptByokEnvelope(plaintext, keyForVersion(currentVersion), currentVersion)
      const result = await client.query(`INSERT INTO agent_interaction_intents (user_id,session_id,run_id,interaction_id,tool_call_id,ciphertext,nonce,encrypted_data_key,key_version,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [identity.ownerId, identity.sessionId, identity.runId, request.id, request.toolCall.id, encrypted.ciphertext, encrypted.nonce, encrypted.encryptedDataKey, encrypted.keyVersion, expiresAt])
      if (result.rowCount === 0) {
        const previous = await loadIntent(client, identity, request)
        if (!previous || JSON.stringify(previous) !== JSON.stringify(intent)) throw new Error('可信交互状态冲突')
      }
    },
  }
}
