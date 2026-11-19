import { createHash } from 'node:crypto'
import { z } from 'zod'
import { strip } from '../../shared/values.js'
import { asciiDecimalDigits } from '../../shared/unicode-decimal.js'
import type { RunIdentity, ToolCall, ToolResult } from '../models.js'
import type { ToolDefinition, ToolScope } from './contracts.js'
import type { ConfirmationClaimReference, ConfirmationTargetSnapshot, createConfirmationGate } from './confirmation.js'

export interface TrashListItem {
  id: number; file_id?: number; folder_id?: number; kind: 'file' | 'folder'
  name: string; space: string; deleted_at: string | null
}
export interface TrashListPort {
  list(identity: RunIdentity, limit: number, signal: AbortSignal): Promise<{
    files: readonly TrashListItem[]; folders: readonly TrashListItem[]
  }>
}

function limitValue(value: unknown): number {
  if (value === undefined) return 50
  let integer: bigint
  if (typeof value === 'boolean') integer = value ? 1n : 0n
  else if (typeof value === 'number' && Number.isFinite(value)) integer = BigInt(Math.trunc(value))
  else if (typeof value === 'string') {
    const text = asciiDecimalDigits(strip(value))
    if (text.replace(/[+_-]/gu, '').length > 4300 || !/^[+-]?[0-9]+(?:_[0-9]+)*$/u.test(text)) throw new Error('回收站条数无效')
    integer = BigInt(text.replaceAll('_', ''))
  } else throw new Error('回收站条数无效')
  return Number(integer < 1n ? 1n : integer > 100n ? 100n : integer)
}

/** 只读已有回收站领域视图，不包含恢复、物理删除或清空操作。 */
export function createListTrashTool(port: TrashListPort): ToolDefinition {
  return {
    definition: { name: 'list_trash', schema: { type: 'function', function: {
      name: 'list_trash', description: '列出回收站里的独立文件和顶层文件夹（软删除、30 天内可还原）；文件夹内的文件随文件夹整体恢复，不重复列出。',
      parameters: { type: 'object', properties: {} },
    } } },
    effect: 'read',
    validate(input) {
      return input !== null && typeof input === 'object' && !Array.isArray(input)
        ? { success: true, data: input } : { success: false }
    },
    async execute(input, scope) {
      const limit = limitValue((input as Record<string, unknown>).limit)
      scope.signal.throwIfAborted()
      const { files, folders } = await port.list(scope.identity, limit, scope.signal)
      scope.signal.throwIfAborted()
      const items = [...files, ...folders].sort((a, b) => (a.deleted_at ?? '') > (b.deleted_at ?? '') ? -1 : (a.deleted_at ?? '') < (b.deleted_at ?? '') ? 1 : 0)
      const more = items.length > limit || files.length === limit || folders.length === limit
      const selected = items.slice(0, limit)
      return { kind: 'completed', successful: true, mutated: false, value: more
        ? { items: selected, note: `仅列出最近 ${limit} 个，可能还有更多；要清空整个回收站用 permanent_delete(all=true) 一次清，别逐个删。` }
        : selected }
    },
  }
}

export interface TrashRestoreRequest {
  identity:RunIdentity; roundId:string; toolCallId:string; kind:'file'|'folder'; id:number
}
export interface TrashRestorePort {
  apply(input:TrashRestoreRequest & {signal:AbortSignal}):Promise<import('../models.js').ToolResult>
  reconcile(input:TrashRestoreRequest):Promise<import('../models.js').ToolResult>
}
/** 回收站恢复复用 Host 的文件领域服务和持久调用收据。 */
export function createTrashRestoreTools(port:TrashRestorePort):ToolDefinition[] {
  return (['file','folder'] as const).map(kind=>{
    const name=`restore_${kind}`, field=`${kind}_id`
    return {definition:{name,schema:{type:'function',function:{name,description:kind==='file'?'把回收站里的文件还原回原位置。':'把回收站里的文件夹及其子文件、子文件夹还原回原位置。',parameters:{type:'object',properties:{[field]:{type:'integer'}},required:[field]}}}},effect:'write',
      validate(input:unknown){if(!input||typeof input!=='object'||Array.isArray(input))return {success:false};const id=(input as Record<string,unknown>)[field];return typeof id==='number'&&Number.isSafeInteger(id)?{success:true,data:input}:{success:false}},
      execute:(input:unknown,scope:import('./contracts.js').ToolScope,call:import('../models.js').ToolCall)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,kind,id:(input as Record<string,number>)[field]!,signal:scope.signal}),
      reconcile:(input:unknown,identity:RunIdentity & {roundId:string},call:import('../models.js').ToolCall)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,kind,id:(input as Record<string,number>)[field]!})}
  })
}

