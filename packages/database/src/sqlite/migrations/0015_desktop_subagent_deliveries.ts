import type SQLite from 'better-sqlite3'
import { subagentDeliverySchema } from '../../shared/subagent-deliveries.js'

export function initializeDesktopSubagentDeliveries(db: SQLite.Database): void {
  db.transaction(() => db.exec(subagentDeliverySchema('BLOB'))).immediate()
}
