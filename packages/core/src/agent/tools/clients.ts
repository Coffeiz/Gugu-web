import { z } from 'zod'
import { createHash } from 'node:crypto'
import { strip } from '../../shared/values.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import { ClientValidationError } from '../../clients/service.js'
import type { ClientRecord, Fields, Json } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { services } from '../../data/repositories.js'
import type { DataServices } from '../../data/services.js'
import { nowUtc } from '../../data/codec.js'
import type { ToolResult } from '../models.js'
import type { ToolDefinition } from './contracts.js'
import type { RunIdentity, ToolCall } from '../models.js'
import { redactToolError } from '../core.js'
import { enrichToolError } from './input-errors.js'
import { createConfirmationGate, type ConfirmationClaimReference, type ConfirmationTargetSnapshot } from './confirmation.js'
import type { Database } from '../../data/schema.js'
import type { Transaction } from 'kysely'

const fields = { client_name: z.string().optional(), contact: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), notes: z.string().optional() }
const validators = {
  list_clients: z.object({}).passthrough(),
  create_client: z.object({ ...fields, client_name: z.string() }).passthrough(),
  update_client: z.object({ client_id: z.number().int().safe().optional(), client: z.string().optional(), client_ids: z.array(z.number().int().safe()).max(50).refine(ids => new Set(ids).size === ids.length).meta({ uniqueItems: true }).optional(), ...fields }).passthrough(),
}
const descriptions = { list_clients: '列出当前用户的所有联系人。', create_client: '新建联系人，记录联系人、邮箱、电话、备注。', update_client: '修改联系人信息（名称/联系人/邮箱/电话/备注）。' }
function completed(value: unknown, successful = true, mutated = false): ToolResult {
  return { kind: 'completed', value, successful, mutated }
}
function failed(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return completed(JSON.stringify({ error, ...extra }), false)
}
function projection(row: ClientRecord) {
  const { id, name, contact, email, phone, notes } = row
  return { id, name, contact, email, phone, notes }
}
/** 使用已有 owner-scoped Core 数据服务，不另建联系人数据库实现。 */
export function createClientTools(runtime: SqlDataRuntime): ToolDefinition[] {
  return (Object.keys(validators) as (keyof typeof validators)[]).map(name => ({
    definition: { name, schema: { type: 'function', function: { name, description: descriptions[name], parameters: z.toJSONSchema(validators[name]) as Record<string, Json> } } },
    effect: name === 'list_clients' ? 'read' : 'write',
    validate(input) { return validators[name].safeParse(input) },
    async execute(input, scope) {
      const args = input as Record<string, unknown>
      let callbackError: unknown
      // 提交失败等非领域异常交给注册器保留 unknown，不能伪装普通失败。
      try {
        return await runtime.transaction(dataContext(scope.identity.ownerId), async data => {
          try {
            if (name === 'list_clients') return completed((await data.clients.list()).map(projection))
            if (name === 'create_client') {
              if (!args.client_name) return failed('联系人名称必填')
              const row = await data.clients.create({ name: args.client_name, contact: args.contact ?? null, email: args.email ?? null, phone: args.phone ?? null, notes: args.notes ?? '' })
              return completed({ success: true, client_id: row.id, name: row.name }, true, true)
            }
            let row: ClientRecord | null | undefined
            if (args.client_id) {
              row = await data.clients.repository.get(args.client_id as number)
              if (!row) return failed('联系人不存在')
            } else if (args.client) {
              const query = strip(args.client as string)
              const candidates = await data.clients.findByName(query)
              if (!candidates.length) return failed(`未找到联系人「${query}」`)
              if (candidates.length > 1) return failed(`有多个匹配「${query}」的联系人，请指明`, { candidates: candidates.slice(0, 10).map(item => ({ id: item.id, name: item.name })) })
              row = candidates[0]
            } else return failed('需提供 client_id 或联系人名 client')
            const changes: Fields = {}
            for (const key of Object.keys(fields)) if (Object.hasOwn(args, key)) changes[key === 'client_name' ? 'name' : key] = args[key]
            if (!Object.keys(changes).length) return failed('没提供要修改的字段（client_name/contact/email/phone/notes），未改动。')
            const updated = await data.clients.update(row!.id, changes)
            return completed({ success: true, client_id: updated.id, name: updated.name }, true, true)
          } catch (error) { callbackError = error; throw error }
        }, { signal: scope.signal })
      } catch (error) {
        if (error === callbackError && error instanceof ClientValidationError) return {
          kind: 'completed', value: JSON.stringify({ error: '联系人字段无效' }), successful: false, mutated: false,
          modelValue: enrichToolError(name, { error: redactToolError(`工具 ${name} 执行出错：ValueError: ${error.message}`) }),
        }
        if (error === callbackError && error instanceof CoreError && error.code === 'invalid_request') return failed('联系人字段无效')
        throw error
      }
    },
  }))
}

