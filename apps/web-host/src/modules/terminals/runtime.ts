import type { Pool } from 'pg'
import type { Kysely } from 'kysely'
import { createTerminalShellFactsReader } from '@gugu/core/terminals/shell-facts'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { RedisEventPublisher } from '../../adapters/redis-events.js'
import { createTerminalConfirmationGate, type TerminalConfirmationStore } from './confirmation.js'
import { createHostTerminalCommandService } from './command-service.js'
import { createTerminalInputAuthorizer } from './input-authorization.js'
import { createTerminalLiveOutput } from './live-output.js'
import { executeBubblewrapShell } from './bubblewrap-command.js'
import { createTerminalShellExecution } from './shell-execution.js'
import { createTerminalShellSnapshotReader } from './shell-snapshot.js'
import { createTerminalWorkspaceMounts } from './workspace-mounts.js'
import type { TerminalCommandPorts } from '@gugu/core/terminals/command'

/** 将认证后的终端用例、持久化、确认、挂载和 MXC 组合为同一生命周期。 */
export function createTerminalRuntime<DB>(options: {
  pool: Pick<Pool, 'connect'>; db: Kysely<DB>; storageRoot: string
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>; confirmations: TerminalConfirmationStore
  read(owner: string, terminal: string): Promise<TerminalListItem>
  runtime: Parameters<typeof createTerminalShellSnapshotReader>[2]
  ptyEnabled(): boolean | Promise<boolean>; diagnose(): void
  cancellation: { isRequested(owner: string, terminal: string, request: string): Promise<boolean> }
  lease: NonNullable<TerminalCommandPorts['lease']>
  sandboxRootfs?: string
}) {
  if (!options.cancellation || !options.lease) throw new Error('终端取消与活动租约必须同时启用')
  const snapshot = createTerminalShellSnapshotReader(options.db, 'postgres', options.runtime)
  const authorize = createTerminalInputAuthorizer({ read: options.read, snapshot, ptyEnabled: options.ptyEnabled })
  const mounts = createTerminalWorkspaceMounts(options.pool, options.db, options.storageRoot)
  const gate = createTerminalConfirmationGate(options.confirmations)
  const execute = createTerminalShellExecution({
    read: snapshot, redeem: options.confirmations.redeem, confirm: gate,
    isCancelled: options.cancellation.isRequested,
    async run(owner, terminal, requestId, input, current, confirmed, signal) {
      if (!options.sandboxRootfs || current.networkProfile !== 'none' || input.network !== 'none')
        throw new Error('无可用的断网 Bubblewrap 执行环境')
      const mount = await mounts(owner, current.workspaceId, current.facts.fullUserSandboxWrite, input.cwd)
      const publish = createTerminalLiveOutput(options.publisher)
      return executeBubblewrapShell(options.sandboxRootfs, mount, input, confirmed, signal, (stream, chunk) => {
        void publish(owner, terminal, requestId, input.command, stream, chunk).catch(options.diagnose)
      })
    },
  })
  return createHostTerminalCommandService({ db: options.db, publisher: options.publisher, authorize, read: options.read, execute, diagnose: options.diagnose, lease: options.lease })
}
