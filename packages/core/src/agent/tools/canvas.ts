import { MindCanvasRelationMutationError } from '../../mind/relation-delete-global.js'
import { createMindCanvasRelationDelete } from '../../mind/relation-delete-canvas.js'
import { createSqlMindCanvasRelationDeleteRuntime } from '../../mind/relation-delete-canvas-sql.js'
import { createMindCanvasDelete } from '../../mind/canvas-delete.js'
import { createSqlMindCanvasDeleteRuntime } from '../../mind/canvas-delete-sql.js'
import { MindRefNodeCreateError } from '../../mind/ref-node-create.js'
import { applyCanvasEditBatch, applyCanvasEdits, type CanvasBatchIntent, type CanvasEditIntent } from '../../mind/canvas-edits.js'
import { MindCanvasItemMutationError } from '../../mind/canvas-item-remove.js'
import { MindCanvasNoteMutationError } from '../../mind/canvas-note.js'
import { createHash } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from '../../data/schema.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import { strip } from '../../shared/values.js'
import { createMindCanvasCreation, MindCanvasMutationError } from '../../mind/canvas-create.js'
import { createSqlMindCanvasCreateRuntime } from '../../mind/canvas-create-sql.js'
import { z } from 'zod'
import type { createSqlMindCanvasReader } from '../../mind/canvas-read.js'
import type { ToolDefinition } from './contracts.js'
import { createConfirmationGate, type ConfirmationClaimReference, type ConfirmationTargetSnapshot } from './confirmation.js'

const inputSchema = z.object({ project_id: z.number().int().safe().optional(), limit: z.number().int().safe().optional(), offset: z.number().int().safe().optional() }).passthrough()
export type AgentCanvasReader = Pick<ReturnType<typeof createSqlMindCanvasReader>, 'listAgentCanvases' | 'getAgentCanvas' | 'searchAgentCanvas' | 'getAgentCanvasFocus'>

/** Host 注入实时 owner-scoped 读取，不使用工具参数中的身份。 */
export function createCanvasReadTools(reader: AgentCanvasReader): ToolDefinition[] {
  const listing:ToolDefinition = {
    definition: { name: 'canvas_list', schema: { type: 'function', function: {
      name: 'canvas_list', description: '分页查询画布列表、节点数与视图。', parameters: { type: 'object', properties: {
        project_id: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' },
      } },
    } } }, effect: 'read',
    validate(input) { const parsed = inputSchema.safeParse(input); return parsed.success ? { success: true, data: parsed.data } : { success: false } },
    async execute(input, scope) {
      const args = input as z.infer<typeof inputSchema>
      scope.signal.throwIfAborted()
      const value = await reader.listAgentCanvases(scope.identity.ownerId, {
        signal: scope.signal, projectId: args.project_id, limit: Math.max(1, Math.min(args.limit ?? 20, 20)), offset: Math.max(0, args.offset ?? 0),
      })
      scope.signal.throwIfAborted()
      return { kind: 'completed', successful: true, mutated: false, value }
    },
  }
  return [listing,...createCanvasDetailTools(reader),...createCanvasFocusTools(reader)]
}


function createCanvasDetailTools(reader:AgentCanvasReader):ToolDefinition[]{
 const common={canvas_id:z.number().int().safe(),include_content:z.boolean().optional(),limit:z.number().int().min(1).max(20).optional()}
 const schemas={canvas_get:z.object({...common,include_nodes:z.boolean().optional(),include_relations:z.boolean().optional(),offset:z.number().int().min(0).optional()}).passthrough(),
  canvas_search:z.object({...common,query:z.string().optional(),q:z.string().optional(),queries:z.array(z.string()).optional(),types:z.array(z.enum(['canvas_note','project','file','event'])).optional(),mode:z.enum(['OR','AND']).optional()}).passthrough()}
 return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name=>({
  definition:{name,schema:{type:'function',function:{name,description:name==='canvas_get'?'读取画布分页节点和独立关系快照，审计仅给默认端点建议，不修改布局。':'搜索画布已有节点，返回limit+1探测count及truncated。',
   parameters:(()=>{const result=z.toJSONSchema(schemas[name]) as Record<string,import('../models.js').Json>;delete result.additionalProperties;return result})()}}},
  effect:'read',validate:input=>schemas[name].safeParse(input),
  async execute(input,scope){
   const args=input as import('../../mind/canvas-read.js').AgentCanvasOptions
   const value=await reader[name==='canvas_get'?'getAgentCanvas':'searchAgentCanvas'](scope.identity.ownerId,args,scope.signal)
   scope.signal.throwIfAborted()
   return {kind:'completed',successful:!('error' in value),mutated:false,value}
  },
 }))
}

const focusInput = z.object({ canvas_id: z.number().int().safe(), item_id: z.number().int().safe() }).strict()
type CanvasFocusReader = Pick<ReturnType<typeof createSqlMindCanvasReader>, 'getAgentCanvasFocus'>

/** 使用现有 owner-scoped 读取生成定位回执，不修改卡片或视口。 */
export function createCanvasFocusTools(reader: CanvasFocusReader): ToolDefinition[] {
  return [{
    definition: { name: 'canvas_focus_node', schema: { type: 'function', function: {
      name: 'canvas_focus_node', description: '生成用户可点击的画布卡片定位链接。',
      parameters: { type: 'object', properties: { canvas_id: { type: 'integer' }, item_id: { type: 'integer' } }, required: ['canvas_id', 'item_id'], additionalProperties:false },
    } } }, effect: 'read',
    validate(input) { const parsed = focusInput.safeParse(input); return parsed.success ? { success: true, data: parsed.data } : { success: false } },
    async execute(input, scope) {
      const args = input as z.infer<typeof focusInput>
      scope.signal.throwIfAborted()
      const value = await reader.getAgentCanvasFocus(scope.identity.ownerId,args,scope.signal)
      scope.signal.throwIfAborted()
      return { kind: 'completed', successful: !('error' in value), mutated: false, value }
    },
  }]
}

export function createCanvasPlaceableSearchTool(search: ReturnType<typeof import('../../mind/canvas-read.js').createAgentPlaceableSearch>): ToolDefinition {
  const schema = z.object({ query: z.string().optional(), q: z.string().optional(), queries: z.array(z.string()).optional(),
    types: z.array(z.enum(['project','file','event'])).optional(), canvas_id: z.number().int().safe().optional(),
    mode: z.enum(['OR','AND']).optional(), limit: z.number().int().min(1).max(20).optional(), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 21).optional() }).passthrough()
  return { definition: { name: 'canvas_search_placeable', schema: { type: 'function', function: { name: 'canvas_search_placeable',
    description: '搜索当前用户可放入画布的项目、文件和日历活动，不自动创建引用节点。', parameters: z.toJSONSchema(schema) as Record<string,import('../models.js').Json> } } },
    effect: 'read', validate: input => schema.safeParse(input),
    async execute(input, scope) {
      const value = await search(scope.identity.ownerId, input as z.infer<typeof schema>, scope.signal)
      scope.signal.throwIfAborted()
      return { kind:'completed', successful: !('error' in value), mutated:false, value }
    },
  }
}

