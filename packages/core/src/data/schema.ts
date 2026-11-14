import type { Generated } from 'kysely'

export interface ProjectTable {
  id: Generated<number>
  user_id: string
  name: string
  summary: string | null
  contact_name: string | null
  status: string
  start_date: string | null
  deadline: string | null
  color: string
  progress: number
  stages_json: string
  current_stage: string | null
  priority: string | null
  version: number
  archived: boolean | number
  done_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  idempotency_key: string | null
  idempotency_fingerprint: string | null
}
export interface ClientTable {
  id: Generated<number>
  user_id: string
  name: string
  contact: string | null
  email: string | null
  phone: string | null
  notes: string
  created_at: string
}
export interface ReceiptTable {
  owner_id: string
  operation_id: string
  fingerprint: string
  method: string
  result_json: string
  created_at: string
}
export interface Database {
  projects: ProjectTable
  clients: ClientTable
  core_runtime_meta: { key: string; value: string }
  core_operation_receipts: ReceiptTable
}
export const PROJECT_COLUMNS = [
  'id',
  'user_id',
  'name',
  'summary',
  'contact_name',
  'status',
  'start_date',
  'deadline',
  'color',
  'progress',
  'stages_json',
  'current_stage',
  'priority',
  'version',
  'archived',
  'done_at',
  'created_at',
  'updated_at',
  'deleted_at',
  'idempotency_key',
  'idempotency_fingerprint',
]
export const CLIENT_COLUMNS = [
  'id',
  'user_id',
  'name',
  'contact',
  'email',
  'phone',
  'notes',
  'created_at',
]
export const RECEIPT_COLUMNS = [
  'owner_id',
  'operation_id',
  'fingerprint',
  'method',
  'result_json',
  'created_at',
]
export const SCHEMA_VERSION = '3'
export function tablesSql(backend: 'sqlite' | 'postgres'): {
  projects: string
  clients: string
  receipts: string
} {
  const id = backend === 'sqlite' ? 'INTEGER PRIMARY KEY NOT NULL' : 'SERIAL PRIMARY KEY'
  const owner = backend === 'sqlite' ? 'CHAR(32)' : 'UUID'
  const timestamp = backend === 'sqlite' ? 'DATETIME' : 'TIMESTAMPTZ'
  return {
    projects: `CREATE TABLE projects (id ${id}, user_id ${owner} NOT NULL, name VARCHAR(200) NOT NULL, summary VARCHAR(200), contact_name VARCHAR(200), status VARCHAR(20) NOT NULL, start_date VARCHAR(10), deadline VARCHAR(10), color VARCHAR(300) NOT NULL, progress INTEGER NOT NULL, stages_json TEXT NOT NULL, current_stage VARCHAR(100), priority VARCHAR(20), version INTEGER NOT NULL, archived BOOLEAN NOT NULL, done_at ${timestamp}, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, deleted_at ${timestamp}, idempotency_key VARCHAR(64), idempotency_fingerprint VARCHAR(64), CONSTRAINT uq_projects_user_idempotency_key UNIQUE (user_id,idempotency_key))`,
    clients: `CREATE TABLE clients (id ${id}, user_id ${owner} NOT NULL, name VARCHAR(200) NOT NULL, contact VARCHAR(200), email VARCHAR(300), phone VARCHAR(50), notes TEXT NOT NULL, created_at ${timestamp} NOT NULL)`,
    receipts: `CREATE TABLE core_operation_receipts (owner_id ${owner} NOT NULL, operation_id VARCHAR(36) NOT NULL, fingerprint VARCHAR(64) NOT NULL, method VARCHAR(100) NOT NULL, result_json TEXT NOT NULL, created_at ${timestamp} NOT NULL, PRIMARY KEY (owner_id, operation_id))`,
  }
}