export interface TrashPurgeSnapshot {
  file_count: number
  folder_count: number
  digest: string
}
export interface TrashPurgeJobResult {
  id: number
  status: 'queued' | 'running' | 'completed' | 'failed'
  progressCurrent: number
  progressTotal: number
  failedCount: number
  errorCode: string | null
}
export interface TrashPurgeRequest {
  identity: RunIdentity
  roundId: string
  toolCallId: string
  snapshot: TrashPurgeSnapshot
}
export interface TrashPurgePort {
  preview(identity: RunIdentity, signal: AbortSignal): Promise<TrashPurgeSnapshot>
  apply(input: TrashPurgeRequest & { confirmation: ConfirmationClaimReference; signal: AbortSignal }): Promise<ToolResult>
  reconcile(input: TrashPurgeRequest): Promise<ToolResult>
}
export interface TrashPurgeConfirmation {
  gate: ReturnType<typeof createConfirmationGate>
  claim(tx: unknown, receipt: ConfirmationClaimReference, signal: AbortSignal): Promise<boolean>
}

/** 只允许明确确认“全清”；物理删除由 Node 持久任务和 Host Worker 分批执行。 */
export function createPermanentDeleteTool(port: TrashPurgePort, confirmation: TrashPurgeConfirmation): ToolDefinition {
  const schema = z.object({ all: z.literal(true) }).strict()
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const failure = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
  function targets(value: TrashPurgeSnapshot): ConfirmationTargetSnapshot {
    return {
      targetRefs: { trash: ['all'] },
      targetsDigest: digest(['trash', 'all']),
      versionsDigest: digest([value.file_count, value.folder_count, value.digest]),
      displaySummary: `确认永久清空回收站：删除 ${value.file_count} 个文件和 ${value.folder_count} 个文件夹。此操作不可恢复。`,
    }
  }
  const argsDigest = digest({ all: true })
  async function apply(scope: ToolScope, call: ToolCall): Promise<ToolResult> {
    scope.signal.throwIfAborted()
    let current: TrashPurgeSnapshot
    try { current = await port.preview(scope.identity, scope.signal) }
    catch (error) { scope.signal.throwIfAborted(); return failure(error instanceof Error ? error.message : '回收站状态不可用') }
    if (![current.file_count, current.folder_count].every(value => Number.isSafeInteger(value) && value >= 0)
      || typeof current.digest !== 'string' || !current.digest) return failure('回收站快照无效')
    if (current.file_count + current.folder_count === 0)
      return { kind: 'completed', successful: true, mutated: false, value: { status: 'completed', progressCurrent: 0, progressTotal: 0, failedCount: 0 } }
    const snapshot = targets(current)
    if (scope.resolution === null) {
      const prepared = await confirmation.gate.prepare(call, scope, argsDigest, snapshot)
      return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : failure('回收站清空确认无效或已过期')
    }
    const verified = await confirmation.gate.verify(call, scope, argsDigest, snapshot)
    if (!verified.ok) return failure('回收站清空确认无效或已过期')
    return port.apply({ identity: scope.identity, roundId: scope.roundId, toolCallId: call.id,
      snapshot: current, confirmation: verified.value, signal: scope.signal })
  }
  return {
    definition: { name: 'permanent_delete', schema: { type: 'function', function: {
      name: 'permanent_delete',
      description: '永久清空整个回收站。必须传 all=true；此操作不可恢复，Node 会在用户确认后创建持久清理任务。',
      parameters: { type: 'object', properties: { all: { type: 'boolean', const: true } }, required: ['all'], additionalProperties: false },
    } } },
    effect: 'write', requiresInteraction: true, confirmationReplay: true,
    validate(input) { return schema.safeParse(input) },
    execute(_input, scope, call) { return apply(scope, call) },
    reconcile(input, identity, call) {
      if (!schema.safeParse(input).success) return Promise.resolve({ kind: 'unknown' })
      return port.reconcile({ identity, roundId: identity.roundId, toolCallId: call.id,
        snapshot: { file_count: 0, folder_count: 0, digest: '' } })
    },
  }
}
