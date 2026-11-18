import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import { createTelegramBotApi, type createTelegramConnector } from '@gugu/core/im/telegram-connect'
import { createPublicAgentEgress } from '../../adapters/safe-egress-proxy.js'
import type { SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'

/** 每次校验都热读管理员代理；启用代理失败时 createPublicAgentEgress 不会回退直连。 */
export function createTelegramConnectHostOptions(readSettings: () => SafeEgressReadSettings, secretKey: string) {
  const egress = createPublicAgentEgress(readSettings, secretKey)
  return {
    verify: (token: string) => egress.withTransport(AbortSignal.timeout(45_000), transport => createTelegramBotApi(transport).verify(token)),
    sendMessage: (token: string, chatId: string, text: string) => egress.withTransport(
      AbortSignal.timeout(45_000), transport => createTelegramBotApi(transport).sendMessage(token, chatId, text),
    ),
    sendAttachment: (token: string, chatId: string, file: { bytes: Uint8Array; filename: string; mime: string }) => egress.withTransport(
      AbortSignal.timeout(180_000), transport => createTelegramBotApi(transport).sendAttachment(token, chatId, file),
    ),
  }
}

export interface TelegramConnectRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  connect: ReturnType<typeof createTelegramConnector>
}

function tokenBody(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const token = (value as Record<string, unknown>).token
  return typeof token === 'string' && token.length > 0 && token.length <= 160 ? token : null
}

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof Error && error.name === 'TelegramConnectionError') {
    const status = (error as Error & { statusCode?: unknown }).statusCode
    if (typeof status === 'number') return reply.code(status).send({ detail: error.message })
  }
  throw error
}

export function registerTelegramConnectRoutes(app: FastifyInstance, options: TelegramConnectRouteOptions): void {
  app.post('/api/v1/me/telegram/connect', { preHandler: options.requireUser }, async (request, reply) => {
    const body = tokenBody(request.body)
    if (!body) return reply.code(422).send({ detail: 'Telegram Bot Token 参数无效' })
    try { return await options.connect.connect(options.ownerIdFromRequest(request), body) }
    catch (error) { return sendError(error, reply) }
  })
  app.put<{ Params: { bot_id: number } }>('/api/v1/me/telegram/connect/:bot_id', {
    preHandler: options.requireUser,
    schema: { params: { type: 'object', required: ['bot_id'], properties: { bot_id: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    const body = tokenBody(request.body)
    if (!body) return reply.code(422).send({ detail: 'Telegram Bot Token 参数无效' })
    try { return await options.connect.replace(options.ownerIdFromRequest(request), request.params.bot_id, body) }
    catch (error) { return sendError(error, reply) }
  })
}
