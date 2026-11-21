import { strip } from '../../shared/values.js'
import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { RunIdentity, ToolResult } from '../models.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { createKyselyWorkspaceDeclarationRuntime, type WorkspaceDeclarationDatabase } from '../../workspaces/workspace-declarations-store.js'
import { createKyselyAgentWorkspaceReader } from '../../workspaces/workspace-list-store.js'
import { createWorkspaceDeclarationUpdater, WorkspaceUpdateError } from '../../workspaces/workspace-declarations.js'
import { createWorkspaceDeleter } from '../../workspaces/workspace-delete.js'
import { createKyselyWorkspaceDeletionTransaction, type WorkspaceDeletionTables } from '../../workspaces/workspace-delete-store.js'
import { redactToolError } from '../core.js'
import { z } from 'zod'
import type { Transaction } from 'kysely'
import type { Database } from '../../data/schema.js'
import { createConfirmationGate, type ConfirmationClaimReference } from './confirmation.js'
import type { ToolCall } from '../models.js'
import type { ToolScope } from './contracts.js'
import type { createAgentWorkspaceQueries } from '../../workspaces/workspace-list.js'
import type { ToolDefinition } from './contracts.js'

/** 工作区组只读取声明，不将workspace_id当成directory_id或执行授权。 */
export function createWorkspaceReadTools(queries: ReturnType<typeof createAgentWorkspaceQueries>): ToolDefinition[] {
  const workspaceId = z.union([z.number().int().positive().safe(), z.string().trim().min(1).max(256)])
  const validators = { list_workspaces: z.object({}).strict(), get_workspace: z.object({ workspace_id: workspaceId }).strict() }
  return (Object.keys(validators) as (keyof typeof validators)[]).map(name => ({
    definition: { name, schema: { type: 'function', function: { name,
      description: name === 'list_workspaces' ? '列出当前用户可用的工作区。workspace_id 是工作区自身标识，不可与 project_id 或 folder_id 混用。' : '读取当前用户工作区详情；workspace_id 是工作区自身标识，不可与 project_id 或 folder_id 混用。',
      parameters: z.toJSONSchema(validators[name]) as Record<string, import('../models.js').Json> } } },
    effect: 'read', validate(input) { return validators[name].safeParse(input) },
    async execute(input, scope) {
      const value = name === 'list_workspaces' ? await queries.list(scope.identity.ownerId, scope.signal)
        : await queries.get(scope.identity.ownerId, (input as { workspace_id: number | string }).workspace_id, scope.signal)
      scope.signal.throwIfAborted()
      return value === null ? { kind: 'completed', successful: false, mutated: false,
        value: { error: '工作区不存在；workspace_id 不是 directory_id、project_id 或 folder_id' } }
        : { kind: 'completed', successful: true, mutated: false, value }
    },
  }))
}

export interface WorkspaceMutationInput {
 identity: RunIdentity; roundId:string; toolCallId:string
 args:{workspace_id:number;workspace_name?:string;enabled?:boolean}
}
export interface WorkspaceMutationPort {
 apply(input:WorkspaceMutationInput & {signal:AbortSignal}):Promise<ToolResult>
 reconcile(input:WorkspaceMutationInput):Promise<ToolResult>
}

export interface WorkspaceCreateInput {
 identity: RunIdentity; roundId:string; toolCallId:string
 args:{workspace_name:string;kind:'project'|'folder'|'directory';project_id?:number;folder_id?:number;enabled?:boolean}
}
export interface WorkspaceCreatePort {
 create(input:WorkspaceCreateInput & {signal:AbortSignal}):Promise<ToolResult>
 reconcile(input:WorkspaceCreateInput):Promise<ToolResult>
}

