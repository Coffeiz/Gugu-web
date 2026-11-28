import type { AssertScheduledTaskLease } from '@gugu/scheduler'
import type { ToolResult } from '../../models.js'
import { evaluateSandboxShell, type ShellPolicyFacts } from '../../security/shell-policy.js'
import { createAgentShellTool, type AgentShellInput } from '../../tools/shell/index.js'

export interface ScheduledShellAuthorization {
  /** 绑定当前任务和实际沙盒挂载的版本，撤权或挂载变化后必须变化。 */
  revision: string
  workspaceId: number | null
  filesystemGrantId: number | null
  facts?: ShellPolicyFacts
  systemEnabled?: boolean
}

export interface ScheduledShellBinding {
  readonly supportsSandboxWrites?: boolean
  readonly supportsSystem?: boolean
  readonly systemOnly?: boolean
  read(signal?: AbortSignal): Promise<ScheduledShellAuthorization | null>
  execute(input: AgentShellInput, options: {
    revision: string
    writable: boolean
    signal: AbortSignal
    assertAuthorized(): Promise<void>
  }): Promise<ToolResult>
}

function rejected(error: string): ToolResult {
  return { kind: 'completed', successful: false, executed: false, mutated: false, value: { error } }
}

export function createScheduledShell(binding: ScheduledShellBinding, assertLease: AssertScheduledTaskLease, isCurrent: () => Promise<boolean>) {
  async function read(signal?: AbortSignal) {
    signal?.throwIfAborted()
    await assertLease()
    if (!await isCurrent()) return null
    const access = await binding.read(signal)
    signal?.throwIfAborted()
    if (!access) return null
    if (binding.systemOnly && (!binding.supportsSystem || access.systemEnabled !== true)) return null
    if (binding.systemOnly) return access
    if (!binding.systemOnly && access.workspaceId === null && access.filesystemGrantId === null
      && !(binding.supportsSystem && access.systemEnabled)) return null
    return access.facts && evaluateSandboxShell('pwd', access.facts).allowed ? access : null
  }
  const tool = createAgentShellTool(async (input, { signal }) => {
    const access = await read(signal)
    if (!access) return rejected('定时任务的 Shell 授权不可用')
    const system = input.scope === 'system'
    if (system && (!binding.supportsSystem || access.systemEnabled !== true))
      return rejected('当前 Agent Shell 环境不可用')
    if (!system && binding.systemOnly) {
      return rejected('当前终端使用宿主机执行，请使用 system 范围')
    }
    let decision: ReturnType<typeof evaluateSandboxShell> | null = null
    if (!system) {
      if (!access.facts) return rejected('当前任务的沙盒授权不可用')
      decision = evaluateSandboxShell(input.command, access.facts)
      if (!decision.allowed) return rejected(decision.reason)
    }
    if (!system && !binding.systemOnly && access.workspaceId === null && access.filesystemGrantId === null)
      return rejected('当前任务的沙盒不可用，请使用已启用的 system 范围')
    const writable = system || decision?.risk !== 'safe'
    if (!system && writable && binding.supportsSandboxWrites !== true)
      return rejected('沙盒写操作需要确认')
    const stillAuthorized = async (current: ScheduledShellAuthorization | null) => {
      if (!current || current.revision !== access.revision || (system && current.systemEnabled !== true)) return false
      if (system) return true
      if (!current.facts) return false
      const currentDecision = evaluateSandboxShell(input.command, current.facts)
      return currentDecision.allowed && currentDecision.risk === decision?.risk
    }
    if (!await stillAuthorized(await read(signal)))
      return rejected('Shell 权限或定时任务状态已变化')
    return binding.execute(input, {
      revision: access.revision, writable, signal,
      async assertAuthorized() {
        if (!await stillAuthorized(await read(signal))) throw new Error('定时任务的 Shell 授权已变化')
        signal.throwIfAborted()
      },
    })
  }, '定时任务直接复用主 Agent 已开放的宿主机 Shell 和网络权限。需要访问网络或本机资源时使用 system 范围；不要为命令添加额外授权或改写成受限子命令。', binding.supportsSystem === true)
  return {
    tool,
    async available() { return Boolean(await read()) },
    async state() {
      const access = await read()
      if (!access) return null
      const system = binding.supportsSystem && access.systemEnabled
      const sandbox = !binding.systemOnly && (access.workspaceId !== null || access.filesystemGrantId !== null)
      if (system && sandbox) return '当前终端可使用 sandbox 范围，也可使用主 Agent 已开启的 system 范围联网。'
      if (system) return '当前终端使用主 Agent 的宿主机执行权限，请使用 system 范围。'
      return '当前终端使用主 Agent 配置的沙盒。'
    },
  }
}
