import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { defaultUserBotGroupSettings } from '@gugu/core/im/user-bots'
import { invalidateOwnerImSnapshots } from '@gugu/core/im/user-bot-create'
import { createTelegramBotApi, createTelegramDeliveryApi, validateTelegramBotToken, verifyTelegramBotIdentity, type TelegramBotIdentity } from '@gugu/gateway/telegram'
import { createPublicAgentEgress } from '../../../../../adapters/network/safe-egress-proxy.js'
import type { SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'

/** 每次校验都热读管理员代理；启用代理失败时 createPublicAgentEgress 不会回退直连。 */
export function createTelegramConnectHostOptions(readSettings: () => SafeEgressReadSettings, secretKey: string) {
  const egress = createPublicAgentEgress(readSettings, secretKey)
  return {
    verify: (token: string) => {
      const signal = AbortSignal.timeout(45_000)
      return egress.withTransport(signal, transport => {
        const api = createTelegramBotApi({ transport })
        return verifyTelegramBotIdentity(method => api.call(token, method, { signal }))
      })
    },
    sendMessage: (token: string, chatId: string, text: string, plainText = false) => egress.withTransport(
      AbortSignal.timeout(45_000), transport => createTelegramDeliveryApi(transport).sendMessage(token, chatId, text, plainText),
    ),
    sendAttachment: (token: string, chatId: string, file: { bytes: Uint8Array; filename: string; mime: string }) => egress.withTransport(
      AbortSignal.timeout(180_000), transport => createTelegramDeliveryApi(transport).sendAttachment(token, chatId, file),
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

export class TelegramConnectionError extends Error {
  override name = 'TelegramConnectionError'
  constructor(readonly statusCode: number, message: string) { super(message) }
}

export interface TelegramConnectOptions {
  verify(token: string): Promise<TelegramBotIdentity>
  encrypt(value: string): string | Promise<string>
  platforms(): readonly string[] | Promise<readonly string[]>
  publishChanged(ownerId: string): Promise<unknown>
  /** SQLite 不支持 SELECT FOR UPDATE；Web Host 生产组合必须使用 PostgreSQL。 */
  dialect?: 'postgres' | 'sqlite'
}

function normalizeToken(value: unknown): string {
  if (typeof value === 'string') {
    try { return validateTelegramBotToken(value) } catch { /* 使用统一连接错误。 */ }
  }
  throw new TelegramConnectionError(400, 'Telegram Bot Token 格式无效')
}

function botName(info: TelegramBotIdentity): string {
  const username = typeof info.username === 'string' ? info.username.trim() : ''
  if (username) return `@${username}`
  const fullName = [info.first_name, info.last_name].filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean).join(' ')
  return fullName || '我的 Telegram 机器人'
}

function publicBot(id: number, name: string, appId: string) {
  return { id, platform: 'telegram' as const, name, app_id: appId, enabled: true }
}

/** Telegram 凭据接入用例。验证和密文写入分离，只有成功提交后才发布渠道刷新。 */
export function createTelegramConnector<DB>(db: Kysely<DB>, options: TelegramConnectOptions) {
  async function ready() {
    if (!(await options.platforms()).includes('telegram')) throw new TelegramConnectionError(503, '该即时通讯平台暂未开放')
  }
  async function verified(value: unknown): Promise<{ token: string; info: TelegramBotIdentity }> {
    const token = normalizeToken(value)
    try {
      const info = await options.verify(token)
      if (!info || !Number.isSafeInteger(info.id) || info.id <= 0) throw new TelegramConnectionError(502, 'Telegram 未返回有效的 Bot 身份')
      if (typeof info.webhookUrl === 'string' && info.webhookUrl.trim()) throw new TelegramConnectionError(409, '该 Bot 已配置 Webhook；请先在 Telegram 侧移除 Webhook 后再接入')
      return { token, info }
    } catch (error) {
      if (error instanceof TelegramConnectionError) throw error
      const errorCode = (error as { errorCode?: unknown } | null)?.errorCode
      if (errorCode === 401 || errorCode === 404) throw new TelegramConnectionError(400, 'Telegram Bot Token 无效')
      throw new TelegramConnectionError(502, '暂时无法验证 Telegram Bot，请稍后重试')
    }
  }
  async function lockUniqueKeys(tx: Kysely<DB>, ...keys: string[]) {
    if (options.dialect === 'sqlite') return
    for (const key of [...new Set(keys)].sort()) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`telegram-userbot:${key}`}))`.execute(tx)
    }
  }
  async function notify(owner: string) {
    try { await invalidateOwnerImSnapshots(db, owner) } catch { /* 已提交的凭据不能因上下文失效失败而回滚。 */ }
    try { await options.publishChanged(owner) } catch { /* live 不可用时保留凭据，由现有消费者后续读取。 */ }
  }

  return {
    async connect(ownerId: string, rawToken: unknown) {
      const owner = dataContext(ownerId).ownerId
      await ready()
      const { token, info } = await verified(rawToken)
      const platformId = String(info.id)
      const name = botName(info)
      const group = defaultUserBotGroupSettings('telegram')
      const encrypted = await options.encrypt(token)
      const id = await db.transaction().execute(async tx => {
        await lockUniqueKeys(tx, platformId, owner)
        const existing = (await sql<{ id: number }>`SELECT id FROM user_bots WHERE user_id=${owner} AND platform='telegram' LIMIT 1`.execute(tx)).rows[0]
        if (existing) throw new TelegramConnectionError(409, '每个咕咕账号只能接入一个 Telegram Bot；请使用替换凭据')
        const duplicate = (await sql<{ id: number }>`SELECT id FROM user_bots WHERE platform='telegram' AND app_id=${platformId} LIMIT 1`.execute(tx)).rows[0]
        if (duplicate) throw new TelegramConnectionError(409, '这个 Telegram Bot 已关联其他咕咕账号')
        return (await sql<{ id: number }>`INSERT INTO user_bots(user_id,platform,name,app_id,app_secret,enabled,group_chat_enabled,group_attention_mode,group_allowed_tools,group_memory_enabled,member_memory_enabled,group_owner_memory_enabled,bot_platform_user_id,created_at)
          VALUES(${owner},'telegram',${name},${platformId},${encrypted},TRUE,${group.groupChatEnabled},${group.groupAttentionMode},${JSON.stringify(group.groupAllowedTools)}::json,${group.groupMemoryEnabled},${group.memberMemoryEnabled},${group.groupOwnerMemoryEnabled},${platformId},CURRENT_TIMESTAMP) RETURNING id`.execute(tx)).rows[0]!.id
      })
      await notify(owner)
      return publicBot(id, name, platformId)
    },
    async replace(ownerId: string, botId: number, rawToken: unknown) {
      const owner = dataContext(ownerId).ownerId
      await ready()
      const owned = (await sql<{ id: number }>`SELECT id FROM user_bots WHERE id=${botId} AND user_id=${owner} AND platform='telegram'`.execute(db)).rows[0]
      if (!owned) throw new TelegramConnectionError(404, 'Telegram 机器人不存在')
      const { token, info } = await verified(rawToken)
      const platformId = String(info.id)
      const name = botName(info)
      const encrypted = await options.encrypt(token)
      await db.transaction().execute(async tx => {
        await lockUniqueKeys(tx, platformId)
        if (options.dialect !== 'sqlite') await sql`SELECT id FROM user_bots WHERE id=${botId} AND user_id=${owner} AND platform='telegram' FOR UPDATE`.execute(tx)
        const current = (await sql<{ id: number; app_id: string }>`SELECT id,app_id FROM user_bots WHERE id=${botId} AND user_id=${owner} AND platform='telegram'`.execute(tx)).rows[0]
        if (!current) throw new TelegramConnectionError(404, 'Telegram 机器人不存在')
        const duplicate = (await sql<{ id: number }>`SELECT id FROM user_bots WHERE platform='telegram' AND app_id=${platformId} AND id<>${botId} LIMIT 1`.execute(tx)).rows[0]
        if (duplicate) throw new TelegramConnectionError(409, '这个 Telegram Bot 已关联其他咕咕账号')
        if (current.app_id !== platformId) {
          await sql`UPDATE user_bots SET app_id=${platformId},bot_platform_user_id=${platformId},name=${name},app_secret=${encrypted},enabled=TRUE,owner_platform_user_id=NULL,owner_bound_at=NULL WHERE id=${botId} AND user_id=${owner} AND platform='telegram'`.execute(tx)
        } else {
          await sql`UPDATE user_bots SET app_id=${platformId},bot_platform_user_id=${platformId},name=${name},app_secret=${encrypted},enabled=TRUE WHERE id=${botId} AND user_id=${owner} AND platform='telegram'`.execute(tx)
        }
      })
      await notify(owner)
      return publicBot(botId, name, platformId)
    },
  }
}
