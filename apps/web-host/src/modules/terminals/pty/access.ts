import { evaluateSandboxShell, type ShellPolicyFacts } from '@gugu/core/agent'
import type { TerminalListItem } from '@gugu/core/terminals/list'

/** 输入与取消均重新检查 owner、终端入口、PTY 开关及 Shell 执行范围。 */
export function createTerminalInputAuthorizer(options: {
  read(owner: string, terminal: string): Promise<TerminalListItem>
  snapshot(owner: string, terminal: string): Promise<{ facts: ShellPolicyFacts } | null>
  ptyEnabled(): boolean | Promise<boolean>
}) {
  return async (owner: string, terminal: string) => {
    const row = await options.read(owner, terminal)
    if (row.mode === 'interactive-pty' && !await options.ptyEnabled())
      throw Object.assign(new Error('交互式 PTY 不可用'), { statusCode: 403 })
    const snapshot = await options.snapshot(owner, terminal)
    if (!snapshot || !evaluateSandboxShell('pwd', snapshot.facts).allowed)
      throw Object.assign(new Error(row.sessionId === null ? '当前终端没有可用的 Shell 执行范围' : '当前会话没有可用的 Shell 执行范围'), { statusCode: 403 })
  }
}
