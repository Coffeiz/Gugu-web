import type SQLite from 'better-sqlite3'

export function initializeDesktopScheduleMode(db: SQLite.Database) {
  const columns = db.pragma('table_info(scheduled_tasks)') as { name: string }[]
  // 已创建的桌面任务由系统直接投递，升级后延续提醒模式。
  if (!columns.some(column => column.name === 'execution_mode'))
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'reminder' CHECK(execution_mode IN ('reminder', 'instruction'))")
}
