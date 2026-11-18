import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { mutateConfigOverride, type ConfigOverrideLock } from '../../adapters/config-override-file.js'
import { createPosixConfigFileLock } from '../../adapters/posix-config-lock.js'
import { normalizeMxcEgressProxyUrl } from '../terminals/egress-proxy-url.js'

type RuntimeSettings = {
  networkProfile: 'none' | 'egress'
  egressProxyUrl?: string
  egressProxyError?: string
}
type MxcReadiness = { supported: boolean; reason?: string; proxyEnforcement?: boolean; proxyEnforcementReason?: string }

/** The update is atomic and preserves every unrelated user override section. */
export function createSandboxEgressConfigUpdater(path: string, lock: ConfigOverrideLock = createPosixConfigFileLock()) {
  if (!path.trim()) throw new TypeError('配置文件路径无效')
  return async (proxyUrl: string): Promise<void> => {
    await mutateConfigOverride(path, document => {
      const value = document.sandbox
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value)))
        throw new Error('沙盒配置格式无效，已拒绝覆盖')
      const sandbox: Record<string, unknown> = { ...(value as Record<string, unknown> | undefined), egress_proxy_url: proxyUrl }
      if (!proxyUrl && sandbox.network_profile === 'egress') sandbox.network_profile = 'none'
      document.sandbox = sandbox
    }, lock)
  }
}

function parseProxy(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(key => key !== 'proxy_url') || typeof body.proxy_url !== 'string' || body.proxy_url.length > 2048) return null
  const raw = body.proxy_url.trim()
  if (!raw) return ''
  try { return normalizeMxcEgressProxyUrl(raw) ?? '' } catch { return null }
}

function status(settings: RuntimeSettings, readiness: MxcReadiness) {
  const configured = Boolean(settings.egressProxyUrl)
  const error = settings.egressProxyError
    ?? (!configured ? '尚未配置本机回环 HTTP(S) 代理'
      : !readiness.supported ? readiness.reason || 'MXC 执行平台不可用'
        : readiness.proxyEnforcement !== true ? readiness.proxyEnforcementReason || 'MXC 代理专用出站未就绪' : undefined)
  return {
    network_profile: settings.networkProfile,
    egress_proxy_configured: configured,
    egress_proxy_url: settings.egressProxyUrl ?? '',
    egress_network_ready: readiness.proxyEnforcement === true,
    egress_config_error: error ?? null,
    egress_available: !error,
    egress_enabled: settings.networkProfile === 'egress' && !error,
  }
}

export interface SandboxEgressRouteOptions {
  requireAdmin: preHandlerHookHandler
  updateProxy(proxyUrl: string): Promise<void>
  readSettings(): Promise<RuntimeSettings>
  readiness(): Promise<MxcReadiness>
}

/** 管理员只保存代理地址并检查本地 MXC 能力，不发起外网探测。 */
export function registerSandboxEgressRoutes(app: FastifyInstance, options: SandboxEgressRouteOptions): void {
  app.post('/api/v1/admin/sandbox/egress/config', { preHandler: options.requireAdmin }, async (request, reply) => {
    const proxyUrl = parseProxy(request.body)
    if (proxyUrl === null) return reply.code(422).send({ detail: '代理地址必须是无凭据的本机回环 HTTP(S) 地址，且不能包含路径、查询参数或片段' })
    await options.updateProxy(proxyUrl)
    const [settings, readiness] = await Promise.all([options.readSettings(), options.readiness()])
    return status(settings, readiness)
  })

  app.post('/api/v1/admin/sandbox/egress/validate', { preHandler: options.requireAdmin }, async (_request, reply) => {
    const [settings, readiness] = await Promise.all([options.readSettings(), options.readiness()])
    const current = status(settings, readiness)
    if (!current.egress_available) return reply.code(409).send({ detail: current.egress_config_error })
    return {
      ok: true,
      message: '配置有效；MXC 将保持默认拒绝出站并只使用已配置的本机代理。实际代理连通性在命令执行时验证。',
      network_name: 'mxc-bubblewrap',
      proxy_configured: true,
    }
  })
}
