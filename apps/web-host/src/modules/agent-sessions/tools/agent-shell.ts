import { createHash } from 'node:crypto'
import { evaluateSandboxShell, stableJson, type RunIdentity, type ToolResult } from '@gugu/core/agent'
import { createAgentShellTool } from '@gugu/core/tools'
import { executeBubblewrapShell, type ShellMountPlan } from '../../terminals/bubblewrap-command.js'
import type { createWebAgentToolConfirmation } from './agent-confirmation.js'
import { executeAgentSystemShell } from './agent-system-shell.js'

type Confirmation = ReturnType<typeof createWebAgentToolConfirmation>
type Snapshot = {
  workspaceId: number
  workspaceTarget: string
  securityVersion?: number
  systemEnabled?: boolean
  facts: Parameters<typeof evaluateSandboxShell>[1]
}

const rejected = (error: string): ToolResult => ({
  kind: 'completed', successful: false, mutated: false, executed: false, value: { error },
})

/** 每次准备、确认及执行都使用绑定当前 Run 的可信授权。 */
export function createWebAgentShell(options: {
  rootfs: string
  read(identity: RunIdentity, signal: AbortSignal): Promise<Snapshot | null>
  mounts(owner: string, workspaceId: number, fullWrite: boolean, cwd: string): Promise<ShellMountPlan>
  confirmation: Confirmation
  claim(reference: Parameters<Confirmation['claim']>[1], signal: AbortSignal): Promise<boolean>
}) {
  return createAgentShellTool(async (input, scope, call) => {
    const { identity, signal } = scope
    const initial = await options.read(identity, signal)
    if (!initial) return rejected('当前会话没有可用的 Shell 执行范围')
    const system = input.scope === 'system'
    if (system && initial.systemEnabled !== true) return rejected('管理员和当前用户均需开启 system Shell')
    const decision = evaluateSandboxShell(input.command, initial.facts)
    if (!decision.allowed) return rejected(decision.reason)
    const snapshotKey = stableJson(initial)
    const stillAuthorized = async () => {
      const current = await options.read(identity, signal)
      return current !== null && stableJson(current) === snapshotKey
    }
    const needsConfirmation = system || decision.needsConfirmation || decision.risk === 'write'
    if (needsConfirmation) {
      const digest = (value: string) => createHash('sha256').update(value).digest('hex')
      const argsDigest = digest(stableJson(input))
      const snapshot = {
        targetIds: { workspace_id: [initial.workspaceId] },
        targetsDigest: digest(initial.workspaceTarget), versionsDigest: digest(snapshotKey),
        displaySummary: `${system ? '在 Web Host 系统环境执行命令（使用服务账号权限）' : '在沙箱内执行命令'}：${Array.from(input.command).slice(0, 240).join('')}`,
      }
      if (scope.resolution === null) {
        const prepared = await options.confirmation.gate.prepare(call, scope, argsDigest, snapshot)
        return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : rejected('无法申请 Shell 执行确认')
      }
      const approved = await options.confirmation.gate.verify(call, scope, argsDigest, snapshot)
      if (!approved.ok || !await options.claim(approved.value, signal)) return rejected('Shell 执行确认无效或已过期')
    } else if (scope.resolution !== null) {
      return rejected('命令确认对应的权限已变化')
    }
    if (!await stillAuthorized()) return rejected('Shell 执行权限已变化')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    let checking = false
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return
      checking = true
      void stillAuthorized().then(allowed => { if (!allowed) cancel() }, cancel).finally(() => { checking = false })
    }, 1000)
    try {
      if (system) {
        const fingerprint = createHash('sha256').update(stableJson({ identity, input, id: call.id })).digest('hex').slice(0, 24)
        try {
          const result = await executeAgentSystemShell({
            command: input.command, cwd: input.cwd, timeout: input.timeout, maxOutputChars: input.max_output_chars,
          }, controller.signal)
          console.info('系统 Shell 执行结束', { fingerprint, ok: result.ok, timedOut: result.timed_out })
          return { kind: 'completed', successful: result.ok, mutated: true, executed: true, value: result }
        } catch (error) {
          console.info('系统 Shell 执行中止或结果未知', { fingerprint })
          throw error
        }
      }
      const mount = await options.mounts(identity.ownerId, initial.workspaceId, decision.fullUserSandboxWrite, input.cwd)
      try {
        if (!await stillAuthorized()) {
          await mount.close()
          return rejected('Shell 执行权限已变化')
        }
      } catch (error) {
        await mount.close()
        throw error
      }
      // 风险分类只用于申请确认。未获确认的命令由 OS 强制限制为只读文件访问。
      const authorizedMount = needsConfirmation ? mount : {
        ...mount, sandboxMounts: mount.sandboxMounts.map(entry => ({ ...entry, readonly: true })),
      }
      const result = await executeBubblewrapShell(options.rootfs, authorizedMount, {
        command: input.command, timeout: input.timeout, maxOutputChars: input.max_output_chars,
      }, needsConfirmation, controller.signal)
      return { kind: 'completed', successful: result.ok, mutated: needsConfirmation, executed: true, value: {
        ok: result.ok, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode,
        timed_out: result.timedOut, truncated: result.truncated, cwd: result.cwd, scope: 'sandbox', network_access: 'none',
      } }
    } finally {
      clearInterval(timer)
      signal.removeEventListener('abort', cancel)
    }
  })
}
