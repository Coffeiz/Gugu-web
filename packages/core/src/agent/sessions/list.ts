import { replacePlatformMentionIds } from '../context/messages/mentions.js'
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../../data/codec.js'

type Row = { title_bot_id?: string | null; id: number; title: string; source: string | null; chat_type: string | null; workspace_name: string | null; session_context: unknown; updated_at_iso: string; created_at_iso: string }
export interface AgentSessionListRuntime {
  activeStatuses(sessionIds: number[], ownerId: string): Promise<Map<number, boolean>>
  filesystemAuthorizationEnabled(): boolean
  workspaceShellSupported(): boolean
  /** SQLite 授权到期比较使用可信 UTC 时钟；PostgreSQL 使用数据库时钟。 */
  clock?: Clock
  /** SQLite 必须明确声明工作区存储是否装配；未装配时任何绑定均禁止读取。 */
  sqliteWorkspace?: 'available' | 'unavailable'
  /** 桌面 IM 的会话来源存放在本地连接映射表。 */
  desktopImSessions?: boolean
}
function isoUtc(value: string): string {
  const normalized = utc(value).replace(' ', 'T').replace(/\+00:00$/, '')
  return `${normalized.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')}Z`
}

function truth(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}
export function projectAgentSessionGoal(state: Record<string, unknown>): {
  goalActive: boolean; goalStatus: 'active' | 'paused' | null
} {
  const hasGoal = typeof state.goal_text === 'string' && state.goal_text.trim().length > 0
  const goalStatus = hasGoal ? state.goal_status === 'paused' ? 'paused' : 'active' : null
  return { goalActive: goalStatus === 'active' && truth(state.goal_mode), goalStatus }
}

export function applyAgentGoalCommand(context: Record<string, unknown>, action: 'status' | 'pause' | 'resume' | 'cancel') {
  const text = typeof context.goal_text === 'string' ? context.goal_text.trim() : ''
  if (action === 'status') return { changed: false, text: text
    ? `当前目标任务（${context.goal_status === 'paused' ? '已暂停' : '进行中'}）：${text}`
    : '当前会话没有进行中的目标任务。' }
  if (action === 'pause' && !text) return { changed: false, text: '当前会话没有可暂停的目标任务。' }
  if (action === 'resume' && !text) return { changed: false, text: '当前会话没有可恢复的目标任务。' }
  if (action === 'resume') context.goal_status = 'active'
  else if (action === 'pause') context.goal_status = 'paused'
  else {
    delete context.goal_text
    delete context.goal_status
  }
  context.goal_mode = action === 'resume'
  return { changed: true, text: action === 'resume' ? '目标任务已恢复。'
    : action === 'pause' ? '目标任务已暂停。发送 /goal resume 可继续。' : '已取消当前目标任务。' }
}

