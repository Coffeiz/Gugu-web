import { CoreError, isThemePalette } from '@gugu/core'
import { parseSmtpSettings, type SmtpSettings } from '@gugu/core/smtp'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export type UserSmtpSettings = SmtpSettings

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

function smtpTestBody(value: unknown): Omit<UserSmtpTestInput, 'toAddr'> & { toAddr?: string } {
  const body = record(value)
  const settings = parseSmtpSettings(body).settings
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
  if (!isThemePalette(palette))
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
    const { settings, password } = parseSmtpSettings(request.body)
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
