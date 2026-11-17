import { readConfigOverride } from '../../adapters/config-override-file.js'

/** 读取服务端沙盒配置；配置错误时拒绝执行，不能静默启用网络或沙盒。 */
export function createTerminalRuntimeSettingsReader(path: string, environment: NodeJS.ProcessEnv, readiness: () => Promise<{ supported: boolean; reason?: string }>) {
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
    const profile = String(sandbox.network_profile ?? environment.SANDBOX__NETWORK_PROFILE ?? sandboxEnv.network_profile ?? 'egress').trim().toLowerCase()
    if (profile !== 'none' && profile !== 'egress') throw new Error('沙盒网络配置无效')
    const status = await readiness()
    return { shellEnabled: bool(agent.shell_enabled ?? environment.AGENT__SHELL_ENABLED ?? agentEnv.shell_enabled, true),
      shellDangerousEnabled: bool(agent.shell_dangerous_enabled ?? environment.AGENT__SHELL_DANGEROUS_ENABLED ?? agentEnv.shell_dangerous_enabled, true),
      sandboxEnabled: bool(sandbox.enabled ?? environment.SANDBOX__ENABLED ?? sandboxEnv.enabled, true), sandboxReady: status.supported,
      ...(status.reason ? { sandboxReason: status.reason } : {}),
      filesystemAuthorizationEnabled: bool(sandbox.full_user_sandbox_authorization_enabled ?? environment.SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED ?? sandboxEnv.full_user_sandbox_authorization_enabled, true),
      networkProfile: profile }
  }
}