export interface CanvasCreateRequest {
  identity: import('../models.js').RunIdentity; roundId: string; toolCallId: string
  args: { title: string; project_id?: number | null }
}
export interface CanvasCreatePort {
  create(input: CanvasCreateRequest & { signal: AbortSignal }): Promise<import('../models.js').ToolResult>
  reconcile(input: CanvasCreateRequest): Promise<import('../models.js').ToolResult>
}
/** 创建、Undo 和调用收据共用事务；提交未知只能查收据，不再次插入。 */
export function createCanvasCreationPort(core: import('../../data/runtime.js').SqlDataRuntime, publishChanged: import('../../mind/canvas-create.js').MindCanvasCreateRuntime['publishChanged']): CanvasCreatePort {
  if (!core.receipts || typeof publishChanged !== 'function') throw new Error('画布创建后端未装配')
  const absent = new Error('画布创建收据不存在')
  async function recover(input: CanvasCreateRequest): Promise<import('../models.js').ToolResult> {
    try {
      const key = canvasCoordinate(input,'canvas.create')
      const stored = await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.create',input.args,async()=>{throw absent})
      return { kind:'completed',successful:true,mutated:false,value:stored.result }
    } catch { return {kind:'unknown'} }
  }
  return { reconcile:recover, async create(input) {
    input.signal.throwIfAborted()
    const title = strip(input.args.title)
    if (!title) return {kind:'completed',successful:false,mutated:false,value:{error:'需要提供画布标题'}}
    let callbackError: unknown
    let publication: Parameters<typeof publishChanged>[0] | undefined
    try {
      const key = canvasCoordinate(input,'canvas.create')
      const receipt = await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.create',input.args,async tx=>{
        try {
          input.signal.throwIfAborted()
          const runtime = createSqlMindCanvasCreateRuntime(tx,core.backend,async event=>{publication=event})
          const created = await createMindCanvasCreation(runtime)(key.context.ownerId,{title,project_id:input.args.project_id},{undoContextId:key.operationId,clientId:null})
          input.signal.throwIfAborted()
          return {canvas:{canvas_id:created.id,title:created.title,project_id:created.projectId}}
        } catch(error) {callbackError=error;throw error}
      },{signal:input.signal})
      if (!receipt.replayed && publication) {
        try {await publishChanged(publication)} catch { /* 通知失败不回滚已提交创建。 */ }
      }
      return {kind:'completed',successful:true,mutated:!receipt.replayed,value:receipt.result}
    } catch(error) {
      if (error === callbackError && error instanceof MindCanvasMutationError) return {kind:'completed',successful:false,mutated:false,value:{error:error.message}}
      if (error instanceof CoreError && error.code === 'conflict') return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
      if (input.signal.aborted && error === callbackError) throw error
      return recover(input)
    }
  } }
}

export function createCanvasCreateTool(port: CanvasCreatePort): ToolDefinition {
  const schema = z.object({title:z.string().min(1).refine(value=>[...value].length<=300).meta({maxLength:300}),project_id:z.number().int().safe().nullable().optional()}).passthrough()
  return {definition:{name:'canvas_create',schema:{type:'function',function:{name:'canvas_create',description:'按用户要求创建指定标题和可选项目的画布。',parameters:z.toJSONSchema(schema) as Record<string,import('../models.js').Json>}}},
    effect:'write',validate:input=>schema.safeParse(input),
    execute:(input,scope,call)=>port.create({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,args:input as CanvasCreateRequest['args'],signal:scope.signal}),
    reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,args:input as CanvasCreateRequest['args']}),
  }
}

