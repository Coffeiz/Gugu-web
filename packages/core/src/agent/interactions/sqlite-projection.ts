import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import type { AgentRunEventProjection } from '../run/event-projection.js'
import { createSqlAgentInteractionHistory } from '../sessions/interaction-history.js'

/** 仅投影当前运行绑定的提示，选项令牌沿用交互历史的事务规则。 */
export function createSqliteInteractionProjection(db: Kysely<Database>, secretKey: string): AgentRunEventProjection {
  const history = createSqlAgentInteractionHistory(db, 'sqlite', undefined, secretKey)
  return { async interaction(event) {
    const interactionId = event.payload.interactionId
    if (event.type !== 'interaction_required' || typeof interactionId !== 'string' || !interactionId)
      throw new CoreError('invalid_request', '交互事件无效')
    const { ownerId, sessionId, runId } = event.identity
    const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
    const { rows: [binding] } = await sql<{ prompt_id: number }>`
      SELECT prompt_id FROM agent_interaction_bindings
      WHERE user_id=${owner} AND session_id=${sessionId} AND run_id=${runId}
        AND interaction_id=${interactionId}`.execute(db)
    if (!binding) throw new CoreError('not_found', '交互不存在')
    const [prompt] = await history(ownerId, Number(sessionId), { restoreActive: true, promptId: binding.prompt_id })
    if (!prompt) throw new CoreError('not_found', '交互不存在')
    const { id, ...fields } = prompt
    return { type: 'interaction_required', prompt_id: id, core_run_id: runId, ...fields }
  } }
}
