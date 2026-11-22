import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { consumeInteractionAction, InteractionConsumeError } from '@gugu/core/agent/interactions/consume-action'
import { consumeInteractionText, InteractionTextError } from '@gugu/core/agent'
import type { InteractionActionRecord, InteractionConsumeResult, InteractionPromptRecord } from '@gugu/core/agent/interactions/consume-action'
import { z } from 'zod'
import { parsePythonInteger } from '../../../http/request.js'
import { createPostgresInteractionConsumeStore, createPostgresInteractionTextStore, type InteractionSideEffects } from './consume.js'

export interface AgentInteractionRespondService {
  respond(ownerId: string, promptId: number, token: string, eventId?: string, selectedOptionIds?: string[], customAnswer?: string): Promise<InteractionConsumeResult & { run_id?: string }>
  findResolvedRun?(ownerId: string, promptId: number, token: string): Promise<{ session_id: number; run_id: string; status: string; option_id: string } | null>
  resumeText?(ownerId: string, promptId: number, text: string, eventId?: string): Promise<{
    prompt_id: number; session_id: number; kind: string; context: Record<string, unknown>; result: Record<string, unknown>; event_id?: string
  }>
}

/** 消费和恢复记录处于同一事务；通知失败不会回滚已提交的动作。 */
export function createAgentInteractionRespondService(options: {
  pool: Pick<Pool, 'connect' | 'query'>
  effects: Pick<InteractionSideEffects, 'applyCommandAction' | 'redeemConfirmation'>
  enqueue(client: PoolClient, prompt: InteractionPromptRecord, action: InteractionActionRecord,
    onEnqueued?: (runId: string, displaySessionId?: number) => void): Promise<void>
  wake(ownerId: string, sessionId: number): Promise<unknown>
  diagnose(): void
  routeDelegated?: boolean
}): AgentInteractionRespondService {
  if (!options.effects || typeof options.effects.applyCommandAction !== 'function' || typeof options.effects.redeemConfirmation !== 'function' || typeof options.enqueue !== 'function' || typeof options.wake !== 'function' || typeof options.diagnose !== 'function') throw new TypeError('交互服务未完整配置')
  const textStore = createPostgresInteractionTextStore(options.pool, async (client, prompt, eventId) => {
    const context = prompt.schema.context && typeof prompt.schema.context === 'object' && !Array.isArray(prompt.schema.context)
      ? prompt.schema.context as Record<string, unknown> : {}
    const action: InteractionActionRecord = {
      id: 0, promptId: prompt.id, tokenHash: '', actionType: 'text', optionId: '__text__', context,
      status: 'consumed', expiresAt: prompt.expiresAt, consumedAt: prompt.resolvedAt, consumedEventId: eventId ?? null,
    }
    await options.enqueue(client, prompt as InteractionPromptRecord, action)
  })
  return {
    async findResolvedRun(ownerId, promptId, token) {
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
      const display = options.routeDelegated
        ? 'COALESCE(d.parent_session_id::integer,b.session_id) AS session_id,COALESCE(d.parent_run_id,b.run_id) AS run_id'
        : 'b.session_id,b.run_id'
      const delegated = options.routeDelegated ? `LEFT JOIN agent_subagent_executions s ON s.child_session_id=b.session_id AND s.child_run_id=b.run_id
         LEFT JOIN agent_subagent_deliveries d ON d.child_run_id=s.child_run_id AND d.owner_id=b.user_id::text` : ''
      const { rows } = await options.pool.query<{ session_id: number; run_id: string; status: string; option_id: string }>(
        `SELECT ${display},p.schema_json::jsonb->'resolved_result'->>'status' AS status,a.option_id
         FROM agent_interaction_bindings b
         JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
         JOIN interaction_actions a ON a.prompt_id=p.id AND a.token_hash=$3
         ${delegated}
         WHERE b.user_id=$1 AND b.prompt_id=$2 AND p.status='resolved' AND a.status='consumed'
           AND p.schema_json::jsonb->'resolved_result'->>'status' IN ('confirmed','cancelled','selected','answered')
           AND p.schema_json::jsonb->'resolved_result'->>'option_id'=a.option_id`, [ownerId, promptId, tokenHash],
      )
      return rows[0] ?? null
    },
    async respond(ownerId, promptId, token, eventId, selectedOptionIds, customAnswer) {
      let runId: string | undefined
      let displaySessionId: number | undefined
      const store = createPostgresInteractionConsumeStore(options.pool, {
        ...options.effects,
        async beforeCommit(client, prompt, action) {
          if (typeof action.context.tool_call_id === 'string' && action.context.tool_call_id)
            await options.enqueue(client, prompt, action, (id, display) => {
              runId = id
              displaySessionId = display
            })
        },
      })
      const result = await consumeInteractionAction(store, { ownerId, promptId, token, selectedOptionIds, customAnswer, ...(eventId != null ? { eventId } : {}) })
      const resolved = result.result
      if (typeof result.context.tool_call_id === 'string' && result.context.tool_call_id && resolved.status !== 'awaiting_text' && resolved.status !== 'error') {
        try { await options.wake(ownerId, result.session_id) } catch { try { options.diagnose() } catch { /* 诊断不得影响已提交结果。 */ } }
      }
      return { ...result, ...(typeof runId === 'string' ? { run_id: runId } : {}),
        ...(displaySessionId === undefined ? {} : { session_id: displaySessionId }) }
    },
    async resumeText(ownerId, promptId, text, eventId) {
      const result = await consumeInteractionText(textStore, { ownerId, promptId, text, ...(eventId != null ? { eventId } : {}) })
      if (typeof result.context.tool_call_id === 'string' && result.context.tool_call_id) {
        try { await options.wake(ownerId, result.session_id) } catch { try { options.diagnose() } catch { /* 已提交事务不受诊断失败影响。 */ } }
      }
      return result
    },
  }
}

