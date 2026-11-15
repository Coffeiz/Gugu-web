import { strip } from '../../shared/values.js'
import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { RunIdentity, ToolResult } from '../models.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { createKyselyWorkspaceDeclarationRuntime, type WorkspaceDeclarationDatabase } from '../../data/workspace-declarations.js'
import { createKyselyAgentWorkspaceReader } from '../../data/workspace-list.js'
import { createWorkspaceDeclarationUpdater, WorkspaceUpdateError } from '../../workspaces/workspace-declarations.js'
import { redactToolError } from '../core.js'
import { z } from 'zod'
import type { createAgentWorkspaceQueries } from '../../workspaces/workspace-list.js'
import type { ToolDefinition } from './contracts.js'

/** 工作区组只读取声明，不将workspace_id当成directory_id或执行授权。 */
export function createWorkspaceReadTools(queries: ReturnType<typeof createAgentWorkspaceQueries>): ToolDefinition[] {
  const validators = { list_workspaces: z.object({}).strict(), get_workspace: z.object({ workspace_id: z.number().int().safe() }).strict() }
  return (Object.keys(validators) as (keyof typeof validators)[]).map(name => ({
    definition: { name, schema: { type: 'function', function: { name,
      description: name === 'list_workspaces' ? '列出当前用户的工作区，包括停用项。kind=directory 是顶层物理工作区，kind=folder/project 是对应资源的 Shell 绑定。workspace_id 与 directory_id/folder_id/project_id 属于不同 ID。' : '读取当前用户的工作区详情；workspace_id 与目录、项目、文件夹 ID 不同。',
      parameters: z.toJSONSchema(validators[name]) as Record<string, import('../models.js').Json> } } },
    effect: 'read', validate(input) { return validators[name].safeParse(input) },
    async execute(input, scope) {
      const value = name === 'list_workspaces' ? await queries.list(scope.identity.ownerId, scope.signal)
        : await queries.get(scope.identity.ownerId, (input as { workspace_id: number }).workspace_id, scope.signal)
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
 const schema=z.object({workspace_id:z.number().int().safe(),workspace_name:z.string().refine(value=>[...value].length<=200).optional(),enabled:z.boolean().optional()}).strict()
 return {definition:{name:'update_workspace',schema:{type:'function',function:{name:'update_workspace',
  description:'修改工作区显示名或启用状态；目录工作区同步显示名，不改变物理路径或绑定。',
  parameters:{type:'object',properties:{workspace_id:{type:'integer'},workspace_name:{type:'string',maxLength:200},enabled:{type:'boolean'}},required:['workspace_id'],additionalProperties:false}}}},
  effect:'write',validate:input=>schema.safeParse(input),
  execute:(args,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,args:args as WorkspaceMutationInput['args'],signal:scope.signal}),
  reconcile:(args,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,args:args as WorkspaceMutationInput['args']})}
}
