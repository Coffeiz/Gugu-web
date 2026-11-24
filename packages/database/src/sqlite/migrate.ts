export { initializeDesktopScheduledTaskFilePaths } from './migrations/0027_desktop_scheduled_task_file_paths.js'
export { initializeDesktopImportedMemory } from './migrations/0026_desktop_imported_memory.js'
export { initializeDesktopAgentRunRetention } from './migrations/0025_desktop_agent_run_retention.js'
export { initializeDesktopSubagentSessionInbox } from './migrations/0024_desktop_subagent_session_inbox.js'
export { initializeDesktopSubagentAdmissions } from './migrations/0023_desktop_subagent_admissions.js'
export { initializeDesktopSubagentExecutions } from './migrations/0022_desktop_subagent_executions.js'
export { initializeDesktopSubagentContinuations } from './migrations/0021_desktop_subagent_continuations.js'
export { initializeDesktopSubagentConversations } from './migrations/0020_desktop_subagent_conversations.js'
export { initializeDesktopAgentInbox } from './migrations/0019_desktop_agent_inbox.js'
export { initializeDesktopSubagentWaits } from './migrations/0018_desktop_subagent_waits.js'
export { initializeDesktopSubagentLaunches } from './migrations/0017_desktop_subagent_launches.js'
export { initializeDesktopSubagentSessions } from './migrations/0016_desktop_subagent_sessions.js'
export { initializeDesktopSubagentDeliveries } from './migrations/0015_desktop_subagent_deliveries.js'
export { initializeDesktopAgentCredentials } from './migrations/0012_desktop_agent_credentials.js'
export { initializeDesktopImReflection } from './migrations/0013_desktop_im_reflection.js'
export { initializeDesktopImAcceptedFacts } from './migrations/0014_desktop_im_accepted_facts.js'
export { initializeDesktopImProjection } from './migrations/0011_desktop_im_projection.js'
export { initializeDesktopAgentContinuations } from './migrations/0010_desktop_agent_continuations.js'
export { initializeDesktopImInbox } from './migrations/0009_desktop_im_inbox.js'
export { initializeDesktopAgentConfirmations } from './migrations/0007_desktop_agent_confirmations.js'
export { initializeDesktopChatAttachments } from './migrations/0008_desktop_chat_attachments.js'
export { initializeDesktopAgentInteractions } from './migrations/0006_desktop_agent_interactions.js'
export { initializeDesktopAgentMemory } from './migrations/0005_desktop_agent_memory.js'
export { initializeDesktopAgentRuns } from './migrations/0004_desktop_agent_runs.js'
export { initializeDesktopScheduleMode } from './migrations/0003_desktop_schedule_mode.js'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type SQLite from 'better-sqlite3'
import { DatabaseError } from '../shared/error.js'
import { configureSqlite, loadSqliteDriver } from './driver.js'
import type { MigrationAction, MigrationStatus } from '../shared/command.js'
import { initializeSchema } from './migrations/0001_initialize.js'
export { initializeDesktopSkills } from './migrations/0002_desktop_skills.js'
import { validateSqliteBaseline } from './validate.js'

async function createDatabase(path: string): Promise<boolean> {
  const target = resolve(path),
    parent = dirname(target),
    Driver = await loadSqliteDriver()
  if (existsSync(target)) return false
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, '.core-initialize-')),
    temporary = join(directory, 'core.db')
  let db: SQLite.Database | undefined
  try {
    closeSync(openSync(temporary, 'wx', 0o600))
    db = new Driver(temporary)
    configureSqlite(db)
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal')
      throw new DatabaseError('storage_error', '本地数据库无法启用 WAL')
    db.exec('BEGIN IMMEDIATE')
    initializeSchema(db)
    validateSqliteBaseline(db)
    db.exec('COMMIT')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    db = undefined
    // 完整文件发布前目标不可见；硬链接不覆盖已出现的用户文件。
    try { linkSync(temporary, target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    return true
  } finally {
    db?.close()
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(temporary + suffix)) unlinkSync(temporary + suffix)
    rmdirSync(directory)
  }
}
export async function initializeSqlite(path: string): Promise<void> {
  if (!await createDatabase(path)) throw new DatabaseError('storage_error', '数据库已存在，已拒绝覆盖')
}

export async function migrateSqlite(path: string, action: MigrationAction): Promise<MigrationStatus> {
  const target = resolve(path)
  if (action === 'apply' && await createDatabase(target)) return 'applied'
  if (!existsSync(target)) return 'pending'
  const Driver = await loadSqliteDriver()
  const db = new Driver(target, { readonly: true, fileMustExist: true })
  try {
    validateSqliteBaseline(db)
    return action === 'check' ? 'applied' : 'unchanged'
  } finally {
    db.close()
  }
}
