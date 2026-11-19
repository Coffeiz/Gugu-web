import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import type { MxcDiagnostics } from '@gugu/sandbox/platform'



import { mutateConfigOverride,type ConfigOverrideLock } from '../../adapters/config/config-override-file.js'

import { createPosixConfigFileLock } from '../../adapters/config/posix-config-lock.js'




import { normalizeMxcEgressProxyUrl } from '../terminals/egress-proxy-url.js'



type ShellRuntimeDiagnostics = MxcDiagnostics & { executionBackend?: 'bubblewrap' }

type SandboxDisableSettings = {
  shellEnabled: boolean
  shellDangerousEnabled: boolean
  sandboxEnabled: boolean
  sandboxReady: boolean
  sandboxReason?: string
  networkProfile: 'none' | 'egress'
  egressProxyUrl?: string
  egressProxyError?: string
}

export interface SandboxDisableRouteOptions {
  requireAdmin: preHandlerHookHandler
  updateDisabled(): Promise<void>
  publishTerminalRefresh(): Promise<void>
  readSettings(): Promise<SandboxDisableSettings>
  readiness(): Promise<ShellRuntimeDiagnostics>
}

/** Shell 命令每秒复核 Shell 策略；先提交停用配置即可在 Host 所有实例撤销运行中授权。 */
export function registerSandboxDisableRoute(app: FastifyInstance, options: SandboxDisableRouteOptions): void {
  app.post('/api/v1/admin/sandbox/disable', { preHandler: options.requireAdmin }, async () => {
    await options.updateDisabled()
    await options.publishTerminalRefresh()
    const [settings, runtime] = await Promise.all([options.readSettings(), options.readiness()])
    return projectSandboxStatus(settings, runtime)
  })
}

type SandboxEnableSettings = {
  sandboxEnabled: boolean
  sandboxReady: boolean
  sandboxReason?: string
  networkProfile: 'none' | 'egress'
  egressProxyUrl?: string
  egressProxyError?: string
  shellEnabled: boolean
  shellDangerousEnabled: boolean
}

export interface SandboxEnableRouteOptions {
  requireAdmin: preHandlerHookHandler
  updateEnabled(enabled: boolean): Promise<void>
  publishTerminalRefresh(): Promise<void>
  readSettings(): Promise<SandboxEnableSettings>
  readiness(): Promise<ShellRuntimeDiagnostics>
}

/** 持锁原子更新 Shell 沙盒开关；启用前要求隔离与代理能力已就绪。 */
export function createSandboxRuntimeUpdater(path: string, lock: ConfigOverrideLock = createPosixConfigFileLock()) {
  if (!path.trim()) throw new TypeError('配置文件路径无效')
  return async (enabled: boolean): Promise<void> => {
    await mutateConfigOverride(path, document => {
      const value = document.sandbox
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value)))
        throw new Error('沙盒配置格式无效，已拒绝覆盖')
      document.sandbox = { ...(value as Record<string, unknown> | undefined), enabled }
      if (!enabled) {
        const agentValue = document.agent
        if (agentValue !== undefined && (agentValue === null || typeof agentValue !== 'object' || Array.isArray(agentValue)))
          throw new Error('Agent 配置格式无效，已拒绝覆盖')
        document.agent = { ...(agentValue as Record<string, unknown> | undefined), shell_enabled: false, shell_system_enabled: false, shell_dangerous_enabled: false }
      }
    }, lock)
  }
}

export function registerSandboxEnableRoute(app: FastifyInstance, options: SandboxEnableRouteOptions): void {
  app.post('/api/v1/admin/sandbox/enable', { preHandler: options.requireAdmin }, async (request, reply) => {
    const [settings, runtime] = await Promise.all([options.readSettings(), options.readiness()])
    if (!runtime.supported || !settings.sandboxReady) {
      return reply.code(409).send({ detail: settings.sandboxReason ?? runtime.reason ?? 'Shell 隔离执行环境尚未就绪' })
    }
    await options.updateEnabled(true)
    await options.publishTerminalRefresh()
    const updated = await options.readSettings()
    return projectSandboxStatus(updated, runtime)
  })
}

type SandboxNetworkSettings = {
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

function status(settings: SandboxNetworkSettings, readiness: MxcReadiness) {
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
  readSettings(): Promise<SandboxNetworkSettings>
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

type SandboxStatusSettings = {
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
  readSettings(): Promise<SandboxStatusSettings>
  readiness(): Promise<ShellRuntimeDiagnostics>
}

export function projectSandboxStatus(settings: SandboxStatusSettings, runtime: ShellRuntimeDiagnostics) {
  const direct = runtime.executionBackend === 'bubblewrap'
  const egressProxyConfigured = Boolean(settings.egressProxyUrl)
  const egressNetworkReady = !direct && runtime.proxyEnforcement === true
  const egressConfigError = settings.egressProxyError
    ?? (settings.networkProfile === 'egress' && direct ? '当前 Bubblewrap 后端仅支持断网执行，请将网络策略切换为断网'
      : settings.networkProfile === 'egress' && !egressProxyConfigured ? '尚未配置本机回环 HTTP(S) 代理'
      : settings.networkProfile === 'egress' && !egressNetworkReady
        ? runtime.proxyEnforcementReason ?? runtime.reason ?? 'MXC 代理专用出站未就绪'
        : null)
  const egressAvailable = !direct && (settings.networkProfile !== 'egress' || (egressProxyConfigured && egressNetworkReady && !egressConfigError))
  const state = !runtime.supported ? 'runtime_unavailable'
    : settings.networkProfile === 'egress' && !egressAvailable ? 'egress_unready'
      : !settings.sandboxEnabled ? 'disabled' : 'ready'
  const message = state === 'runtime_unavailable' ? runtime.reason ?? (direct ? 'Bubblewrap 执行环境不可用' : 'MXC 执行环境不可用')
    : state === 'egress_unready' ? egressConfigError ?? 'MXC 代理专用出站未就绪'
      : state === 'disabled' ? 'Shell 沙盒已关闭'
        : direct ? 'Bubblewrap 执行环境已就绪' : 'MXC Bubblewrap 执行环境已就绪'
  return {
    enabled: settings.sandboxEnabled,
    sandbox_ready: settings.sandboxReady,
    shell_enabled: settings.shellEnabled,
    shell_dangerous_enabled: settings.shellDangerousEnabled,
    runtime_supported: runtime.supported,
    runtime_methods: [...runtime.methods],
    ...(direct ? { execution_backend: runtime.executionBackend } : {}),
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

/** Admin 页面展示 Host 实际使用的执行后端和 Shell 策略。 */
export function registerSandboxStatusRoute(app: FastifyInstance, options: SandboxStatusRouteOptions): void {
  app.get('/api/v1/admin/sandbox/status', { preHandler: options.requireAdmin }, async () => {
    const [settings, runtime] = await Promise.all([options.readSettings(), options.readiness()])
    return projectSandboxStatus(settings, runtime)
  })
}
