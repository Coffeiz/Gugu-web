import { sql, type Kysely } from 'kysely'
import type { Database } from '../data/schema.js'
import { buildGreetingPrompt, type GreetingProject } from '../agent/greeting.js'
import type { DesktopMemoryFiles } from '../agent/memory/desktop-files.js'
import { readSqliteAgentMemory } from '../agent/memory/sqlite.js'
import { parseOwnerDailyEntries } from '../memory/owner-daily-compaction.js'
import { createDesktopAppearanceService } from '../preferences/desktop-appearance.js'
import { createKyselyPreferenceDocumentStore } from '../preferences/document-store.js'

function timestamp(value: number | null): Date | null {
  const date = new Date((value ?? 0) * 1000)
  return value && Number.isFinite(date.getTime()) ? date : null
}

export async function buildDesktopGreetingPrompt(db: Kysely<Database>, ownerId: string, locale: string,
  signal: AbortSignal, memoryFiles?: DesktopMemoryFiles) {
  const owner = ownerId.replaceAll('-', '')
  const preferences = createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite'))
  const [{ memory }, { timezone }, messages, projects] = await Promise.all([
    readSqliteAgentMemory(db, ownerId, '', signal, undefined, memoryFiles),
    preferences.get(ownerId),
    sql<{ created_at: string }>`SELECT m.created_at FROM conversation_messages m
      JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=${owner}
      ORDER BY m.created_at DESC LIMIT 1`.execute(db),
    sql<GreetingProject>`SELECT id,name,status,progress,priority,start_date AS "startDate",deadline FROM projects
      WHERE user_id=${owner} AND deleted_at IS NULL AND archived=0 AND status IN ('pending','active')`.execute(db),
  ])
  signal.throwIfAborted()
  const lastMessageAt = new Date(messages.rows[0]?.created_at ?? '')
  return buildGreetingPrompt({
    locale, now: new Date(), timeZone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    lastMessageAt: Number.isFinite(lastMessageAt.getTime()) ? lastMessageAt : null,
    projects: projects.rows,
    memory: {
      summary: memory.summary, summaryAt: timestamp(memory.summary_ts), profile: memory.profile,
      daily: parseOwnerDailyEntries(memory.daily).map(([date, note]) => ({ date, note })),
    },
    stance: memory.stance ? { value: memory.stance, updatedAt: timestamp(memory.stance_ts) } : null,
  })
}
