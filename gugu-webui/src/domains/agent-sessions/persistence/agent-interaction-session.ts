import type { Pool } from 'pg'

export class InteractionNotFoundError extends Error {
  readonly statusCode = 404
  constructor() {
    super('交互不存在')
  }
}

interface InteractionSessionRow {
  session_id: number
  schema_json: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Owner-scoped lookup used to resolve a sensitive-interaction deep link. */
export function createInteractionSessionLookup(pool: Pool) {
  return {
    async get(ownerId: string, promptId: number): Promise<{ session_id: number }> {
      const result = await pool.query<InteractionSessionRow>(
        `SELECT session_id, schema_json
         FROM interaction_prompts
         WHERE id = $1 AND user_id = $2`,
        [promptId, ownerId],
      )
      const prompt = result.rows[0]
      if (!prompt) throw new InteractionNotFoundError()

      const schema = isRecord(prompt.schema_json) ? prompt.schema_json : {}
      const context = isRecord(schema.context) ? schema.context : {}
      const target = context.secret_target
      if (!schema.secret_fields || !isRecord(target) || target.kind !== 'mcp_credentials')
        throw new InteractionNotFoundError()

      // Match Python get_user_prompt: expiry/status govern action consumption, not link resolution.
      return { session_id: prompt.session_id }
    },
  }
}
