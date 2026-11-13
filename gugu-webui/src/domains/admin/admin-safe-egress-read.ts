import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export interface SafeEgressReadSettings {
  enabled: boolean
  proxy_url: string
  proxy_auth_secret: string
}

export interface AdminSafeEgressReadOptions {
  requireAdmin: preHandlerHookHandler
  /** 由Host读取并校验运行配置；路由仅投影必要字段，不返回凭据密文。 */
  readSettings: () => SafeEgressReadSettings
}

function ensureProxyUrlIsSafeToReturn(value: string): void {
  const raw = value.trim()
  if (!raw) return
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('安全出站代理配置无效')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username !== ''
    || parsed.password !== ''
    || !['', '/'].includes(parsed.pathname)
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.port === '0'
  ) throw new Error('安全出站代理配置无效')
}

export function registerAdminSafeEgressReadRoute(app: FastifyInstance, options: AdminSafeEgressReadOptions): void {
  app.get('/api/v1/admin/safe-egress', { preHandler: options.requireAdmin }, async () => {
    const settings = options.readSettings()
    ensureProxyUrlIsSafeToReturn(settings.proxy_url)
    return {
      enabled: settings.enabled,
      proxy_url: settings.proxy_url,
      has_auth: Boolean(settings.proxy_auth_secret),
    }
  })
}
