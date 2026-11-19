import { dirname } from 'node:path'
import { createDesktopRuntimeLog } from '../main/log/index.js'
import { DatabaseSync } from 'node:sqlite'
import { createTelegramAdapter, validateTelegramBotToken, type TelegramPollingOptions } from '@gugu/gateway/telegram'

type Payload = Record<string, unknown>

/** 使用 Desktop 应用私有目录中的数据库。消费成功后按 updateId 确认。 */
function openDesktopTelegramInbox(path: string, scope: { ownerId: string; botId: string; platformBotId: string }) {
  const db = new DatabaseSync(path)
  const key = JSON.stringify([scope.ownerId, scope.botId, scope.platformBotId])
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_cursor (scope TEXT PRIMARY KEY, update_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_inbox (
        scope TEXT NOT NULL, update_id INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (scope, update_id)
      );
    `)
    const read = db.prepare('SELECT update_id FROM telegram_cursor WHERE scope = ?')
    const advance = db.prepare(`
      INSERT INTO telegram_cursor VALUES (?, ?)
      ON CONFLICT(scope) DO UPDATE SET update_id = excluded.update_id
      WHERE excluded.update_id > telegram_cursor.update_id
    `)
    const enqueue = db.prepare('INSERT INTO telegram_inbox VALUES (?, ?, ?)')
    const next = db.prepare('SELECT update_id, payload FROM telegram_inbox WHERE scope = ? ORDER BY update_id LIMIT 1')
    const remove = db.prepare('DELETE FROM telegram_inbox WHERE scope = ? AND update_id = ?')
    return {
      async cursor() { return (read.get(key)?.update_id as number | undefined) ?? null },
      async commit(updateId: number, payload: Payload | null) {
        if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('Telegram 事件 ID 无效')
        db.exec('BEGIN IMMEDIATE')
        try {
          const { changes } = advance.run(key, updateId)
          if (changes && payload !== null) enqueue.run(key, updateId, JSON.stringify(payload))
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
      peek(): { updateId: number; payload: Payload } | null {
        const row = next.get(key)
        return row ? { updateId: row.update_id as number, payload: JSON.parse(row.payload as string) as Payload } : null
      },
      acknowledge(updateId: number) { remove.run(key, updateId) },
      close() { db.close() },
    }
  } catch (error) {
    db.close()
    throw error
  }
}

type DesktopTelegramOptions = Omit<TelegramPollingOptions, 'api' | 'inbox' | 'expectedPlatformBotId'> &
  Pick<Parameters<typeof createTelegramAdapter>[0], 'transport'> & { databasePath: string }

/** 在桌面 Node 进程中显式启用。凭据、入站授权、交互和附件策略由调用者提供。 */
export async function startDesktopTelegram(options: DesktopTelegramOptions) {
  const { databasePath, transport, ...polling } = options
  const report = createDesktopRuntimeLog(dirname(databasePath))
  try {
    const token = validateTelegramBotToken(polling.token)
    const platformBotId = token.slice(0, token.indexOf(':'))
    const inbox = openDesktopTelegramInbox(databasePath, { ...polling, platformBotId })
    try {
      const adapter = createTelegramAdapter({ token, transport })
      const connection = await adapter.connect({
        ...polling, inbox, expectedPlatformBotId: platformBotId,
        report(code, error) {
          report('gateway.degraded', { code, error })
          polling.report?.(code)
        },
      })
      report('gateway.started')
      void connection.closed.then(
        () => report('gateway.stopped'),
        error => report('gateway.stop_failed', { error }),
      )
      let stopping: Promise<void> | undefined
      return {
        sender: adapter.sender,
        peek: inbox.peek,
        acknowledge: inbox.acknowledge,
        closed: connection.closed,
        stop() {
          return stopping ??= connection.stop().finally(inbox.close)
        },
      }
    } catch (error) {
      inbox.close()
      throw error
    }
  } catch (error) {
    report('gateway.start_failed', { error })
    throw error
  }
}
