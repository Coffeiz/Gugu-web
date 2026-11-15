import { createHash } from 'node:crypto'
import { CoreError,dataContext } from '../../contracts/index.js'
import { applyNoteLifecycle } from '../../mind/note-lifecycle.js'
import { MindNoteMutationError } from '../../mind/note-mutations.js'
import { z } from 'zod'
import type { createAgentMindReader } from '../../mind/note-read.js'
import type { ToolDefinition } from './contracts.js'
import type { Json } from '../models.js'

/** Mind组：搜索只召回note/canvas_note，详情可读同owner存活来源节点；关系与正文引用分别投影。 */
export function createNoteReadTools(reader:ReturnType<typeof createAgentMindReader>):ToolDefinition[]{
  const schemas={
    note_search:z.object({query:z.string().optional(),q:z.string().optional(),queries:z.array(z.string()).optional(),
      mode:z.enum(['OR','AND']).optional(),limit:z.number().int().safe().optional(),include_content:z.boolean().optional()}).passthrough(),
    note_get:z.object({node_id:z.number().int().safe()}).passthrough(),
  }
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name=>({
    definition:{name,schema:{type:'function',function:{name,
      description:name==='note_search'?'搜索笔记和画布便签；related为一跳关系，references为正文中可访问的项目、文件和活动引用；include_content可返回完整正文。':'读取已知思维节点正文、原始物理行号、一跳关系和正文引用；代码示例不计入references。',
      parameters:(()=>{const value=z.toJSONSchema(schemas[name]) as Record<string,Json>;delete value.additionalProperties;return value})()}}},
    effect:'read',validate:input=>schemas[name].safeParse(input),
    async execute(input,scope){
      const value=name==='note_search'?await reader.search(scope.identity.ownerId,input as z.infer<typeof schemas.note_search>,scope.signal)
        :await reader.get(scope.identity.ownerId,(input as {node_id:number}).node_id,scope.signal)
      scope.signal.throwIfAborted()
      return {kind:'completed',successful:!('error' in value),mutated:false,value}
    },
  }))
}

export interface NoteLifecycleRequest {
  identity:import('../models.js').RunIdentity;roundId:string;toolCallId:string
  intent:import('../../mind/note-lifecycle.js').NoteLifecycleIntent
}
export interface NoteLifecyclePort {
  apply(input:NoteLifecycleRequest&{signal:AbortSignal}):Promise<import('../models.js').ToolResult>
  reconcile(input:NoteLifecycleRequest):Promise<import('../models.js').ToolResult>
}
/** 收据与生命周期/Undo共用事务；恢复绝不重新选择“最近”笔记。 */
export function createNoteLifecyclePort(core:import('../../data/runtime.js').SqlDataRuntime,publish:(event:import('../../mind/note-lifecycle.js').NoteLifecyclePublication)=>Promise<void>):NoteLifecyclePort{
  if(!core.receipts||typeof publish!=='function')throw new Error('笔记生命周期后端未装配')
  const absent=new Error('笔记调用收据不存在')
  function key(input:NoteLifecycleRequest){
    const context=dataContext(input.identity.ownerId)
    const parts=['note.lifecycle',context.ownerId,input.identity.sessionId,input.identity.runId,input.roundId,input.toolCallId]
    if(parts.some(value=>typeof value!=='string'||!value.trim()))throw new CoreError('invalid_request','工具运行身份无效')
    const hash=createHash('sha256').update(JSON.stringify(parts)).digest('hex'),id=hash.slice(0,12)+'5'+hash.slice(13,16)+'8'+hash.slice(17,32)
    return {context,operationId:[id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-')}
  }
  async function recover(input:NoteLifecycleRequest):Promise<import('../models.js').ToolResult>{
    try{const k=key(input),receipt=await core.operationWithTransaction(k.context,k.operationId,'agent.note.lifecycle',input.intent,async()=>{throw absent})
      return {kind:'completed',successful:true,mutated:false,value:receipt.result}
    }catch{return {kind:'unknown'}}
  }
  return {reconcile:recover,async apply(input){
    input.signal.throwIfAborted()
    let callbackError:unknown,publication:import('../../mind/note-lifecycle.js').NoteLifecyclePublication|undefined
    try{
      const k=key(input),receipt=await core.operationWithTransaction(k.context,k.operationId,'agent.note.lifecycle',input.intent,async tx=>{
        try{const result=await applyNoteLifecycle(tx,core.backend,k.context.ownerId,input.intent,k.operationId,input.signal);publication=result.publication;return result.value}
        catch(error){callbackError=error;throw error}
      },{signal:input.signal})
      if(!receipt.replayed&&publication){try{await publish(publication)}catch{/* 提交后的通知失败不回滚。 */}}
      return {kind:'completed',successful:true,mutated:!receipt.replayed,value:receipt.result}
    }catch(error){
      if(error===callbackError&&error instanceof MindNoteMutationError)return {kind:'completed',successful:false,mutated:false,value:{error:error.statusCode===409?(input.intent.action==='restore'?'便签状态已变化，请重新确认':input.intent.action==='undo'?'刚才的记录状态已变化，请重新确认':'便签刚被修改，请稍后重试'):error.message}}
      if(error instanceof CoreError&&error.code==='conflict')return {kind:'completed',successful:false,mutated:false,value:{error:'操作标识已用于不同内容'}}
      if(input.signal.aborted&&error===callbackError)throw error
      return recover(input)
    }
  }}
}

export function createNoteLifecycleTools(port:NoteLifecyclePort):ToolDefinition[]{
  const schemas={note_delete:z.object({node_id:z.number().int().safe()}).strict(),note_restore:z.object({node_id:z.number().int().safe()}).passthrough(),note_undo:z.object({}).passthrough()}
  const descriptions={note_delete:'软删精确node_id对应的普通便签，可由note_restore恢复；不按关键词模糊删除。',note_restore:'恢复精确node_id对应的已软删普通便签，保留正文。',note_undo:'撤销当前用户最近创建的一条咕咕笔记，不影响用户自行创建的笔记。'}
  function intent(name:keyof typeof schemas,input:unknown):import('../../mind/note-lifecycle.js').NoteLifecycleIntent{return name==='note_undo'?{action:'undo'}:{action:name==='note_restore'?'restore':'delete',node_id:(input as {node_id:number}).node_id}}
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name=>({definition:{name,schema:{type:'function',function:{name,description:descriptions[name],parameters:z.toJSONSchema(schemas[name]) as Record<string,Json>}}},effect:'write',validate:input=>schemas[name].safeParse(input),
    execute:(input,scope,call)=>port.apply({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,intent:intent(name,input),signal:scope.signal}),
    reconcile:(input,identity,call)=>port.reconcile({identity,roundId:identity.roundId,toolCallId:call.id,intent:intent(name,input)})}))
}
