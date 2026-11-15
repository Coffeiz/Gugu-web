import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { parsePythonInteger } from '../../http/request.js'
import { consumeInteractionAction, InteractionConsumeError, type InteractionConsumeResult } from './application/agent-interaction-consume.js'
import { createPostgresInteractionConsumeStore, type InteractionSideEffects } from './persistence/agent-interaction-consume-postgres.js'
import type { InteractionActionRecord, InteractionPromptRecord } from './application/agent-interaction-consume.js'

export interface AgentInteractionRespondService {
  respond(ownerId: string, promptId: number, token: string, eventId?: string): Promise<InteractionConsumeResult>
}

/** 消费和恢复记录处于同一事务；通知失败不会回滚已提交的动作。 */
export function createAgentInteractionRespondService(options: {
  pool: Pick<Pool, 'connect'>
  effects: Pick<InteractionSideEffects, 'applyCommandAction' | 'redeemConfirmation'>
  enqueue(client: PoolClient, prompt: InteractionPromptRecord, action: InteractionActionRecord): Promise<void>
  wake(): Promise<void>
  diagnose(): void
}): AgentInteractionRespondService {
  if (!options.effects || typeof options.effects.applyCommandAction !== 'function' || typeof options.effects.redeemConfirmation !== 'function' || typeof options.enqueue !== 'function' || typeof options.wake !== 'function' || typeof options.diagnose !== 'function') throw new TypeError('交互服务未完整配置')
  const store = createPostgresInteractionConsumeStore(options.pool, {
    ...options.effects,
    async beforeCommit(client, prompt, action) {
      if (typeof action.context.tool_call_id === 'string' && action.context.tool_call_id) await options.enqueue(client, prompt, action)
    },
  })
  return {
    async respond(ownerId, promptId, token, eventId) {
      const result = await consumeInteractionAction(store, { ownerId, promptId, token, ...(eventId != null ? { eventId } : {}) })
      const resolved = result.result
      if (typeof result.context.tool_call_id === 'string' && result.context.tool_call_id && resolved.status !== 'awaiting_text' && resolved.status !== 'error') {
        try { await options.wake() } catch { try { options.diagnose() } catch { /* 诊断不得影响已提交结果。 */ } }
      }
      return result
    },
  }
}

const bodySchema = z.object({ token: z.string(), event_id: z.string().nullish() })
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
    try { return await options.service.respond(options.userIdFromRequest(request), promptId, body.data.token, body.data.event_id ?? undefined) }
    catch (error) {
      if (error instanceof InteractionConsumeError) return reply.code(error.code === 'interaction_not_found' ? 404 : 409).send({ detail: errorDetails[error.code] })
      return reply.code(500).send({ detail: '交互处理失败' })
    }
  })
}
