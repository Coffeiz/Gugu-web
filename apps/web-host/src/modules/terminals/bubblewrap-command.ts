import { runBubblewrapCommand } from '@gugu/sandbox/linux/command'
import type { BubblewrapMount } from '@gugu/sandbox/linux/bubblewrap'
import type { TerminalCommandInput } from '@gugu/core/terminals/command'
import { classifyShellCommandRisk } from '@gugu/core/agent/security/shell-command-risk'

export interface ShellMountPlan {
  sandboxCwd: string
  sandboxMounts: readonly BubblewrapMount[]
  close(): Promise<void>
}

/** 本地目录由 Host 持有到进程退出，终端与 Agent 共享同一执行边界。 */
export async function executeBubblewrapShell(
  rootfs: string,
  mount: ShellMountPlan,
  input: Pick<TerminalCommandInput, 'command' | 'timeout' | 'maxOutputChars'>,
  confirmed: boolean,
  signal: AbortSignal,
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void,
) {
  try {
    if (classifyShellCommandRisk(input.command) === 'dangerous' && !confirmed)
      throw new Error('危险命令未获得确认')
    const result = await runBubblewrapCommand({
      rootfs, mounts: mount.sandboxMounts, cwd: mount.sandboxCwd, command: input.command,
    }, {
      timeoutMs: Math.ceil(input.timeout * 1000),
      outputBytes: Math.min(1_048_576, input.maxOutputChars * 4),
      resourceScope: true,
    }, signal, onOutput)
    const truncate = (value: string) => Array.from(value).slice(0, input.maxOutputChars).join('')
    const stdout = truncate(result.stdout), stderr = truncate(result.stderr)
    return { ...result, stdout, stderr, cwd: mount.sandboxCwd,
      truncated: result.truncated || stdout !== result.stdout || stderr !== result.stderr }
  } finally {
    await mount.close()
  }
}
