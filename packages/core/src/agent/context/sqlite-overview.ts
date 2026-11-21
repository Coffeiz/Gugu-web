import { sql, type Kysely } from 'kysely'
import { databaseTime, utc } from '../../data/codec.js'
import type { Database } from '../../data/schema.js'
import { dateKeyInTimeZone } from '../../shared/date-time.js'
import { normalizePreferenceText, readDecisionGuardPreference } from '../../preferences/general.js'
import type { RunIdentity } from '../models.js'
import type { Json } from '../models.js'
import { sqliteAgentRunScope } from '../run/sqlite-store.js'
import { buildAgentDynamicSnapshot, formatAgentProjects, formatAgentSource } from './prompt-format.js'

export interface SqliteAgentOverviewData {
  projects: Json
  events: Json
  notes: Json
}

function preferenceRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** 从当前 owner 的本机偏好文档读取 Web Agent 使用的回复风格设置。 */
export async function readSqliteAgentStylePreferences(db: Kysely<Database>, identity: RunIdentity,
  signal: AbortSignal): Promise<Record<string, Json>> {
  signal.throwIfAborted()
  const { owner, session, run } = sqliteAgentRunScope(identity)
  return db.transaction().execute(async tx => {
    const { rows } = await sql<{ data_json: string | null }>`
      SELECT p.data_json FROM conversation_sessions s
      LEFT JOIN user_preferences p ON p.user_id=s.user_id
      WHERE s.id=${session} AND s.user_id=${owner} AND s.active_run_id=${run}
        AND (s.source IS NULL OR s.source='web')`.execute(tx)
    signal.throwIfAborted()
    if (!rows.length) throw new Error('本机会话上下文不存在')
    const data = preferenceRecord(rows[0]!.data_json)
    const output: Record<string, Json> = {}
    if (readDecisionGuardPreference(data)) output.decision_guard_enabled = true
    const enabled = data.custom_reply_style_enabled != null && data.custom_reply_style_enabled !== false
      && data.custom_reply_style_enabled !== 0 && data.custom_reply_style_enabled !== ''
    if (enabled) output.custom_reply_style_enabled = true
    const reply = normalizePreferenceText(data.custom_reply_style, '回复风格')
    if (reply) output.custom_reply_style = reply
    if (typeof data.locale === 'string' && ['zh-CN', 'ja-JP', 'en-US'].includes(data.locale)) output.locale = data.locale
    output.personality_preference_enabled = false
    const revision = Number(data.personality_preference_revision)
    output.personality_preference_revision = Number.isSafeInteger(revision) && revision > 0 ? revision : 0
    signal.throwIfAborted()
    return output
  })
}

/** 读取桌面当前已接入的低频来源，固定在当前 owner 会话的 SQLite 读取视图。 */
export async function readSqliteAgentOverviewData(db: Kysely<Database>, identity: RunIdentity,
  timezone: string, signal: AbortSignal): Promise<SqliteAgentOverviewData> {
  signal.throwIfAborted()
  const { owner, session, run } = sqliteAgentRunScope(identity)
  const now = new Date()
  return db.transaction().execute(async tx => {
    const allowed = await sql`SELECT 1 FROM conversation_sessions
      WHERE id=${session} AND user_id=${owner} AND active_run_id=${run} AND (source IS NULL OR source='web')`.execute(tx)
    if (!allowed.rows.length) throw new Error('本机会话上下文不存在')
    const projects = await sql<{
      id: number; name: string; status: string; deadline: string | null; contact_name: string | null
      summary: string | null; stages_json: string
    }>`
      SELECT id,name,status,deadline,contact_name,summary,stages_json FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY status ORDER BY
          CASE priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
          CASE status WHEN 'active' THEN coalesce(deadline,'') WHEN 'pending' THEN coalesce(start_date,'') END,
          CASE WHEN status='done' THEN done_at END DESC,id) AS rank
        FROM projects WHERE user_id=${owner} AND deleted_at IS NULL AND archived=0 AND status IN ('pending','active','done')
      ) WHERE rank <= CASE status WHEN 'active' THEN 10 WHEN 'pending' THEN 5 ELSE 3 END
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,rank`.execute(tx)
    signal.throwIfAborted()
    const events = await sql<{ date: string; title: string }>`SELECT date,title FROM calendar_events
      WHERE user_id=${owner} AND deleted_at IS NULL AND date>=${dateKeyInTimeZone(now, timezone)} ORDER BY date,id LIMIT 10`.execute(tx)
    const since = databaseTime(new Date(now.getTime() - 7 * 86_400_000).toISOString(), 'sqlite')
    const notes = await sql<{ title: string | null; content_plain: string; content_md: string; captured_at: string }>`
      SELECT title,content_plain,content_md,captured_at FROM mind_nodes
      WHERE user_id=${owner} AND kind='note' AND deleted_at IS NULL AND captured_at>=${since}
      ORDER BY captured_at DESC,id DESC LIMIT 20`.execute(tx)
    signal.throwIfAborted()
    return {
      projects: projects.rows.map(row => {
        const stages: unknown = JSON.parse(row.stages_json)
        if (!Array.isArray(stages)) throw new Error('项目阶段无效')
        return { id: row.id, name: row.name, status: row.status, deadline: row.deadline, contact: row.contact_name,
          summary: row.summary, stagesDone: stages.filter(stage => stage?.done === true).length, stagesTotal: stages.length }
      }) as Json,
      events: events.rows as Json,
      notes: notes.rows.map(row => ({ title: row.title?.trim() ?? null,
        content: Array.from((row.content_plain || row.content_md).trim()).slice(0, 500).join(''),
        capturedAt: utc(row.captured_at).replace(' ', 'T') })) as Json,
    }
  })
}

/** 桌面与 Web 共用 Core 的动态快照格式化规则。 */
export function formatSqliteAgentOverview(data: SqliteAgentOverviewData, memoryBlock: string,
  files: Record<string, Json> = {}, knowledge: readonly Record<string, unknown>[] = [],
  channels?: Readonly<Record<string, boolean>>): string {
  return buildAgentDynamicSnapshot({
    memoryBlock, sourceBlock: channels ? formatAgentSource(null, channels, false) : '', projectBlock: formatAgentProjects(data.projects),
    events: data.events as Array<{ date: string; title: string }>,
    notes: data.notes as Array<{ title: string | null; content: string; capturedAt: string }>,
    files: files as unknown as Parameters<typeof buildAgentDynamicSnapshot>[0]['files'], knowledge,
    includeProjects: true, includeCalendar: true, includeFiles: true, includeKnowledge: true,
  })
}

export async function readSqliteAgentOverview(db: Kysely<Database>, identity: RunIdentity,
  timezone: string, memoryBlock: string, signal: AbortSignal): Promise<string> {
  return formatSqliteAgentOverview(await readSqliteAgentOverviewData(db, identity, timezone, signal), memoryBlock)
}
