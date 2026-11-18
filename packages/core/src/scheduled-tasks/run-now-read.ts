import { sql, type Kysely, type QueryExecutorProvider } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { integer, utc } from '../data/codec.js'
import { createWorkspaceShellTargetReader } from '../workspaces/shell-target.js'
import type { ScheduledTaskRunNowRecord } from './run-now.js'

function taskId(value: string): string {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new TypeError('定时任务 ID 无效')
  return value
}

function timestamp(value: unknown): number | null {
  if (value == null) return null
  const normalized = value instanceof Date ? value.toISOString() : utc(value).replace(' ', 'T')
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) throw new Error('定时任务时间无效')
  return parsed
}

/** owner-scoped immediate-run 状态读取；同一 SQL 合同支持 Core SQLite 与 PostgreSQL。 */
export function createKyselyScheduledTaskRunNowReader<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres') {
  return async function readOwned(rawOwner: string, rawTaskId: string): Promise<ScheduledTaskRunNowRecord | null> {
    const owner = dataContext(rawOwner).ownerId
    const id = taskId(rawTaskId)
    const user = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
    const result = await sql<Record<string, unknown>>`SELECT schedule_kind,enabled,end_at,last_run_failed FROM scheduled_tasks WHERE id=${id} AND user_id=${user} LIMIT 1`.execute(db)
    const row = result.rows[0]
    if (!row) return null
    if (!['once', 'cron', 'interval'].includes(String(row.schedule_kind))) throw new Error('定时任务类型无效')
    return {
      scheduleKind: row.schedule_kind as ScheduledTaskRunNowRecord['scheduleKind'],
      enabled: row.enabled === true || row.enabled === 1,
      endAt: timestamp(row.end_at),
      lastRunFailed: row.last_run_failed === true || row.last_run_failed === 1,
    }
  }
}

export interface ScheduledTaskExecutionPlan {
  id: string
  ownerId: string
  name: string
  payload: string
  channels: readonly string[]
  deliveryTargets: Readonly<Record<string, unknown>>
  /** 由 Host 确认归属的 IM 群范围。原始投递目标不能用于读取群上下文。 */
  groupScope?: Readonly<{
    ownerId: string
    platform: 'qq' | 'feishu' | 'telegram'
    botId: string
    scopeType: 'group'
    scopeId: string
  }>
  authorizedTools: readonly string[]
  emailAttachmentFileIds: readonly number[]
  workspaceId: number | null
  /** 准备时有效的授权引用。执行工具前仍须重新校验当前策略。 */
  filesystemGrantId: number | null
}

/** 写入尝试收据时锁住任务，确保撤权或改写指令与发送认领有明确顺序。 */
export async function hasScheduledEmailAuthorization(
  db: QueryExecutorProvider,
  backend: 'sqlite' | 'postgres',
  task: Pick<ScheduledTaskExecutionPlan, 'id' | 'ownerId' | 'name' | 'payload'>,
  now: number,
  lock = false,
): Promise<boolean> {
  const owner = dataContext(task.ownerId).ownerId
  const user = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const { rows: [row] } = await sql<Record<string, unknown>>`SELECT name,payload,authorized_tools,schedule_kind,end_at
    FROM scheduled_tasks WHERE id=${taskId(task.id)} AND user_id=${user} AND enabled=TRUE
    ${lock && backend === 'postgres' ? sql`FOR UPDATE` : sql``}`.execute(db)
  if (!row || row.name !== task.name || String(row.payload ?? '') !== task.payload) return false
  const allowed = decoded(row.authorized_tools)
  const end = timestamp(row.end_at)
  return Array.isArray(allowed) && allowed.includes('send_email')
    && (row.schedule_kind === 'once' || end === null || end > now)
}

