import { z } from 'zod'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Fields = Record<string, unknown>
export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'storage_error'
  | 'schema_upgrade_required'
  | 'closed'
  | 'cancelled'
  | 'busy'
  | 'database_in_use'

export class CoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CoreError'
  }
}

export const ownerSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
export const operationSchema = z.string().uuid()
export const frameSchema = z.strictObject({
  v: z.union([z.literal(1), z.literal(2)]),
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
  operation_id: operationSchema.optional(),
})

export const requestJsonSchema = z.toJSONSchema(frameSchema, { io: 'input' })
export interface DataContext {
  readonly ownerId: string
}
export function dataContext(ownerId: string): DataContext {
  return Object.freeze({ ownerId: ownerSchema.parse(ownerId).toLowerCase() })
}

export interface Todo {
  id: string
  text?: string
  done?: boolean
  [key: string]: unknown
}
export interface Stage {
  key: string
  label: string
  todos?: Todo[]
  [key: string]: unknown
}
export interface ProjectRecord {
  id: number
  user_id: string
  name: string
  summary: string | null
  client: string | null
  status: string
  start_date: string | null
  deadline: string | null
  color: string
  progress: number
  stages_json: string
  current_stage: string | null
  priority: string | null
  version: number
  archived: boolean
  done_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export interface ClientRecord {
  id: number
  user_id: string
  name: string
  contact: string | null
  email: string | null
  phone: string | null
  notes: string
  created_at: string
}
