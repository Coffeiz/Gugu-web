import { strip } from '../../shared/values.js'
import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { RunIdentity, ToolResult } from '../models.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { createKyselyWorkspaceDeclarationRuntime, type WorkspaceDeclarationDatabase } from '../../workspaces/workspace-declarations-store.js'
import { createKyselyAgentWorkspaceReader } from '../../workspaces/workspace-list-store.js'
import { createWorkspaceDeclarationUpdater, WorkspaceUpdateError } from '../../workspaces/workspace-declarations.js'
import { redactToolError } from '../core.js'
import { z } from 'zod'
import type { createAgentWorkspaceQueries } from '../../workspaces/workspace-list.js'
import type { ToolDefinition } from './contracts.js'

/** 工作区组只读取声明，不将workspace_id当成directory_id或执行授权。 */
const workspaceId = z.union([z.number().int().positive().safe(), z.string().trim().min(1).max(256)])

export function createWorkspaceReadTools(queries: ReturnType<typeof createAgentWorkspaceQueries>): ToolDefinition[] {
  const validators = { list_workspaces: z.object({}).strict(), get_workspace: z.object({ workspace_id: workspaceId }).strict() }
  return (Object.keys(validators) as (keyof typeof validators)[]).map(name => ({
    definition: { name, schema: { type: 'function', function: { name,
      description: name === 'list_workspaces' ? '列出当前用户可用的工作区。workspace_id 是工作区自身标识，不可与 project_id 混用。' : '读取当前用户工作区详情；workspace_id 是工作区自身标识，不可与 project_id 混用。',
      parameters: z.toJSONSchema(validators[name]) as Record<string, import('../models.js').Json> } } },
    effect: 'read', validate(input) { return validators[name].safeParse(input) },
    async execute(input, scope) {
      const value = name === 'list_workspaces' ? await queries.list(scope.identity.ownerId, scope.signal)
        : await queries.get(scope.identity.ownerId, (input as { workspace_id: number | string }).workspace_id, scope.signal)
      scope.signal.throwIfAborted()
      return value === null ? { kind: 'completed', successful: false, mutated: false,
        value: { error: '工作区不存在；workspace_id 不是 directory_id、project_id' } }
        : { kind: 'completed', successful: true, mutated: false, value }
    },
  }))
}

const projectWorkspaceSchema = z.object({
  project_id: z.number().int().positive().safe(),
  workspace_id: workspaceId,
  bound: z.boolean(),
}).strict()

export type ProjectWorkspaceBindingPort = (
  identity: RunIdentity, input: z.infer<typeof projectWorkspaceSchema>, signal: AbortSignal,
) => Promise<boolean>

export function createProjectWorkspaceBindingTool(apply: ProjectWorkspaceBindingPort): ToolDefinition {
  const name = 'set_project_workspace'
  return {
    definition: { name, schema: { type: 'function', function: { name,
      description: '将已登记的文件库工作区关联到项目并设为当前文件目录。bound=false 解除关联，若解除的是当前目录，项目回到内置项目文件目录。先用 list_workspaces 获取 workspace_id。',
      parameters: z.toJSONSchema(projectWorkspaceSchema) as Record<string, import('../models.js').Json>,
    } } },
    effect: 'write',
    validate: input => projectWorkspaceSchema.safeParse(input),
    async execute(input, scope) {
      scope.signal.throwIfAborted()
      const args = projectWorkspaceSchema.parse(input)
      try {
        const changed = await apply(scope.identity, args, scope.signal)
        return { kind: 'completed', successful: true, mutated: changed, value: { ...args, changed } }
      } catch (error) {
        scope.signal.throwIfAborted()
        if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code))
          return { kind: 'completed', successful: false, mutated: false, value: { error: redactToolError(error.message) } }
        throw error
      }
    },
  }
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
 args:{workspace_name:string;kind:'project'|'directory';project_id?:number;enabled?:boolean}
}
export interface WorkspaceCreatePort {
 create(input:WorkspaceCreateInput & {signal:AbortSignal}):Promise<ToolResult>
 reconcile(input:WorkspaceCreateInput):Promise<ToolResult>
}

/** 创建工作区声明；目录和项目的实际创建/归属由 Host 共享服务完成。 */
export function createWorkspaceTool(port:WorkspaceCreatePort):ToolDefinition{
 const schema=z.object({workspace_name:z.string().refine(value=>value.trim().length>0&&[...value].length<=200),
  kind:z.literal('directory'),enabled:z.boolean().optional()}).strict()
 return {definition:{name:'create_workspace',schema:{type:'function',function:{name:'create_workspace',description:'创建文件库顶层工作区。使用 set_project_workspace 将已有工作区绑定到项目。',parameters:{type:'object',properties:{workspace_name:{type:'string',minLength:1,maxLength:200},kind:{type:'string',enum:['directory']},enabled:{type:'boolean'}},required:['workspace_name','kind'],additionalProperties:false}}}},
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