export function readAgentSessionContext(value: unknown, backend: 'postgres' | 'sqlite'): Record<string, unknown> {
  if (backend === 'sqlite' && typeof value === 'string') {
    try { value = JSON.parse(value) } catch { throw new CoreError('storage_error', '会话上下文数据格式无效') }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 状态、安全能力由可信 Host 注入；读取不声明跨 Redis 和数据库的原子快照。 */
export function createSqlAgentSessionLister(db: Kysely<any>, backend: 'postgres' | 'sqlite', runtime: AgentSessionListRuntime) {
  const key = (owner: string) => backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error) {
      const e = error as { code?: string; message?: string }
      if (backend === 'sqlite' && e.code === 'SQLITE_ERROR' && /no such table: (?:conversation_sessions|conversation_messages|workspaces|filesystem_authorization_grants)/.test(e.message ?? '')) throw new CoreError('schema_upgrade_required', 'Agent 会话列表所需数据表尚未初始化')
      throw error
    }
  }
  return async (ownerId: string) => guarded(async () => {
    const normalized = dataContext(ownerId).ownerId, owner = key(normalized)
    const sqliteShell = backend === 'sqlite' ? runtime.workspaceShellSupported() : false
    const sqliteEnabled = backend === 'sqlite' ? runtime.filesystemAuthorizationEnabled() : false
    if (backend === 'sqlite' && runtime.sqliteWorkspace !== 'available' && runtime.sqliteWorkspace !== 'unavailable') throw new CoreError('schema_upgrade_required', 'SQLite 工作区存储状态未明确装配')
    if (backend === 'sqlite' && runtime.sqliteWorkspace === 'unavailable' && sqliteShell) throw new CoreError('schema_upgrade_required', 'SQLite 工作区存储未装配')
    if (backend === 'sqlite' && sqliteEnabled) await sql`SELECT 1 FROM filesystem_authorization_grants LIMIT 0`.execute(db)
    const workspaceUnavailable = backend === 'sqlite' && runtime.sqliteWorkspace === 'unavailable'
    const workspaceName = workspaceUnavailable ? sql`NULL` : sql`w.name`
    const workspaceJoin = workspaceUnavailable ? sql`` : sql`LEFT JOIN workspaces w ON w.id=s.workspace_id AND w.user_id=s.user_id`
    const bound = workspaceUnavailable ? sql`EXISTS (SELECT 1 FROM conversation_sessions x WHERE x.user_id=${owner} AND x.workspace_id IS NOT NULL)` : sql`0`
    const updated = backend === 'postgres' ? sql`to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')` : sql`s.updated_at`
    const created = backend === 'postgres' ? sql`to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')` : sql`s.created_at`
    const titleBot = backend === 'postgres' ? sql`CASE WHEN s.source='qq' AND s.chat_type='group' AND NOT s.title_locked AND s.title LIKE '%<@%' THEN
      (SELECT m.platform_bot_user_id FROM conversation_messages m WHERE m.session_id=s.id AND m.platform_bot_user_id IS NOT NULL
        AND (strpos(s.title,'<@'||m.platform_bot_user_id||'>')>0 OR strpos(s.title,'<@!'||m.platform_bot_user_id||'>')>0)
        ORDER BY m.conversation_seq DESC LIMIT 1) END` : sql`NULL`
    const desktopIm = backend === 'sqlite' && runtime.desktopImSessions === true
    const sessionSource = desktopIm ? sql`COALESCE(im.platform,s.source)` : sql`s.source`
    const chatType = desktopIm ? sql`CASE WHEN im.platform IS NOT NULL THEN COALESCE(s.chat_type, 'c2c') ELSE s.chat_type END` : sql`s.chat_type`
    const imJoin = desktopIm ? sql`LEFT JOIN desktop_im_sessions im ON im.session_id=s.id AND im.owner_id=s.user_id` : sql``
    const desktopAccessible = desktopIm ? sql`AND (s.source IS NULL OR s.source='web')` : sql`AND s.source IS DISTINCT FROM 'subagent'`
    const load = async (connection: Kysely<any> | Transaction<any>, web: boolean) => {
      const source = web ? sql`(${sessionSource} IS NULL OR ${sessionSource}='web')` : sql`(${sessionSource} IS NOT NULL AND ${sessionSource}<>'web')`
      return (await sql<Row>`SELECT s.id,s.title,${titleBot} AS title_bot_id,${sessionSource} AS source,${chatType} AS chat_type,${workspaceName} AS workspace_name,s.session_context,${updated} AS updated_at_iso,${created} AS created_at_iso,${bound} AS unavailable_workspace_bound FROM conversation_sessions s ${workspaceJoin} ${imJoin} WHERE s.user_id=${owner} ${desktopAccessible} AND ${source} ORDER BY s.updated_at DESC LIMIT 50`.execute(connection)).rows
    }
    const [web, im] = backend === 'sqlite'
      ? await db.transaction().execute(async tx => {
          // 校验与筛选处于同一事务快照，不在事务中等待 Host 状态服务。
          const dates = await sql<{ created_at: string; updated_at: string }>`SELECT created_at,updated_at FROM conversation_sessions WHERE user_id=${owner}`.execute(tx)
          for (const row of dates.rows) for (const value of [row.created_at, row.updated_at])
            if (databaseTime(value, 'sqlite') !== value) throw new CoreError('storage_error', '会话时间不是规范 UTC 微秒格式')
          const first = await load(tx, true), second = await load(tx, false)
          return [first, second] as const
        })
      : await Promise.all([load(db, true), load(db, false)])
    const sessions = [...web, ...im].sort((a, b) => b.updated_at_iso.localeCompare(a.updated_at_iso))
    if (workspaceUnavailable && sessions.some(row => Boolean((row as Row & { unavailable_workspace_bound?: number }).unavailable_workspace_bound))) throw new CoreError('schema_upgrade_required', 'SQLite 会话包含未支持的工作区绑定')
    if (!sessions.length) return []
    const enabled = backend === 'sqlite' ? sqliteEnabled : runtime.filesystemAuthorizationEnabled()
    const ids = sessions.map(row => row.id), webIds = sessions.filter(row => !row.source || row.source === 'web').map(row => row.id)
    const files = backend === 'postgres' ? sql`message.files::text` : sql`message.files`
    const cutoff = backend === 'sqlite' && enabled ? databaseTime((runtime.clock ?? nowUtc)(), 'sqlite') : null
    const unexpired = backend === 'postgres' ? sql`AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)` : sql``
    const [running, grantRows, replies] = await Promise.all([
      runtime.activeStatuses(ids, normalized),
      enabled ? sql<{ subject_id: string; expires_at: string | null }>`SELECT subject_id,expires_at FROM filesystem_authorization_grants WHERE user_id=${owner} AND subject_type='session' AND revoked_at IS NULL ${unexpired}`.execute(db).then(result => result.rows) : Promise.resolve([]),
      webIds.length ? sql<{ session_id: number; id: number }>`WITH latest AS (SELECT session_id,max(conversation_seq) AS conversation_seq FROM conversation_messages AS message WHERE session_id IN (${sql.join(webIds)}) AND role='assistant' AND content_json IS NULL AND (content<>'' OR (files IS NOT NULL AND ${files} NOT IN ('[]','null'))) GROUP BY session_id) SELECT message.session_id,message.id FROM conversation_messages message JOIN latest ON latest.session_id=message.session_id AND latest.conversation_seq=message.conversation_seq`.execute(db).then(result => result.rows) : Promise.resolve([]),
    ])
    const grants = new Set(grantRows.filter(row => backend === 'postgres' || row.expires_at === null || databaseTime(row.expires_at, 'sqlite') > cutoff!).map(row => /^\d+$/.test(row.subject_id) ? Number(row.subject_id) : 0).filter(id => id > 0))
    const last = new Map(replies.map(row => [row.session_id, row.id])), shell = backend === 'sqlite' ? sqliteShell : runtime.workspaceShellSupported()
    return sessions.map(session => {
      const state = readAgentSessionContext(session.session_context, backend), row: Record<string, unknown> = {
        id: session.id, title: session.title_bot_id ? replacePlatformMentionIds(session.title, new Map([[session.title_bot_id, '咕咕']])) : session.title, source: session.source, chatType: session.chat_type,
        workspaceName: shell ? session.workspace_name : null,
        ...projectAgentSessionGoal(state),
        filesystemAuthorized: enabled && grants.has(session.id), filesystemAuthorizationEnabled: enabled,
        updatedAt: isoUtc(session.updated_at_iso), createdAt: isoUtc(session.created_at_iso), isRunning: running.get(session.id),
      }
      if (!session.source || session.source === 'web') row.lastAssistantId = last.get(session.id) ?? 0
      return row
    })
  })
}

/** 借用连接池，生命周期由 Host 负责。 */
export function createPostgresAgentSessionLister(pool: Pick<Pool, 'query' | 'connect'>, runtime: AgentSessionListRuntime) {
  return createSqlAgentSessionLister(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }), 'postgres', runtime)
}
