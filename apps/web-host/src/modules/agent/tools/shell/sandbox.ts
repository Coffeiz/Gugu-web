import type { RuntimeLog } from '@gugu/log/runtime'
import { createHash } from 'node:crypto'
import { actionApprovalMode, createHostShellGrants, evaluateSandboxShell, shellConfirmationMode, stableJson, type RunIdentity, type ToolResult } from '@gugu/core/agent'
import { createAgentShellTool } from '@gugu/core/tools'
import { executeBubblewrapShell, type ShellMountPlan } from '../../../terminals/sandbox/bubblewrap.js'
import { parseShellTrash } from '../../../terminals/shell/trash.js'
import type { createWebAgentToolConfirmation } from '../confirm.js'
import { executeAgentSystemShell } from './system.js'
import { isIsolatedWorkspaceWrite } from '../../../terminals/shell/workspace-write.js'

type Confirmation = ReturnType<typeof createWebAgentToolConfirmation>
type Snapshot = {
  workspaceId: number | null
  workspaceTarget: string
  isolatedWorkspace?: string
  securityVersion?: number
  systemEnabled?: boolean
  automaticModeEnabled?: boolean
  facts: Parameters<typeof evaluateSandboxShell>[1]
}

const rejected = (error: string): ToolResult => ({
  kind: 'completed', successful: false, mutated: false, executed: false, value: { error },
})
const hostGrants = createHostShellGrants(30 * 60 * 1000)

/** 每次准备、确认及执行都使用绑定当前 Run 的可信授权。 */
export function createWebAgentShell(options: {
  log?: RuntimeLog
  rootfs: string
  read(identity: RunIdentity, signal: AbortSignal): Promise<Snapshot | null>
  mounts(owner: string, workspaceId: number | null, fullWrite: boolean, cwd: string): Promise<ShellMountPlan>
  confirmation: Confirmation
  claim(reference: Parameters<Confirmation['claim']>[1], signal: AbortSignal): Promise<boolean>
}) {
  return createAgentShellTool(async (input, scope, call) => {
    const { identity, signal } = scope
    const initial = await options.read(identity, signal)
    if (!initial) return rejected('当前会话没有可用的 Shell 执行范围')
    const system = input.scope === 'system'
    if (system && initial.systemEnabled !== true) return rejected('管理员和当前用户均需开启 system Shell')
    const isolatedWorkspace = !system && scope.resolution === null && initial.isolatedWorkspace
      && isIsolatedWorkspaceWrite(input.command, input.cwd, initial.isolatedWorkspace)
      ? initial.isolatedWorkspace : null
    const trash = !system && parseShellTrash(input.command)
    const facts = trash ? { ...initial.facts, userDangerousEnabled: true } : initial.facts
    const decision = evaluateSandboxShell(input.command, facts, { isolatedWorkspaceWrite: isolatedWorkspace !== null })
    if (!decision.allowed) return rejected(decision.reason)
    // 独立目录由 workspaceTarget 派生，保留部署前已签发确认的摘要格式。
    const confirmationSnapshot = ({ isolatedWorkspace: _isolatedWorkspace, automaticModeEnabled: _automaticModeEnabled, ...snapshot }: Snapshot) => stableJson(snapshot)
    const snapshotKey = confirmationSnapshot(initial)
    const authorizationKey = stableJson(initial)
    const stillAuthorized = async () => {
      const current = await options.read(identity, signal)
      return current !== null && stableJson(current) === authorizationKey
    }
    const needsConfirmation = !isolatedWorkspace && (decision.needsConfirmation || (!system && decision.risk === 'write'))
    const systemMode = () => actionApprovalMode(
      initial.automaticModeEnabled || hostGrants.permits(identity, snapshotKey) ? 'never' : 'ask',
      true, scope.resolution !== null,
    )
    const mode = system ? systemMode() : shellConfirmationMode(decision, {
      system, isolatedWorkspace: isolatedWorkspace !== null, approvalPolicy: initial.automaticModeEnabled ? 'never' : 'ask',
      hasResolution: scope.resolution !== null,
    })
    if (mode === 'request' || mode === 'verify') {
      const digest = (value: string) => createHash('sha256').update(value).digest('hex')
      const argsDigest = digest(stableJson(input))
      const snapshot = {
        targetIds: { workspace_id: initial.workspaceId === null ? [] : [initial.workspaceId] },
        targetsDigest: digest(initial.workspaceTarget), versionsDigest: digest(snapshotKey),
        displaySummary: `${system ? '允许此会话在未来 30 分钟以 Web Host 服务账号执行宿主机命令' : trash ? '将授权路径移入回收站（可恢复）' : '在沙箱内执行命令'}：${Array.from(input.command).slice(0, 240).join('')}${input.description ? `\n操作说明：${input.description}` : ''}`,
      }
      if (mode === 'request') {
        const prepared = await options.confirmation.gate.prepare(call, scope, argsDigest, snapshot)
        return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : rejected('无法申请 Shell 执行确认')
      }
      const approved = await options.confirmation.gate.verify(call, scope, argsDigest, snapshot)
      if (!approved.ok || !await options.claim(approved.value, signal)) return rejected('Shell 执行确认无效或已过期')
    } else if (mode === 'stale') {
      return rejected('命令确认对应的权限已变化')
    }
    if (!await stillAuthorized()) return rejected('Shell 执行权限已变化')
    if (system && mode === 'verify') hostGrants.approve(identity, snapshotKey)
    if (system && mode === 'execute' && systemMode() !== 'execute') return rejected('宿主机 Shell 授权已过期')
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
        const result = await executeAgentSystemShell({
          command: input.command, cwd: input.cwd, timeout: input.timeout, maxOutputChars: input.max_output_chars,
        }, controller.signal)
        options.log?.('sandbox.system_completed', { ok: result.ok, timedOut: result.timed_out })
        return { kind: 'completed', successful: result.ok, mutated: true, executed: true, value: result }
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
      // 确认门与实际挂载分开。普通写入的唯一可写挂载由执行器校验。
      const authorizedMount = needsConfirmation || isolatedWorkspace ? mount : {
        ...mount, sandboxMounts: mount.sandboxMounts.map(entry => ({ ...entry, readonly: true })),
      }
      const result = await executeBubblewrapShell(options.rootfs, authorizedMount, {
        command: input.command, timeout: input.timeout, maxOutputChars: input.max_output_chars,
      }, isolatedWorkspace ? { isolatedWorkspace } : needsConfirmation, controller.signal)
      return { kind: 'completed', successful: result.ok, mutated: needsConfirmation || isolatedWorkspace !== null, executed: true, value: {
        ok: result.ok, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode,
        timed_out: result.timedOut, truncated: result.truncated, cwd: result.cwd, scope: 'sandbox', network_access: 'none',
      } }
    } catch (error) {
      options.log?.('sandbox.command_failed', { error })
      throw error
    } finally {
      clearInterval(timer)
      signal.removeEventListener('abort', cancel)
    }
  })
}
