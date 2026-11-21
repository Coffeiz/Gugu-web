import type { Pool, PoolClient } from 'pg'
import { CompiledQuery, type Transaction } from 'kysely'
import type { Database } from '@gugu/core/data'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import { isPostgresUniqueViolation } from '../../adapters/database/postgres-errors.js'
import { scheduleTimestamp, type ScheduleSpec, scheduleMicroseconds, shanghaiWallMilliseconds } from '@gugu/core/scheduled-task-schedule'
import { createScheduledTask, normalizeScheduledTaskChannels, normalizeScheduledTaskContext, normalizeScheduledTaskTools, updateScheduledTask, type ScheduledTaskCreateInput, type ScheduledTaskPatch, type ScheduledTaskPreparedUpdate, ScheduledTaskReferenceError } from '@gugu/core/scheduled-task-write'
import { taskPreciseColumns, taskResponse } from './routes.js'
import { scheduledTaskUndoSnapshot } from '@gugu/core/calendar'
import { createHmac } from 'node:crypto'

type TaskWriteQuery = Pick<PoolClient, 'query'>

type TaskRow = Record<string, any> & { schedule_kind: string; end_at: Date | null; enabled: boolean }

export interface ResolvedTaskFields {
  workspace_id: number | null; delivery_targets: unknown; email_attachment_file_ids: number[]; reminder_lead_minutes: number | null
}

export interface TaskWriteOptions {
  validateCron(cron: string): void
  /** 在事务中校验工作区、附件和投递目标的 owner，解析提醒提前量和权限撤销。 */
  resolve(client: TaskWriteQuery, owner: string, input: Record<string, unknown>, schedule: ScheduleSpec, previous: TaskRow | null): Promise<ResolvedTaskFields>
  filesystemAuthorizationEnabled(): boolean
  publish(owner: string, operation: 'create' | 'update', task: unknown, origin: string | null): Promise<void>
}