export interface ClientDeleteConfirmationPort {
  gate: ReturnType<typeof createConfirmationGate>
  /** 联系人删除与一次性确认 claim 必须处于同一事务。 */
  claim(tx: Transaction<Database>, reference: ConfirmationClaimReference, signal: AbortSignal): Promise<boolean>
}

export interface ClientDeleteRequest {
  identity: RunIdentity
  roundId: string
  toolCallId: string
  args: { client_id?: number; client?: string; client_ids?: number[] }
}

export interface ClientDeletePort {
  destructive?: boolean
  confirmation?: ClientDeleteConfirmationPort
  apply(input: ClientDeleteRequest & { signal: AbortSignal; call: ToolCall; scope: import('./contracts.js').ToolScope }): Promise<ToolResult>
  reconcile(input: ClientDeleteRequest): Promise<ToolResult>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function clientDeleteCoordinate(input: ClientDeleteRequest) {
  const context = dataContext(input.identity.ownerId)
  const parts = ['client.delete', context.ownerId, input.identity.sessionId, input.identity.runId, input.roundId, input.toolCallId]
  if (parts.some(value => typeof value !== 'string' || !value.trim())) throw new CoreError('invalid_request', '工具运行身份无效')
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  const raw = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17, 32)}`
  return { context, operationId: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}` }
}

async function resolveClientDeleteRows(data: DataServices, args: ClientDeleteRequest['args'], signal?: AbortSignal) {
  const submitted = args.client_ids ?? (args.client_id ? [args.client_id] : null)
  if (args.client_ids !== undefined && (!Array.isArray(args.client_ids) || args.client_ids.length < 1 || args.client_ids.length > 50))
    return { rows: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: 'client_ids 必须是 1-50 个联系人 id' } as const
  let rows: ClientRecord[]
  if (submitted !== null) {
    const ids = [...new Set(submitted)].sort((a, b) => a - b)
    rows = []
    for (const id of ids) {
      signal?.throwIfAborted()
      const client = await data.clients.repository.get(id)
      if (!client) return { rows: [], snapshot: { targetsDigest: '', versionsDigest: '' },
        error: args.client_ids === undefined ? '联系人不存在' : `联系人 ${id} 不存在` } as const
      rows.push(client)
    }
    if (rows.length !== ids.length) return { rows: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: '联系人不存在' } as const
  } else {
    if (typeof args.client !== 'string' || !args.client.trim())
      return { rows: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: '需提供 client_id 或联系人名 client' } as const
    const query = strip(args.client)
    const candidates = await data.clients.findByName(query)
    signal?.throwIfAborted()
    if (!candidates.length) return { rows: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: `未找到联系人「${query}」` } as const
    if (candidates.length > 1) return { rows: [], snapshot: { targetsDigest: '', versionsDigest: '' }, error: `有多个匹配「${query}」的联系人，请指明`, candidates: candidates.slice(0, 10).map(item => ({ id: item.id, name: item.name })) } as const
    rows = candidates
  }
  rows.sort((a, b) => a.id - b.id)
  const targetIds = rows.map(row => row.id)
  const snapshot: ConfirmationTargetSnapshot = {
    targetIds: { client_id: targetIds },
    targetsDigest: digest({ clientIds: targetIds }),
    versionsDigest: digest(rows.map(row => ({ id: row.id, name: row.name, contact: row.contact, email: row.email, phone: row.phone, notes: row.notes, created_at: row.created_at }))),
  }
  return { rows, snapshot } as const
}

async function resolveClientDeleteTargets(runtime: SqlDataRuntime, ownerId: string, args: ClientDeleteRequest['args'], signal: AbortSignal) {
  return runtime.transaction(dataContext(ownerId), data => resolveClientDeleteRows(data, args, signal), { signal })
}

