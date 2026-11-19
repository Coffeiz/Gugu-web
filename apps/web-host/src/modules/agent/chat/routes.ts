import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { AgentChatService as CoreAgentChatService } from '@gugu/core/agent'
import { z } from 'zod'
import { parsePythonInteger } from '../../../http/request.js'

const chatBody = z.object({
  message: z.string(),
  client_message_id: z.string().max(64).regex(/^[A-Za-z0-9:_-]+$/).nullish(),
  credential_id: z.number().int().positive().max(2147483647).optional(),
  locale: z.enum(['zh-CN', 'ja-JP', 'en-US']).nullish(),
  session_id: z.number().int().safe().nullish(),
  pending_queue_id: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).nullish(),
  pending_queue_item_key: z.number().int().positive().safe().nullish(),
  pending_queue_claim_token: z.string().max(128).nullish(),
  attachments: z.array(z.string()).nullish(),
  references: z.array(z.record(z.string(), z.unknown())).nullish(),
  greeting: z.string().nullish(),
  interaction_prompt_id: z.number().int().safe().nullish(),
  interaction_token: z.string().nullish(),
  interaction_event_id: z.string().nullish(),
})

export type AgentChatInput = z.infer<typeof chatBody>
export type AgentChatEvent = { type: string; [key: string]: unknown }

/** Core 定义生命周期契约；HTTP route 仅提供认证后的输入适配。 */
export type AgentChatService = CoreAgentChatService<AgentChatInput>

export interface AgentChatRouteOptions {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  service: AgentChatService
}

function requestStreamSignal(request: FastifyRequest, reply: import('fastify').FastifyReply) {
  const controller = new AbortController()
  const onRequestAborted = () => controller.abort()
  const cleanup = () => {
    request.raw.off('aborted', onRequestAborted)
    reply.raw.off('close', onResponseClose)
    reply.raw.off('finish', cleanup)
  }
  const onResponseClose = () => {
    if (!reply.raw.writableFinished) controller.abort()
    cleanup()
  }
  request.raw.once('aborted', onRequestAborted)
  reply.raw.once('close', onResponseClose)
  reply.raw.once('finish', cleanup)
  return { signal: controller.signal, cleanup }
}

async function* encodeEvents(events: AsyncIterable<AgentChatEvent>): AsyncGenerator<string> {
  try {
    for await (const event of events) yield `data: ${JSON.stringify(event)}\n\n`
  } catch {
    yield `data: ${JSON.stringify({ type: 'error', message: '生成失败，请稍后重试' })}\n\n`
    yield `data: ${JSON.stringify({ type: 'done' })}\n\n`
  }
}

export function registerAgentChatRoutes(app: FastifyInstance, options: AgentChatRouteOptions): void {
  function stream(reply: import('fastify').FastifyReply, events: AsyncIterable<AgentChatEvent>) {
    return reply.header('Cache-Control', 'no-cache').header('X-Accel-Buffering', 'no')
      .type('text/event-stream').send(Readable.from(encodeEvents(events)))
  }
  app.post('/api/v1/agent/chat', { preHandler: options.requireUser }, async (request, reply) => {
    const body = chatBody.safeParse(request.body)
    if (!body.success) return reply.code(422).send({ detail: '聊天请求无效' })
    const origin = request.headers['x-client-id']
    const connection = requestStreamSignal(request, reply)
    try {
      const events = await options.service.start(options.userIdFromRequest(request), body.data,
        typeof origin === 'string' ? origin : undefined, connection.signal)
      return stream(reply, events)
    } catch (error) {
      connection.cleanup()
      throw error
    }
  })
  app.get<{ Params: { session_id: string }; Querystring: { run_id?: unknown } }>('/api/v1/agent/sessions/:session_id/stream', { preHandler: options.requireUser }, async (request, reply) => {
    const id = parsePythonInteger(request.params.session_id)
    const runId = request.query.run_id
    if (id == null || (runId !== undefined && (typeof runId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(runId))))
      return reply.code(422).send({ detail: '会话或运行 ID 无效' })
    const connection = requestStreamSignal(request, reply)
    let events: AsyncIterable<AgentChatEvent> | null
    try { events = await options.service.resume(options.userIdFromRequest(request), id, connection.signal, runId) }
    catch (error) { connection.cleanup(); throw error }
    if (!events) { connection.cleanup(); return reply.code(404).send({ detail: '对话不存在' }) }
    return stream(reply, events)
  })
  app.post<{ Params: { session_id: string } }>('/api/v1/agent/sessions/:session_id/cancel', { preHandler: options.requireUser }, async (request, reply) => {
    const id = parsePythonInteger(request.params.session_id)
    if (id == null) return reply.code(422).send({ detail: '会话 ID 无效' })
    const result = await options.service.cancel(options.userIdFromRequest(request), id)
    return result ?? reply.code(404).send({ detail: '会话不存在' })
  })
  app.post<{ Params: { session_id: string } }>('/api/v1/agent/sessions/:session_id/retry-reconstruction', { preHandler: options.requireUser }, async (request, reply) => {
    const id = parsePythonInteger(request.params.session_id)
    if (id == null) return reply.code(422).send({ detail: '会话 ID 无效' })
    if (!options.service.retryReconstruction) return reply.code(503).send({ detail: '运行恢复服务不可用' })
    const result = await options.service.retryReconstruction(options.userIdFromRequest(request), id)
    return result ?? reply.code(404).send({ detail: '对话不存在' })
  })
}
