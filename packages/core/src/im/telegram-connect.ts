import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { JsonObject, ProviderTransport } from '../agent/providers/contracts.js'
import { byteSource, multipartBody } from '../agent/providers/media.js'
import { invalidateOwnerImSnapshots } from './user-bot-create.js'

const TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{20,128}$/
export const telegramDocumentLimit = 50_000_000
export const telegramPhotoLimit = 10_000_000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export class TelegramConnectionError extends Error {
  override name = 'TelegramConnectionError'
  constructor(readonly statusCode: number, message: string) { super(message) }
}

export interface TelegramBotIdentity {
  id: number
  username?: string
  first_name?: string
  last_name?: string
  webhookUrl?: string
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
  if (typeof value !== 'string') throw new TelegramConnectionError(400, 'Telegram Bot Token 格式无效')
  const token = value.trim()
  if (token.length > 160 || !TOKEN.test(token)) throw new TelegramConnectionError(400, 'Telegram Bot Token 格式无效')
  return token
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
      const encrypted = await options.encrypt(token)
      const id = await db.transaction().execute(async tx => {
        await lockUniqueKeys(tx, platformId, owner)
        const existing = (await sql<{ id: number }>`SELECT id FROM user_bots WHERE user_id=${owner} AND platform='telegram' LIMIT 1`.execute(tx)).rows[0]
        if (existing) throw new TelegramConnectionError(409, '每个咕咕账号只能接入一个 Telegram Bot；请使用替换凭据')
        const duplicate = (await sql<{ id: number }>`SELECT id FROM user_bots WHERE platform='telegram' AND app_id=${platformId} LIMIT 1`.execute(tx)).rows[0]
        if (duplicate) throw new TelegramConnectionError(409, '这个 Telegram Bot 已关联其他咕咕账号')
        return (await sql<{ id: number }>`INSERT INTO user_bots(user_id,platform,name,app_id,app_secret,enabled,group_chat_enabled,bot_platform_user_id,created_at)
          VALUES(${owner},'telegram',${name},${platformId},${encrypted},TRUE,FALSE,${platformId},CURRENT_TIMESTAMP) RETURNING id`.execute(tx)).rows[0]!.id
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

/** 官方 Bot API 只有 URL 路径 Token 认证；固定 origin、无重定向且不暴露底层异常。 */
export function createTelegramBotApi(transport: ProviderTransport) {
  async function call(tokenValue: string, method: 'getMe' | 'getWebhookInfo' | 'sendMessage' | 'sendPhoto' | 'sendDocument',
    body: JsonObject | AsyncIterable<Uint8Array> = {}, contentType = 'application/json', timeoutMs = 20_000,
    suppliedSignal?: AbortSignal) {
    const token = normalizeToken(tokenValue)
    const signal = suppliedSignal ?? AbortSignal.timeout(timeoutMs)
    let response: import('../agent/providers/contracts.js').ProviderHttpResponse | undefined
    try {
      response = await transport.request({
        url: `https://api.telegram.org/bot${token}/${method}`,
        method: 'POST', headers: { 'content-type': contentType }, body, timeoutMs,
      }, signal)
      let raw = '', size = 0
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > 1024 * 1024) throw new Error('Telegram API 响应超限')
        raw += decoder.decode(chunk, { stream: true })
      }
      raw += decoder.decode()
      const value: unknown = JSON.parse(raw)
      if (response.status >= 300 || !object(value) || value.ok !== true) throw Object.assign(new Error('Telegram API 请求失败'), {
        statusCode: response.status, errorCode: object(value) ? value.error_code : undefined,
      })
      if (!object(value.result)) throw new Error('Telegram API 响应无效')
      return value.result
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
      const errorCode = (error as { errorCode?: unknown } | null)?.errorCode
      throw Object.assign(new Error('Telegram API 请求失败'), {
        ...(typeof statusCode === 'number' ? { statusCode } : {}),
        ...(typeof errorCode === 'number' ? { errorCode } : {}),
      })
    } finally { await response?.cancel() }
  }
  return {
    async sendMessage(token: string, chatId: string, text: string): Promise<boolean> {
      if (!chatId || chatId.length > 256 || !text || text.length > 4096) return false
      const result = await call(token, 'sendMessage', { chat_id: chatId, text })
      return typeof result.message_id === 'number' && Number.isSafeInteger(result.message_id) && result.message_id > 0
    },
    async sendAttachment(token: string, chatId: string, file: { bytes: Uint8Array; filename: string; mime: string }): Promise<boolean> {
      if (!chatId || chatId.length > 256 || file.bytes.byteLength === 0 || file.bytes.byteLength > telegramDocumentLimit
        || !file.filename || file.filename.length > 180 || /[\r\n]/u.test(file.mime)) return false
      const photo = /\.(?:jpe?g|png)$/iu.test(file.filename) && file.bytes.byteLength <= telegramPhotoLimit
      const send = async (method: 'sendPhoto' | 'sendDocument', fieldName: 'photo' | 'document') => {
        const boundary = `guguTelegram${globalThis.crypto.randomUUID().replaceAll('-', '')}`
        const signal = AbortSignal.timeout(120_000)
        const body = multipartBody({ chat_id: chatId }, {
          name: file.filename, mime: file.mime || 'application/octet-stream', source: byteSource(file.bytes),
        }, boundary, signal, fieldName)
        const result = await call(token, method, body, `multipart/form-data; boundary=${boundary}`, 120_000, signal)
        return typeof result.message_id === 'number' && Number.isSafeInteger(result.message_id) && result.message_id > 0
      }
      if (!photo) return send('sendDocument', 'document')
      try { return await send('sendPhoto', 'photo') }
      catch (error) {
        if ((error as { errorCode?: unknown } | null)?.errorCode !== 400) throw error
        return send('sendDocument', 'document')
      }
    },
    async verify(token: string): Promise<TelegramBotIdentity> {
      const me = await call(token, 'getMe')
      const id = me.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return { id: 0 }
      const webhook = await call(token, 'getWebhookInfo')
      return {
        id,
        ...(typeof me.username === 'string' ? { username: me.username } : {}),
        ...(typeof me.first_name === 'string' ? { first_name: me.first_name } : {}),
        ...(typeof me.last_name === 'string' ? { last_name: me.last_name } : {}),
        webhookUrl: typeof webhook.url === 'string' ? webhook.url : '',
      }
    },
  }
}