function canvasCoordinate(input: {identity:import('../models.js').RunIdentity;roundId:string;toolCallId:string}, namespace: string) {
    const context = dataContext(input.identity.ownerId)
    const parts = [namespace,context.ownerId,input.identity.sessionId,input.identity.runId,input.roundId,input.toolCallId]
    if (parts.some(value => typeof value !== 'string' || !value.trim())) throw new CoreError('invalid_request','工具运行身份无效')
    const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
    const id = hash.slice(0,12)+'5'+hash.slice(13,16)+'8'+hash.slice(17,32)
    return { context, operationId: [id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-') }
  }


export interface CanvasEditRequest {
  identity: import('../models.js').RunIdentity; roundId: string; toolCallId: string
  intent: import('../../mind/canvas-edits.js').CanvasEditIntent
}
export interface CanvasEditPort {
  apply(input: CanvasEditRequest & {signal: AbortSignal}): Promise<import('../models.js').ToolResult>
  reconcile(input: CanvasEditRequest): Promise<import('../models.js').ToolResult>
}

export interface CanvasBatchRequest {
  identity:import('../models.js').RunIdentity;roundId:string;toolCallId:string;args:CanvasBatchIntent
}
export interface CanvasBatchConfirmationPort {
  gate:ReturnType<typeof createConfirmationGate>
  /** 必须在操作收据与领域写入的同一数据库事务中校验目标版本并单次 claim。 */
  claim(tx:Transaction<Database>,reference:ConfirmationClaimReference,signal:AbortSignal):Promise<boolean>
}
export interface CanvasBatchPort {
  confirmation?:CanvasBatchConfirmationPort
  apply(input:CanvasBatchRequest&{signal:AbortSignal;call:import('../models.js').ToolCall;scope:import('./contracts.js').ToolScope}):Promise<import('../models.js').ToolResult>
  reconcile(input:CanvasBatchRequest):Promise<import('../models.js').ToolResult>
}

export interface CanvasDeleteNotePort {
  confirmation?: CanvasBatchConfirmationPort
  apply(input: CanvasEditRequest & { signal: AbortSignal; call: import('../models.js').ToolCall; scope: import('./contracts.js').ToolScope }): Promise<import('../models.js').ToolResult>
  reconcile(input: CanvasEditRequest): Promise<import('../models.js').ToolResult>
}
export interface CanvasDisconnectRequest { identity:import('../models.js').RunIdentity;roundId:string;toolCallId:string;canvasId:number;relationIds:number[];batched:boolean }
export interface CanvasDisconnectPort {
  confirmation?:CanvasBatchConfirmationPort
  apply(input:CanvasDisconnectRequest&{signal:AbortSignal;call:import('../models.js').ToolCall;scope:import('./contracts.js').ToolScope}):Promise<import('../models.js').ToolResult>
  reconcile(input:CanvasDisconnectRequest):Promise<import('../models.js').ToolResult>
}
export interface CanvasDeleteRequest { identity:import('../models.js').RunIdentity;roundId:string;toolCallId:string;canvasIds:number[];batched:boolean }
export interface CanvasDeletePort {
  confirmation?:CanvasBatchConfirmationPort
  apply(input:CanvasDeleteRequest&{signal:AbortSignal;call:import('../models.js').ToolCall;scope:import('./contracts.js').ToolScope}):Promise<import('../models.js').ToolResult>
  reconcile(input:CanvasDeleteRequest):Promise<import('../models.js').ToolResult>
}

function batchOperationId(owner:string,canvasId:number,requestId:string){
  const hash=createHash('sha256').update(JSON.stringify(['agent.canvas.batch',owner,canvasId,requestId])).digest('hex')
  const value=hash.slice(0,12)+'5'+hash.slice(13,16)+'8'+hash.slice(17,32)
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`
}
function batchCanonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(batchCanonical).join(',')}]`
  if(value!==null&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${batchCanonical(item)}`).join(',')}}`
  return JSON.stringify(value)??'null'
}
function batchDigest(value:unknown){return createHash('sha256').update(batchCanonical(value)).digest('hex')}
type CanvasSnapshotData = Pick<import('../../data/runtime.js').SqlDataRuntime, 'db' | 'backend'>
async function canvasBatchDeleteSnapshot(core:CanvasSnapshotData,owner:string,intent:CanvasBatchIntent,signal:AbortSignal):Promise<ConfirmationTargetSnapshot|null>{
  const nodeIds=[...new Set(intent.operations.filter(operation=>operation.kind==='delete_note').map(operation=>operation.node_id).filter((id):id is number=>typeof id==='number'&&Number.isSafeInteger(id)&&id>0))].sort((a,b)=>a-b)
  if(!nodeIds.length)return null
  const notes=await core.db.selectFrom('mind_nodes').select(['id','version']).where('id','in',nodeIds).where('user_id','=',owner).where('kind','=','canvas_note').where('deleted_at','is',null).orderBy('id').execute()
  signal.throwIfAborted()
  if(notes.length!==nodeIds.length)return null
  const items=await core.db.selectFrom('mind_canvas_items').select(['id','node_id','updated_at']).where('user_id','=',owner).where('node_id','in',nodeIds).where('deleted_at','is',null).orderBy('id').execute()
  signal.throwIfAborted()
  return {
    targetIds:{nodeIds,viewItemIds:items.map(item=>Number(item.id))},
    targetsDigest:batchDigest({nodeIds,viewItemIds:items.map(item=>Number(item.id))}),
    versionsDigest:batchDigest({notes:notes.map(note=>({id:Number(note.id),version:Number(note.version)})),items:items.map(item=>({id:Number(item.id),node_id:Number(item.node_id),updated_at:dateStamp(item.updated_at)}))}),
  }
}
function dateStamp(value:unknown){return value instanceof Date?value.toISOString():String(value)}

async function canvasNoteDeleteSnapshot(core:CanvasSnapshotData,owner:string,nodeIds:number[],signal:AbortSignal):Promise<ConfirmationTargetSnapshot|null>{
  const normalized=[...new Set(nodeIds)].sort((a,b)=>a-b)
  const key=core.backend==='sqlite'?owner.replaceAll('-',''):owner
  const notes=await core.db.selectFrom('mind_nodes').select(['id','version']).where('id','in',normalized).where('user_id','=',key).where('kind','=','canvas_note').where('deleted_at','is',null).orderBy('id').execute()
  signal.throwIfAborted()
  if(notes.length!==normalized.length)return null
  const items=await core.db.selectFrom('mind_canvas_items').select(['id','node_id','updated_at']).where('user_id','=',key).where('node_id','in',normalized).where('deleted_at','is',null).orderBy('id').execute()
  signal.throwIfAborted()
  return {targetIds:{nodeIds:normalized,viewItemIds:items.map(item=>Number(item.id))},targetsDigest:batchDigest({nodeIds:normalized,viewItemIds:items.map(item=>Number(item.id))}),versionsDigest:batchDigest({notes:notes.map(note=>({id:Number(note.id),version:Number(note.version)})),items:items.map(item=>({id:Number(item.id),node_id:Number(item.node_id),updated_at:dateStamp(item.updated_at)}))})}
}

/** 独立便签删除复用 Mind 写用例；确认、事务内claim与收据必须一并提供。 */
export function createCanvasDeleteNotePort(core:import('../../data/runtime.js').SqlDataRuntime,publish:(event:import('../../mind/canvas-edits.js').CanvasEditPublication)=>Promise<void>,confirmation?:CanvasBatchConfirmationPort):CanvasDeleteNotePort{
  if(!core.receipts||typeof publish!=='function')throw new Error('画布便签删除后端未装配')
  const absent=new Error('画布便签删除收据不存在')
  function intent(input:CanvasEditRequest):Extract<CanvasEditIntent,{action:'delete_note'}>{const source=input.intent as Extract<CanvasEditIntent,{action:'delete_note'}>;return {action:'delete_note',canvas_id:0,node_ids:source.node_ids,batched:source.batched}}
  async function reconcile(input:CanvasEditRequest):Promise<import('../models.js').ToolResult>{
    try{const key=canvasCoordinate(input,'canvas.delete_note');const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.delete_note',input.intent,async()=>{throw absent});return {kind:'completed',successful:true,mutated:false,value:receipt.result}}
    catch{return {kind:'unknown'}}
  }
  return {confirmation,reconcile,async apply(input){
    input.signal.throwIfAborted()
    const deletion=intent(input),ids=deletion.node_ids
    if(input.scope.resolution?.status==='confirmed'){
      const replay=await reconcile(input)
      if(replay.kind==='completed')return replay
    }
    if(!confirmation)return {kind:'completed',successful:false,mutated:false,value:{error:'画布便签删除需要可信确认能力'}}
    const targets=await canvasNoteDeleteSnapshot(core,input.identity.ownerId,ids,input.signal)
    if(!targets)return {kind:'completed',successful:false,mutated:false,value:{error:'找不到这条画布便签'}}
    const digest=batchDigest(input.intent)
    if(input.scope.resolution===null){
      const prepared=await confirmation.gate.prepare(input.call,input.scope,digest,targets)
      return prepared.ok?{kind:'waiting',interaction:prepared.value}:{kind:'completed',successful:false,mutated:false,value:{error:'画布便签删除确认无效或已过期'}}
    }
    const verified=await confirmation.gate.verify(input.call,input.scope,digest,targets)
    if(!verified.ok)return {kind:'completed',successful:false,mutated:false,value:{error:'画布便签删除确认无效或已过期'}}
    let callbackError:unknown,events:import('../../mind/canvas-edits.js').CanvasEditPublication[]=[]
    try{
      const key=canvasCoordinate(input,'canvas.delete_note')
      const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.delete_note',input.intent,async tx=>{
        try{
          input.signal.throwIfAborted()
          if(!await confirmation.claim(tx,verified.value,input.signal))throw new Error('画布便签删除确认已使用或目标已变化')
          const current=await canvasNoteDeleteSnapshot({db:tx,backend:core.backend},key.context.ownerId,ids,input.signal)
          if(!current||current.targetsDigest!==targets.targetsDigest||current.versionsDigest!==targets.versionsDigest)throw new Error('画布便签删除确认已使用或目标已变化')
          const result=await applyCanvasEdits(tx,core.backend,key.context.ownerId,deletion,key.operationId,input.signal)
          events=result.publications
          return result.value
        }catch(error){callbackError=error;throw error}
      },{signal:input.signal})
      if(!receipt.replayed)for(const event of events){try{await publish(event)}catch{/* 提交后通知失败不回滚。 */}}
      return {kind:'completed',successful:true,mutated:!receipt.replayed,value:receipt.result}
    }catch(error){
      if(error instanceof CoreError&&error.code==='conflict')return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
      if(input.signal.aborted&&error===callbackError)throw error
      if(error===callbackError&&error instanceof MindCanvasNoteMutationError)return {kind:'completed',successful:false,mutated:false,value:{error:error.statusCode===409?'画布便签刚被修改，请稍后重试':error.message}}
      if(error===callbackError&&error instanceof Error)return {kind:'completed',successful:false,mutated:false,value:{error:error.message}}
      return reconcile(input)
    }
  }}
}

export function createCanvasDeleteNoteTool(port:CanvasDeleteNotePort):ToolDefinition{
  const id=z.number().int().safe().positive()
  const entry=z.object({node_id:id}).strict()
  const schema=z.object({node_id:id.optional(),notes:z.array(entry).min(1).max(20).optional()}).strict().refine(value=>(value.node_id===undefined)!==(value.notes===undefined)).refine(value=>value.notes===undefined||new Set(value.notes.map(note=>note.node_id)).size===value.notes.length)
  return {definition:{name:'canvas_delete_note',schema:{type:'function',function:{name:'canvas_delete_note',description:'删除一个或多个画布专属便签并移除其画布视图，最多 20 个；执行前必须一次性展示影响并获得可信确认。',parameters:{type:'object',properties:{node_id:{type:'integer'},notes:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'object',properties:{node_id:{type:'integer'}},required:['node_id'],additionalProperties:false}}},oneOf:[{required:['node_id'],not:{required:['notes']}},{required:['notes'],not:{required:['node_id']}}],additionalProperties:false}}}},effect:'write',requiresInteraction:true,confirmationReplay:true,validate:input=>schema.safeParse(input),
    execute(input,scope,call){const args=input as z.infer<typeof schema>,batched=args.notes!==undefined;return port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,intent:{action:'delete_note',canvas_id:0,node_ids:(batched?args.notes!.map(note=>note.node_id):[args.node_id!]).sort((a,b)=>a-b),batched},signal:scope.signal,call,scope})},
    reconcile(input,identity,call){const args=input as z.infer<typeof schema>,batched=args.notes!==undefined;return port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:{action:'delete_note',canvas_id:0,node_ids:(batched?args.notes!.map(note=>note.node_id):[args.node_id!]).sort((a,b)=>a-b),batched}})},
  }
}

