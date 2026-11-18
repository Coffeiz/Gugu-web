import type { PoolClient } from 'pg'
import { scheduleMicroseconds, shanghaiWallMilliseconds, type ScheduleSpec } from '@gugu/core/scheduled-task-schedule'
import { ScheduledTaskReferenceError } from '@gugu/core/scheduled-task-write'
import type { ResolvedTaskFields } from './task-writes-postgres.js'

type TaskWriteQuery = Pick<PoolClient, 'query'>
type Row = Record<string, any>
export interface TaskExternalResolution {
  /** 解析 IM 私聊/群投递目标并校验 owner，不可在缺失能力时返回伪成功。 */
  resolveDelivery(client: TaskWriteQuery, owner: string, input: Record<string, unknown>, previous: Row | null): Promise<unknown>
  /** 在事务内撤销持久授权并记录审计；确认码侧清理由调用方提供。 */
  revokeFilesystem(client: TaskWriteQuery, owner: string, task: Row): Promise<void>
}
const has = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key)

export async function validateTaskReferences(client: TaskWriteQuery, owner: string, workspace: unknown, attachments: unknown): Promise<number[]> {
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
  return async (client: TaskWriteQuery, owner: string, input: Record<string, unknown>, spec: ScheduleSpec, previous: Row | null): Promise<ResolvedTaskFields> => {
    const workspace = has(input, 'workspace_id') ? input.workspace_id : previous?.workspace_id ?? null
    const attachments = has(input, 'email_attachment_file_ids') ? input.email_attachment_file_ids ?? [] : previous?.email_attachment_file_ids ?? []
    const ids = await validateTaskReferences(client, owner,
      !previous || has(input, 'workspace_id') ? workspace : null,
      !previous || has(input, 'email_attachment_file_ids') ? attachments : [])
    if (previous && input.enabled === false && previous.event_id == null && previous.filesystem_authorization_grant_id != null)
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
