import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { parsePythonInteger } from '../../http/request.js'
import { SecretInteractionError } from './persistence/agent-secret-interaction-postgres.js'

export interface AgentSecretInteractionService {
  consume(ownerId: string, promptId: number, values: Record<string, string> | null): Promise<{ ok: boolean; prompt_id: number; status?: string }>
}

/** 事务提交后唤醒失效与恢复消费者；权威任务必须已在事务内持久化。 */
export function createAgentSecretInteractionService(options: {
  consume: AgentSecretInteractionService['consume']
  wake(): Promise<void>
  diagnose(): void
}): AgentSecretInteractionService {
  if (typeof options.consume !== 'function' || typeof options.wake !== 'function' || typeof options.diagnose !== 'function') throw new TypeError('凭据交互服务未完整配置')
  return { async consume(owner, prompt, values) {
    const result = await options.consume(owner, prompt, values)
    try { await options.wake() } catch { try { options.diagnose() } catch { /* 已提交事务不受诊断失败影响。 */ } }
    return result
  } }
}

const bodySchema = z.object({ values: z.record(z.string(), z.string()).default({}) })
const safeDetails = new Set(['敏感信息输入不存在', '凭据输入不存在', '当前交互不支持凭据取消', '当前敏感信息交互没有可用的业务处理器', '凭据输入已结束', '敏感信息输入已过期', '敏感字段不匹配', '敏感字段不能为空或过长', '敏感信息目标已失效', 'MCP server 不存在', '凭据槽位不匹配', 'HTTP Header 凭据只能使用 ASCII 字符；请检查密钥值和前缀', 'HTTP Header 凭据不能包含换行或控制字符'])

export function registerAgentSecretInteractionRoutes(app: FastifyInstance, options: {
  requireUser: preHandlerHookHandler
  userIdFromRequest(request: FastifyRequest): string
  service: AgentSecretInteractionService
}): void {
  async function handle(request: FastifyRequest<{ Params: { prompt_id: string } }>, reply: import('fastify').FastifyReply, cancel: boolean) {
    const id = parsePythonInteger(request.params.prompt_id)
    const body = cancel ? null : bodySchema.safeParse(request.body)
    if (id == null || body && !body.success) return reply.code(422).send({ detail: '凭据交互请求无效' })
    try { return await options.service.consume(options.userIdFromRequest(request), id, body?.success ? body.data.values : null) }
    catch (error) {
      if (error instanceof SecretInteractionError && safeDetails.has(error.message)) return reply.code(error.status).send({ detail: error.message })
      return reply.code(500).send({ detail: '凭据交互处理失败' })
    }
  }
  app.post<{ Params: { prompt_id: string } }>('/api/v1/agent/interactions/:prompt_id/secrets', { preHandler: options.requireUser }, (request, reply) => handle(request, reply, false))
  app.post<{ Params: { prompt_id: string } }>('/api/v1/agent/interactions/:prompt_id/secrets/cancel', { preHandler: options.requireUser }, (request, reply) => handle(request, reply, true))
}