async function attachReminder(client: TaskWriteQuery, owner: string, contextId: string | null, eventId: number, task: TaskRow): Promise<void> {
  const ctx = normalizeScheduledTaskContext(contextId)
  if (!ctx) return
  const found = await client.query<TaskRow>(`SELECT id,after_state,target_refs,base_versions FROM undo_operations WHERE user_id=$1 AND undo_context_id=$2 AND actor_type='web' AND resource='calendar' AND action='create' AND status='active' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [owner, ctx])
  const operation = found.rows[0]
  if (!operation) return
  const state = operation.after_state ?? {}, items = state.items ?? {}
  if (!items[`event:${eventId}`] || items[`task:${task.id}`]) return
  items[`task:${task.id}`] = scheduledTaskUndoSnapshot(task as any, () => task.precise_start == null ? null : String(task.precise_start).replace('.000000Z', 'Z').replace('Z', '+00:00'))
  await client.query(`UPDATE undo_operations SET after_state=$2::json,target_refs=$3::json,base_versions=$4::json WHERE id=$1`, [operation.id, JSON.stringify({ ...state, items }), JSON.stringify([...(operation.target_refs ?? []), { kind: 'task', id: task.id }]), JSON.stringify({ ...(operation.base_versions ?? {}), [`task:${task.id}`]: { version: 0 } })])
}

type TaskWriteTransaction = <T>(work: (query: TaskWriteQuery) => Promise<T>) => Promise<T>

function taskWrites(transact: TaskWriteTransaction, options: TaskWriteOptions, conflicts?: TaskWriteQuery) {
  const independent = !conflicts
  return {
    create(rawOwner: string, input: ScheduledTaskCreateInput, contextId: string | null, origin: string | null) {
      return createScheduledTask({
        validateCron: options.validateCron,
        persist: async (rawId, input, spec, undoContextId) => {
      const owner = normalizeOwnerId(rawId)
      let created = false
      let row: TaskRow
      try {
        row = await transact(async client => {
          const mode = input.event_id == null ? input.execution_mode ?? 'instruction' : 'reminder'
          await validateTaskReferences(client, owner, mode === 'reminder' ? null : input.workspace_id ?? null, input.email_attachment_file_ids ?? [])
          if (input.event_id != null) {
            const event = await client.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE', [input.event_id, owner])
            if (!event.rowCount) throw new TypeError('绑定的日历事件不存在')
            const existing = await client.query<TaskRow>(`SELECT *,${taskPreciseColumns} FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 AND cron=$3`, [owner, input.event_id, spec.cron])
            if (existing.rows[0]) return existing.rows[0]
          }
          const resolved = await options.resolve(client, owner, { ...input, execution_mode: mode }, spec, null)
          const result = await client.query<TaskRow>(`INSERT INTO scheduled_tasks(user_id,event_id,workspace_id,name,payload,cron,schedule_kind,interval_minutes,start_at,end_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,reminder_lead_minutes,execution_mode,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::json,$14::json,$15::json,$16,$17,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *,${taskPreciseColumns}`, [owner, input.event_id ?? null, resolved.workspace_id, input.name, input.payload || '', spec.cron, spec.schedule_kind, spec.interval_minutes, scheduleTimestamp(spec.start_at), scheduleTimestamp(spec.end_at), normalizeScheduledTaskChannels(input.channels ?? ['web']), input.enabled ?? true, JSON.stringify(resolved.delivery_targets ?? null), JSON.stringify(mode === 'reminder' ? [] : normalizeScheduledTaskTools(input.authorized_tools)), JSON.stringify(resolved.email_attachment_file_ids), resolved.reminder_lead_minutes, mode])
          const task = result.rows[0]!
          if (input.event_id != null) await attachReminder(client, owner, undoContextId, Number(input.event_id), task)
          await enqueueScheduledTaskRagRebuild(client, owner, Number(task.id))
          created = true
          return task
        })
      } catch (error) {
        if (!conflicts || !isPostgresUniqueViolation(error) || input.event_id == null) throw error
        const existing = (await conflicts.query<TaskRow>(`SELECT *,${taskPreciseColumns} FROM scheduled_tasks
          WHERE user_id=$1 AND event_id=$2 AND cron=$3`, [owner, input.event_id, spec.cron])).rows[0]
        if (!existing) throw error
        row = existing
      }
      const response = taskResponse(row, options.filesystemAuthorizationEnabled())
      return { task: response, created }
        },
        publish: (owner, task, from) => options.publish(owner, 'create', task, from),
      }, rawOwner, input, contextId, origin)
    },
    update(rawOwner: string, id: number, patch: ScheduledTaskPatch, origin: string | null, eventId?: number) {
      return updateScheduledTask({
        validateCron: options.validateCron,
        persist: async (rawId, taskId, values, prepare) => {
      const owner = normalizeOwnerId(rawId)
      const row = await transact(async client => {
        const found = await client.query<TaskRow>(`SELECT *,to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_start,to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_end FROM scheduled_tasks WHERE id=$1 AND user_id=$2 ${eventId !== undefined ? 'AND event_id=$3 AND EXISTS (SELECT 1 FROM calendar_events WHERE id=$3 AND user_id=$2 AND deleted_at IS NULL FOR SHARE)' : independent ? 'AND event_id IS NULL' : ''} FOR UPDATE`, eventId === undefined ? [taskId, owner] : [taskId, owner, eventId])
        const current = found.rows[0]
        if (!current) throw Object.assign(new Error('任务不存在'), { statusCode: 404 })
        const has = (key: string) => Object.prototype.hasOwnProperty.call(values, key)
        const scheduleKeys = ['schedule_kind', 'cron', 'interval_minutes', 'start_at', 'end_at']
        const scheduleChanged = scheduleKeys.some(has)
        const coreCurrent = {
          schedule_kind: String(current.schedule_kind), cron: String(current.cron),
          interval_minutes: current.interval_minutes == null ? null : Number(current.interval_minutes),
          start_at: current.precise_start as string | null, end_at: current.precise_end as string | null,
          event_id: current.event_id == null ? null : Number(current.event_id),
        }
        const retainedSchedule: ScheduleSpec = {
          schedule_kind: current.schedule_kind, cron: current.cron, interval_minutes: current.interval_minutes,
          start_at: current.start_at == null ? null : new Date(current.start_at),
          end_at: current.end_at == null ? null : new Date(current.end_at),
        }
        const mode = current.event_id == null ? values.execution_mode ?? current.execution_mode ?? 'instruction' : 'reminder'
        if (current.event_id == null && mode === 'reminder' && !String(values.payload ?? current.payload ?? '').trim()) throw new TypeError('请输入提醒内容')
        let resolved: ResolvedTaskFields | undefined
        const prepared: ScheduledTaskPreparedUpdate = await prepare(coreCurrent, async (_task, nextPatch, schedule) => {
          const spec: ScheduleSpec = schedule ?? retainedSchedule
          if (scheduleChanged && current.event_id != null && schedule) {
            const event = await client.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE', [current.event_id, owner])
            if (!event.rowCount) throw new TypeError('绑定的日历事件不存在')
            const conflict = await client.query('SELECT id FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 AND cron=$3 AND id<>$4', [owner, current.event_id, spec.cron, taskId])
            if (conflict.rowCount) throw Object.assign(new Error('该活动在同一触发时刻已有提醒'), { statusCode: 409 })
          }
          resolved = await options.resolve(client, owner, { ...nextPatch, execution_mode: mode }, spec, current)
        })
        const spec = prepared.schedule ?? retainedSchedule
        const normalizedPatch = prepared.patch
        const resolvedFields = resolved!
        const nextChannels = has('channels') && normalizedPatch.channels != null ? normalizeScheduledTaskChannels(normalizedPatch.channels) : current.channels
        const nextTools = mode === 'reminder' ? [] : has('authorized_tools') && normalizedPatch.authorized_tools != null ? normalizeScheduledTaskTools(normalizedPatch.authorized_tools)
          : has('payload') && normalizedPatch.payload != null || scheduleKeys.some(has) || has('channels') && normalizedPatch.channels != null ? [] : current.authorized_tools
        const result = await client.query<TaskRow>(`UPDATE scheduled_tasks SET name=$3,payload=$4,cron=$5,schedule_kind=$6,interval_minutes=$7,start_at=CASE WHEN $17::boolean THEN $8::timestamptz ELSE start_at END,end_at=CASE WHEN $17::boolean THEN $9::timestamptz ELSE end_at END,channels=$10,enabled=$11,workspace_id=$12,delivery_targets=$13::json,authorized_tools=$14::json,email_attachment_file_ids=$15::json,reminder_lead_minutes=$16,execution_mode=$18,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 RETURNING *,${taskPreciseColumns}`, [taskId, owner, normalizedPatch.name ?? current.name, normalizedPatch.payload ?? current.payload, spec.cron, spec.schedule_kind, spec.interval_minutes, scheduleTimestamp(spec.start_at), scheduleTimestamp(spec.end_at), nextChannels, normalizedPatch.enabled ?? current.enabled, resolvedFields.workspace_id, JSON.stringify(resolvedFields.delivery_targets ?? null), JSON.stringify(nextTools ?? []), JSON.stringify(resolvedFields.email_attachment_file_ids), resolvedFields.reminder_lead_minutes, scheduleChanged, mode])
        await enqueueScheduledTaskRagRebuild(client, owner, taskId)
        return result.rows[0]!
      })
      const response = taskResponse(row, options.filesystemAuthorizationEnabled())
      return response
        },
        publish: (owner, task, from) => options.publish(owner, 'update', task, from),
      }, rawOwner, id, patch, origin)
    },
  }
}

/** Web REST 拥有事务，提交后发布；活动提醒去重保留原语义。 */
export function createPostgresTaskWrites(pool: Pool, options: TaskWriteOptions) {
  return taskWrites(work => withPostgresTransaction(pool, work), options, pool)
}

/** Agent 只修改独立任务，调度校验及写入借用外层确认和调用收据事务。 */
export function createBorrowedPostgresTaskWrites(tx: Transaction<Database>, options: Omit<TaskWriteOptions, 'publish'>) {
  const query = async <TaskRow>(text: string, parameters: unknown[] = []) => {
    const result = await tx.getExecutor().executeQuery<TaskRow>(CompiledQuery.raw(text, parameters))
    return { rows: result.rows, rowCount: Number(result.numAffectedRows ?? result.rows.length) }
  }
  // 本方法只承诺写入外层事务；调用者在提交成功后按领域回执通知。
  return taskWrites(work => work({ query: query as PoolClient['query'] }), { ...options, async publish() {} })
}

type ResolverQuery = Pick<PoolClient, 'query'>

type ResolveRow = Record<string, any>

export interface TaskExternalResolution {
  /** 解析 IM 私聊/群投递目标并校验 owner，不可在缺失能力时返回伪成功。 */
  resolveDelivery(client: ResolverQuery, owner: string, input: Record<string, unknown>, previous: ResolveRow | null): Promise<unknown>
  /** 在事务内撤销持久授权并记录审计；确认码侧清理由调用方提供。 */
  revokeFilesystem(client: ResolverQuery, owner: string, task: ResolveRow): Promise<void>
}

const has = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key)

export async function validateTaskReferences(client: ResolverQuery, owner: string, workspace: unknown, attachments: unknown): Promise<number[]> {
  if (workspace != null) {
    if (!Number.isSafeInteger(workspace) || Number(workspace) < 1) throw new ScheduledTaskReferenceError('工作区不存在或已停用')
    const result = await client.query('SELECT id FROM workspaces WHERE id=$1 AND user_id=$2 AND enabled=TRUE', [workspace, owner])
    if (!result.rowCount) throw new ScheduledTaskReferenceError('工作区不存在或已停用')
  }
  if (!Array.isArray(attachments) || attachments.length > 5 || attachments.some(id => !Number.isSafeInteger(id) || id <= 0))
    throw new ScheduledTaskReferenceError('file_ids 只能包含正整数 file_id，附件最多 5 个')
  const ids: number[] = [...new Set(attachments)]
  if (ids.length) {
    const files = await client.query('SELECT id FROM files WHERE user_id=$1 AND id=ANY($2::int[]) AND deleted_at IS NULL', [owner, ids])
    if (files.rowCount !== ids.length) throw new ScheduledTaskReferenceError('定时任务附件不存在、已删除或不属于当前用户')
  }
  return ids
}

export function createPostgresTaskResolver(external: TaskExternalResolution) {
  return async (client: ResolverQuery, owner: string, input: Record<string, unknown>, spec: ScheduleSpec, previous: ResolveRow | null): Promise<ResolvedTaskFields> => {
    const workspace = input.execution_mode === 'reminder' ? null : has(input, 'workspace_id') ? input.workspace_id : previous?.workspace_id ?? null
    const attachments = has(input, 'email_attachment_file_ids') ? input.email_attachment_file_ids ?? [] : previous?.email_attachment_file_ids ?? []
    const ids = await validateTaskReferences(client, owner,
      !previous || has(input, 'workspace_id') ? workspace : null,
      !previous || has(input, 'email_attachment_file_ids') ? attachments : [])
    if (previous && (input.enabled === false || input.execution_mode === 'reminder') && previous.event_id == null && previous.filesystem_authorization_grant_id != null)
      await external.revokeFilesystem(client, owner, previous)
    const delivery = !previous || input.channels != null || has(input, 'qq_delivery') || has(input, 'im_delivery')
      ? await external.resolveDelivery(client, owner, input, previous) : previous.delivery_targets
    let lead: number | null = previous?.reminder_lead_minutes ?? null
    const eventId = previous?.event_id ?? input.event_id
    if (eventId != null && (!previous || ['schedule_kind','cron','interval_minutes','start_at','end_at'].some(key => has(input, key)))) {
      const result = await client.query<{ date: string; time: string | null }>('SELECT date,time FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [eventId, owner])
      const event = result.rows[0]
      if (!event || !spec.start_at) throw new TypeError('绑定的日历事件不存在')
      const base = Date.parse(`${event.date}T${event.time || '09:00'}:00Z`)
      if (!Number.isFinite(base)) throw new TypeError('活动时间无效')
      const instantMicros = scheduleMicroseconds(spec.start_at)
      const remainder = ((instantMicros % 1000n) + 1000n) % 1000n
      const fireWall = BigInt(shanghaiWallMilliseconds(spec.start_at)) * 1000n + remainder
      const minutes = Number(BigInt(base) * 1000n - fireWall) / 60_000_000, floor = Math.floor(minutes)
      lead = minutes - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(minutes)
    }
    return { workspace_id: workspace as number | null, delivery_targets: delivery, email_attachment_file_ids: !previous || has(input, 'email_attachment_file_ids') ? ids : attachments, reminder_lead_minutes: lead }
  }
}

type ExternalRow = Record<string, any>

const platforms = ['qq', 'feishu', 'telegram'] as const

const object = (value: unknown): ExternalRow => value && typeof value === 'object' && !Array.isArray(value) ? value as ExternalRow : {}

export interface TaskExternalOptions {
  secretKey: string
  readWechatPrivate(owner: string): Promise<ExternalRow | null>
  revokeConfirmation(owner: string, summary: string, identity: string): Promise<void>
}

export function createPostgresTaskExternal(options: TaskExternalOptions): TaskExternalResolution {
  return {
    async resolveDelivery(client, owner, input, previous) {
      const selected: string[] = Array.isArray(input.channels) ? input.channels : previous?.channels?.split(',').filter(Boolean) ?? ['web']
      const targets: ExternalRow = {}, old = object(previous?.delivery_targets)
      const configs = { ...object(input.im_delivery) }
      if (!configs.qq && input.qq_delivery && typeof input.qq_delivery === 'object') configs.qq = input.qq_delivery
      for (const platform of [...platforms, 'wechat'] as const) {
        const enabled = selected.includes(platform)
        let bot: ExternalRow | undefined
        if (enabled) bot = (await client.query<ExternalRow>(`SELECT id,owner_platform_user_id FROM user_bots WHERE user_id=$1 AND platform=$2 AND enabled=TRUE ORDER BY id LIMIT 1`, [owner, platform])).rows[0]
        if (platform === 'wechat') {
          if (enabled) {
            const reach = await options.readWechatPrivate(owner)
            if (bot && reach && String(reach.channel_id) === String(bot.id) && reach.puid && reach.context_token)
              targets[platform] = { platform, chat_type: 'c2c', chat_id: null, puid: reach.puid, channel_id: reach.channel_id }
          }
          continue
        }
        if (enabled) targets[platform] = { platform, chat_type: 'c2c', chat_id: null, puid: bot?.owner_platform_user_id ?? null, channel_id: bot ? String(bot.id) : null }
        const config = object(configs[platform])
        if (enabled && configs[platform] && config.mode === 'private') {
          if (platform !== 'qq' && !bot?.owner_platform_user_id) throw new TypeError(`${platform} 尚无可用私聊目标，请先与 Bot 私聊`)
        } else if (enabled && configs[platform] && config.mode === 'group') {
          const chatId = String(config.chat_id ?? '').trim()
          if (!chatId) throw new TypeError('群投递需要 chat_id')
          if (!bot) throw new TypeError(`${platform} Bot 未连接或已停用`)
          const session = await client.query(`SELECT id FROM conversation_sessions WHERE user_id=$1 AND source=$2 AND chat_type='group' AND chat_id=$3 AND bot_id=$4 ORDER BY id DESC LIMIT 1`, [owner, platform, chatId, String(bot.id)])
          if (!session.rowCount) throw new TypeError('找不到该群会话，请先让咕咕在群里收到一条消息')
          targets[platform] = { platform, chat_type: 'group', chat_id: chatId, puid: bot.owner_platform_user_id, channel_id: String(bot.id) }
        } else if (enabled && configs[platform]) throw new TypeError('投递目标 mode 只能是 private 或 group')
        else if (old[platform]) targets[platform] = old[platform]
      }
      const active = Object.entries(targets).filter(([channel]) => selected.includes('im') || selected.includes(channel))
      if (active.filter(([, value]) => object(value).chat_type === 'group' && object(value).chat_id).length > 1) throw new TypeError('一个定时任务目前只能设置一个群聊投递目标')
      return Object.keys(targets).length ? targets : null
    },
    async revokeFilesystem(client, owner, task) {
      await options.revokeConfirmation(owner, `允许定时任务「${task.name}」读写整个用户沙箱（包含 /workspace、/personal、/project）`, `scheduled-task:filesystem:${task.id}`)
      const grantId = task.filesystem_authorization_grant_id
      await client.query('UPDATE scheduled_tasks SET filesystem_authorization_grant_id=NULL WHERE id=$1 AND user_id=$2', [task.id, owner])
      const result = await client.query(`UPDATE filesystem_authorization_grants SET revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`, [grantId, owner])
      if (!result.rowCount) return
      const metadata = { subject_type: 'scheduled_task', subject_id: String(task.id), grant_id: String(grantId), scope: 'user_sandbox', operation: 'authorization', outcome: 'revoked', source: 'system' }
      const fingerprint = createHmac('sha256', options.secretKey).update(String(task.id)).digest('hex')
      await client.query(`INSERT INTO security_events(user_id,event_type,resource_type,resource_fingerprint,owner_fingerprint,client_fingerprint,ip_fingerprint,user_agent_fingerprint,action,reason_code,metadata_json,occurred_at,expires_at) VALUES($1,'filesystem.authorization','filesystem:scheduled_task',$2,NULL,NULL,NULL,NULL,'logged','revoked',$3::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '90 days')`, [owner, fingerprint, JSON.stringify(metadata)])
    },
  }
}

/** 将定时任务变更与其 RAG 投影任务写入同一领域事务。 */
export async function enqueueScheduledTaskRagRebuild(client: Pick<PoolClient, 'query'>, ownerId: string, taskId: number): Promise<void> {
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new TypeError('RAG 定时任务标识无效')
  const sourceId = String(taskId)
  await client.query(
    `INSERT INTO rag_index_jobs (
       user_id, source_type, source_id, pending_source_ids, version, operation, status,
       generation, completed_generation, attempts, next_attempt_at, lease_until,
       last_error_code, last_started_at, last_succeeded_at, created_at, updated_at
     ) VALUES ($1, 'scheduled_task', $2::text, json_build_array($2::text), '', 'upsert', 'queued', 1, 0, 0,
       CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, source_type) DO UPDATE SET
       source_id = CASE WHEN rag_index_jobs.source_id = '' THEN '' ELSE EXCLUDED.source_id END,
       version = '', operation = 'upsert', status = 'queued',
       generation = rag_index_jobs.generation + 1,
       next_attempt_at = CURRENT_TIMESTAMP, lease_until = NULL, last_error_code = NULL,
       pending_source_ids = CASE WHEN rag_index_jobs.source_id = '' THEN '[]'::json ELSE (
         SELECT COALESCE(json_agg(item.source_id ORDER BY item.first_position), '[]'::json)
         FROM (
           SELECT source_id, MIN(position) AS first_position
           FROM (
             SELECT value AS source_id, ordinality AS position
             FROM jsonb_array_elements_text(COALESCE(rag_index_jobs.pending_source_ids::jsonb, '[]'::jsonb)) WITH ORDINALITY
             UNION ALL SELECT rag_index_jobs.source_id, 2147483646 WHERE rag_index_jobs.source_id <> ''
             UNION ALL SELECT EXCLUDED.source_id, 2147483647
           ) pending
           GROUP BY source_id
         ) item
       ) END,
       updated_at = CURRENT_TIMESTAMP`,
    [ownerId, sourceId],
  )
}