/** 关系断开复用Mind关系删除、Undo与owner过滤，批量共用确认、事务与收据。 */
export function createCanvasDisconnectPort(core:import('../../data/runtime.js').SqlDataRuntime,publish:(event:Parameters<import('../../mind/relation-delete-canvas.js').CanvasRelationDeleteRuntime['publishChanged']>[0])=>Promise<void>,confirmation?:CanvasBatchConfirmationPort):CanvasDisconnectPort{
  if(!core.receipts||typeof publish!=='function')throw new Error('画布关系删除后端未装配')
  const absent=new Error('画布关系删除收据不存在')
  async function reconcile(input:CanvasDisconnectRequest):Promise<import('../models.js').ToolResult>{
    try{const key=canvasCoordinate(input,'canvas.disconnect');const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.disconnect',{canvas_id:input.canvasId,relation_ids:input.relationIds,batched:input.batched},async()=>{throw absent});return {kind:'completed',successful:true,mutated:false,value:receipt.result}}
    catch{return {kind:'unknown'}}
  }
  return {confirmation,reconcile,async apply(input){
    input.signal.throwIfAborted()
    const ids=[...input.relationIds].sort((a,b)=>a-b),owner=dataContext(input.identity.ownerId).ownerId,dbOwner=core.backend==='sqlite'?owner.replaceAll('-',''):owner
    if(input.batched&&(ids.length<1||ids.length>50))return {kind:'completed',successful:false,mutated:false,value:{error:'relation_ids 必须是 1-50 个关联 id'}}
    if(input.scope.resolution?.status==='confirmed'){const replay=await reconcile(input);if(replay.kind==='completed')return replay}
    const canvas=await core.db.selectFrom('mind_maps').select('id').where('id','=',input.canvasId).where('user_id','=',dbOwner).where('deleted_at','is',null).executeTakeFirst()
    if(!canvas)return {kind:'completed',successful:false,mutated:false,value:{error:ids.length===1&&!input.batched?'关联不存在':`关联 ${ids[0]} 不存在`}}
    const relations=await core.db.selectFrom('mind_relations').select(['id','src_node_id','dst_node_id','rel_type','edge_key','status','updated_at']).where('id','in',ids).where('canvas_id','=',input.canvasId).where('user_id','=',dbOwner).where('deleted_at','is',null).orderBy('id').execute()
    input.signal.throwIfAborted()
    if(relations.length!==ids.length){const missing=ids.find(id=>!relations.some(row=>Number(row.id)===id))!;return {kind:'completed',successful:false,mutated:false,value:{error:input.batched?`关联 ${missing} 不存在`:'关联不存在'}}}
    if(!confirmation)return {kind:'completed',successful:false,mutated:false,value:{error:'画布关系删除需要可信确认能力'}}
    const versions=(rows:typeof relations)=>batchDigest(rows.map(row=>({id:Number(row.id),src:Number(row.src_node_id),dst:Number(row.dst_node_id),type:row.rel_type,key:row.edge_key,status:row.status,updated_at:dateStamp(row.updated_at)})))
    const targets={targetIds:{canvasIds:[input.canvasId],relationIds:ids},targetsDigest:batchDigest({canvasId:input.canvasId,relationIds:ids}),versionsDigest:versions(relations)}
    const args={canvas_id:input.canvasId,relation_ids:ids,batched:input.batched},digest=batchDigest(args)
    if(input.scope.resolution===null){const prepared=await confirmation.gate.prepare(input.call,input.scope,digest,targets);return prepared.ok?{kind:'waiting',interaction:prepared.value}:{kind:'completed',successful:false,mutated:false,value:{error:'画布关系删除确认无效或已过期'}}}
    const verified=await confirmation.gate.verify(input.call,input.scope,digest,targets)
    if(!verified.ok)return {kind:'completed',successful:false,mutated:false,value:{error:'画布关系删除确认无效或已过期'}}
    let callbackError:unknown,events:Parameters<typeof publish>[0][]=[]
    try{
      const key=canvasCoordinate(input,'canvas.disconnect')
      const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.disconnect',args,async tx=>{
        try{
          input.signal.throwIfAborted()
          if(!await confirmation.claim(tx,verified.value,input.signal))throw new Error('画布关系删除确认已使用或目标已变化')
          const currentCanvas=await tx.selectFrom('mind_maps').select('id').where('id','=',input.canvasId).where('user_id','=',dbOwner).where('deleted_at','is',null).executeTakeFirst()
          const current=await tx.selectFrom('mind_relations').select(['id','src_node_id','dst_node_id','rel_type','edge_key','status','updated_at']).where('id','in',ids).where('canvas_id','=',input.canvasId).where('user_id','=',dbOwner).where('deleted_at','is',null).orderBy('id').execute()
          input.signal.throwIfAborted()
          if(!currentCanvas||current.length!==ids.length||versions(current)!==targets.versionsDigest)throw new Error('画布关系删除确认已使用或目标已变化')
          const remove=createMindCanvasRelationDelete(createSqlMindCanvasRelationDeleteRuntime(tx,core.backend,async event=>{events.push(event)}))
          for(const id of ids){await remove(key.context.ownerId,input.canvasId,id,{undoContextId:null,clientId:null,mutationId:key.operationId});input.signal.throwIfAborted()}
          return input.batched?{success:true,deleted_count:ids.length,deleted_relation_ids:ids}:{deleted_relation_id:ids[0]}
        }catch(error){callbackError=error;throw error}
      },{signal:input.signal})
      if(!receipt.replayed)for(const event of events){try{await publish(event)}catch{/* 提交后通知失败不回滚。 */}}
      return {kind:'completed',successful:true,mutated:!receipt.replayed,value:receipt.result}
    }catch(error){
      if(error instanceof CoreError&&error.code==='conflict')return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
      if(input.signal.aborted&&error===callbackError)throw error
      if(error===callbackError&&error instanceof Error)return {kind:'completed',successful:false,mutated:false,value:{error:error.message}}
      return reconcile(input)
    }
  }}
}

export function createCanvasDisconnectTool(port:CanvasDisconnectPort):ToolDefinition{
  const id=z.number().int().safe()
  const schema=z.object({canvas_id:id,relation_id:id.optional(),relation_ids:z.array(id).max(50).optional()}).strict().refine(value=>(value.relation_id===undefined)!==(value.relation_ids===undefined)).refine(value=>value.relation_ids===undefined||new Set(value.relation_ids).size===value.relation_ids.length)
  const request=(input:z.infer<typeof schema>,identity:import('../models.js').RunIdentity,roundId:string,toolCallId:string)=>{const batched=input.relation_ids!==undefined;return {identity,roundId,toolCallId,canvasId:input.canvas_id,relationIds:(batched?input.relation_ids!:[input.relation_id!]).sort((a,b)=>a-b),batched}}
  return {definition:{name:'canvas_disconnect',schema:{type:'function',function:{name:'canvas_disconnect',description:'删除指定画布中的一条或多条关系；批量最多 50 条，执行前需可信目标确认。',parameters:{type:'object',properties:{canvas_id:{type:'integer'},relation_id:{type:'integer'},relation_ids:{type:'array',maxItems:50,uniqueItems:true,items:{type:'integer'}}},required:['canvas_id'],oneOf:[{required:['relation_id'],not:{required:['relation_ids']}},{required:['relation_ids'],not:{required:['relation_id']}}],additionalProperties:false}}}},effect:'write',requiresInteraction:true,confirmationReplay:true,validate:input=>schema.safeParse(input),
    execute(input,scope,call){return port.apply({...request(input as z.infer<typeof schema>,scope.identity,scope.roundId,call.id),signal:scope.signal,call,scope})},
    reconcile(input,identity,call){return port.reconcile(request(input as z.infer<typeof schema>,identity,identity.roundId,call.id))},
  }
}