/** 旧版单项/批量联系人删除语义；精确目标、确认 claim 与 Core 操作收据原子绑定。 */
export function createClientDeletePort(runtime: SqlDataRuntime, confirmation?: ClientDeleteConfirmationPort): ClientDeletePort {
  if (!runtime.receipts) throw new Error('联系人删除需要持久操作收据')
  const absent = new Error('联系人删除收据不存在')
  async function reconcile(input: ClientDeleteRequest): Promise<ToolResult> {
    try {
      const key = clientDeleteCoordinate(input)
      const receipt = await runtime.operationWithTransaction(key.context, key.operationId, 'agent.client.delete', { args: input.args }, async () => { throw absent })
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch { return { kind: 'unknown' } }
  }
  return { confirmation, reconcile, async apply(input) {
    input.signal.throwIfAborted()
    if (input.scope.resolution?.status === 'confirmed') {
      const previous = await reconcile(input)
      if (previous.kind === 'completed') return previous
    }
    if (input.args.client_ids !== undefined && (!input.args.client_ids.length || input.args.client_ids.length > 50))
      return { kind: 'completed', successful: false, mutated: false, value: { error: 'client_ids 必须是 1-50 个联系人 id' } }
    const batch = input.args.client_ids !== undefined
    const targets = await resolveClientDeleteTargets(runtime, input.identity.ownerId, input.args, input.signal)
    input.signal.throwIfAborted()
    if ('error' in targets) return { kind: 'completed', successful: false, mutated: false, value: { error: targets.error, ...('candidates' in targets ? { candidates: targets.candidates } : {}) } }
    if (!confirmation) return { kind: 'completed', successful: false, mutated: false, value: { error: '联系人删除需要可信确认能力' } }
    const params = { args: input.args }, inputDigest = digest(params)
    if (input.scope.resolution === null) {
      const prepared = await confirmation.gate.prepare(input.call, input.scope, inputDigest, targets.snapshot)
      return prepared.ok ? { kind: 'waiting', interaction: prepared.value }
        : { kind: 'completed', successful: false, mutated: false, value: { error: '联系人删除确认无效或已过期' } }
    }
    const verified = await confirmation.gate.verify(input.call, input.scope, inputDigest, targets.snapshot)
    if (!verified.ok) return { kind: 'completed', successful: false, mutated: false, value: { error: '联系人删除确认无效或已过期' } }
    const key = clientDeleteCoordinate(input)
    let callbackError: unknown
    try {
      const receipt = await runtime.operationWithTransaction(key.context, key.operationId, 'agent.client.delete', params, async (tx, owner) => {
        try {
          input.signal.throwIfAborted()
          if (!await confirmation.claim(tx, verified.value, input.signal)) throw new Error('联系人删除确认已使用或目标已变化')
          if (runtime.backend === 'postgres') {
            await tx.selectFrom('clients').select('id').where('user_id', '=', owner)
              .where('id', 'in', targets.rows.map(row => row.id)).forUpdate().execute()
            input.signal.throwIfAborted()
          }
          const data = services(tx, owner, runtime.backend, nowUtc)
          const current = await resolveClientDeleteRows(data, { client_ids: targets.rows.map(row => row.id) }, input.signal)
          if ('error' in current || current.snapshot.targetsDigest !== targets.snapshot.targetsDigest || current.snapshot.versionsDigest !== targets.snapshot.versionsDigest)
            throw new Error('联系人删除确认已使用或目标已变化')
          const results = []
          for (const row of current.rows) {
            input.signal.throwIfAborted()
            await data.clients.delete(row.id)
            results.push({ deleted_client_id: row.id, name: row.name })
          }
          input.signal.throwIfAborted()
          return batch
            ? { success: true, deleted_count: results.length, results }
            : { success: true, ...results[0] }
        } catch (error) { callbackError = error; throw error }
      }, { signal: input.signal })
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return { kind: 'completed', successful: false, mutated: false, value: { error: '操作标识已用于不同内容' } }
      if (input.signal.aborted && error === callbackError) throw error
      if (error === callbackError && error instanceof Error) return { kind: 'completed', successful: false, mutated: false, value: { error: error.message } }
      return reconcile(input)
    }
  } }
}

const clientDeleteId = z.number().int().safe()
const clientDeleteInput = z.object({
  client_id: clientDeleteId.optional(), client: z.string().optional(),
  client_ids: z.array(clientDeleteId).max(50).refine(ids => new Set(ids).size === ids.length).optional(),
}).passthrough()

export async function describeClientDeleteTargets(data: DataServices, input: unknown,
  expected: Pick<ConfirmationTargetSnapshot, 'targetsDigest' | 'versionsDigest'>) {
  const parsed = clientDeleteInput.safeParse(input)
  if (!parsed.success) throw new CoreError('invalid_request', '联系人删除确认目标无效')
  const result = await resolveClientDeleteRows(data, parsed.data)
  if ('error' in result || result.snapshot.targetsDigest !== expected.targetsDigest
    || result.snapshot.versionsDigest !== expected.versionsDigest)
    throw new CoreError('conflict', '联系人删除确认目标已变化')
  const names = result.rows.slice(0, 10).map(row => row.name).join('、').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  const visible = Array.from(names).slice(0, 420).join('')
  return `将删除联系人：${visible}，共 ${result.rows.length} 个，此操作不可恢复`
}

export function createClientDeleteTool(port: ClientDeletePort): ToolDefinition {
  const schema = clientDeleteInput
  const request = (args: z.infer<typeof schema>, identity: RunIdentity, roundId: string, toolCallId: string): ClientDeleteRequest => ({ identity, roundId, toolCallId, args })
  return {
    definition: { name: 'delete_client', schema: { type: 'function', function: { name: 'delete_client', description: '删除一个或多个联系人（不可恢复）。单项传 client_id 或联系人名 client，批量传 client_ids；执行前必须确认。', parameters: z.toJSONSchema(schema) as Record<string, Json> } } },
    effect: 'write', destructive: port.destructive, requiresInteraction: true, confirmationReplay: true, validate: input => schema.safeParse(input),
    execute(input, scope, call) { return port.apply({ ...request(input as z.infer<typeof schema>, scope.identity, scope.roundId, call.id), signal: scope.signal, call, scope }) },
    reconcile(input, identity, call) { return port.reconcile(request(input as z.infer<typeof schema>, identity, identity.roundId, call.id)) },
  }
}
