import { CoreError } from '@gugu/core'
import { UnsafeLocalPathError } from '@gugu/fs/node'
import { runBubblewrapCommand } from '@gugu/sandbox/linux/command'
import type { BubblewrapMount } from '@gugu/sandbox/linux/bubblewrap'
import type { TerminalCommandInput } from '@gugu/core/terminals/command'
import { parseShellTrash, shellTrashPrefix, type ShellTrashCommand } from '../shell/trash.js'
import { isIsolatedWorkspaceWrite } from '../shell/workspace-write.js'
import { classifyShellCommandRisk } from '@gugu/core/agent/security/shell-command-risk'

export interface ShellMountPlan {
  sandboxCwd: string
  sandboxMounts: readonly BubblewrapMount[]
  trash?(command: ShellTrashCommand, signal: AbortSignal): Promise<number>
  close(): Promise<void>
}

/** 本地目录由 Host 持有到进程退出，终端与 Agent 共享同一执行边界。 */
export async function executeBubblewrapShell(
  rootfs: string,
  mount: ShellMountPlan,
  input: Pick<TerminalCommandInput, 'command' | 'timeout' | 'maxOutputChars'>,
  authorization: boolean | { isolatedWorkspace: string },
  signal: AbortSignal,
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void,
) {
  try {
    if (authorization === false && classifyShellCommandRisk(input.command) === 'dangerous')
      throw new Error('危险命令未获得确认')
    const removal = parseShellTrash(input.command)
    if (removal) {
      if (authorization !== true || !mount.trash) throw new Error('回收操作未获授权')
      try {
        const count = await mount.trash(removal, signal)
        return { ok: true, exitCode: 0, timedOut: false, stdout: count ? `已移入回收站：${count} 项\n` : '', stderr: '',
          cwd: mount.sandboxCwd, truncated: false }
      } catch (error) {
        if (!(error instanceof CoreError) && !(error instanceof UnsafeLocalPathError)) throw error
        return { ok: false, exitCode: 1, timedOut: false, stdout: '',
          stderr: error instanceof CoreError ? error.message : '删除路径无效',
          cwd: mount.sandboxCwd, truncated: false }
      }
    }
    if (shellTrashPrefix.test(input.command.trim()))
      return { ok: false, exitCode: 1, timedOut: false, stdout: '', stderr: '请使用单条 rm 命令和明确的文件路径',
        cwd: mount.sandboxCwd, truncated: false }
    const writableRoot = mount.sandboxMounts.find(entry => !entry.readonly
      && isIsolatedWorkspaceWrite(input.command, mount.sandboxCwd, entry.target))?.target
    let mounts = mount.sandboxMounts.map(entry => ({
      ...entry, readonly: entry.readonly || entry.target !== writableRoot,
    }))
    if (typeof authorization === 'object') {
      const root = authorization.isolatedWorkspace
      if (!isIsolatedWorkspaceWrite(input.command, mount.sandboxCwd, root) || !/^\/workspace\/[A-Za-z0-9_-]+$/.test(root)
        || (mount.sandboxCwd !== root && !mount.sandboxCwd.startsWith(`${root}/`))
        || !mounts.some(entry => entry.target === root && !entry.readonly))
        throw new Error('独立沙箱工作目录未授权')
      mounts = mount.sandboxMounts.map(entry => entry.target === root ? entry : { ...entry, readonly: true })
    }
    const result = await runBubblewrapCommand({
      rootfs, mounts, cwd: mount.sandboxCwd, command: input.command,
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