async function canvasDeleteTargetSnapshot(core:CanvasSnapshotData,owner:string,canvasIds:number[],signal:AbortSignal):Promise<{snapshot:ConfirmationTargetSnapshot;titles:string[]}|null>{
  const ids=[...new Set(canvasIds)].sort((a,b)=>a-b),key=core.backend==='sqlite'?owner.replaceAll('-',''):owner
  const canvases=await core.db.selectFrom('mind_maps').select(['id','title','project_id','data_json','updated_at']).where('id','in',ids).where('user_id','=',key).where('deleted_at','is',null).orderBy('id').execute()
  signal.throwIfAborted()
  if(canvases.length!==ids.length)return null
  const items=await core.db.selectFrom('mind_canvas_items').select(['id','canvas_id','node_id','updated_at','deleted_at']).where('canvas_id','in',ids).where('user_id','=',key).orderBy('id').execute()
  const relations=await core.db.selectFrom('mind_relations').select(['id','canvas_id','src_node_id','dst_node_id','rel_type','edge_key','status','updated_at','deleted_at']).where('canvas_id','in',ids).where('user_id','=',key).orderBy('id').execute()
  signal.throwIfAborted()
  const nodeIds=[...new Set(items.map(item=>Number(item.node_id)))].sort((a,b)=>a-b)
  const notes=nodeIds.length?await core.db.selectFrom('mind_nodes').select(['id','version','updated_at','deleted_at']).where('id','in',nodeIds).where('user_id','=',key).where('kind','=','canvas_note').orderBy('id').execute():[]
  signal.throwIfAborted()
  return {snapshot:{targetIds:{canvasIds:ids,itemIds:items.map(row=>Number(row.id)),relationIds:relations.map(row=>Number(row.id)),canvasNoteIds:notes.map(row=>Number(row.id))},targetsDigest:batchDigest({canvasIds:ids,itemIds:items.map(row=>Number(row.id)),relationIds:relations.map(row=>Number(row.id)),canvasNoteIds:notes.map(row=>Number(row.id))}),versionsDigest:batchDigest({canvases:canvases.map(row=>({id:Number(row.id),title:row.title,project_id:row.project_id,data_json:row.data_json,updated_at:dateStamp(row.updated_at)})),items:items.map(row=>({id:Number(row.id),canvas_id:Number(row.canvas_id),node_id:Number(row.node_id),updated_at:dateStamp(row.updated_at),deleted_at:row.deleted_at===null?null:dateStamp(row.deleted_at)})),relations:relations.map(row=>({id:Number(row.id),canvas_id:row.canvas_id===null?null:Number(row.canvas_id),src:Number(row.src_node_id),dst:Number(row.dst_node_id),type:row.rel_type,key:row.edge_key,status:row.status,updated_at:dateStamp(row.updated_at),deleted_at:row.deleted_at===null?null:dateStamp(row.deleted_at)})),notes:notes.map(row=>({id:Number(row.id),version:Number(row.version),updated_at:dateStamp(row.updated_at),deleted_at:row.deleted_at===null?null:dateStamp(row.deleted_at)}))})},titles:canvases.map(row=>row.title||'未命名画布')}
}

/** 级联删除复用共享Mind删除服务，批量目标与级联集合在一次收据事务中提交。 */
export function createCanvasDeletePort(core:import('../../data/runtime.js').SqlDataRuntime,publish:(event:Parameters<import('../../mind/canvas-delete.js').MindCanvasDeleteRuntime['publishChanged']>[0])=>Promise<void>,confirmation?:CanvasBatchConfirmationPort):CanvasDeletePort{
  if(!core.receipts||typeof publish!=='function')throw new Error('画布删除后端未装配')
  const absent=new Error('画布删除收据不存在')
  async function reconcile(input:CanvasDeleteRequest):Promise<import('../models.js').ToolResult>{
    try{const key=canvasCoordinate(input,'canvas.delete'),ids=[...input.canvasIds].sort((a,b)=>a-b);const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.delete',{canvas_ids:ids,batched:input.batched},async()=>{throw absent});return {kind:'completed',successful:true,mutated:false,value:receipt.result}}
    catch{return {kind:'unknown'}}
  }
  return {confirmation,reconcile,async apply(input){
    input.signal.throwIfAborted()
    const ids=[...input.canvasIds].sort((a,b)=>a-b)
    if(input.batched&&(ids.length<1||ids.length>20))return {kind:'completed',successful:false,mutated:false,value:{error:'canvas_ids 必须是 1-20 个画布 id'}}
    if(input.scope.resolution?.status==='confirmed'){const replay=await reconcile(input);if(replay.kind==='completed')return replay}
    const owner=dataContext(input.identity.ownerId).ownerId,targets=await canvasDeleteTargetSnapshot(core,owner,ids,input.signal)
    if(!targets){const dbOwner=core.backend==='sqlite'?owner.replaceAll('-',''):owner;let missing=ids[0];for(const candidate of input.canvasIds){const found=await core.db.selectFrom('mind_maps').select('id').where('id','=',candidate).where('user_id','=',dbOwner).where('deleted_at','is',null).executeTakeFirst();input.signal.throwIfAborted();if(!found){missing=candidate;break}}return {kind:'completed',successful:false,mutated:false,value:{error:input.batched?`画布 ${missing} 不存在`:'画布不存在'}}}
    if(!confirmation)return {kind:'completed',successful:false,mutated:false,value:{error:'画布删除需要可信确认能力'}}
    const args={canvas_ids:ids,batched:input.batched},digest=batchDigest(args)
    if(input.scope.resolution===null){const prepared=await confirmation.gate.prepare(input.call,input.scope,digest,targets.snapshot);return prepared.ok?{kind:'waiting',interaction:prepared.value}:{kind:'completed',successful:false,mutated:false,value:{error:'画布删除确认无效或已过期'}}}
    const verified=await confirmation.gate.verify(input.call,input.scope,digest,targets.snapshot)
    if(!verified.ok)return {kind:'completed',successful:false,mutated:false,value:{error:'画布删除确认无效或已过期'}}
    let callbackError:unknown,events:Parameters<typeof publish>[0][]=[]
    try{
      const key=canvasCoordinate(input,'canvas.delete')
      const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.delete',args,async tx=>{
        try{
          input.signal.throwIfAborted()
          if(!await confirmation.claim(tx,verified.value,input.signal))throw new Error('画布删除确认已使用或目标已变化')
          const current=await canvasDeleteTargetSnapshot({db:tx,backend:core.backend},owner,ids,input.signal)
          if(!current||current.snapshot.targetsDigest!==targets.snapshot.targetsDigest||current.snapshot.versionsDigest!==targets.snapshot.versionsDigest)throw new Error('画布删除确认已使用或目标已变化')
          const remove=createMindCanvasDelete(createSqlMindCanvasDeleteRuntime(tx,core.backend,async event=>{events.push(event)}))
          for(const id of ids){await remove(key.context.ownerId,id,{undoContextId:null,clientId:null});input.signal.throwIfAborted()}
          return input.batched?{success:true,deleted_count:ids.length,deleted_canvas_ids:ids}:{deleted:true,canvas_id:ids[0],title:targets.titles[0]}
        }catch(error){callbackError=error;throw error}
      },{signal:input.signal})
      if(!receipt.replayed)for(const event of events){try{await publish(event)}catch{/* 提交后通知失败不回滚。 */}}
      return {kind:'completed',successful:true,mutated:!receipt.replayed,value:receipt.result}
    }catch(error){
      if(error instanceof CoreError&&error.code==='conflict')return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
      if(input.signal.aborted&&error===callbackError)throw error
      if(error===callbackError&&error instanceof Error)return {kind:'completed',successful:false,mutated:false,value:{error:error.message}}
      return reconcile(input)
    }
  }}
}