function decoded(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 在租约内读取执行快照。停用渠道的旧目标不参与 Agent 上下文或投递。 */
export function createKyselyScheduledTaskExecutionReader<DB>(
  db: Kysely<DB>,
  backend: 'sqlite' | 'postgres',
  filesystemAuthorizationEnabled: () => boolean = () => false,
) {
  const readWorkspace = createWorkspaceShellTargetReader(db, backend)
  return async (rawOwner: string, rawTaskId: string, now = Date.now()): Promise<{ plan: ScheduledTaskExecutionPlan } | { error: string }> => {
    const ownerId = dataContext(rawOwner).ownerId
    const id = taskId(rawTaskId)
    const user = backend === 'sqlite' ? ownerId.replaceAll('-', '') : ownerId
    const { rows: [row] } = await sql<Record<string, unknown>>`SELECT name,payload,channels,delivery_targets,authorized_tools,
      email_attachment_file_ids,workspace_id,filesystem_authorization_grant_id,schedule_kind,end_at
      FROM scheduled_tasks WHERE id=${id} AND user_id=${user} AND enabled=TRUE`.execute(db)
    if (!row) return { error: '任务不存在或已停用' }
    const endsAt = timestamp(row.end_at)
    if (row.schedule_kind !== 'once' && endsAt !== null && endsAt <= now) return { error: '任务已结束' }
    const channels = [...new Set(String(row.channels ?? '').split(',').filter(Boolean))]
    const deliveryTargets = Object.fromEntries(Object.entries(record(decoded(row.delivery_targets)))
      .filter(([channel]) => channels.includes('im') || channels.includes(channel)))
    const groupCount = Object.values(deliveryTargets).filter(target => {
      const value = record(target)
      return value.chat_type === 'group' && Boolean(value.chat_id)
    }).length
    if (groupCount > 1) return { error: '一个定时任务目前只能设置一个群聊投递目标' }
    const workspaceId = row.workspace_id == null ? null : integer(row.workspace_id)
    if (workspaceId !== null && !await readWorkspace(ownerId, workspaceId))
      return { error: '任务工作区不可用，已跳过执行' }
    const grantId = row.filesystem_authorization_grant_id
    const grant = grantId != null && filesystemAuthorizationEnabled()
      ? (await sql<{ id: number }>`SELECT g.id FROM filesystem_authorization_grants g
          JOIN scheduled_tasks t ON t.filesystem_authorization_grant_id=g.id AND t.user_id=g.user_id
          WHERE t.id=${id} AND t.user_id=${user} AND t.enabled=TRUE AND t.event_id IS NULL
            AND g.id=${integer(grantId)} AND g.subject_type='scheduled_task' AND g.subject_id=${id}
            AND g.scope='user_sandbox' AND g.permission='read_write' AND g.revoked_at IS NULL
            AND (g.expires_at IS NULL OR g.expires_at>CURRENT_TIMESTAMP)`.execute(db)).rows[0]
      : undefined
    const authorizedTools = decoded(row.authorized_tools)
    const emailAttachmentFileIds = decoded(row.email_attachment_file_ids)
    return { plan: {
      ownerId, id, name: String(row.name), payload: String(row.payload ?? ''), channels, deliveryTargets,
      authorizedTools: Array.isArray(authorizedTools) ? authorizedTools.filter((name): name is string => typeof name === 'string') : [],
      emailAttachmentFileIds: Array.isArray(emailAttachmentFileIds) ? emailAttachmentFileIds.map(integer) : [],
      workspaceId,
      filesystemGrantId: grant ? integer(grant.id) : null,
    } }
  }
}

/** 仅缺少保存目标时才允许沿用默认地址。无效的保存目标必须拒绝。 */
export function parseScheduledTaskDeliveryTarget(targets: Readonly<Record<string, unknown>> | undefined, platform: string) {
  if (!targets || !Object.hasOwn(targets, platform)) return undefined
  const raw = targets[platform]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const channel = value.channel_id
  if (value.platform != null && value.platform !== platform) return null
  if (typeof channel !== 'number' && !(typeof channel === 'string' && /^[1-9]\d*$/.test(channel))) return null
  const botId = Number(channel)
  if (!Number.isSafeInteger(botId) || botId <= 0) return null
  if (value.chat_type !== 'c2c' && value.chat_type !== 'group') return null
  const group = value.chat_type === 'group'
  const recipient = group ? value.chat_id : value.puid
  if (typeof recipient !== 'string' || !recipient || recipient.length > 256 || recipient.trim() !== recipient) return null
  return { botId, group, recipient }
}

/** 群记忆与群历史只能使用当前归属明确的单群范围。SQLite 没有 IM Bot 账户表。 */
export function createKyselyScheduledTaskGroupScopeReader<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres') {
  return async (plan: ScheduledTaskExecutionPlan): Promise<ScheduledTaskExecutionPlan['groupScope'] | null> => {
    const groups = Object.entries(plan.deliveryTargets).filter(([, value]) => record(value).chat_type === 'group')
    if (groups.length === 0) return undefined
    if (groups.length !== 1 || backend !== 'postgres') return null
    const [platform] = groups[0]!
    if (platform !== 'qq' && platform !== 'feishu' && platform !== 'telegram') return null
    const target = parseScheduledTaskDeliveryTarget(plan.deliveryTargets, platform)
    if (!target?.group) return null
    const ownerId = dataContext(plan.ownerId).ownerId
    const botId = String(target.botId)
    const result = await sql`SELECT 1 FROM conversation_sessions s
      JOIN user_bots b ON b.user_id=s.user_id AND b.platform=s.source
      WHERE s.user_id=${ownerId} AND s.source=${platform} AND s.chat_type='group'
        AND s.bot_id=${botId} AND s.chat_id=${target.recipient} AND b.id=${target.botId} AND b.enabled=TRUE
      LIMIT 1`.execute(db)
    if (result.rows.length === 0) return null
    return { ownerId, platform, botId, scopeType: 'group', scopeId: target.recipient }
  }
}
