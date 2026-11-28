import { createHash, randomBytes } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import type { PendingInteraction, RunIdentity } from '../models.js'
import type { AgentPromptDescriptionPorts } from './prompt-description.js'
import { prepareAgentInteractionPrompt } from './prompt-preparation.js'

/** 同一运行内重复激活返回已有提示，提示、动作和绑定在同一事务写入。 */
export function createSqliteInteractionActivator(
  db: Kysely<Database>,
  descriptions: AgentPromptDescriptionPorts<Transaction<Database>>,
) {
  return { async activate(identity: RunIdentity, request: PendingInteraction, signal: AbortSignal): Promise<PendingInteraction> {
    signal.throwIfAborted()
    const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
    return db.transaction().execute(async tx => {
      const run = await sql`SELECT 1 FROM agent_run_checkpoints
        WHERE user_id=${owner} AND session_id=${identity.sessionId} AND run_id=${identity.runId}
          AND status='running'`.execute(tx)
      if (!run.rows.length) throw new CoreError('conflict', '运行已结束或不存在')
      const { rows: [prior] } = await sql<{ tool_call_id: string; status: string; expires_at: string }>`
        SELECT b.tool_call_id, p.status, p.expires_at
        FROM agent_interaction_bindings b
        JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
        WHERE b.user_id=${owner} AND b.session_id=${identity.sessionId} AND b.run_id=${identity.runId}
          AND b.interaction_id=${request.id}`.execute(tx)
      if (prior) {
        if (prior.tool_call_id !== request.toolCall.id || prior.status !== 'active' || Date.parse(prior.expires_at) <= Date.now())
          throw new CoreError('conflict', '交互绑定冲突或已结束')
        return request
      }
      const spec = await descriptions.describe(tx, identity, request)
      signal.throwIfAborted()
      const now = Date.now()
      const createdAt = new Date(now).toISOString()
      const { expiry, options, context, schema } = prepareAgentInteractionPrompt(spec, request, now)
      const body = request.kind === 'confirmation' && request.toolCall.name === 'shell'
        ? spec.body : spec.body.slice(0, 1000)
      const expiresAt = expiry.toISOString()
      await sql`UPDATE interaction_prompts SET status='cancelled', resolved_at=${createdAt}
        WHERE user_id=${owner} AND session_id=${identity.sessionId} AND status='active'`.execute(tx)
      const { rows: [prompt] } = await sql<{ id: number }>`
        INSERT INTO interaction_prompts (user_id, session_id, kind, title, body, schema_json, status, expires_at, created_at)
        VALUES (${owner}, ${identity.sessionId}, ${spec.kind}, ${spec.title.slice(0, 120)}, ${body},
          ${JSON.stringify(schema)}, 'active', ${expiresAt}, ${createdAt}) RETURNING id`.execute(tx)
      for (const option of options) {
        const tokenHash = createHash('sha256').update(randomBytes(24).toString('base64url')).digest('hex')
        await sql`INSERT INTO interaction_actions (prompt_id, token_hash, action_type, option_id, context_json, status, expires_at, created_at)
          VALUES (${prompt!.id}, ${tokenHash}, ${option.actionType}, ${option.id}, ${JSON.stringify(context)},
            'pending', ${expiresAt}, ${createdAt})`.execute(tx)
      }
      await sql`INSERT INTO agent_interaction_bindings (user_id, session_id, run_id, interaction_id, tool_call_id, prompt_id)
        VALUES (${owner}, ${identity.sessionId}, ${identity.runId}, ${request.id}, ${request.toolCall.id}, ${prompt!.id})`.execute(tx)
      return request
    })
  } }
}