export function createCanvasDeleteTool(port:CanvasDeletePort):ToolDefinition{
  const id=z.number().int().safe()
  const schema=z.object({canvas_id:id.optional(),canvas_ids:z.array(id).max(20).optional()}).strict().refine(value=>(value.canvas_id===undefined)!==(value.canvas_ids===undefined)).refine(value=>value.canvas_ids===undefined||new Set(value.canvas_ids).size===value.canvas_ids.length)
  const request=(input:z.infer<typeof schema>,identity:import('../models.js').RunIdentity,roundId:string,toolCallId:string)=>{const batched=input.canvas_ids!==undefined;return {identity,roundId,toolCallId,canvasIds:batched?input.canvas_ids!:[input.canvas_id!],batched}}
  return {definition:{name:'canvas_delete',schema:{type:'function',function:{name:'canvas_delete',description:'删除一张或多张画布及其所有内容；批量最多 20 张，执行前需可信目标确认。',parameters:{type:'object',properties:{canvas_id:{type:'integer'},canvas_ids:{type:'array',maxItems:20,uniqueItems:true,items:{type:'integer'}}},oneOf:[{required:['canvas_id'],not:{required:['canvas_ids']}},{required:['canvas_ids'],not:{required:['canvas_id']}}],additionalProperties:false}}}},effect:'write',requiresInteraction:true,confirmationReplay:true,validate:input=>schema.safeParse(input),
    execute(input,scope,call){return port.apply({...request(input as z.infer<typeof schema>,scope.identity,scope.roundId,call.id),signal:scope.signal,call,scope})},
    reconcile(input,identity,call){return port.reconcile(request(input as z.infer<typeof schema>,identity,identity.roundId,call.id))},
  }
}
/** request_id 对同一owner+画布持久去重；批操作复用既有Mind事务与调用收据。 */
export function createCanvasBatchPort(core:import('../../data/runtime.js').SqlDataRuntime,publish:(event:import('../../mind/canvas-edits.js').CanvasEditPublication)=>Promise<void>,confirmation?:CanvasBatchConfirmationPort):CanvasBatchPort{
  if(!core.receipts||typeof publish!=='function')throw new Error('画布批处理后端未装配')
  const absent=new Error('画布批处理收据不存在')
  async function reconcile(input:CanvasBatchRequest):Promise<import('../models.js').ToolResult>{
    try{
      const context=dataContext(input.identity.ownerId),operationId=batchOperationId(context.ownerId,input.args.canvas_id,input.args.request_id)
      const receipt=await core.operationWithTransaction(context,operationId,'agent.canvas.batch',input.args as unknown as Record<string,unknown>,async()=>{throw absent})
      return {kind:'completed',successful:true,mutated:false,value:receipt.result}
    }catch{return {kind:'unknown'}}
  }
  return {confirmation,reconcile,async apply(input){
    input.signal.throwIfAborted()
    if(!input.args.request_id.trim()||[...input.args.request_id].length>120)return {kind:'completed',successful:false,mutated:false,value:{error:'需要提供用于重试去重的 request_id'}}
    const canonicalOwner=dataContext(input.identity.ownerId).ownerId
    const owner=core.backend==='sqlite'?canonicalOwner.replaceAll('-',''):canonicalOwner
    const canvas=await core.db.selectFrom('mind_maps').select('id').where('id','=',input.args.canvas_id).where('user_id','=',owner).where('deleted_at','is',null).executeTakeFirst()
    input.signal.throwIfAborted()
    if(!canvas)return {kind:'completed',successful:false,mutated:false,value:{error:'画布不存在'}}
    const hasDelete=input.args.operations.some(operation=>operation.kind==='delete_note')
    let claim:ConfirmationClaimReference|null=null,confirmedTargets:ConfirmationTargetSnapshot|null=null
    if(hasDelete){
      if(!confirmation)return {kind:'completed',successful:false,mutated:false,value:{error:'画布便签删除需要可信确认能力',request_id:input.args.request_id}}
      const targets=await canvasBatchDeleteSnapshot(core,owner,input.args,input.signal)
      if(!targets)return {kind:'completed',successful:false,mutated:false,value:{error:'画布便签不存在或已被修改',request_id:input.args.request_id}}
      const digest=batchDigest(input.args)
      if(input.scope.resolution===null){
        const prepared=await confirmation.gate.prepare(input.call,input.scope,digest,targets)
        if(!prepared.ok)return {kind:'completed',successful:false,mutated:false,value:{error:'画布便签删除确认无效或已过期',request_id:input.args.request_id}}
        return {kind:'waiting',interaction:prepared.value}
      }
      const verified=await confirmation.gate.verify(input.call,input.scope,digest,targets)
      if(!verified.ok)return {kind:'completed',successful:false,mutated:false,value:{error:'画布便签删除确认无效或已过期',request_id:input.args.request_id}}
      claim=verified.value;confirmedTargets=targets
    }
    const context=dataContext(input.identity.ownerId),operationId=batchOperationId(context.ownerId,input.args.canvas_id,input.args.request_id)
    let callbackError:unknown
    let events:import('../../mind/canvas-edits.js').CanvasEditPublication[]=[]
    let mutated=false
    try{
      const receipt=await core.operationWithTransaction(context,operationId,'agent.canvas.batch',input.args as unknown as Record<string,unknown>,async tx=>{
        try{
          input.signal.throwIfAborted()
          if(claim&&(!confirmation||!await confirmation.claim(tx,claim,input.signal)))throw new Error('画布便签删除确认已使用或目标已变化')
          if(claim){
            const current=await canvasBatchDeleteSnapshot({db:tx,backend:core.backend},owner,input.args,input.signal)
            if(!current||!confirmedTargets||current.targetsDigest!==confirmedTargets.targetsDigest||current.versionsDigest!==confirmedTargets.versionsDigest)throw new Error('画布便签删除确认已使用或目标已变化')
          }
          const result=await applyCanvasEditBatch(tx,core.backend,context.ownerId,input.args,operationId,input.signal)
          events=result.publications;mutated=result.mutated
          return result.value
        }catch(error){callbackError=error;throw error}
      },{signal:input.signal})
      if(!receipt.replayed)for(const event of events){try{await publish(event)}catch{/* 提交后通知失败不回滚批处理。 */}}
      return {kind:'completed',successful:true,mutated:!receipt.replayed&&mutated,value:receipt.result}
    }catch(error){
      if(error instanceof CoreError&&error.code==='conflict')return {kind:'completed',successful:false,mutated:false,value:{error:'request_id 已用于不同的批量请求，请更换 request_id',request_id:input.args.request_id,idempotency_conflict:true}}
      if(input.signal.aborted&&error===callbackError)throw error
      if(error===callbackError&&error instanceof Error)return {kind:'completed',successful:false,mutated:false,value:{error:error.message,request_id:input.args.request_id,rolled_back:true}}
      return reconcile(input)
    }
  }}
}

