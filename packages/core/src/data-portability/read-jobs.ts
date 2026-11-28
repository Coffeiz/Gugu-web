import { CoreError, dataContext } from '../contracts/index.js'
import { utc } from '../data/codec.js'

type Row = Record<string, any>
export type PortabilityJobQuery = (text: string, params: unknown[]) => Promise<{ rows: Row[] }>
const timestamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00' AS ${column}`
const time = (value: string | null) => value === null ? null : utc(value).replace(' ','T')
const common = (row: Row) => ({ id: row.id as string, status: row.status as string, stage: row.stage as string | null,
  progress_current: Number(row.progress_current), progress_total: row.progress_total === null ? null : Number(row.progress_total),
  error_code: row.error_code as string | null, created_at: time(row.created_at), expires_at: time(row.expires_at) })
const exportView = (row: Row) => ({ ...common(row), artifact_size: row.artifact_size === null ? null : Number(row.artifact_size), download_available: row.status === 'ready' && row.artifact_key !== null })
const importView = (row: Row) => ({ ...common(row), mode: row.mode as string, preview: row.preview as unknown, rollback_expires_at: time(row.rollback_expires_at) })

/** 只读现有权威任务；不续租、不更新状态、不创建工作队列。 */
export function createPortabilityJobReader(query: PortabilityJobQuery) {
  const exportColumns = `id::text,status,stage,progress_current,progress_total,error_code,artifact_size,artifact_key,${timestamp('created_at')},${timestamp('expires_at')}`
  const importColumns = `id::text,status,stage,mode,progress_current,progress_total,error_code,preview,${timestamp('created_at')},${timestamp('expires_at')},${timestamp('rollback_expires_at')}`
  async function rows(kind: 'export' | 'import', owner: string, job?: string) {
    const ownerId = dataContext(owner).ownerId
    const parameters = job === undefined ? [ownerId] : [ownerId, dataContext(job).ownerId]
    return (await query(`SELECT ${kind === 'export' ? exportColumns : importColumns} FROM data_${kind}_jobs WHERE user_id=$1${job === undefined ? ` ORDER BY created_at DESC LIMIT ${kind === 'export' ? 10 : 20}` : ' AND id=$2'}`, parameters)).rows
  }
  return {
    async listExports(owner: string) { return (await rows('export',owner)).map(exportView) },
    async listImports(owner: string) { return (await rows('import',owner)).map(importView) },
    async getExport(owner: string, job: string) {
      const row = (await rows('export',owner,job))[0]
      if (!row) throw new CoreError('not_found','找不到此导出任务')
      return exportView(row)
    },
    async getImport(owner: string, job: string) {
      const row = (await rows('import',owner,job))[0]
      if (!row) throw new CoreError('not_found','找不到此导入任务')
      return importView(row)
    },
  }
}