/** 创建工作区声明；目录、项目和文件夹的实际创建/归属由 Host 共享服务完成。 */
export function createWorkspaceTool(port:WorkspaceCreatePort):ToolDefinition{
 const schema=z.object({workspace_name:z.string().refine(value=>value.trim().length>0&&[...value].length<=200),
  kind:z.enum(['project','folder','directory']),project_id:z.number().int().positive().safe().optional(),folder_id:z.number().int().positive().safe().optional(),enabled:z.boolean().optional()})
  .strict().superRefine((value,ctx)=>{
   if(value.kind==='project'&&value.folder_id!==undefined)ctx.addIssue({code:'custom',message:'kind=project 只能填写 project_id，不能填写 folder_id',path:['folder_id']})
   if(value.kind==='folder'&&value.project_id!==undefined)ctx.addIssue({code:'custom',message:'kind=folder 只能填写 folder_id，不能填写 project_id',path:['project_id']})
   if(value.kind==='directory'&&(value.folder_id!==undefined||value.project_id!==undefined))ctx.addIssue({code:'custom',message:'kind=directory 只填写 workspace_name，不接受 folder_id 或 project_id'})
   if(value.kind==='project'&&value.project_id===undefined)ctx.addIssue({code:'custom',message:'kind=project 需要 project_id',path:['project_id']})
   if(value.kind==='folder'&&value.folder_id===undefined)ctx.addIssue({code:'custom',message:'kind=folder 需要 folder_id',path:['folder_id']})
  })
 return {definition:{name:'create_workspace',schema:{type:'function',function:{name:'create_workspace',description:'创建工作区目标：kind=directory 创建顶层物理目录，kind=project 使用 project_id，kind=folder 使用 folder_id；项目与文件夹 ID 不可混用。可用 enabled 指定新绑定状态。',parameters:{type:'object',properties:{workspace_name:{type:'string',minLength:1,maxLength:200},kind:{type:'string',enum:['project','folder','directory']},project_id:{type:'integer'},folder_id:{type:'integer'},enabled:{type:'boolean'}},required:['workspace_name','kind'],additionalProperties:false}}}},
  effect:'write',validate:input=>schema.safeParse(input),async execute(input,scope,call){
   scope.signal.throwIfAborted()
   return port.create({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,args:input as WorkspaceCreateInput['args'],signal:scope.signal})
  },reconcile(input,identity,call){return port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,args:input as WorkspaceCreateInput['args']})}}
}
/** 收据、目录显示名同步和完整结果查询借用同一SQL事务；不改变物理目录。 */
export function createWorkspaceMutationPort(core:SqlDataRuntime):WorkspaceMutationPort{
 if(!core.receipts)throw new CoreError('schema_upgrade_required','工作区修改需要持久调用收据')
 const absent=new Error('收据不存在')
 function key(input:WorkspaceMutationInput){
  const context=dataContext(input.identity.ownerId)
  const parts=['workspace',context.ownerId,input.identity.sessionId,input.identity.runId,input.roundId,input.toolCallId]
  if(parts.some(value=>typeof value!=='string'||!value.trim()))throw new CoreError('invalid_request','工具运行身份无效')
  const raw=createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  const hex=raw.slice(0,12)+'5'+raw.slice(13,16)+'8'+raw.slice(17,32)
  const operationId=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
  return {context,operationId}
 }
 async function recover(input:WorkspaceMutationInput):Promise<ToolResult>{
  try{
   const k=key(input),receipt=await core.operationWithTransaction(k.context,k.operationId,'agent.workspace.update',input.args,async()=>{throw absent})
   return {kind:'completed',successful:true,mutated:false,value:receipt.result}
  }catch{return {kind:'unknown'}}
 }
 return {reconcile:recover,async apply(input){
  input.signal.throwIfAborted()
  if(input.args.workspace_name===undefined&&input.args.enabled===undefined)
   return {kind:'completed',successful:false,mutated:false,value:{error:'至少提供 workspace_name 或 enabled 一个要修改的字段'}}
  let callbackError:unknown
  try{
   const k=key(input)
   const receipt=await core.operationWithTransaction(k.context,k.operationId,'agent.workspace.update',input.args,async tx=>{
    try{
     input.signal.throwIfAborted()
     const before=await createKyselyAgentWorkspaceReader(tx,core.backend).read(k.context.ownerId,input.args.workspace_id,input.signal)
     if(!before[0])throw new WorkspaceUpdateError(404,'工作区不存在')
     const name=input.args.workspace_name===undefined?undefined:strip(input.args.workspace_name)
     if(name==='')throw new WorkspaceUpdateError(400,'工作区名称不能为空')
     const db=tx as unknown as Kysely<WorkspaceDeclarationDatabase>
     const update=createWorkspaceDeclarationUpdater(createKyselyWorkspaceDeclarationRuntime(db,core.backend))
     await update(k.context.ownerId,input.args.workspace_id,{name,enabled:input.args.enabled})
     const rows=await createKyselyAgentWorkspaceReader(tx,core.backend).read(k.context.ownerId,input.args.workspace_id,input.signal)
     if(!rows[0])throw new WorkspaceUpdateError(404,'工作区不存在')
     input.signal.throwIfAborted()
     return {success:true,workspace:rows[0]}
    }catch(error){callbackError=error;throw error}
   },{signal:input.signal})
   return {kind:'completed',successful:true,mutated:!receipt.replayed,value:receipt.result}
  }catch(error){
   if(error===callbackError&&(error instanceof WorkspaceUpdateError||error instanceof CoreError))
    return {kind:'completed',successful:false,mutated:false,value:{error:redactToolError(error.message)}}
   if(error instanceof CoreError&&error.code==='conflict')
    return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
   return recover(input)
  }
 }}
}
export function createWorkspaceUpdateTool(port:WorkspaceMutationPort):ToolDefinition{
 const schema=z.object({workspace_id:z.number().int().positive().safe(),workspace_name:z.string().refine(value=>[...value].length<=200).optional(),enabled:z.boolean().optional()}).strict()
 return {definition:{name:'update_workspace',schema:{type:'function',function:{name:'update_workspace',
  description:'修改工作区显示名或启用状态；目录工作区同步显示名，不改变物理路径或绑定。',
  parameters:{type:'object',properties:{workspace_id:{type:'integer'},workspace_name:{type:'string',maxLength:200},enabled:{type:'boolean'}},required:['workspace_id'],additionalProperties:false}}}},
  effect:'write',validate:input=>schema.safeParse(input),
  execute:(args,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,args:args as WorkspaceMutationInput['args'],signal:scope.signal}),
  reconcile:(args,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,args:args as WorkspaceMutationInput['args']})}
}

