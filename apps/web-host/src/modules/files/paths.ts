import { sandboxTarget } from '../workspaces/roots.js'
import type { ResolvedObjectPath } from '@gugu/core/agent'
import { CoreError } from '@gugu/core'
import type { PoolClient } from 'pg'

const invalidPathChars = /[\\/:*?"<>|]/g

function safePathName(value: string): string {
  const safe = value.replace(invalidPathChars, '_')
  if (!safe || safe === '.' || safe === '..') throw new Error('项目路径包含无效目录段')
  return safe
}

function projectPathSegments(projectId: number, name: string, startDate: unknown, createdAt: unknown): string[] {
  const source = startDate ?? createdAt
  const text = source instanceof Date ? source.toISOString().slice(0, 10) : String(source ?? '')
  const match = /^(\d{4})-(\d{2})/.exec(text)
  const year = match?.[1] ?? ''
  const month = match?.[2] ?? ''
  return ['项目文件', ...(year && month ? [year, month] : []), `${safePathName(name)} #${projectId}`]
}

/** 项目磁盘目录与 Shell 挂载共用同一套命名规则。 */
export function projectFileStorageKey(
  ownerId: string,
  projectId: number,
  name: string,
  startDate: unknown,
  createdAt: unknown,
): string {
  return [ownerId, ...projectPathSegments(projectId, name, startDate, createdAt)].join('/')
}

async function readOwnedProjectPathRow(client: Pick<PoolClient, 'query'>, ownerId: string, projectId: number) {
  const result = await client.query<{ name: string; start_date: unknown; created_at: unknown }>(
    `SELECT name,start_date,created_at FROM projects
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [projectId, ownerId],
  )
  const project = result.rows[0]
  if (!project) throw new CoreError('not_found', '项目不存在')
  return project
}

/** 只解析当前 owner 的活动项目路径，不读取数据库文件夹记录。 */
export async function readPostgresProjectPathKey(
  client: Pick<PoolClient, 'query'>,
  ownerId: string,
  projectId: number,
): Promise<string> {
  const project = await readOwnedProjectPathRow(client, ownerId, projectId)
  return projectFileStorageKey(ownerId, projectId, project.name, project.start_date, project.created_at)
}

export async function readProjectObjectLocation(
  client: Pick<PoolClient, 'query'>,
  ownerId: string,
  projectId: number,
): Promise<ResolvedObjectPath> {
  return { kind: 'sandbox', value: sandboxTarget(await readPostgresProjectPathKey(client, ownerId, projectId)) }
}
