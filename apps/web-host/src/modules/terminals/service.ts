import type { Pool } from 'pg'
import type { Kysely } from 'kysely'
import { createTerminalCreator, type TerminalCreateAccessSettings } from '@gugu/core/terminals/create'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { RedisEventPublisher } from '../../adapters/cache/redis-events.js'
import { createTerminalReopener, type TerminalReopenSettings } from '@gugu/core/terminals/reopen'
import { readTerminalCleanupState, resetTerminalForOwner, terminateTerminalForOwner } from '@gugu/core/terminals/lifecycle'
import { createTerminalShellFactsReader } from '@gugu/core/terminals/shell-facts'
import { createTerminalConfirmationGate, type TerminalConfirmationStore } from './shell/confirm.js'
import { createHostTerminalCommandService, createTerminalShellExecution } from './shell/command.js'
import { createTerminalInputAuthorizer } from './pty/access.js'
import { createTerminalLiveOutput } from './pty/output.js'
import { executeBubblewrapShell } from './sandbox/bubblewrap.js'
import { createTerminalShellSnapshotReader } from './shell/snapshot.js'
import { createTerminalWorkspaceMounts } from './sandbox/mounts.js'
import type { TerminalCommandPorts } from '@gugu/core/terminals/command'

/** Host-only preferences/readiness are combined with the Core creation transaction. */
export function createPostgresTerminalCreator<DB>(options: {
  pool: Pool
  db: Kysely<DB>
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>
  readRuntime(): Promise<TerminalCreateAccessSettings>
  now?: () => Date
}) {
  const create = createTerminalCreator(options.db, 'postgres', async (ownerId, terminalId, origin) => {
    await options.publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'create', entityId: terminalId, origin })
  }, { workspaceSupported: true, ...(options.now ? { now: options.now } : {}) })

  return async (ownerId: string, input: {
    name: string
    sessionId: number | null
    workspaceId: number | null
    mode: 'agent-events' | 'interactive-pty'
    origin: string | null
  }): Promise<TerminalListItem> => {
    const [preferences, settings] = await Promise.all([
      options.pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id=$1', [ownerId]),
      options.readRuntime(),
    ])
    return create(ownerId, {
      ...input,
      preferences: preferences.rows[0]?.data_json,
      settings,
      ptyEnabled: settings.terminalMode === 'auto' && settings.fullUserSandboxAuthorizationEnabled,
    })
  }
}

/** Host preferences and live MXC readiness feed the Core owner transaction. */
export function createPostgresTerminalReopener<DB>(options: {
  pool: Pool
  db: Kysely<DB>
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>
  readRuntime(): Promise<TerminalReopenSettings>
  now?: () => Date
}) {
  const reopen = createTerminalReopener(options.db, 'postgres', async (ownerId, terminalId, origin) => {
    await options.publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'update', entityId: terminalId, origin })
  }, { workspaceSupported: true, ...(options.now ? { now: options.now } : {}) })

  return async (ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem> => {
    const [preferences, settings] = await Promise.all([
      options.pool.query<{ data_json: string | Record<string, unknown> } & Record<string, unknown>>(
        'SELECT data_json FROM user_preferences WHERE user_id=$1', [ownerId]),
      options.readRuntime(),
    ])
    return reopen(ownerId, terminalId, {
      preferences: preferences.rows[0]?.data_json,
      settings,
      ptyEnabled: settings.terminalMode === 'auto' && settings.fullUserSandboxAuthorizationEnabled,
      origin,
    })
  }
}

type TerminalPtyLifecycleManager = {
  get(terminalId: string): unknown
  terminate(terminalId: string): Promise<void>
}

function stopFailure(): Error & { statusCode: number } {
  return Object.assign(new Error('终端进程停止失败，请重试'), { statusCode: 503 })
}

/** Stop a local PTY before Core commits the corresponding owner-scoped lifecycle state. */
export function createPostgresTerminalLifecycle<DB>(options: {
  db: Kysely<DB>
  manager: TerminalPtyLifecycleManager
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>
  now?: () => Date
}) {
  async function stopIfRunning(ownerId: string, terminalId: string) {
    const state = await readTerminalCleanupState(options.db, 'postgres', ownerId, terminalId)
    if (state.mode !== 'interactive-pty') return
    const live = options.manager.get(terminalId)
    if (live) {
      try { await options.manager.terminate(terminalId) } catch { throw stopFailure() }
      return
    }
    if (state.status === 'running' && state.closedAt === null) throw stopFailure()
  }

  return {
    async reset(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem> {
      await stopIfRunning(ownerId, terminalId)
      const result = await resetTerminalForOwner(options.db, 'postgres', ownerId, terminalId, options.now)
      try {
        await options.publisher.publishResourceChanged({
          ownerId, resource: 'terminals', operation: 'update', entityId: terminalId, origin,
          payload: { terminal: result, reset: true },
        })
      } catch { /* 数据库已提交，通知失败不回滚重置。 */ }
      return result
    },
    async terminate(ownerId: string, terminalId: string, origin: string | null): Promise<TerminalListItem> {
      await stopIfRunning(ownerId, terminalId)
      const result = await terminateTerminalForOwner(options.db, 'postgres', ownerId, terminalId, options.now)
      try {
        await options.publisher.publishResourceChanged({
          ownerId, resource: 'terminals', operation: 'append', entityId: terminalId, origin,
          payload: { terminal_id: terminalId, terminal: result },
        })
      } catch { /* 数据库已提交，通知失败不回滚终止。 */ }
      return result
    },
  }
}

/** 将认证后的终端用例、持久化、确认、挂载和 MXC 组合为同一生命周期。 */
export function createTerminalRuntime<DB>(options: {
  pool: Pick<Pool, 'connect' | 'query'>; db: Kysely<DB>; storageRoot: string
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>; confirmations: TerminalConfirmationStore
  read(owner: string, terminal: string): Promise<TerminalListItem>
  runtime: Parameters<typeof createTerminalShellSnapshotReader>[2]
  ptyEnabled(): boolean | Promise<boolean>; diagnose(error?: unknown): void
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