export interface WorkspaceUnlinkConfirmation {
 gate: ReturnType<typeof createConfirmationGate>
 claim(tx: Transaction<Database>, reference: ConfirmationClaimReference, signal: AbortSignal): Promise<boolean>
}

export interface WorkspaceDirectoryDeletePreview {
 id: number; name: string; directory_name: string; is_default: boolean; is_system: boolean
 file_count: number; folder_count: number; bound_session_count: number; bound_task_count: number
}
export interface WorkspaceDirectoryDeleteRequest {
 identity: RunIdentity; roundId: string; toolCallId: string; directoryId: number; preview: WorkspaceDirectoryDeletePreview
}
export interface WorkspaceDirectoryDeleteReceiptRequest {
 identity: RunIdentity; roundId: string; toolCallId: string; directoryId: number
}
export interface WorkspaceDirectoryDeletePort {
 preview(identity: RunIdentity, directoryId: number, signal: AbortSignal): Promise<WorkspaceDirectoryDeletePreview | null>
 apply(input: WorkspaceDirectoryDeleteRequest & { confirmation: ConfirmationClaimReference; signal: AbortSignal }): Promise<ToolResult>
 reconcile(input: WorkspaceDirectoryDeleteReceiptRequest): Promise<ToolResult>
}

function workspaceUnlinkDigest(value: unknown): string {
 return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 经用户确认解除工作区声明和会话/普通任务绑定；不删除目录、父资源或文件。 */
export function createWorkspaceUnlinkTool(
 core: SqlDataRuntime,
 queries: ReturnType<typeof createAgentWorkspaceQueries>,
 confirmation: WorkspaceUnlinkConfirmation,
): ToolDefinition {
 if (!core.receipts) throw new CoreError('schema_upgrade_required', '工作区解除绑定需要持久调用收据')
 const schema = z.object({ workspace_id: z.number().int().positive().safe() }).strict()
 const method = 'agent.workspace.unlink'
 const absent = new Error('工作区解除绑定收据不存在')
 const failure = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })

 function request(args: { workspace_id: number }, identity: RunIdentity, roundId: string, toolCallId: string) {
  const context = dataContext(identity.ownerId)
  const parts = ['workspace.unlink', context.ownerId, identity.sessionId, identity.runId, roundId, toolCallId]
  if (parts.some(value => typeof value !== 'string' || !value.trim())) throw new CoreError('invalid_request', '工具运行身份无效')
  const hex = workspaceUnlinkDigest(parts)
  const raw = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17, 32)}`
  return { args, identity, context, operationId: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}` }
 }
 async function reconcile(input: ReturnType<typeof request>): Promise<ToolResult> {
  try {
   const receipt = await core.operationWithTransaction(input.context, input.operationId, method, input.args, async () => { throw absent })
   return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
  } catch { return { kind: 'unknown' } }
 }
 async function apply(input: ReturnType<typeof request>, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
  const { signal } = scope
  signal.throwIfAborted()
  const stored = scope.resolution?.status === 'confirmed' ? await reconcile(input) : null
  if (stored?.kind === 'completed') return stored
  const current = await queries.get(input.context.ownerId, input.args.workspace_id, signal)
  if (!current) return failure('工作区不存在；workspace_id 不是 directory_id、project_id 或 folder_id')
  const name = typeof current.name === 'string' ? current.name : ''
  const kind = typeof current.kind === 'string' ? current.kind : ''
  const snapshot = {
   targetIds: { workspace_id: [input.args.workspace_id] },
   targetsDigest: workspaceUnlinkDigest([input.args.workspace_id]),
   versionsDigest: workspaceUnlinkDigest([input.args.workspace_id, name, kind]),
  }
  const argsDigest = workspaceUnlinkDigest(input.args)
  if (scope.resolution === null) {
   const prepared = await confirmation.gate.prepare(call, scope, argsDigest, snapshot)
   return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : failure('工作区解除绑定确认无效或已过期')
  }
  const verified = await confirmation.gate.verify(call, scope, argsDigest, snapshot)
  if (!verified.ok) return failure('工作区解除绑定确认无效或已过期')
  let callbackError: unknown
  try {
   const receipt = await core.operationWithTransaction(input.context, input.operationId, method, input.args, async tx => {
    try {
     signal.throwIfAborted()
     if (!await confirmation.claim(tx, verified.value, signal)) throw new Error('confirmation_claim_rejected')
     const deletion = createKyselyWorkspaceDeletionTransaction(tx as unknown as Kysely<WorkspaceDeletionTables>, core.backend)
     if (!await deletion.lockOwnedWorkspace(input.context.ownerId, input.args.workspace_id)) throw new CoreError('not_found', '工作区不存在')
     const rows = await createKyselyAgentWorkspaceReader(tx, core.backend).read(input.context.ownerId, input.args.workspace_id, signal)
     const row = rows[0]
     if (!row || workspaceUnlinkDigest([input.args.workspace_id, row.name, row.kind]) !== snapshot.versionsDigest)
      throw new Error('workspace_target_changed')
     const deleter = createWorkspaceDeleter({
      transaction: work => work(deletion),
     })
     await deleter(input.context.ownerId, input.args.workspace_id, { signal })
     signal.throwIfAborted()
     return { success: true, deleted_workspace_id: input.args.workspace_id, name }
    } catch (error) { callbackError = error; throw error }
   }, { signal })
   return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
  } catch (error) {
   if (error === callbackError && error instanceof Error && error.message === 'workspace_target_changed') return failure('工作区解除绑定确认已失效，目标已变化')
   if (error === callbackError && error instanceof Error && error.message === 'confirmation_claim_rejected') return failure('工作区解除绑定确认无效或已过期')
   if (error === callbackError && error instanceof CoreError && error.code === 'not_found') return failure('工作区不存在；workspace_id 不是 directory_id、project_id 或 folder_id')
   if (error === callbackError && signal.aborted) throw error
   return reconcile(input)
  }
 }
 return {
  definition: { name: 'unlink_workspace', schema: { type: 'function', function: {
   name: 'unlink_workspace', description: '确认后解除 Shell 工作区与会话的绑定，并停用关联的普通定时任务；不删除顶层目录、项目、文件夹或文件。',
   parameters: { type: 'object', properties: { workspace_id: { type: 'integer' } }, required: ['workspace_id'], additionalProperties: false },
  } } },
  effect: 'write', requiresInteraction: true, confirmationReplay: true,
  validate: input => schema.safeParse(input),
  execute(input, scope, call) { return apply(request(input as { workspace_id: number }, scope.identity, scope.roundId, call.id), scope, call) },
  reconcile(input, identity, call) { return reconcile(request(input as { workspace_id: number }, identity, identity.roundId, call.id)) },
 }
}