/** 完整批处理工具只有在Host提供持久确认 gate 和事务内claim时才注册。 */
export function createCanvasBatchTool(port:CanvasBatchPort):ToolDefinition{
  const id=z.number().int().safe(),finite=z.number().finite()
  const position=z.object({x:finite.optional(),y:finite.optional(),anchor:z.enum(['auto','viewport_center','viewport_top_left','viewport_top_right','viewport_bottom_left','viewport_bottom_right','near_node']).optional(),near_node_id:id.optional(),offset_x:finite.optional(),offset_y:finite.optional()}).passthrough().optional()
  const operation=z.object({kind:z.enum(['create_note','add_node','update_item','remove_item','delete_note','connect']),ref_type:z.enum(['project','file','event']).optional(),ref_id:id.optional(),node_id:id.optional(),item_id:id.optional(),source_node_id:id.optional(),target_node_id:id.optional(),source_side:z.enum(['left','right']).optional(),target_side:z.enum(['left','right']).optional(),title:z.string().optional(),content:z.string().optional(),color:z.enum(['amber','coral','blue','teal']).optional(),x:finite.optional(),y:finite.optional(),width:finite.optional(),height:finite.optional(),z:id.optional(),collapsed:z.boolean().optional(),position}).passthrough()
  const schema=z.object({canvas_id:id,request_id:z.string().refine(value=>[...value].length<=120),operations:z.array(operation).min(1).max(20)}).passthrough()
  return {definition:{name:'canvas_batch',schema:{type:'function',function:{name:'canvas_batch',description:'在一个事务中按顺序批量编排画布节点、便签和连接，最多 20 项；任一操作失败则整批回滚，request_id 用于安全重放。删除便签须经过可信目标确认。',parameters:z.toJSONSchema(schema) as Record<string,import('../models.js').Json>}}},effect:'write',requiresInteraction:true,confirmationReplay:true,validate:input=>schema.safeParse(input),
    execute:(input,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,args:input as CanvasBatchIntent,signal:scope.signal,call,scope}),
    reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,args:input as CanvasBatchIntent}),
  }
}
/** 三种画布编辑共用持久收据与恢复，业务字段及SQL交给Mind共享服务。 */
export function createCanvasEditPort(core: import('../../data/runtime.js').SqlDataRuntime, publish: (event: import('../../mind/canvas-edits.js').CanvasEditPublication) => Promise<void>): CanvasEditPort {
  if(!core.receipts||typeof publish!=='function')throw new Error('画布编辑后端未装配')
  const absent=new Error('画布编辑收据不存在')
  async function recover(input:CanvasEditRequest):Promise<import('../models.js').ToolResult>{
    try{
      const key=canvasCoordinate(input,'canvas.edit')
      const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.edit',input.intent,async()=>{throw absent})
      return {kind:'completed',successful:true,mutated:false,value:receipt.result}
    }catch{return {kind:'unknown'}}
  }
  return {reconcile:recover,async apply(input){
    input.signal.throwIfAborted()
    let callbackError:unknown
    let events:import('../../mind/canvas-edits.js').CanvasEditPublication[]=[]
    let mutated=true
    try{
      const key=canvasCoordinate(input,'canvas.edit')
      const receipt=await core.operationWithTransaction(key.context,key.operationId,'agent.canvas.edit',input.intent,async tx=>{
        try{
          const result=await applyCanvasEdits(tx,core.backend,key.context.ownerId,input.intent,key.operationId,input.signal)
          events=result.publications;mutated=result.mutated;return result.value
        }catch(error){callbackError=error;throw error}
      },{signal:input.signal})
      if(!receipt.replayed)for(const event of events){try{await publish(event)}catch{/* 提交后通知失败不回滚。 */}}
      return {kind:'completed',successful:true,mutated:!receipt.replayed&&mutated,value:receipt.result}
    }catch(error){
      if(error===callbackError&&(error instanceof MindCanvasItemMutationError||error instanceof MindCanvasNoteMutationError||error instanceof MindRefNodeCreateError||error instanceof MindCanvasMutationError||error instanceof MindCanvasRelationMutationError)){
        const message=error instanceof MindCanvasNoteMutationError&&error.statusCode===409?'画布便签刚被修改，请稍后重试':error.message
        return {kind:'completed',successful:false,mutated:false,value:{error:message}}
      }
      if(error instanceof CoreError&&error.code==='conflict')return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
      if(input.signal.aborted&&error===callbackError)throw error
      return recover(input)
    }
  }}
}

export function createCanvasEditTools(port:CanvasEditPort):ToolDefinition[]{
  const id=z.number().int().safe(),number=z.number().finite()
  const layout={item_id:id,x:number.optional(),y:number.optional(),z:id.optional(),collapsed:z.boolean().optional(),width:number.min(180).max(520).optional(),height:number.min(100).max(420).optional()}
  const note={node_id:id,title:z.string().refine(value=>[...value].length<=300).meta({maxLength:300}).optional(),content:z.string().optional(),color:z.enum(['amber','coral','blue','teal']).optional()}
  const layoutKeys=['x','y','z','collapsed','width','height'],noteKeys=['title','content','color']
  const has=(entry:Record<string,unknown>,keys:string[])=>keys.some(key=>entry[key]!==undefined)
  const layoutEntry=z.object(layout).strict().refine(value=>has(value,layoutKeys))
  const noteEntry=z.object(note).strict().refine(value=>has(value,noteKeys))
  const layoutSchema=z.object({canvas_id:id,...layout,item_id:id.optional(),updates:z.array(layoutEntry).min(1).max(20).optional()}).passthrough().refine(value=>value.updates===undefined?value.item_id!==undefined&&has(value,layoutKeys):!has(value,['item_id',...layoutKeys]))
  const noteSchema=z.object({...note,node_id:id.optional(),updates:z.array(noteEntry).min(1).max(20).optional()}).passthrough().refine(value=>value.updates===undefined?value.node_id!==undefined&&has(value,noteKeys):!has(value,['node_id',...noteKeys]))
  const removeSchema=z.object({canvas_id:id,item_id:id.optional(),item_ids:z.array(id).min(1).max(20).optional()}).passthrough().refine(value=>(value.item_id===undefined)!==(value.item_ids===undefined))
  const schemas={canvas_update_node:layoutSchema,canvas_remove_node:removeSchema,canvas_update_note:noteSchema}
  function intent(name:keyof typeof schemas,input:unknown):import('../../mind/canvas-edits.js').CanvasEditIntent{
    if(name==='canvas_remove_node'){const args=input as z.infer<typeof removeSchema>;return {action:'remove',canvas_id:args.canvas_id,item_ids:args.item_ids??[args.item_id!],batched:args.item_ids!==undefined}}
    if(name==='canvas_update_note'){const args=input as z.infer<typeof noteSchema>;return {action:'note',entries:args.updates??[args as z.infer<typeof noteEntry>],batched:args.updates!==undefined}}
    const args=input as z.infer<typeof layoutSchema>;return {action:'layout',canvas_id:args.canvas_id,entries:args.updates??[args as z.infer<typeof layoutEntry>],batched:args.updates!==undefined}
  }
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name=>{
    const parameters=z.toJSONSchema(schemas[name]) as Record<string,import('../models.js').Json>
    // 公开单项/批量互斥条件；内部refine在归一化之后仍再次验证。
    const singular=name==='canvas_update_note'?'node_id':'item_id',plural=name==='canvas_remove_node'?'item_ids':'updates',keys=name==='canvas_remove_node'?[]:name==='canvas_update_note'?noteKeys:layoutKeys
    parameters.oneOf=[{required:[singular],not:{required:[plural]},...(keys.length?{anyOf:keys.map(key=>({required:[key]}))}:{})},{required:[plural],not:{anyOf:[singular,...keys].map(key=>({required:[key]}))}}]
    if(plural==='updates'){
      const properties=parameters.properties as Record<string,import('../models.js').Json>
      const batch=properties.updates as Record<string,import('../models.js').Json>,entry=batch.items as Record<string,import('../models.js').Json>
      entry.anyOf=keys.map(key=>({required:[key]}))
    }
    return {definition:{name,schema:{type:'function',function:{name,description:name==='canvas_update_node'?'调整画布条目位置、层级、折叠及便签尺寸，不修改业务来源。':name==='canvas_remove_node'?'仅移除画布视图，保留节点正文和业务来源。':'增量更新画布专属便签，不修改普通时间流笔记。',parameters}}},
      effect:'write',validate:input=>schemas[name].safeParse(input),
      execute:(input,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,intent:intent(name,input),signal:scope.signal}),
      reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:intent(name,input)}),
    }
  })
}