const bodySchema = z.object({ token: z.string(), custom_answer: z.string().max(8_000).optional(), selected_option_ids: z.array(z.string().min(1).max(64)).optional(), event_id: z.string().nullish() })
const textBodySchema = z.object({ text: z.string(), event_id: z.string().nullish() })
const errorDetails: Record<InteractionConsumeError['code'], string> = {
  interaction_not_found: '交互不存在', interaction_ended: '交互已结束', interaction_expired: '交互已过期',
  action_invalid: '动作无效或已使用', custom_reply_not_allowed: '该交互不接受自定义回答',
  secret_interaction_requires_private_route: '敏感信息交互必须通过专用入口处理', command_action_unsupported: '该交互命令暂不支持',
  command_action_handler_unavailable: '交互命令处理器不可用', confirmation_redeemer_unavailable: '确认状态无法校验',
}

export function registerAgentInteractionRespondRoute(app: FastifyInstance, options: {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  service: AgentInteractionRespondService
}): void {
  app.post<{ Params: { prompt_id: string } }>('/api/v1/agent/interactions/:prompt_id/respond', { preHandler: options.requireUser }, async (request, reply) => {
    const promptId = parsePythonInteger(request.params.prompt_id), body = bodySchema.safeParse(request.body)
    if (promptId == null || !body.success) return reply.code(422).send({ detail: '交互请求无效' })
    try { return await options.service.respond(options.userIdFromRequest(request), promptId, body.data.token, body.data.event_id ?? undefined, body.data.selected_option_ids, body.data.custom_answer) }
    catch (error) {
      if (error instanceof InteractionConsumeError) return reply.code(error.code === 'interaction_not_found' ? 404 : 409).send({ detail: errorDetails[error.code] })
      return reply.code(500).send({ detail: '交互处理失败' })
    }
  })
  app.post<{ Params: { prompt_id: string } }>('/api/v1/agent/interactions/:prompt_id/resume', { preHandler: options.requireUser }, async (request, reply) => {
    const promptId = parsePythonInteger(request.params.prompt_id), body = bodySchema.safeParse(request.body)
    if (promptId == null || !body.success) return reply.code(422).send({ detail: '交互请求无效' })
    const ownerId = options.userIdFromRequest(request)
    try {
      const result = await options.service.respond(ownerId, promptId, body.data.token, body.data.event_id ?? undefined, body.data.selected_option_ids, body.data.custom_answer)
      if (!result.context.tool_call_id) return reply.code(409).send({ detail: '该交互不支持恢复原任务' })
      const resolved = result.result && typeof result.result === 'object' ? result.result as Record<string, unknown> : {}
      if (resolved.status === 'error') return reply.code(409).send({ detail: typeof resolved.text === 'string' ? resolved.text : '确认未生效，请重新发起操作。' })
      return { ok: true, session_id: result.session_id, status: resolved.status, option_id: result.option_id, run_id: result.run_id }
    } catch (error) {
      if (error instanceof InteractionConsumeError && error.code === 'interaction_ended') {
        // 确认已提交时只返回原运行坐标。重复请求不会再次入队或执行工具。
        const previous = await options.service.findResolvedRun?.(ownerId, promptId, body.data.token).catch(() => null)
        if (previous) return { ok: true, ...previous }
      }
      if (error instanceof InteractionConsumeError) return reply.code(error.code === 'interaction_not_found' ? 404 : 409).send({ detail: errorDetails[error.code] })
      return reply.code(500).send({ detail: '交互处理失败' })
    }
  })
  if (options.service.resumeText) app.post<{ Params: { prompt_id: string } }>('/api/v1/agent/interactions/:prompt_id/resume-text', { preHandler: options.requireUser }, async (request, reply) => {
    const promptId = parsePythonInteger(request.params.prompt_id), body = textBodySchema.safeParse(request.body)
    if (promptId == null || !body.success) return reply.code(422).send({ detail: '交互请求无效' })
    try {
      const result = await options.service.resumeText!(options.userIdFromRequest(request), promptId, body.data.text, body.data.event_id ?? undefined)
      if (!result.context.tool_call_id) return reply.code(409).send({ detail: '该交互不支持恢复原任务' })
      return { ok: true, session_id: result.session_id }
    } catch (error) {
      if (error instanceof InteractionTextError) {
        const details: Record<typeof error.code, string> = {
          interaction_not_found: '交互不存在', interaction_expired: '交互已过期',
          secret_interaction_requires_private_route: '敏感信息交互必须通过专用入口处理',
          custom_reply_not_allowed: '该交互不接受文本回答', custom_reply_must_be_selected: '请先选择自定义回答',
          text_invalid: '回答不能为空或过长',
        }
        return reply.code(error.code === 'interaction_not_found' ? 404 : 409).send({ detail: details[error.code] })
      }
      return reply.code(500).send({ detail: '交互处理失败' })
    }
  })
}
