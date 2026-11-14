import { createHash } from 'node:crypto'

export class InteractionSessionNotFoundError extends Error {
  readonly statusCode = 404
  constructor() {
    super('对话不存在')
  }
}

export interface PendingInteractionAction {
  id: number
  status: string
  optionId: string
  tokenHash: string
  actionType: string
  context: Record<string, unknown> | null
  expiresAt: Date
}

export interface PendingInteractionPrompt {
  id: number
  sessionId: number
  kind: string
  title: string
  body: string
  status: string
  expiresAt: Date
  createdAt: Date
  schema: unknown
}

export interface PendingInteractionWindow {
  restoreActive?: boolean
  startAt?: Date | null
  endBefore?: Date | null
  toolCallIds?: ReadonlySet<string> | null
}

export interface PendingInteractionStore {
  sessionOwnedBy(ownerId: string, sessionId: number): Promise<boolean>
  listPrompts(ownerId: string, sessionId: number, window: PendingInteractionWindow): Promise<PendingInteractionPrompt[]>
  listActions(promptId: number): Promise<PendingInteractionAction[]>
  commit(): Promise<void>
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* malformed historical JSON is treated as empty metadata */ }
  }
  return {}
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function createPendingInteractionHistory(
  store: PendingInteractionStore,
  signToken: () => string,
  now: () => Date = () => new Date(),
) {
  return {
    async list(ownerId: string, sessionId: number, window: PendingInteractionWindow = {}) {
      if (!await store.sessionOwnedBy(ownerId, sessionId)) throw new InteractionSessionNotFoundError()
      const timestamp = now()
      const restoreActive = window.restoreActive !== false
      const prompts = (await store.listPrompts(ownerId, sessionId, window))
        .filter((prompt) => {
          const active = prompt.status === 'active' && prompt.expiresAt > timestamp
          if (active) return restoreActive
          if (window.startAt && prompt.createdAt < window.startAt) return false
          if (window.endBefore && prompt.createdAt >= window.endBefore) return false
          if (window.toolCallIds) {
            const callId = record(record(prompt.schema).context).tool_call_id
            if (!window.toolCallIds.has(String(callId ?? ''))) return false
          }
          return true
        })
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id - right.id)
      const result: Array<Record<string, unknown>> = []
      let changed = false

      for (const prompt of prompts) {
        const schema = record(prompt.schema)
        const context = record(schema.context)
        const target = context.secret_target
        const secretPrompt = Boolean(schema.secret_fields)
          && target !== null && typeof target === 'object' && !Array.isArray(target)
          && (target as Record<string, unknown>).kind === 'mcp_credentials'
        const active = prompt.status === 'active' && prompt.expiresAt > timestamp
        const actions = (await store.listActions(prompt.id)).sort((left, right) => left.id - right.id)
        const options: Array<{ id: string; label: string; token: string }> = []
        let selectedOptionId: string | null = null
        const schemaOptions = Array.isArray(schema.options) ? schema.options : []

        for (const action of secretPrompt ? [] : actions) {
          if (action.status === 'consumed') {
            selectedOptionId = action.optionId
            continue
          }
          if (active && action.expiresAt > timestamp && action.status === 'pending') {
            const token = signToken()
            action.tokenHash = tokenDigest(token)
            changed = true
            const labelOption = schemaOptions.find((item) =>
              item && typeof item === 'object' && String((item as Record<string, unknown>).id ?? '') === action.optionId,
            ) as Record<string, unknown> | undefined
            options.push({ id: action.optionId, label: String(labelOption?.label ?? action.optionId), token })
          }
        }

        const resolvedResult = record(schema.resolved_result)
        const toolCallId = String(context.tool_call_id ?? '') || null
        result.push({
          id: prompt.id,
          session_id: prompt.sessionId,
          kind: prompt.kind,
          title: prompt.title,
          body: prompt.body,
          tool_call_id: toolCallId,
          task_paused: prompt.kind === 'confirm' && Boolean(toolCallId),
          options,
          secret_fields: Array.isArray(schema.secret_fields) ? schema.secret_fields : [],
          allow_text_input: schema.source === 'agent' && Boolean(schema.allow_text_input),
          custom_input_active: Boolean(schema.custom_input_active),
          resolved: !active,
          selected_option_id: selectedOptionId,
          response_text: typeof resolvedResult.text === 'string' ? resolvedResult.text : null,
          expires_at: prompt.expiresAt.toISOString(),
          created_at: prompt.createdAt.toISOString(),
        })
      }
      if (changed) await store.commit()
      return result
    },
  }
}
