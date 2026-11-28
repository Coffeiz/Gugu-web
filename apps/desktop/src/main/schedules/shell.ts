import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { executeDesktopHostShell } from '#core-source/runtime/desktop-host-shell.js'
import type { ScheduledShellBinding } from '#core-source/agent/scenes/task/shell.js'
import type { ScheduledTaskExecutionPlan } from '#core-source/tasks/run-now-read.js'

export function createDesktopScheduledShellBinding(
  task: ScheduledTaskExecutionPlan,
  readPreferences: () => Promise<{ shellEnabled: boolean; dangerousEnabled: boolean; automaticMode: boolean }>,
): ScheduledShellBinding {
  return {
    supportsSystem: true, systemOnly: true,
    async read() {
      const preferences = await readPreferences()
      if (!preferences.shellEnabled) return null
      return {
        revision: `${task.id}:${task.payload}:${preferences.shellEnabled}`,
        workspaceId: task.workspaceId, filesystemGrantId: task.filesystemGrantId,
        systemEnabled: true,
      }
    },
    async execute(input, { signal, assertAuthorized }) {
      const invalid = input.scope !== 'system'
        || /[\p{Cc}\p{Cf}]/u.test(input.cwd)
        || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/u.test(input.command)
      const requestedCwd = invalid ? null : resolve(input.cwd)
      const cwd = requestedCwd ? await realpath(requestedCwd).catch(() => null) : null
      if (!cwd || !(await stat(cwd).catch(() => null))?.isDirectory())
        return { kind: 'completed', successful: false, executed: false, mutated: false,
          value: { error: '宿主机命令需要有效的绝对工作目录' } }
      await assertAuthorized()
      const value = await executeDesktopHostShell(input.command, cwd, input.timeout, input.max_output_chars, signal)
      return { kind: 'completed', successful: value.ok, executed: true, mutated: true, value }
    },
  }
}
