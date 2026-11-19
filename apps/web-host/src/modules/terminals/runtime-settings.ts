import { readConfigOverride } from '../../adapters/config-override-file.js'
import { normalizeMxcEgressProxyUrl } from './egress-proxy-url.js'

/** 读取服务端沙盒配置；配置错误时拒绝执行，不能静默启用网络或沙盒。 */
export function createTerminalRuntimeSettingsReader(path: string, environment: NodeJS.ProcessEnv, readiness: () => Promise<{ supported: boolean; reason?: string; proxyEnforcement?: boolean; proxyEnforcementReason?: string }>, defaultNetworkProfile: 'none' | 'egress' = 'egress') {
  return async () => {
    const override = readConfigOverride(path)
    const section = (value: unknown): Record<string, unknown> => {
      if (value == null) return {}
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('终端配置无效')
      return value as Record<string, unknown>
    }
    const sandbox = section(override.sandbox), agent = section(override.agent)
    const envSection = (value: string | undefined) => value === undefined ? {} : section(JSON.parse(value))
    const sandboxEnv = envSection(environment.SANDBOX), agentEnv = envSection(environment.AGENT)
    const bool = (value: unknown, fallback: boolean): boolean => {
      if (value === undefined) return fallback
      if (typeof value === 'boolean') return value
      if (typeof value === 'string' && /^(true|1|yes|on)$/i.test(value.trim())) return true
      if (typeof value === 'string' && /^(false|0|no|off)$/i.test(value.trim())) return false
      throw new Error('终端配置无效')
    }
    const rawProfile = String(sandbox.network_profile ?? environment.SANDBOX__NETWORK_PROFILE ?? sandboxEnv.network_profile ?? defaultNetworkProfile).trim().toLowerCase()
    let profile: 'none' | 'egress'
    if (rawProfile === 'none') profile = 'none'
    else if (rawProfile === 'egress') profile = 'egress'
    else throw new Error('沙盒网络配置无效')
    let egressProxyUrl: string | undefined, egressProxyError: string | undefined
    try {
      egressProxyUrl = normalizeMxcEgressProxyUrl(
        sandbox.egress_proxy_url ?? environment.SANDBOX__EGRESS_PROXY_URL ?? sandboxEnv.egress_proxy_url,
      )
    } catch (error) { egressProxyError = error instanceof Error ? error.message : '沙盒 egress 代理配置无效' }
    const terminalMode = String(sandbox.terminal_mode ?? environment.SANDBOX__TERMINAL_MODE ?? sandboxEnv.terminal_mode ?? 'auto').trim().toLowerCase() || 'auto'
    if (terminalMode !== 'auto' && terminalMode !== 'pty_disabled' && terminalMode !== 'entry_disabled')
      throw new Error('用户终端策略配置无效')
    const status = await readiness()
    const proxyReady = profile !== 'egress' || (Boolean(egressProxyUrl) && !egressProxyError && status.proxyEnforcement === true)
    const sandboxReady = status.supported && proxyReady
    return { shellEnabled: bool(agent.shell_enabled ?? environment.AGENT__SHELL_ENABLED ?? agentEnv.shell_enabled, true),
      shellSystemEnabled: bool(agent.shell_system_enabled ?? environment.AGENT__SHELL_SYSTEM_ENABLED ?? agentEnv.shell_system_enabled, false),
      shellDangerousEnabled: bool(agent.shell_dangerous_enabled ?? environment.AGENT__SHELL_DANGEROUS_ENABLED ?? agentEnv.shell_dangerous_enabled, true),
      sandboxEnabled: bool(sandbox.enabled ?? environment.SANDBOX__ENABLED ?? sandboxEnv.enabled, true), sandboxReady,
      ...(!proxyReady ? { sandboxReason: egressProxyError || status.proxyEnforcementReason || '沙盒代理专用出站未就绪或未配置' } : status.reason ? { sandboxReason: status.reason } : {}),
      filesystemAuthorizationEnabled: bool(sandbox.full_user_sandbox_authorization_enabled ?? environment.SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED ?? sandboxEnv.full_user_sandbox_authorization_enabled, true),
      terminalMode, networkProfile: profile, egressProxyUrl, egressProxyError }
  }
}

/** 页面、终端接口与执行前校验共享当前配置和隔离探测。 */
export function createTerminalAccessReader(readSettings: ReturnType<typeof createTerminalRuntimeSettingsReader>) {
  return async () => {
    const settings = await readSettings()
    return {
      terminalMode: settings.terminalMode,
      shellEnabled: settings.shellEnabled,
      shellSystemEnabled: settings.shellSystemEnabled,
      shellDangerousEnabled: settings.shellDangerousEnabled,
      fullUserSandboxAuthorizationEnabled: settings.filesystemAuthorizationEnabled,
      sandboxReady: settings.sandboxEnabled && settings.sandboxReady,
      ...(settings.sandboxReason ? { sandboxUnavailableReason: settings.sandboxReason } : {}),
    }
  }
}
