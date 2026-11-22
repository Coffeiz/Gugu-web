import type SQLite from 'better-sqlite3'

/** 事件写入后不再变化，检查点每次提交都刷新，二者共同构成保留期的时间基准。 */
export const AGENT_RUN_EVENT_TIME_COLUMN = 'created_at_ms'
export const AGENT_RUN_CHECKPOINT_TIME_COLUMN = 'updated_at_ms'

/**
 * 本地时间戳形如 `2026-11-22 06:39:00.123456`，一律是 UTC 且不带时区标记。
 * 直接交给 Date.parse 会被当成本机时间，必须显式补 Z。
 */
function sqliteTimeToMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim())
  if (!match) return null
  const milliseconds = Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function tableColumns(db: SQLite.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name)
}

function ensureTimeColumn(db: SQLite.Database, table: string, column: string): void {
  if (tableColumns(db, table).includes(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
}

/**
 * 历史运行没有写入时间，用会话正文时间回填：
 * 优先取带 run_id 的消息（运行收尾时写入），其次取准入那条用户消息。
 * 两条都拿不到时按迁移时刻回填，保证时间基准不为空。
 */
function backfillRunTimestamps(db: SQLite.Database, now: number): void {
  const runs = db.prepare(`SELECT user_id, session_id, run_id FROM agent_run_checkpoints
    WHERE ${AGENT_RUN_CHECKPOINT_TIME_COLUMN} = 0`).all() as {
    user_id: string
    session_id: number
    run_id: string
  }[]
  if (!runs.length) return
  const messageTimes = db.prepare(`SELECT m.created_at AS created_at FROM conversation_messages m
    WHERE m.session_id = ? AND m.run_id = ?`)
  const admissionTimes = db.prepare(`SELECT m.created_at AS created_at FROM agent_run_admissions a
    JOIN conversation_messages m ON m.id = a.user_message_id
    WHERE a.user_id = ? AND a.session_id = ? AND a.run_id = ?`)
  const updateCheckpoint = db.prepare(`UPDATE agent_run_checkpoints SET ${AGENT_RUN_CHECKPOINT_TIME_COLUMN} = ?
    WHERE user_id = ? AND session_id = ? AND run_id = ? AND ${AGENT_RUN_CHECKPOINT_TIME_COLUMN} = 0`)
  const updateEvent = db.prepare(`UPDATE agent_run_events SET ${AGENT_RUN_EVENT_TIME_COLUMN} = ?
    WHERE user_id = ? AND session_id = ? AND run_id = ? AND ${AGENT_RUN_EVENT_TIME_COLUMN} = 0`)
  for (const run of runs) {
    const candidates = [
      ...(messageTimes.all(run.session_id, run.run_id) as { created_at: unknown }[]),
      ...(admissionTimes.all(run.user_id, run.session_id, run.run_id) as { created_at: unknown }[]),
    ].map(row => sqliteTimeToMs(row.created_at)).filter((value): value is number => value !== null)
    const last = candidates.length ? Math.max(...candidates) : now
    const first = candidates.length ? Math.min(...candidates) : now
    updateCheckpoint.run(last, run.user_id, run.session_id, run.run_id)
    updateEvent.run(first, run.user_id, run.session_id, run.run_id)
  }
}

/**
 * 在现有桌面库中安装 Agent Run 保留期时间列。
 * 事件表是追加日志，检查点表是原地重写，二者都从建表起没有任何删除路径，
 * 没有时间基准就无法判断哪些运行已经过期。
 */
export function initializeDesktopAgentRunRetention(db: SQLite.Database): void {
  db.transaction(() => {
    ensureTimeColumn(db, 'agent_run_events', AGENT_RUN_EVENT_TIME_COLUMN)
    ensureTimeColumn(db, 'agent_run_checkpoints', AGENT_RUN_CHECKPOINT_TIME_COLUMN)
    backfillRunTimestamps(db, Date.now())
    db.exec(`CREATE INDEX IF NOT EXISTS ix_agent_run_checkpoints_retention
      ON agent_run_checkpoints(status, ${AGENT_RUN_CHECKPOINT_TIME_COLUMN})`)
    db.exec(`CREATE INDEX IF NOT EXISTS ix_agent_run_events_retention
      ON agent_run_events(${AGENT_RUN_EVENT_TIME_COLUMN})`)
  }).immediate()
}
