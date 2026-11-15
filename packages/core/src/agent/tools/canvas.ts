import { MindCanvasRelationMutationError } from '../../mind/relation-delete-global.js'
import { MindRefNodeCreateError } from '../../mind/ref-node-create.js'
import { applyCanvasEdits } from '../../mind/canvas-edits.js'
import { MindCanvasItemMutationError } from '../../mind/canvas-item-remove.js'
import { MindCanvasNoteMutationError } from '../../mind/canvas-note.js'
import { createHash } from 'node:crypto'
import { CoreError, dataContext } from '../../contracts/index.js'
import { strip } from '../../shared/values.js'
import { createMindCanvasCreation, MindCanvasMutationError } from '../../mind/canvas-create.js'
import { createSqlMindCanvasCreateRuntime } from '../../mind/canvas-create-sql.js'
import { z } from 'zod'
import type { createSqlMindCanvasReader } from '../../mind/canvas-read.js'
import type { ToolDefinition } from './contracts.js'

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

function canvasCoordinate(input: Pick<CanvasCreateRequest,'identity'|'roundId'|'toolCallId'>, namespace: string) {
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
