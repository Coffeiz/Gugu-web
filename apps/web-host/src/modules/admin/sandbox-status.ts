import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { MxcDiagnostics } from '@gugu/sandbox/platform'

type RuntimeSettings = {
  shellEnabled: boolean
  shellDangerousEnabled: boolean
  sandboxEnabled: boolean
  sandboxReady: boolean
  sandboxReason?: string
  networkProfile: 'none' | 'egress'
  egressProxyUrl?: string
  egressProxyError?: string
}

export interface SandboxStatusRouteOptions {
  requireAdmin: preHandlerHookHandler
  readSettings(): Promise<RuntimeSettings>
  readiness(): Promise<MxcDiagnostics>
}

export function projectSandboxStatus(settings: RuntimeSettings, runtime: MxcDiagnostics) {
  const egressProxyConfigured = Boolean(settings.egressProxyUrl)
  const egressNetworkReady = runtime.proxyEnforcement === true
  const egressConfigError = settings.egressProxyError
    ?? (settings.networkProfile === 'egress' && !egressProxyConfigured ? '尚未配置本机回环 HTTP(S) 代理'
      : settings.networkProfile === 'egress' && !egressNetworkReady
        ? runtime.proxyEnforcementReason ?? runtime.reason ?? 'MXC 代理专用出站未就绪'
        : null)
  const egressAvailable = settings.networkProfile !== 'egress' || (egressProxyConfigured && egressNetworkReady && !egressConfigError)
  const state = !runtime.supported ? 'runtime_unavailable'
    : settings.networkProfile === 'egress' && !egressAvailable ? 'egress_unready'
      : !settings.sandboxEnabled ? 'disabled' : 'ready'
  const message = state === 'runtime_unavailable' ? runtime.reason ?? 'MXC 执行环境不可用'
    : state === 'egress_unready' ? egressConfigError ?? 'MXC 代理专用出站未就绪'
      : state === 'disabled' ? 'Shell 沙盒已关闭'
        : 'MXC Bubblewrap 执行环境已就绪'
  return {
    enabled: settings.sandboxEnabled,
    sandbox_ready: settings.sandboxReady,
    shell_enabled: settings.shellEnabled,
    shell_dangerous_enabled: settings.shellDangerousEnabled,
    runtime_supported: runtime.supported,
    runtime_methods: [...runtime.methods],
    readiness_checked: runtime.checkAvailable,
    state,
    message,
    network_profile: settings.networkProfile,
    egress_proxy_configured: egressProxyConfigured,
    egress_proxy_url: settings.egressProxyUrl ?? '',
    egress_network_ready: egressNetworkReady,
    egress_config_error: egressConfigError,
    egress_available: egressAvailable,
    egress_enabled: settings.networkProfile === 'egress' && egressAvailable,
  }
}

/** Admin 页面只展示 Host 实际使用的 MXC 与 Shell 策略，不探测 Docker。 */
export function registerSandboxStatusRoute(app: FastifyInstance, options: SandboxStatusRouteOptions): void {
  app.get('/api/v1/admin/sandbox/status', { preHandler: options.requireAdmin }, async () => {
    const [settings, runtime] = await Promise.all([options.readSettings(), options.readiness()])
    return projectSandboxStatus(settings, runtime)
  })
}
