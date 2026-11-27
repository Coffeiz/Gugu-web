import type { createScheduledTaskRunToolPorts } from '@gugu/core/agent/scenes/task'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createKyselyScheduledTaskExecutionReader, type ScheduledTaskExecutionPlan } from '@gugu/core/tasks/execution-read'
import { executeAgentSystemShell } from '../../agent/tools/shell/system.js'

type Binding = NonNullable<Parameters<typeof createScheduledTaskRunToolPorts>[0]['shell']>

/** 定时任务直接复用主 Agent 开启的 system Shell；任务不再额外配置命令或网络权限。 */
export function createWebScheduledShellBinding(options: {
  core: SqlDataRuntime
  readPolicy(owner: string): Promise<{ systemEnabled: boolean } | null>
}) {
  const { db, backend } = options.core
  const readTask = createKyselyScheduledTaskExecutionReader(db, backend)
  return (task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'workspaceId'>): Binding => ({
    supportsSystem: true,
    systemOnly: true,
    async read(signal) {
      signal?.throwIfAborted()
      const current = await readTask(task.ownerId, task.id)
      if (!('plan' in current) || current.plan.executionMode === 'reminder'
        || current.plan.workspaceId !== task.workspaceId) return null
      const policy = await options.readPolicy(task.ownerId)
      signal?.throwIfAborted()
      if (!policy?.systemEnabled) return null
      return {
        workspaceId: current.plan.workspaceId,
        filesystemGrantId: current.plan.filesystemGrantId,
        revision: JSON.stringify([current.plan.id, current.plan.executionMode, current.plan.workspaceId, policy.systemEnabled]),
        systemEnabled: true,
      }
    },
    async execute(input, { signal, assertAuthorized }) {
      if (input.scope !== 'system')
        return { kind: 'completed', successful: false, executed: false, mutated: false,
          value: { error: '当前定时任务使用主 Agent 的宿主机 Shell，请使用 system 范围' } }
      await assertAuthorized()
      const value = await executeAgentSystemShell({
        command: input.command, cwd: input.cwd, timeout: input.timeout, maxOutputChars: input.max_output_chars,
      }, signal)
      return { kind: 'completed', successful: value.ok, executed: true, mutated: true, value }
    },
  })
}
