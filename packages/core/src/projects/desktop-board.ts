import { sql, type Transaction } from 'kysely'
import { CoreError, type Fields } from '../contracts/index.js'
import { MAX_FRAME, type DesktopProjectPage } from '../contracts/desktop.js'
import { databaseTime } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import { object, safeInteger } from '../shared/values.js'
import { projectResponse } from './project-projection.js'
import type { ProjectService } from './service.js'

const retentionMs = 30 * 24 * 60 * 60 * 1000

export async function listDesktopProjects(projects: ProjectService, collection: unknown, offset: number): Promise<DesktopProjectPage> {
  if (collection !== 'active' && collection !== 'archived' && collection !== 'deleted')
    throw new CoreError('invalid_request', '项目集合无效')
  const rows = collection === 'deleted'
    ? await projects.listDeleted(new Date(Date.now() - retentionMs).toISOString())
    : await projects.list(collection === 'archived')
  const items: DesktopProjectPage['items'] = []
  let bytes = 0
  for (const row of rows.slice(offset)) {
    const project = projectResponse(row, 0)
    bytes += Buffer.byteLength(JSON.stringify(project)) + 1
    if (items.length && bytes > MAX_FRAME - 1024) return { items, nextOffset: offset + items.length }
    items.push(project)
  }
  return { items, nextOffset: null }
}

export async function getDesktopProject(projects: ProjectService, id: number, includeDeleted = false) {
  const project = await projects.get(id, includeDeleted)
  if (!project) throw new CoreError('not_found', '项目不存在')
  return projectResponse(project, 0)
}

export function desktopProjectFields(value: unknown): Fields {
  object(value)
  const { startDate, currentStage, ...fields } = value
  if (Object.hasOwn(value, 'startDate')) fields.start_date = startDate
  if (Object.hasOwn(value, 'currentStage')) fields.current_stage = currentStage
  return fields
}

/** 本地只软删关联活动，恢复时只恢复同一批次的活动，保留此前独立删除的记录。 */
export async function setDesktopProjectDeleted(
  tx: Transaction<Database>, ownerId: string, rawId: unknown, deleted: boolean,
) {
  const id = safeInteger(rawId)
  const current = await tx.selectFrom('projects').select('deleted_at')
    .where('user_id', '=', ownerId).where('id', '=', id).executeTakeFirst()
  if (!current || deleted !== (current.deleted_at === null))
    throw new CoreError('not_found', '项目不存在')
  const now = Date.now()
  const stamp = databaseTime(new Date(now).toISOString(), 'sqlite')
  const cutoff = databaseTime(new Date(now - retentionMs).toISOString(), 'sqlite')
  if (!deleted && current.deleted_at! < cutoff)
    throw new CoreError('not_found', '项目已超过回收站保留期')

  const project = await tx.updateTable('projects').set({
    deleted_at: deleted ? stamp : null, updated_at: stamp, version: sql<number>`version + 1`,
  }).where('user_id', '=', ownerId).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
  await tx.updateTable('calendar_events').set({
    deleted_at: deleted ? stamp : null, version: sql<number>`version + 1`,
  }).where('user_id', '=', ownerId).where('project_id', '=', id)
    .where('deleted_at', deleted ? 'is' : '=', current.deleted_at).execute()
  return project
}

/** 清理已软删的项目记录和所属日程；磁盘目录由桌面宿主处理。 */
export async function purgeDesktopProject(tx: Transaction<Database>, ownerId: string, rawId: unknown): Promise<void> {
  const id = safeInteger(rawId)
  const project = await tx.selectFrom('projects').select('id')
    .where('user_id', '=', ownerId).where('id', '=', id).where('deleted_at', 'is not', null).executeTakeFirst()
  if (!project) throw new CoreError('not_found', '已删除项目不存在')

  const events = tx.selectFrom('calendar_events').select('id')
    .where('user_id', '=', ownerId).where('project_id', '=', id)
  await tx.deleteFrom('scheduled_tasks').where('user_id', '=', ownerId).where('event_id', 'in', events).execute()
  await tx.deleteFrom('calendar_events').where('user_id', '=', ownerId).where('project_id', '=', id).execute()
  await tx.deleteFrom('projects').where('user_id', '=', ownerId).where('id', '=', id)
    .where('deleted_at', 'is not', null).executeTakeFirstOrThrow()
}
