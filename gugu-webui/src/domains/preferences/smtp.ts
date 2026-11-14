import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export interface UserSmtpSettings {
  host: string
  port: number
  user: string
  fromAddr: string
  useSsl: boolean
  enabled: boolean
}

export interface UserSmtpSettingsStore {
  read(ownerId: string): Promise<UserSmtpSettings | null>
  write(ownerId: string, settings: UserSmtpSettings, password: string | null): Promise<void>
  readPassword(ownerId: string): Promise<string>
}

export interface UserSmtpTestInput extends UserSmtpSettings {
  password: string
  toAddr: string
  template: 'notification' | 'reminder' | 'report' | 'security' | 'test'
  theme: 'light' | 'dark'
  palette: 'cafe' | 'neutral' | 'red' | 'blue' | 'green'
}

export interface UserSmtpSettingsRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  userEmailFromRequest(request: FastifyRequest): string
  store: UserSmtpSettingsStore
  sendTestEmail(input: UserSmtpTestInput): Promise<void>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CoreError('invalid_request', '请求体无效')
  return value as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, camel: string, snake: string, fallback: string, max: number): string {
  const value = body[camel] === undefined ? body[snake] : body[camel]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max)
    throw new CoreError('invalid_request', `${camel} 无效`)
  return value
}

function booleanField(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
  }
  throw new CoreError('invalid_request', `${field} 无效`)
}

function settingsBody(value: unknown): { settings: UserSmtpSettings; password: string | null } {
  const body = record(value)
  const host = stringField(body, 'host', 'host', '', 255)
  if (!host) throw new CoreError('invalid_request', 'host 无效')
  const portValue = body.port === undefined ? 587 : body.port
  const rawPort = typeof portValue === 'string' && /^\d+$/.test(portValue.trim()) ? Number(portValue.trim()) : portValue
  if (typeof rawPort !== 'number' || !Number.isSafeInteger(rawPort) || rawPort < 1 || rawPort > 65535)
    throw new CoreError('invalid_request', 'port 无效')
  let password: string | null = null
  if (body.password !== undefined && body.password !== null) {
    if (typeof body.password !== 'string' || body.password.length > 1000)
      throw new CoreError('invalid_request', 'password 无效')
    password = body.password
  }
  return {
    settings: {
      host,
      port: rawPort,
      user: stringField(body, 'user', 'user', '', 300),
      fromAddr: stringField(body, 'fromAddr', 'from_addr', '', 300),
      useSsl: booleanField(body.useSsl === undefined ? body.use_ssl : body.useSsl, 'useSsl', false),
      enabled: booleanField(body.enabled, 'enabled', true),
    },
    password,
  }
}

function smtpTestBody(value: unknown): Omit<UserSmtpTestInput, 'toAddr'> & { toAddr?: string } {
  const body = record(value)
  const settings = settingsBody(body).settings
  const password = body.password === undefined ? '' : body.password
  if (typeof password !== 'string' || password.length > 1000)
    throw new CoreError('invalid_request', 'password 无效')
  const toAddr = stringField(body, 'toAddr', 'to_addr', '', 300)
  const template = stringField(body, 'template', 'template', 'test', 32)
  const theme = stringField(body, 'theme', 'theme', 'light', 16)
  const palette = stringField(body, 'palette', 'palette', 'neutral', 16)
  if (!['notification', 'reminder', 'report', 'security', 'test'].includes(template))
    throw new CoreError('invalid_request', 'template 无效')
  if (!['light', 'dark'].includes(theme)) throw new CoreError('invalid_request', 'theme 无效')
  if (!['cafe', 'neutral', 'red', 'blue', 'green'].includes(palette))
    throw new CoreError('invalid_request', 'palette 无效')
  return { ...settings, password, ...(toAddr ? { toAddr } : {}), template, theme, palette } as Omit<UserSmtpTestInput, 'toAddr'> & { toAddr?: string }
}

function response(settings: UserSmtpSettings | null) {
  if (!settings) return null
  return { ...settings, configured: true }
}

export function registerUserSmtpSettingsRoutes(app: FastifyInstance, options: UserSmtpSettingsRouteOptions): void {
  app.get('/api/v1/preferences/smtp', { preHandler: options.requireUser }, async (request) =>
    response(await options.store.read(options.ownerIdFromRequest(request))))

  app.put('/api/v1/preferences/smtp', { preHandler: options.requireUser }, async (request) => {
    const { settings, password } = settingsBody(request.body)
    await options.store.write(options.ownerIdFromRequest(request), settings, password)
    return response(settings)
  })

  app.post('/api/v1/preferences/smtp/test', { preHandler: options.requireUser }, async (request) => {
    const body = smtpTestBody(request.body)
    const ownerId = options.ownerIdFromRequest(request)
    const password = body.password || await options.store.readPassword(ownerId)
    try {
      await options.sendTestEmail({
        ...body,
        password,
        toAddr: body.toAddr || options.userEmailFromRequest(request),
      })
      return { ok: true, message: '测试邮件已发送' }
    } catch {
      return { ok: false, message: 'SMTP 测试失败，请检查服务器、账号或密码' }
    }
  })
}
