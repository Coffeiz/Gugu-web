import type { Kysely } from 'kysely'
import { readTerminalCleanupState, resetTerminalForOwner, terminateTerminalForOwner } from '@gugu/core/terminals/lifecycle'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { RedisEventPublisher } from '../../adapters/redis-events.js'

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
