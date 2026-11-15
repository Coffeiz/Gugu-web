import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { integer, utc, nowUtc, type Clock } from '../data/codec.js'
import { asciiDecimalDigits, isDecimalDigits, isDigitString } from '../shared/unicode-decimal.js'

type Backend = 'sqlite' | 'postgres'
export interface ScheduledTaskCapabilities { workspaceSupported: boolean; filesystemAuthorizationEnabled: boolean }
export interface ScheduledTaskListRow {
  id: number; name: string; payload: string; cron: string; schedule_kind: string; interval_minutes: number | null
  start_at: string | null; end_at: string | null; channels: string; enabled: boolean; event_id: number | null
  workspace_id: number | null; filesystem_authorization_grant_id: number | null; last_run_at: string | null
  last_run_failed: boolean; delivery_targets: unknown; authorized_tools: unknown; email_attachment_file_ids: unknown
}
const stamp = (value: unknown): string | null => value == null ? null : utc(value).replace(' ', 'T')
const json = (value: unknown, backend: Backend) => backend === 'sqlite' && typeof value === 'string' ? JSON.parse(value) : value

/** 只读 owner-scoped 任务数据；不清理、认领或执行任务。 */
export function createKyselyScheduledTaskReader<DB>(db: Kysely<DB>, backend: Backend) {
  const time = (column: string) => backend === 'postgres'
    ? sql`to_char(${sql.ref(column)} AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`
    : sql.ref(column)
  return async (rawOwner: string, eventId: number | null, signal?: AbortSignal): Promise<ScheduledTaskListRow[]> => {
    signal?.throwIfAborted()
    const owner = dataContext(rawOwner).ownerId
    const ownerKey = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
    try {
      const event = eventId === null ? sql`event_id IS NULL` : sql`event_id=${eventId}`
      const result = await sql<Record<string, unknown>>`SELECT id,name,payload,cron,schedule_kind,interval_minutes,
        ${time('start_at')} AS start_at,${time('end_at')} AS end_at,channels,enabled,event_id,workspace_id,filesystem_authorization_grant_id,
        ${time('last_run_at')} AS last_run_at,last_run_failed,delivery_targets,authorized_tools,email_attachment_file_ids
        FROM scheduled_tasks WHERE user_id=${ownerKey} AND ${event} ORDER BY id DESC`.execute(db)
      return result.rows.map(row => ({
        id: integer(row.id), name: String(row.name), payload: String(row.payload), cron: String(row.cron), schedule_kind: String(row.schedule_kind),
        interval_minutes: row.interval_minutes == null ? null : integer(row.interval_minutes), start_at: stamp(row.start_at), end_at: stamp(row.end_at),
        channels: String(row.channels ?? ''), enabled: Boolean(row.enabled), event_id: row.event_id == null ? null : integer(row.event_id),
        workspace_id: row.workspace_id == null ? null : integer(row.workspace_id), filesystem_authorization_grant_id: row.filesystem_authorization_grant_id == null ? null : integer(row.filesystem_authorization_grant_id),
        last_run_at: stamp(row.last_run_at), last_run_failed: Boolean(row.last_run_failed), delivery_targets: json(row.delivery_targets, backend),
        authorized_tools: json(row.authorized_tools, backend), email_attachment_file_ids: json(row.email_attachment_file_ids, backend),
      }))
    } finally { signal?.throwIfAborted() }
  }
}
function status(row: ScheduledTaskListRow, now: string): string {
  if (!['once', 'cron', 'interval'].includes(row.schedule_kind)) throw new Error('数据库中的 schedule_kind 非法')
  if (row.schedule_kind !== 'once' && row.end_at && utc(row.end_at) <= utc(now)) return 'ended'
  return row.enabled ? 'active' : 'disabled'
}
function when(row: ScheduledTaskListRow): string {
  if (row.schedule_kind === 'interval') return `每 ${row.interval_minutes} 分钟`
  if (row.cron.startsWith('@once:')) return `一次性 ${row.cron.slice(6).replace('T', ' ')}`
  const parts = row.cron.trim().split(/\s+/)
  if (parts.length !== 5) return row.cron
  const [m, h, dom, mon, dow] = parts as [string,string,string,string,string]
  let time = `${h}:${m}`
  if (isDigitString(h) && isDigitString(m)) {
    if (!isDecimalDigits(h) || !isDecimalDigits(m)) throw new Error('定时任务时间不是十进制数字')
    const format = (value: string) => asciiDecimalDigits(value).replace(/^0+(?=\d)/, '').padStart(2, '0')
    time = `${format(h)}:${format(m)}`
  }
  const days: Record<string, string> = { '0':'周日','1':'周一','2':'周二','3':'周三','4':'周四','5':'周五','6':'周六','7':'周日' }
  if (dom === '*' && mon === '*' && dow === '*') return `每天 ${time}`
  if (dom === '*' && mon === '*' && days[dow]) return `每${days[dow]} ${time}`
  if (dow === '*' && mon === '*' && isDigitString(dom)) return `每月${dom}号 ${time}`
  return row.cron
}
const zulu = (value: string | null) => value === null ? null : value.replace('+00:00', 'Z')
export function projectScheduledTaskForAgent(row: ScheduledTaskListRow, capabilities: ScheduledTaskCapabilities, clock: Clock = nowUtc) {
  return { id: row.id, name: row.name, when: when(row), schedule_kind: row.schedule_kind, cron: row.cron,
    interval_minutes: row.interval_minutes, start_at: zulu(row.start_at), end_at: zulu(row.end_at), schedule_status: status(row, clock()),
    instruction: row.payload, channels: row.channels.split(',').filter(Boolean), enabled: row.enabled, last_run_at: row.last_run_at,
    delivery_targets: row.delivery_targets, authorized_tools: row.authorized_tools || [], email_attachment_file_ids: row.email_attachment_file_ids || [],
    workspace_id: capabilities.workspaceSupported ? row.workspace_id : null,
    filesystem_authorized: capabilities.filesystemAuthorizationEnabled && row.filesystem_authorization_grant_id !== null }
}
export function projectScheduledTaskForWeb(row: ScheduledTaskListRow, filesystemAuthorizationEnabled: boolean, clock: Clock = nowUtc) {
  return { id: row.id, name: row.name, payload: row.payload, cron: row.cron, schedule_kind: row.schedule_kind,
    interval_minutes: row.interval_minutes, start_at: zulu(row.start_at), end_at: zulu(row.end_at), schedule_status: status(row, clock()),
    channels: row.channels.split(',').filter(Boolean), enabled: row.enabled, event_id: row.event_id, workspace_id: row.workspace_id,
    filesystem_authorized: filesystemAuthorizationEnabled && row.filesystem_authorization_grant_id !== null,
    last_run_at: zulu(row.last_run_at), last_run_failed: row.last_run_failed, delivery_targets: row.delivery_targets,
    authorized_tools: row.authorized_tools || [], email_attachment_file_ids: row.email_attachment_file_ids || [] }
}

/** 能力由宿主装配，调用方只能提供 owner 与事件范围。 */
export function createScheduledTaskQueries(
  read: ReturnType<typeof createKyselyScheduledTaskReader>,
  capabilities: () => ScheduledTaskCapabilities,
  clock: Clock = nowUtc,
) {
  return {
    async agent(ownerId: string, signal?: AbortSignal) {
      const rows = await read(ownerId, null, signal)
      const trusted = capabilities()
      return rows.map(row => projectScheduledTaskForAgent(row, trusted, clock))
    },
    async web(ownerId: string, eventId: number | null, signal?: AbortSignal) {
      const rows = await read(ownerId, eventId, signal)
      const trusted = capabilities()
      return { tasks: rows.map(row => projectScheduledTaskForWeb(row, trusted.filesystemAuthorizationEnabled, clock)) }
    },
  }
}
