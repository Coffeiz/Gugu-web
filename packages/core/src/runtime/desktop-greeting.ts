import { sql, type Kysely } from 'kysely'
import type { Database } from '../data/schema.js'
import type { GreetingProject } from '../agent/greeting.js'
import { createGreetingScene, type GreetingSourceId } from '../agent/scenes/greeting/definition.js'
import { readAgentMemoryDaily, readAgentMemoryProfile, readAgentMemoryStance, readAgentMemorySummary, type AgentMemoryContextStorage } from '../agent/memory/context.js'
import { dataContext } from '../contracts/index.js'
import { readSqliteGreetingMemoryTarget } from '../agent/memory/sqlite.js'
import type { DesktopMemoryFiles } from '../agent/memory/desktop-files.js'
import { parseOwnerDailyEntries } from '../memory/owner-daily-compaction.js'
import { createDesktopAppearanceService } from '../preferences/desktop-appearance.js'
import { createKyselyPreferenceDocumentStore } from '../preferences/document-store.js'

function timestamp(value: number | null): Date | null {
  const date = new Date((value ?? 0) * 1000)
  return value && Number.isFinite(date.getTime()) ? date : null
}

export async function buildDesktopGreetingPrompt(db: Kysely<Database>, ownerId: string, locale: string,
  signal: AbortSignal, memoryFiles?: DesktopMemoryFiles, selected?: readonly GreetingSourceId[]) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const preferences = createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite'))
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // SQLite 文档优先，兼容旧文件。每个来源只查询自己的记忆目标。
  async function readTarget(target: 'profile' | 'summary' | 'daily' | 'stance', sourceSignal: AbortSignal): Promise<AgentMemoryContextStorage> {
    const body = await readSqliteGreetingMemoryTarget(db, ownerId, target, sourceSignal, memoryFiles)
    const extension = target === 'daily' ? 'md' : 'json'
    return {
      async readText(input) {
        const key = `${ownerId}/.agent/memories/${target}.${extension}`
        return input.ownerId === ownerId && input.key === key ? body?.slice(0, input.maxChars) ?? null : null
      },
    }
  }
  const scene = createGreetingScene({
    async 'clock.now'() {
      const result = await preferences.get(ownerId)
      return { timeZone: result.timezone ?? timezone }
    },
    async 'greeting.last-seen'() {
      const messages = await sql<{ created_at: string }>`SELECT m.created_at FROM conversation_messages m
        JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=${owner}
        ORDER BY m.created_at DESC LIMIT 1`.execute(db)
      const lastMessageAt = new Date(messages.rows[0]?.created_at ?? '')
      return { lastMessageAt: Number.isFinite(lastMessageAt.getTime()) ? lastMessageAt : null }
    },
    async 'overview.projects'() {
      const projects = await sql<GreetingProject>`SELECT id,name,status,progress,priority,start_date AS "startDate",deadline FROM projects
        WHERE user_id=${owner} AND deleted_at IS NULL AND archived=0 AND status IN ('pending','active')`.execute(db)
      return { projects: projects.rows }
    },
    async 'user.profile'(_, sourceSignal) {
      const storage = await readTarget('profile', sourceSignal)
      return { memory: { profile: await readAgentMemoryProfile(storage, ownerId, sourceSignal) } }
    },
    async 'memory.summary'(_, sourceSignal) {
      const storage = await readTarget('summary', sourceSignal)
      const summary = await readAgentMemorySummary(storage, ownerId, sourceSignal)
      return { memory: { summary: summary.text, summaryAt: timestamp(summary.ts) } }
    },
    async 'memory.daily'(_, sourceSignal) {
      const storage = await readTarget('daily', sourceSignal)
      const daily = await readAgentMemoryDaily(storage, ownerId, sourceSignal)
      return { memory: { daily: parseOwnerDailyEntries(daily).map(([date, note]) => ({ date, note })) } }
    },
    async 'greeting.recent-stance'(_, sourceSignal) {
      const storage = await readTarget('stance', sourceSignal)
      const stance = await readAgentMemoryStance(storage, ownerId, sourceSignal)
      return { stance: stance.stance ? { value: stance.stance, updatedAt: timestamp(stance.ts) } : null }
    },
  }, timezone, selected)
  return scene.preparePrompt(ownerId, locale, () => new Date(), signal)
}