/** 经持久确认删除顶层目录及内容；未知提交结果只查询收据，不再次删除磁盘目录。 */
export function createWorkspaceDirectoryDeleteTool(port: WorkspaceDirectoryDeletePort, confirmation: WorkspaceUnlinkConfirmation): ToolDefinition {
 const schema = z.object({ directory_id: z.number().int().safe().positive() }).strict()
 const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
 const fail = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
 function snapshot(preview: WorkspaceDirectoryDeletePreview) {
  return {
   targetIds: { directory_id: [preview.id] },
   targetsDigest: digest([preview.id]),
   versionsDigest: digest([preview.id, preview.name, preview.directory_name, preview.is_default, preview.is_system,
    preview.file_count, preview.folder_count, preview.bound_session_count, preview.bound_task_count]),
   displaySummary: `删除工作区目录「${preview.name}」及磁盘中的 ${preview.file_count} 个文件（不可恢复）；删除 ${preview.folder_count} 个文件夹记录，解除 ${preview.bound_session_count} 个会话绑定，并停用 ${preview.bound_task_count} 个定时任务`,
  }
 }
 function request(args: { directory_id: number }, identity: RunIdentity, roundId: string, toolCallId: string,
  preview: WorkspaceDirectoryDeletePreview): WorkspaceDirectoryDeleteRequest {
  return { identity, roundId, toolCallId, directoryId: args.directory_id, preview }
 }
 async function apply(args: { directory_id: number }, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
  scope.signal.throwIfAborted()
  if (scope.resolution?.status === 'confirmed') {
   let receipt: ToolResult
   try { receipt = await port.reconcile({ identity: scope.identity, roundId: scope.roundId,
    toolCallId: call.id, directoryId: args.directory_id }) }
   catch { return { kind: 'unknown' } }
   if (receipt.kind === 'completed') return receipt
  }
  let preview: WorkspaceDirectoryDeletePreview | null
  try { preview = await port.preview(scope.identity, args.directory_id, scope.signal) }
  catch (error) {
   scope.signal.throwIfAborted()
   if (error instanceof CoreError && error.code === 'conflict') return fail('默认工作区不可删除')
   if (error instanceof CoreError && error.code === 'not_found') return fail('Workspace 目录不存在')
   return fail(redactToolError(error instanceof Error ? error.message : 'Workspace 目录不可用'))
  }
  // 确认后的重试可能发生在磁盘目录已移除、结果收据尚未成功写入时。
  // 此时保留 unknown，不能把它改成普通失败，也不能重新执行物理删除。
  if (!preview) return scope.resolution?.status === 'confirmed' ? { kind: 'unknown' } : fail('Workspace 目录不存在')
  if (preview.is_default || preview.is_system) return fail('默认工作区不可删除')
  const expected = snapshot(preview), argsDigest = digest(args)
  if (scope.resolution === null) {
   const prepared = await confirmation.gate.prepare(call, scope, argsDigest, expected)
   return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : fail('工作区目录删除确认无效或已过期')
  }
  const verified = await confirmation.gate.verify(call, scope, argsDigest, expected)
  if (!verified.ok) return fail('工作区目录删除确认无效或已过期')
  return port.apply({ ...request(args, scope.identity, scope.roundId, call.id, preview), confirmation: verified.value, signal: scope.signal })
 }
 function parse(input: unknown) { return schema.safeParse(input) }
 return {
  definition: { name: 'delete_workspace_directory', schema: { type: 'function', function: {
   name: 'delete_workspace_directory', description: '确认后永久删除顶层物理工作区目录及其中内容；会解除会话绑定、停用关联任务并关闭使用该目录的终端。先用 list_workspaces 确认 kind=directory 并传 directory_id。不要用 delete_folder 或 unlink_workspace 代替。',
   parameters: { type: 'object', properties: { directory_id: { type: 'integer', minimum: 1 } }, required: ['directory_id'], additionalProperties: false },
  } } },
  effect: 'write', requiresInteraction: true, confirmationReplay: true,
  validate: input => parse(input),
  execute(input, scope, call) { return apply(input as { directory_id: number }, scope, call) },
  reconcile(input, identity, call) {
   const parsed = parse(input)
   if (!parsed.success) return Promise.resolve({ kind: 'unknown' })
   return port.reconcile({ identity, roundId: identity.roundId, toolCallId: call.id,
    directoryId: parsed.data.directory_id })
  },
 }
}
