import type SQLite from 'better-sqlite3'

/** 桌面无文件 ID 索引可供解析；删除旧附件锚点并改用路径字段。 */
export function initializeDesktopScheduledTaskFilePaths(db: SQLite.Database, validate: () => void): void {
  const columns = db.pragma('table_info(scheduled_tasks)') as { name: string }[]
  if (!columns.some(column => column.name === 'email_attachment_file_ids')
    || columns.some(column => column.name === 'email_attachment_file_paths')) return

  db.transaction(() => {
    db.exec('ALTER TABLE scheduled_tasks RENAME COLUMN email_attachment_file_ids TO email_attachment_file_paths')
    db.exec("UPDATE scheduled_tasks SET email_attachment_file_paths='[]' WHERE trim(email_attachment_file_paths) IS NOT '[]'")
    validate()
  }).immediate()
}
