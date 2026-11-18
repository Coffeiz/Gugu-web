import { evaluateSandboxShell, type ShellPolicyFacts } from '@gugu/core/agent'
import type { TerminalCommandInput } from '@gugu/core/terminals/command'

interface ShellSnapshot { facts: ShellPolicyFacts; sessionId: number | null; workspaceId: number | null; workspaceTarget?: string; networkProfile?: 'none' | 'egress'; egressProxyUrl?: string; egressProxyError?: string }
interface ShellExecutionPorts {
  read(owner: string, terminal: string): Promise<ShellSnapshot | null>
  redeem(owner: string, code: string): Promise<boolean>
  confirm(owner: string, input: { command: string; sessionId: number | null; workspaceId: number | null; cwd: string }): Promise<{ allowed: boolean; error?: string }>
  isCancelled?(owner: string, terminal: string, id: string): Promise<boolean>
  run(owner: string, terminal: string, id: string, input: TerminalCommandInput, snapshot: ShellSnapshot, confirmed: boolean, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null; ok: boolean }>
}

/** 授权和确认在执行前重新读取；运行期间定期复核并中止权限已变化的进程。 */
export function createTerminalShellExecution(ports: ShellExecutionPorts, intervalMs = 1000) {
  return async (owner: string, terminal: string, id: string, input: TerminalCommandInput, signal: AbortSignal) => {
    const failure = (stderr: string) => ({ stdout: '', stderr, exitCode: null, ok: false })
    if (ports.isCancelled && await ports.isCancelled(owner, terminal, id)) return failure('命令已取消')
    if (input.confirmCode && !await ports.redeem(owner, input.confirmCode)) return failure('确认码无效或已过期，请重新执行命令。')
    const snapshot = await ports.read(owner, terminal)
    if (!snapshot) return failure('终端不存在')
    const decision = evaluateSandboxShell(input.command, snapshot.facts)
    if (!decision.allowed) return failure(decision.reason)
    if (snapshot.networkProfile === 'egress' && (!snapshot.egressProxyUrl || snapshot.egressProxyError)) return failure(snapshot.egressProxyError || '后台 egress 尚未配置 MXC 回环代理，当前沙盒保持断网')
    if (input.network === 'egress' && snapshot.networkProfile !== 'egress') return failure('受控 egress 尚未配置，当前沙盒保持断网')
    if (decision.needsConfirmation) {
      const confirmation = await ports.confirm(owner, { command: input.command, sessionId: snapshot.sessionId, workspaceId: snapshot.workspaceId, cwd: input.cwd })
      if (!confirmation.allowed) return failure(confirmation.error || '确认服务暂不可用')
    }
    const latest = await ports.read(owner, terminal)
    const latestDecision = latest && evaluateSandboxShell(input.command, latest.facts)
    if (!latest || !latestDecision?.allowed || latest.sessionId !== snapshot.sessionId || latest.workspaceId !== snapshot.workspaceId || latest.workspaceTarget !== snapshot.workspaceTarget || latest.networkProfile !== snapshot.networkProfile || latest.egressProxyUrl !== snapshot.egressProxyUrl || latest.egressProxyError !== snapshot.egressProxyError || latestDecision.fullUserSandboxWrite !== decision.fullUserSandboxWrite)
      return failure('Shell 权限已变更，命令已中止')
    if (ports.isCancelled && await ports.isCancelled(owner, terminal, id)) return failure('命令已取消')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) controller.abort()
    let stopped = false, checking: Promise<void> | undefined, revoked = false, cancelled = false
    const timer = setInterval(() => {
      if (checking || stopped) return
      checking = Promise.all([ports.read(owner, terminal), ports.isCancelled?.(owner, terminal, id) ?? false]).then(([current, requested]) => {
        if (requested) { cancelled = true; controller.abort(); return }
        const currentDecision = current && evaluateSandboxShell(input.command, current.facts)
        if (!current || !currentDecision?.allowed || current.sessionId !== snapshot.sessionId || current.workspaceId !== snapshot.workspaceId || current.workspaceTarget !== snapshot.workspaceTarget || current.networkProfile !== snapshot.networkProfile || current.egressProxyUrl !== snapshot.egressProxyUrl || current.egressProxyError !== snapshot.egressProxyError || currentDecision.fullUserSandboxWrite !== decision.fullUserSandboxWrite) {
          revoked = true; controller.abort()
        }
      }).catch(() => { revoked = true; controller.abort() }).finally(() => { checking = undefined })
    }, intervalMs)
    try {
      const result = await ports.run(owner, terminal, id, input, snapshot, decision.needsConfirmation, controller.signal)
      stopped = true
      clearInterval(timer)
      await checking
      return cancelled ? failure('命令已取消') : revoked ? failure('Shell 权限已变更，命令已中止') : result
    } catch (error) {
      if (cancelled) return failure('命令已取消')
      if (revoked) return failure('Shell 权限已变更，命令已中止')
      throw error
    } finally { stopped = true; clearInterval(timer); signal.removeEventListener('abort', cancel) }
  }
}
