import { readConfigOverride } from '../../adapters/config/config-override-file.js'
import { normalizeMxcEgressProxyUrl } from './sandbox/proxy.js'
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runBubblewrapCommand } from '@gugu/sandbox/linux/command'
import { createBubblewrapPtyBridge } from '@gugu/sandbox/linux/pty'

const bool = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && /^(true|1|yes|on)$/i.test(value.trim())) return true
  if (typeof value === 'string' && /^(false|0|no|off)$/i.test(value.trim())) return false
  throw new Error('终端配置无效')
}

export function readSystemShellEnabled(agent: Record<string, unknown>, environment: NodeJS.ProcessEnv): boolean {
  const configured = agent.shell_system_enabled ?? environment.AGENT__SHELL_SYSTEM_ENABLED
  if (configured !== undefined && configured !== null) return bool(configured, false)
  if (environment.AGENT === undefined) return false
  const raw: unknown = JSON.parse(environment.AGENT)
  if (raw === null) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('终端配置无效')
  return bool((raw as Record<string, unknown>).shell_system_enabled, false)
}

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
      shellSystemEnabled: readSystemShellEnabled(agent, environment),
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

const marker = 'gugu-bubblewrap-rootfs-v1'

export function resolveBubblewrapRootfs(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.GUGU_BUBBLEWRAP_ROOTFS
  return configured === undefined
    ? (process.platform === 'linux' ? '/var/lib/gugu-sandbox/rootfs' : undefined)
    : configured.trim() || undefined
}

async function trustedRootfs(root: string) {
  if (!root.startsWith('/') || root === '/' || resolve(root) !== root) return false
  for (let entry = root; entry !== '/'; entry = dirname(entry)) {
    const info = await lstat(entry)
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) return false
  }
  const [release, hostname, resolver, hosts, machineId] = await Promise.all(
    ['gugu-sandbox-release', 'hostname', 'resolv.conf', 'hosts', 'machine-id']
      .map(file => readFile(join(root, 'etc', file), 'utf8')),
  )
  return release?.trim() === marker && hostname === 'gugu-sandbox\n'
    && resolver === '# Gugu sandbox has no DNS\n' && hosts === '127.0.0.1 localhost\n::1 localhost\n' && machineId === ''
}

async function probeRootfs(rootfs: string) {
  if (!await trustedRootfs(rootfs)) return false
  const scratch = await mkdtemp(join(tmpdir(), 'gugu-bwrap-check-'))
  try {
    const directory = await open(scratch, 'r')
    try {
      const mounts = [{ source: scratch, descriptor: directory.fd, target: '/workspace', readonly: false }]
      const result = await runBubblewrapCommand({ rootfs, mounts, cwd: '/workspace',
        command: 'test "$PWD" = /workspace && test -f /etc/gugu-sandbox-release && test ! -e /proc/self/fd/3 && echo ready',
      }, { timeoutMs: 3000, outputBytes: 1024, resourceScope: true })
      if (!result.ok || result.stdout.trim() !== 'ready') return false
      const pty = await createBubblewrapPtyBridge(rootfs).open({
        terminalId: randomUUID(), sandboxCwd: '/workspace', sandboxMounts: mounts,
        cols: 80, rows: 24, networkProfile: 'none', timeoutMs: 3000,
      })
      try {
        // 两段在命令回显中分离，只有实际执行后的输出才含完整标记。
        const token = randomUUID()
        await pty.write(Buffer.from(`printf '%s%s\\n' '${token.slice(0, 18)}' '${token.slice(18)}'\n`))
        let output = ''
        for await (const chunk of pty.output()) {
          output = (output + Buffer.from(chunk).toString('utf8')).slice(-4096)
          if (output.includes(token)) return true
        }
        return false
      } finally { await pty.close() }
    } finally { await directory.close() }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

export async function isolatedShellReadiness(rootfs?: string) {
  const supported = Boolean(rootfs && process.platform === 'linux' && process.getuid?.() !== 0
    && await probeRootfs(rootfs).catch(() => false))
  return { executionBackend: 'bubblewrap' as const, supported, checkAvailable: Boolean(rootfs), methods: supported ? ['bubblewrap'] : [],
    proxyEnforcement: false, proxyEnforcementReason: '当前 Bubblewrap 后端仅支持断网执行',
    ...(supported ? {} : { reason: '独立文件系统沙盒未就绪，请检查运行环境、Bubblewrap、AppArmor 和 systemd 用户服务' }),
  }
}

/** 合并并发检查，运行配置变化仍由调用方实时复核。 */
export function createIsolatedShellReadiness(rootfs?: string) {
  let pending: ReturnType<typeof isolatedShellReadiness> | undefined
  let checkedAt = 0
  return () => {
    if (!pending || (checkedAt !== 0 && Date.now() - checkedAt >= 30_000)) {
      checkedAt = 0
      pending = isolatedShellReadiness(rootfs).finally(() => { checkedAt = Date.now() })
    }
    return pending
  }
}
