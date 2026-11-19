import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { RunEvent } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
/** 仅按已验证的 run 绑定读取并轮换该 prompt 令牌，outbox 永不包含令牌。 */
export function createPostgresInteractionProjection(pool: Pick<Pool, 'connect'>) {
  return { async interaction(event: RunEvent) {
    const interactionId = event.payload.interactionId
    if (event.type !== 'interaction_required' || typeof interactionId !== 'string' || !interactionId) throw new Error('交互事件无效')
    return withPostgresTransaction(pool, async client => {
      const identity = event.identity
      const result = await client.query(`SELECT p.id,p.session_id,p.kind,p.title,p.body,p.schema_json,p.status,p.expires_at,p.created_at
        FROM agent_interaction_bindings b JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
        WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3 AND b.interaction_id=$4 FOR UPDATE OF p`, [identity.ownerId, identity.sessionId, identity.runId, interactionId])
      const prompt = result.rows[0]
      if (!prompt) throw new Error('交互不存在')
      const schema = object(prompt.schema_json), context = object(schema.context), target = object(context.secret_target)
      const secret = Array.isArray(schema.secret_fields) && schema.secret_fields.length > 0 && target.kind === 'mcp_credentials'
      const active = prompt.status === 'active' && new Date(prompt.expires_at).getTime() > Date.now()
      const actions = await client.query('SELECT id,option_id,status,expires_at FROM interaction_actions WHERE prompt_id=$1 ORDER BY id FOR UPDATE', [prompt.id])
      const declared = Array.isArray(schema.options) ? schema.options.map(object) : []
      const options: Array<{ id: string; label: string; token: string }> = []
      let selected: string | null = null
      for (const action of actions.rows) {
        if (action.status === 'consumed') selected = action.option_id
        if (secret || !active || action.status !== 'pending' || new Date(action.expires_at).getTime() <= Date.now()) continue
        const token = randomBytes(24).toString('base64url'), hash = createHash('sha256').update(token).digest('hex')
        const updated = await client.query("UPDATE interaction_actions SET token_hash=$1 WHERE id=$2 AND prompt_id=$3 AND status='pending' AND expires_at > clock_timestamp()", [hash, action.id, prompt.id])
        if (updated.rowCount) options.push({ id: action.option_id, label: String(declared.find(option => option.id === action.option_id)?.label || action.option_id), token })
      }
      const resolved = object(schema.resolved_result)
      return { type: 'interaction_required', prompt_id: prompt.id, session_id: prompt.session_id, core_run_id: identity.runId,
        kind: prompt.kind, title: prompt.title, body: prompt.body,
        tool_call_id: typeof context.tool_call_id === 'string' ? context.tool_call_id : null, task_paused: prompt.kind === 'confirm', options,
        secret_fields: Array.isArray(schema.secret_fields) ? schema.secret_fields : [], allow_text_input: schema.source === 'agent' && !!schema.allow_text_input,
        custom_input_active: !!schema.custom_input_active, resolved: !active, selected_option_id: selected,
        response_text: typeof resolved.text === 'string' ? resolved.text : null, expires_at: new Date(prompt.expires_at).toISOString(), created_at: new Date(prompt.created_at).toISOString() }
    })
  } }
}
