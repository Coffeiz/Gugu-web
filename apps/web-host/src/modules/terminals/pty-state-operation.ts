import type { Kysely } from 'kysely'
import { markTerminalPtyExited, markTerminalPtyRunning } from '@gugu/core/terminals/pty-state'
import type { RedisEventPublisher } from '../../adapters/redis-events.js'
import type { TerminalPtyStateOperations } from './websocket.js'

/** Core owns PTY status transactions; Host only publishes committed resource changes. */
export function createPostgresTerminalPtyStateOperations<DB>(options: {
  db: Kysely<DB>
  publisher: Pick<RedisEventPublisher, 'publishResourceChanged'>
  authorize(ownerId: string, terminalId: string): Promise<void>
}) : TerminalPtyStateOperations {
  return {
    async started(ownerId, terminalId, session) {
      await options.authorize(ownerId, terminalId)
      await markTerminalPtyRunning(options.db, 'postgres', ownerId, terminalId, {
        workspaceId: session.workspaceId,
        pid: session.handle.pid,
        sandboxId: session.handle.sandboxId,
        cols: session.cols,
        rows: session.rows,
      })
      try { await options.publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'update', entityId: terminalId }) }
      catch { /* 提交后的状态不因通知失败回滚。 */ }
    },
    async exited(ownerId, terminalId) {
      const changed = await markTerminalPtyExited(options.db, 'postgres', ownerId, terminalId)
      if (changed) {
        try { await options.publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'update', entityId: terminalId }) }
        catch { /* 状态查询仍可恢复当前状态。 */ }
      }
      return changed
    },
  }
}
