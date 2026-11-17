import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { PendingInteraction, RunIdentity } from '@gugu/core/agent'
import { normalizeSecretFields } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { lockAgentRunSession } from './agent-run-startup-postgres.js'
import { bindInteractionPrompt } from './agent-interaction-resume-postgres.js'

export interface AgentPromptSpec {
  kind: 'choice' | 'question' | 'form' | 'confirm'
  title: string
  body: string
  options: Array<{ id: string; label: string; actionType: string }>
  context: Record<string, unknown>
  secretFields?: Array<{ name: string; label: string; type: 'secret' }>
  allowTextInput?: boolean
  expiresMinutes?: number
}
export interface AgentPromptActivationPorts {
  /** 仅从可信工具结果和授权服务构造，不能从模型自行声明授权或凭据目标。 */
  describe(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec>
}
function validate(spec: AgentPromptSpec, request: PendingInteraction): Array<{ name: string; label: string; type: 'secret' }> {
  if (!['choice', 'question', 'form', 'confirm'].includes(spec.kind) || typeof spec.title !== 'string' || typeof spec.body !== 'string' || !Array.isArray(spec.options) || spec.options.length > 8) throw new Error('交互内容无效')
  if (spec.options.some(option => !option.id || option.id.length > 64 || !option.label || option.label.length > 120 || !option.actionType)) throw new Error('交互选项无效')
  if (new Set(spec.options.map(option => option.id)).size !== spec.options.length) throw new Error('交互选项重复')
  const fields = spec.secretFields ?? []
  if (request.kind === 'credential') {
    const target = spec.context.secret_target as Record<string, unknown> | undefined
    if (spec.kind !== 'form' || target?.kind !== 'mcp_credentials' || typeof target.server_id !== 'string') throw new Error('凭据交互目标无效')
    const normalized = normalizeSecretFields(fields)
    if (!normalized) throw new Error('凭据字段无效')
    return normalized
  } else if (fields.length) throw new Error('交互类型不匹配')
  if (request.kind === 'confirmation' && spec.kind !== 'confirm') throw new Error('交互类型不匹配')
  if (request.kind === 'question' && !['question', 'choice'].includes(spec.kind)) throw new Error('交互类型不匹配')
  return []
}
/** Prompt、动作摘要与绑定一并提交；同一 pending 重试只读取原绑定。 */
export function createPostgresInteractionActivator(pool: Pick<Pool, 'connect'>, ports: AgentPromptActivationPorts) {
  return { async activate(identity: RunIdentity, request: PendingInteraction, signal: AbortSignal): Promise<PendingInteraction> {
    signal.throwIfAborted()
    return withPostgresTransaction(pool, async client => {
      if (!await lockAgentRunSession(client, identity)) throw new Error('会话不存在')
      const prior = await client.query<{ prompt_id: number; tool_call_id: string; status: string; expires_at: Date }>(`SELECT b.prompt_id, b.tool_call_id, p.status, p.expires_at FROM agent_interaction_bindings b
        JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
        WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3 AND b.interaction_id=$4`, [identity.ownerId, identity.sessionId, identity.runId, request.id])
      if (prior.rows[0]) {
        if (prior.rows[0].tool_call_id !== request.toolCall.id) throw new Error('交互绑定冲突')
        if (prior.rows[0].status !== 'active' || new Date(prior.rows[0].expires_at).getTime() <= Date.now()) throw new Error('交互已结束')
        return request
      }
      const spec = await ports.describe(client, identity, request)
      signal.throwIfAborted(); const secretFields = validate(spec, request)
      const minutes = Math.max(1, Math.min(spec.expiresMinutes ?? 10, 30))
      if (!Number.isFinite(minutes)) throw new Error('交互有效期无效')
      const expiry = new Date(Date.now() + minutes * 60000)
      await client.query("UPDATE interaction_prompts SET status='cancelled', resolved_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2 AND status='active'", [identity.ownerId, identity.sessionId])
      await client.query("UPDATE mcp_secret_inputs SET status='cancelled', encrypted_payload='', payload_nonce='', encrypted_data_key='' WHERE user_id=$1 AND session_id=$2 AND status IN ('pending_choice','awaiting_secret')", [identity.ownerId, identity.sessionId])
      const secret = request.kind === 'credential', allowText = request.kind === 'question' && !!spec.allowTextInput && !secret
      const options = [...spec.options, ...(allowText ? [{ id: '__custom_reply__', label: '自定义回复', actionType: 'custom_reply' }] : [])]
      const context = { ...spec.context, tool_call_id: request.toolCall.id, tool_name: request.toolCall.name }
      const schema = { options: options.map(option => ({ id: option.id, label: option.label, action_type: option.actionType })), secret_fields: secretFields, allow_text_input: allowText, source: 'agent', custom_input_active: false, context }
      const inserted = await client.query<{ id: number }>(`INSERT INTO interaction_prompts (user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'active',$7,clock_timestamp()) RETURNING id`, [identity.ownerId, identity.sessionId, spec.kind, spec.title.slice(0, 120), spec.body.slice(0, 1000), JSON.stringify(schema), expiry])
      const promptId = inserted.rows[0]!.id
      for (const option of options) {
        const token = randomBytes(24).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex')
        await client.query(`INSERT INTO interaction_actions (prompt_id,token_hash,action_type,option_id,context_json,status,expires_at,created_at)
          VALUES ($1,$2,$3,$4,$5,'pending',$6,clock_timestamp())`, [promptId, tokenHash, option.actionType, option.id, JSON.stringify(context), expiry])
      }
      await bindInteractionPrompt(client, identity, promptId, request.id, request.toolCall.id)
      return request
    })
  } }
}
