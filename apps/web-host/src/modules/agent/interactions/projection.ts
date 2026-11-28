import { createHash } from 'node:crypto'
import { deriveInteractionActionToken } from '@gugu/core/agent-sessions'
import type { Pool, PoolClient } from 'pg'
import type { RunEvent, RunIdentity } from '@gugu/core/agent'
import { projectAgentInteraction } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
/** 仅按已验证的 run 绑定读取并投影该 prompt 动作令牌，outbox 永不包含令牌。 */
export function createPostgresInteractionProjection(pool: Pick<Pool, 'connect'>, secretKey?: string) {
  return { async interaction(event: RunEvent) {
    const interactionId = event.payload.interactionId
    if (event.type !== 'interaction_required' || typeof interactionId !== 'string' || !interactionId) throw new Error('交互事件无效')
    return withPostgresTransaction(pool, client => projectInteractionPromptLocked(client, event.identity, interactionId, undefined, false, secretKey))
  } }
}

export async function projectInteractionPromptLocked(client: PoolClient, identity: RunIdentity, interactionId: string, onlyOptionId?: string, privateImSecret = false, secretKey?: string) {
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
    if ((secret && !privateImSecret) || (onlyOptionId !== undefined && action.option_id !== onlyOptionId) || !active || action.status !== 'pending' || new Date(action.expires_at).getTime() <= Date.now()) continue
    const token = deriveInteractionActionToken(identity.ownerId, prompt.id, action.id, secretKey), hash = createHash('sha256').update(token).digest('hex')
    const updated = await client.query("UPDATE interaction_actions SET token_hash=$1 WHERE id=$2 AND prompt_id=$3 AND status='pending' AND expires_at > clock_timestamp()", [hash, action.id, prompt.id])
    if (updated.rowCount) options.push({ id: action.option_id, label: String(declared.find(option => option.id === action.option_id)?.label || action.option_id), token })
  }
  return projectAgentInteraction({ runId: identity.runId, prompt, schema, active, options, selected })
}
