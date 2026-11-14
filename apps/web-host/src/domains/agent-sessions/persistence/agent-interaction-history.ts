import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export interface AgentInteractionHistoryWindow {
  readonly restoreActive: boolean
  /** Millisecond epoch as a decimal string; keeps PostgreSQL microsecond ordering intact. */
  readonly startAtMs?: string
  /** Exclusive millisecond epoch boundary as a decimal string. */
  readonly endBeforeMs?: string
  readonly toolCallIds?: readonly string[]
}

interface PromptRow {
  id: number
  session_id: number
  kind: string
  title: string
  body: string
  schema_json: unknown
  status: string
  expires_at: Date | string
  created_at: Date | string
}

interface ActionRow {
  id: number
  prompt_id: number
  option_id: string
  status: string
  expires_at: Date | string
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function expiry(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

function optionLabel(schema: Record<string, unknown>, optionId: string): string {
  const options = Array.isArray(schema.options) ? schema.options : []
  const option = options.find((item) => record(item).id === optionId)
  return String(record(option).label || optionId)
}

/**
 * Reads the Python-compatible history projection. Active action tokens are rotated
 * transactionally and only their hashes are persisted; prompt secrets and action
 * context are never included in the returned DTO.
 */
export function createPostgresAgentInteractionHistory(pool: Pool, now: () => Date = () => new Date()) {
  return {
    async list(ownerId: string, sessionId: number, window: AgentInteractionHistoryWindow) {
      if (window.toolCallIds && window.toolCallIds.length === 0) return []

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const at = now()
        const params: unknown[] = [ownerId, sessionId, at]
        const active = `(prompt.status = 'active' AND prompt.expires_at > $3)`
        const historicalFilters: string[] = []
        if (window.startAtMs !== undefined) {
          params.push(window.startAtMs)
          historicalFilters.push(`EXTRACT(EPOCH FROM prompt.created_at) * 1000 >= $${params.length}::numeric`)
        }
        if (window.endBeforeMs !== undefined) {
          params.push(window.endBeforeMs)
          historicalFilters.push(`EXTRACT(EPOCH FROM prompt.created_at) * 1000 < $${params.length}::numeric`)
        }
        if (window.toolCallIds !== undefined) {
          params.push([...window.toolCallIds])
          historicalFilters.push(`prompt.schema_json #>> '{context,tool_call_id}' = ANY($${params.length}::text[])`)
        }
        const historical = `(NOT ${active}${historicalFilters.length ? ` AND ${historicalFilters.join(' AND ')}` : ''})`
        const predicate = window.restoreActive ? `(${historical} OR ${active})` : historical
        const prompts = await client.query<PromptRow>(
          `SELECT prompt.id, prompt.session_id, prompt.kind, prompt.title, prompt.body,
                  prompt.schema_json, prompt.status, prompt.expires_at, prompt.created_at
           FROM interaction_prompts AS prompt
           WHERE prompt.user_id = $1 AND prompt.session_id = $2 AND ${predicate}
           ORDER BY prompt.created_at, prompt.id`,
          params,
        )
        if (prompts.rows.length === 0) {
          await client.query('COMMIT')
          return []
        }

        const promptIds = prompts.rows.map(({ id }) => id)
        const actions = await client.query<ActionRow>(
          `SELECT id, prompt_id, option_id, status, expires_at
           FROM interaction_actions
           WHERE prompt_id = ANY($1::integer[])
           ORDER BY id
           FOR UPDATE`,
          [promptIds],
        )
        const actionsByPrompt = new Map<number, ActionRow[]>()
        for (const action of actions.rows) {
          const list = actionsByPrompt.get(action.prompt_id) ?? []
          list.push(action)
          actionsByPrompt.set(action.prompt_id, list)
        }

        const result = []
        for (const prompt of prompts.rows) {
          const promptSchema = record(prompt.schema_json)
          const schemaContext = record(promptSchema.context)
          const secretTarget = record(schemaContext.secret_target)
          const secretMcpInteraction = Boolean(
            promptSchema.secret_fields && secretTarget.kind === 'mcp_credentials',
          )
          const isActive = prompt.status === 'active' && expiry(prompt.expires_at) > at.getTime()
          const optionRows = actionsByPrompt.get(prompt.id) ?? []
          const options: Array<{ id: string; label: string; token: string }> = []
          let selectedOptionId: string | null = null
          for (const action of secretMcpInteraction ? [] : optionRows) {
            if (action.status === 'consumed') {
              selectedOptionId = action.option_id
              continue
            }
            if (!isActive || action.status !== 'pending' || expiry(action.expires_at) <= at.getTime())
              continue

            const token = randomBytes(24).toString('base64url')
            const updated = await client.query(
              `UPDATE interaction_actions SET token_hash = $1
               WHERE id = $2 AND prompt_id = $3 AND status = 'pending' AND expires_at > $4`,
              [hashToken(token), action.id, prompt.id, at],
            )
            if (updated.rowCount)
              options.push({ id: action.option_id, label: optionLabel(promptSchema, action.option_id), token })
          }
          const resolvedResult = record(promptSchema.resolved_result)
          const toolCallId = typeof schemaContext.tool_call_id === 'string' && schemaContext.tool_call_id
            ? schemaContext.tool_call_id
            : null
          result.push({
            id: prompt.id,
            session_id: prompt.session_id,
            kind: prompt.kind,
            title: prompt.title,
            body: prompt.body,
            tool_call_id: toolCallId,
            task_paused: prompt.kind === 'confirm' && Boolean(toolCallId),
            options,
            secret_fields: Array.isArray(promptSchema.secret_fields) ? promptSchema.secret_fields : [],
            allow_text_input: promptSchema.source === 'agent' && Boolean(promptSchema.allow_text_input),
            custom_input_active: Boolean(promptSchema.custom_input_active),
            resolved: !isActive,
            selected_option_id: selectedOptionId,
            response_text: typeof resolvedResult.text === 'string' ? resolvedResult.text : null,
            expires_at: timestamp(prompt.expires_at),
            created_at: timestamp(prompt.created_at),
          })
        }
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
}
