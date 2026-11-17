import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import type { InteractionActionRecord, InteractionPromptRecord } from '../application/agent-interaction-consume.js'
import { resolvedSecretPromptResult, validateSecretValues } from '@gugu/core/agent'

interface SecretEnvelope { ciphertext: string; nonce: string; encryptedDataKey: string; keyVersion: number }
export interface SecretInteractionPorts {
  encrypt(values: Record<string, string>): SecretEnvelope
  enqueue(client: PoolClient, prompt: InteractionPromptRecord, action: InteractionActionRecord): Promise<void>
  /** 与凭据更新同事务持久记录跨进程缓存失效，不得使用普通通知代替。 */
  invalidate(client: PoolClient, ownerId: string, serverId: string): Promise<void>
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
export class SecretInteractionError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = 'SecretInteractionError' }
}
function invalid(status: 400 | 404 | 409, message: string): never { throw new SecretInteractionError(status, message) }
/** 凭据只写业务加密槽位，完成标记与恢复引用同事务，不写 prompt、outbox 或日志。 */
export function createPostgresSecretInteraction(pool: Pick<Pool, 'connect'>, ports: SecretInteractionPorts) {
  if (!ports || typeof ports.encrypt !== 'function' || typeof ports.enqueue !== 'function' || typeof ports.invalidate !== 'function') throw new TypeError('凭据交互服务未完整配置')
  return async (ownerId: string, promptId: number, values: Record<string, string> | null) => withPostgresTransaction(pool, async client => {
    const result = await client.query('SELECT id, user_id, session_id, kind, status, expires_at, schema_json FROM interaction_prompts WHERE id = $1 AND user_id = $2 FOR UPDATE', [promptId, ownerId])
    const row = result.rows[0]
    if (!row) invalid(404, values === null ? '凭据输入不存在' : '敏感信息输入不存在')
    const schema = object(row.schema_json), context = object(schema.context), target = object(context.secret_target)
    if (target.kind !== 'mcp_credentials') invalid(400, values === null ? '当前交互不支持凭据取消' : '当前敏感信息交互没有可用的业务处理器')
    if (!Array.isArray(schema.secret_fields) || schema.secret_fields.length === 0 || row.status !== 'active' || new Date(row.expires_at).getTime() <= Date.now()) {
      if (values === null && (!Array.isArray(schema.secret_fields) || !schema.secret_fields.length)) invalid(400, '当前交互不支持凭据取消')
      invalid(409, values === null ? '凭据输入已结束' : '敏感信息输入已过期')
    }
    if (values !== null) {
      const fields = schema.secret_fields.map(object), keys = Object.keys(values)
      if (fields.length > 16 || fields.some(field => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(field.name ?? ''))) || new Set(fields.map(field => String(field.name ?? ''))).size !== fields.length) invalid(400, '敏感字段不匹配')
      let normalized: Record<string, string>
      try { normalized = validateSecretValues(fields, values) }
      catch (error) { invalid(400, error instanceof Error && error.message === '敏感字段不能为空或过长' ? error.message : '敏感字段不匹配') }
      if (typeof target.server_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.server_id)) invalid(409, '敏感信息目标已失效')
      const servers = await client.query('SELECT credential_slots FROM user_mcp_servers WHERE id = $1 AND user_id = $2 AND scope = $3 FOR UPDATE', [target.server_id, ownerId, 'user'])
      const server = servers.rows[0]; if (!server) invalid(404, 'MCP server 不存在')
      const slots = Array.isArray(server.credential_slots) ? server.credential_slots.map(object) : []
      if (!slots.length || slots.length !== keys.length || slots.some((slot: Record<string, unknown>) => typeof slot.id !== 'string' || !keys.includes(slot.id))) invalid(400, '凭据槽位不匹配')
      for (const slot of slots) if (slot.target === 'header') {
        const value = String(slot.prefix ?? '') + normalized[String(slot.id)]
        if (/[^\x00-\x7f]/.test(value)) invalid(400, 'HTTP Header 凭据只能使用 ASCII 字符；请检查密钥值和前缀')
        if (/[\x00-\x1f\x7f]/.test(value)) invalid(400, 'HTTP Header 凭据不能包含换行或控制字符')
      }
      const sealed = ports.encrypt(normalized)
      await client.query('UPDATE user_mcp_servers SET encrypted_credentials = $3, credentials_nonce = $4, encrypted_credentials_key = $5, credentials_key_version = $6 WHERE id = $1 AND user_id = $2', [target.server_id, ownerId, sealed.ciphertext, sealed.nonce, sealed.encryptedDataKey, sealed.keyVersion])
      await ports.invalidate(client, ownerId, target.server_id)
    }
    const resolved = values === null
      ? { kind: row.kind, status: 'cancelled', prompt_id: promptId, option_id: 'cancel', value: null, text: '已取消凭据输入' }
      : resolvedSecretPromptResult(promptId)
    const prompt: InteractionPromptRecord = { id: row.id, ownerId, sessionId: row.session_id, kind: row.kind, status: 'resolved', expiresAt: new Date(row.expires_at), resolvedAt: new Date(), schema: { ...schema, resolved_result: resolved } }
    await client.query('UPDATE interaction_prompts SET status = $3, resolved_at = $4, schema_json = $5 WHERE id = $1 AND user_id = $2', [promptId, ownerId, 'resolved', prompt.resolvedAt, JSON.stringify(prompt.schema)])
    await client.query(`UPDATE mcp_secret_inputs SET status = $3, encrypted_payload = '', payload_nonce = '', encrypted_data_key = ''
      WHERE prompt_id = $1 AND user_id = $2 ${values === null ? "AND status IN ('pending_choice','awaiting_secret')" : ''}`, [promptId, ownerId, values === null ? 'cancelled' : 'completed'])
    if (typeof context.tool_call_id === 'string' && context.tool_call_id) await ports.enqueue(client, prompt, { id: 0, promptId, tokenHash: '', actionType: 'secret', optionId: '', context, status: 'consumed', expiresAt: prompt.expiresAt, consumedAt: prompt.resolvedAt, consumedEventId: null })
    return values === null ? { ok: true, prompt_id: promptId, status: 'cancelled' } : { ok: true, prompt_id: promptId }
  })
}
