import { evaluateSandboxShell, type ShellPolicyFacts } from '@gugu/core/agent'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { MxcPtyLaunchSpec } from '@gugu/sandbox/pty'
import type { BubblewrapMount } from '@gugu/sandbox/linux/bubblewrap'
import type { BubblewrapPtySpec } from '@gugu/sandbox/linux/pty'

type WorkspaceMount = {
  cwd: string
  readwritePaths: string[]
  readonlyPaths: string[]
  environment: Record<string, string>
  close(): Promise<void>
  sandboxCwd?: string
  sandboxMounts?: readonly BubblewrapMount[]
}
type TerminalPtySpec = MxcPtyLaunchSpec & Partial<BubblewrapPtySpec>

/** 使用当前 owner 和 Shell 授权生成启动计划，目录句柄一直持有到 PTY 退出。 */
export function createTerminalPtyRuntime(options: {
  read(owner: string, terminal: string): Promise<TerminalListItem>
  authorize(owner: string, terminal: string): Promise<void>
  snapshot(owner: string, terminal: string): Promise<{
    networkProfile: 'none' | 'egress'
    egressProxyUrl?: string
    egressProxyError?: string
    workspaceId?: number | null
    workspaceTarget?: string
    facts: ShellPolicyFacts
  } | null>
  mounts(owner: string, workspaceId: number | null, fullUserSandboxWrite: boolean, cwd: string): Promise<WorkspaceMount>
  manager: {
    startWithSubscription(spec: TerminalPtySpec): Promise<{
      session: { handle: { pid: number; sandboxId: string }; cols: number; rows: number }
      queue: { take(): Promise<Uint8Array | null> }
    }>
  }
}) {
  return {
    async startWithSubscription(owner: string, terminalId: string) {
      await options.authorize(owner, terminalId)
      const terminal = await options.read(owner, terminalId)
      if (terminal.mode !== 'interactive-pty') throw Object.assign(new Error('交互式终端不存在'), { statusCode: 404 })
      if (terminal.shellMode !== 'sandbox') throw Object.assign(new Error('交互式 PTY 暂不支持 system 范围'), { statusCode: 403 })
      if (terminal.closedAt || terminal.status === 'terminated') throw Object.assign(new Error('终端已终止，请先重新打开'), { statusCode: 403 })
      const snapshot = await options.snapshot(owner, terminalId)
      if (!snapshot || !evaluateSandboxShell('pwd', snapshot.facts).allowed)
        throw Object.assign(new Error('当前终端没有可用的 Shell 执行范围'), { statusCode: 403 })
      if (snapshot.networkProfile === 'egress' && (snapshot.egressProxyError || !snapshot.egressProxyUrl))
        throw Object.assign(new Error(snapshot.egressProxyError || 'MXC 安全出站代理不可用'), { statusCode: 503 })
      const workspaceId = snapshot.workspaceId === undefined ? terminal.workspaceId : snapshot.workspaceId
      const mount = await options.mounts(owner, workspaceId, snapshot.facts.fullUserSandboxWrite, '.')
      const spec: TerminalPtySpec = {
        terminalId,
        root: mount.cwd,
        readwritePaths: mount.readwritePaths,
        readonlyPaths: mount.readonlyPaths,
        environment: mount.environment,
        networkProfile: snapshot.networkProfile,
        ...(snapshot.egressProxyUrl ? { egressProxyUrl: snapshot.egressProxyUrl } : {}),
        cols: terminal.ptyCols ?? 120,
        rows: terminal.ptyRows ?? 32,
        release: mount.close,
        ...(mount.sandboxCwd && mount.sandboxMounts
          ? { sandboxCwd: mount.sandboxCwd, sandboxMounts: mount.sandboxMounts,
            async authorizeRunning() {
              await options.authorize(owner, terminalId)
              const current = await options.snapshot(owner, terminalId)
              return !!current && current.workspaceId === snapshot.workspaceId
                && current.workspaceTarget === snapshot.workspaceTarget && current.networkProfile === snapshot.networkProfile
                && current.facts.fullUserSandboxWrite === snapshot.facts.fullUserSandboxWrite
                && evaluateSandboxShell('pwd', current.facts).allowed
            } }
          : {}),
      }
      try {
        const started = await options.manager.startWithSubscription(spec)
        return { ...started, session: { ...started.session, workspaceId } }
      } catch (error) {
        await mount.close().catch(() => undefined)
        throw error
      }
    },
  }
}
