import { strip } from '../../shared/values.js'
import { asciiDecimalDigits } from '../../shared/unicode-decimal.js'
import type { RunIdentity } from '../models.js'
import type { ToolDefinition } from './contracts.js'

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
