import { CoreError } from '../contracts/index.js'
import type { ClientRecord, ProjectRecord } from '../contracts/index.js'
import type { Selectable } from 'kysely'
import type { ClientTable, ProjectTable } from './schema.js'
import { utc } from '../shared/timestamps.js'
export { utc } from '../shared/timestamps.js'

export type Clock = () => string
export const nowUtc: Clock = () => new Date().toISOString()
export function integer(value: unknown): number {
  if (typeof value === 'string' && !/^-?\d+$/.test(value))
    throw new CoreError('storage_error', '数据整数格式无效')
  const result = typeof value === 'bigint' || typeof value === 'string' ? Number(value) : value
  if (typeof result !== 'number' || !Number.isSafeInteger(result))
    throw new CoreError('storage_error', '数据整数超出协议范围')
  return result
}
export function uuid(value: string): string {
  const hex = value.replaceAll('-', '').toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(hex)) throw new CoreError('storage_error', '数据身份无效')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function databaseTime(value: string, backend: 'sqlite' | 'postgres'): string {
  const normalized = utc(value)
  return backend === 'postgres'
    ? normalized
    : normalized.replace('+00:00', '').replace(/(?<=\d{2}:\d{2}:\d{2})$/, '.000000')
}
export function projectRecord(row: Selectable<ProjectTable>): ProjectRecord {
  if (![true, false, 0, 1, 0n, 1n].includes(row.archived))
    throw new CoreError('storage_error', '数据布尔值无效')
  const {
    contact_name,
    idempotency_key: _key,
    idempotency_fingerprint: _fingerprint,
    ...rest
  } = row
  return {
    ...rest,
    id: integer(row.id),
    user_id: uuid(String(row.user_id)),
    client: contact_name as string | null,
    progress: integer(row.progress),
    version: integer(row.version),
    archived: Boolean(row.archived),
    created_at: utc(row.created_at),
    updated_at: utc(row.updated_at),
    done_at: row.done_at == null ? null : utc(row.done_at),
    deleted_at: row.deleted_at == null ? null : utc(row.deleted_at),
  }
}
export function clientRecord(row: Selectable<ClientTable>): ClientRecord {
  const { name, email, phone, address, notes } = row
  return {
    name, email, phone, address, notes,
    id: integer(row.id),
    user_id: uuid(String(row.user_id)),
    created_at: utc(row.created_at),
  }
}