/** 放置能力独立注入，缺文件/引用后端时不因能编辑布局而自动开放。 */
export function createCanvasPlacementTools(port:CanvasEditPort):ToolDefinition[]{
  const id=z.number().int().safe(),finite=z.number().finite()
  const position=z.object({x:finite.optional(),y:finite.optional(),anchor:z.enum(['auto','viewport_center','viewport_top_left','viewport_top_right','viewport_bottom_left','viewport_bottom_right','near_node']).optional(),near_node_id:id.optional(),offset_x:finite.optional(),offset_y:finite.optional()}).strict()
    .refine(value=>(value.x===undefined)===(value.y===undefined)&&(value.anchor!=='near_node'||value.near_node_id!==undefined))
  const noteFields={title:z.string().refine(value=>[...value].length<=300).meta({maxLength:300}).optional(),content:z.string().optional(),color:z.enum(['amber','coral','blue','teal']).optional(),position:position.optional(),width:finite.min(180).max(520).optional(),height:finite.min(100).max(420).optional()}
  const refFields={node_id:id.optional(),ref_type:z.enum(['project','file','event']).optional(),ref_id:id.optional(),position:position.optional()}
  const reference=(value:{node_id?:number;ref_type?:string;ref_id?:number})=>value.node_id!==undefined?value.ref_type===undefined&&value.ref_id===undefined:value.ref_type!==undefined&&value.ref_id!==undefined
  const noteEntry=z.object(noteFields).strict(),refEntry=z.object(refFields).strict().refine(reference)
  const notes=z.object({canvas_id:id,...noteFields,notes:z.array(noteEntry).min(1).max(20).optional()}).passthrough().refine(value=>value.notes===undefined||Object.keys(noteFields).every(key=>value[key]===undefined))
  const refs=z.object({canvas_id:id,...refFields,nodes:z.array(refEntry).min(1).max(20).optional()}).passthrough().refine(value=>value.nodes===undefined?reference(value):Object.keys(refFields).every(key=>value[key]===undefined))
  const schemas={canvas_create_note:notes,canvas_add_node:refs}
  function intent(name:keyof typeof schemas,input:unknown):import('../../mind/canvas-edits.js').CanvasEditIntent {
    if(name==='canvas_create_note'){const args=input as z.infer<typeof notes>;return {action:'create_note',canvas_id:args.canvas_id,entries:args.notes??[args],batched:args.notes!==undefined}}
    const args=input as z.infer<typeof refs>;return {action:'add',canvas_id:args.canvas_id,entries:args.nodes??[args],batched:args.nodes!==undefined}
  }
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name=>{
    const parameters=z.toJSONSchema(schemas[name]) as Record<string,import('../models.js').Json>
    const properties=parameters.properties as Record<string,Record<string,import('../models.js').Json>>,plural=name==='canvas_create_note'?'notes':'nodes'
    const fields=name==='canvas_create_note'?Object.keys(noteFields):Object.keys(refFields)
    parameters.oneOf=name==='canvas_create_note'?[{required:[plural],not:{anyOf:fields.map(field=>({required:[field]}))}},{not:{required:[plural]}}]
      :[{required:['nodes'],not:{anyOf:fields.map(field=>({required:[field]}))}},{required:['node_id'],not:{anyOf:['nodes','ref_type','ref_id'].map(field=>({required:[field]}))}},{required:['ref_type','ref_id'],not:{anyOf:['nodes','node_id'].map(field=>({required:[field]}))}}]
    const conditions:import('../models.js').Json[]=[{if:{required:['x']},then:{required:['y']}},{if:{required:['y']},then:{required:['x']}},{if:{required:['anchor'],properties:{anchor:{const:'near_node'}}},then:{required:['near_node_id']}}]
    properties.position!.allOf=conditions
    const entry=properties[plural]!.items as Record<string,import('../models.js').Json>,entryProperties=entry.properties as Record<string,Record<string,import('../models.js').Json>>
    entryProperties.position!.allOf=conditions
    if(name==='canvas_add_node')entry.oneOf=[{required:['node_id'],not:{anyOf:['ref_type','ref_id'].map(field=>({required:[field]}))}},{required:['ref_type','ref_id'],not:{required:['node_id']}}]
    return {definition:{name,schema:{type:'function',function:{name,description:name==='canvas_create_note'?'在指定画布创建专属便签，支持单项/批量及世界坐标或视口、相邻节点定位。':'放置已有业务引用或项目/文件/活动资源，不创建普通时间流笔记；已放置目标保留原布局。',parameters}}},effect:'write',
      validate:input=>schemas[name].safeParse(input),
      execute:(input,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,intent:intent(name,input),signal:scope.signal}),
      reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:intent(name,input)})}
  })
}

export function createCanvasAnchorTool(port:CanvasEditPort):ToolDefinition{
  const schema=z.object({canvas_id:z.number().int().safe(),relation_id:z.number().int().safe(),source_side:z.enum(['left','right']),target_side:z.enum(['left','right'])}).passthrough()
  const intent=(input:unknown):import('../../mind/canvas-edits.js').CanvasEditIntent=>({...(input as z.infer<typeof schema>),action:'anchor',batched:false})
  return {definition:{name:'canvas_update_anchor',schema:{type:'function',function:{name:'canvas_update_anchor',description:'修改画布关系端点，保留其他视图数据及关系语义。',parameters:z.toJSONSchema(schema) as Record<string,import('../models.js').Json>}}},effect:'write',validate:input=>schema.safeParse(input),
    execute:(input,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,intent:intent(input),signal:scope.signal}),
    reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:intent(input)})}
}


export function createCanvasRelationTools(port:CanvasEditPort):ToolDefinition[]{
  const schema=z.object({canvas_id:z.number().int().safe(),source_node_id:z.number().int().safe(),target_node_id:z.number().int().safe(),type:z.literal('related').optional(),source_side:z.enum(['left','right']).optional(),target_side:z.enum(['left','right']).optional(),allow_custom_anchor:z.boolean().optional()}).passthrough()
  const intent=(input:unknown):import('../../mind/canvas-edits.js').CanvasEditIntent=>({...(input as z.infer<typeof schema>),action:'connect',batched:false})
  return [createCanvasAnchorTool(port),{definition:{name:'canvas_connect',schema:{type:'function',function:{name:'canvas_connect',description:'连接同画布节点，默认related幂等关系；按实际几何保存端点，自定义端点必须显式声明。',parameters:z.toJSONSchema(schema) as Record<string,import('../models.js').Json>}}},effect:'write',validate:input=>schema.safeParse(input),
    execute:(input,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,intent:intent(input),signal:scope.signal}),
    reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:intent(input)})}]
}
