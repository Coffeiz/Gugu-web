import type { Fields, ProjectRecord, Stage, Todo } from '../contracts/index.js'
import { nextProjectStageKey, nextProjectTodoNumber, replaceProjectStages } from './domain.js'
import { strip } from '../shared/values.js'

export type ProjectStageOperation =
  | { action:'add_stage'; label:string; position?:number }
  | { action:'remove_stage'; stage:string }
  | { action:'rename_stage'; stage:string; new_label:string }
  | { action:'set_stages'; stages:unknown[] }
  | { action:'update_stage'; stage?:string; add?:string[]; todos?:Array<{text:string;stage?:string;done?:boolean;new_text?:string;to_stage?:string;remove?:boolean}> }
export interface ProjectStageRejection { error:string; available?:string[]; results?:Record<string,unknown>[] }
export type ProjectStageChange = {fields:Fields;value:Record<string,unknown>} | ProjectStageRejection

/** key优先；名称必须唯一，不沿用Web的“首个同名”查询。 */
function resolve(stages:Stage[],target:string): Stage | {error:string} | undefined {
  const key=strip(target), exact=stages.find(stage=>stage.key===key)
  if(exact)return exact
  const matched=stages.filter(stage=>stage.label===key)
  return matched.length>1 ? {error:'阶段名称重名，请使用阶段 key 定位'} : matched[0]
}
function missing(stages:Stage[],target:string): ProjectStageRejection {
  return {error:`阶段不存在: ${target}`,available:stages.map(stage=>stage.label)}
}
function findTodo(stages:Stage[],target:string,scope?:Stage) {
  const entries=(scope?[scope]:stages).flatMap(stage=>(stage.todos??[]).map(todo=>({stage,todo})))
  const byId=entries.filter(item=>item.todo.id===target), byText=entries.filter(item=>item.todo.text===target)
  const matches=byId.length?byId:byText.length?byText:entries.filter(item=>item.todo.text?.includes(target))
  if(matches.length===1)return {found:matches[0]!}
  return matches.length ? {error:'待办匹配到多项，请提供 todos[].stage 或待办 ID',candidates:matches.map(({stage,todo})=>({
    stage_key:stage.key,stage:stage.label,todo_id:todo.id,todo:todo.text??null,
  }))} : {error:'未找到待办'}
}

/** 纯领域意图；事务内解析到的快照传入，返回增量供同一CAS/Undo/收据用例提交。 */
export function prepareProjectStageChange(project:Pick<ProjectRecord,'id'|'stages_json'|'current_stage'>,operation:ProjectStageOperation):ProjectStageChange {
  const stages=JSON.parse(project.stages_json) as Stage[]
  const success=(fields:Fields,value:Record<string,unknown>)=>({fields,value:{success:true,project_id:project.id,...value}})
  if(operation.action==='set_stages'){
    const [updated,current]=replaceProjectStages(stages,project.current_stage,operation.stages)
    return success({stages:updated,current_stage:current},{stages:updated.map(stage=>stage.label),
      stage_details:updated.map(stage=>({key:stage.key,label:stage.label,todo_count:stage.todos?.length??0})),current_stage:current})
  }
  if(operation.action==='add_stage'){
    const stage:Stage={key:nextProjectStageKey(stages),label:strip(operation.label),todos:[]}
    if(!stage.label)return {error:'阶段名称不能为空'}
    stages.splice(Math.max(0,Math.min(operation.position??stages.length,stages.length)),0,stage)
    return success({stages},{stage_key:stage.key,label:stage.label})
  }
  if(operation.action==='remove_stage'||operation.action==='rename_stage'){
    const target=strip(operation.stage)
    if(!target)return {error:'stage 必须是非空文本'}
    const stage=resolve(stages,target)
    if(!stage)return operation.action==='remove_stage'?missing(stages,target):{error:`阶段不存在: ${target}`}
    if('error' in stage)return {error:String(stage.error)}
    if(operation.action==='rename_stage'){
      const label=strip(operation.new_label)
      if(!label)return {error:'阶段名称不能为空'}
      stage.label=label
      return success({stages},{label})
    }
    if(stages.length<=1)return {error:'项目至少保留一个阶段，无法删除最后一个阶段'}
    const remaining=stages.filter(item=>item.key!==stage.key)
    const current=project.current_stage===stage.key?remaining[0]!.key:project.current_stage
    const active=remaining.find(item=>item.key===current)
    return success({stages:remaining,current_stage:current},{removed:stage.label,remaining_stages:remaining.map(item=>item.label),
      current_stage_key:active?.key??null,current_stage:active?.label??null})
  }
  return updateTodos(stages,project,operation,success)
}

function updateTodos(stages:Stage[],project:Pick<ProjectRecord,'id'|'current_stage'>,operation:Extract<ProjectStageOperation,{action:'update_stage'}>,
  success:(fields:Fields,value:Record<string,unknown>)=>{fields:Fields;value:Record<string,unknown>}):ProjectStageChange {
  const stageArg=operation.stage===undefined?undefined:strip(operation.stage), add=(operation.add??[]).map(strip), todos=operation.todos??[]
  if(stageArg===''||add.some(text=>!text))return {error:stageArg===''?'stage 必须是非空文本':'add 必须是非空文本组成的数组'}
  for(const [index,item] of todos.entries()){
    if(!strip(item.text))return {error:'todos 第 '+(index+1)+' 项必须包含非空 text'}
    for(const field of ['stage','new_text','to_stage'] as const)
      if(item[field]!==undefined&&!strip(item[field]!))return {error:'todos 第 '+(index+1)+' 项的 '+field+' 必须是非空文本'}
  }
  if(!stageArg&&!add.length&&!todos.length)return {error:'未指定操作：stage（切换阶段）、add（批量新增）或 todos（批量修改）至少给一个'}
  if(stageArg&&!add.length&&!todos.length){
    const stage=resolve(stages,stageArg)
    if(!stage)return missing(stages,stageArg)
    if('error' in stage)return {error:String(stage.error)}
    return success({current_stage:stage.key},{current_stage:stage.key})
  }
  const results:Record<string,unknown>[]=[],rejected=(error:string)=>({error,results})
  let changed=false
  if(add.length){
    const target=stageArg||project.current_stage,stage=target?resolve(stages,target):undefined
    if(!stage)return missing(stages,String(target))
    if('error' in stage)return {error:String(stage.error)}
    const base=nextProjectTodoNumber(stages)
    stage.todos??=[]
    for(const [i,text] of add.entries()){
      if(!Number.isSafeInteger(base+1+i))return rejected('阶段或待办编号超出安全范围')
      stage.todos.push({id:`t${base+1+i}`,text,done:false})
    }
    results.push({action:'add',stage:stage.label,added:add});changed=true
  }
  for(const item of todos){
    const result=applyTodoChange(stages,item,stageArg)
    results.push(result.entry)
    changed=changed||result.changed
  }
  return changed?success({stages},{results}):rejected('没有任何待办被修改')
}


type TodoChange = NonNullable<Extract<ProjectStageOperation,{action:'update_stage'}>['todos']>[number]
/** 单项失败不修改对象，批量成功项仍可继续；删除优先于其他操作。 */
function applyTodoChange(stages:Stage[],item:TodoChange,stageArg?:string){
  const text=strip(item.text),entry:Record<string,unknown>={todo:text},result={entry,changed:false}
  const hint=item.stage||stageArg,scope=hint?resolve(stages,hint):undefined
  if(scope&&'error' in scope){entry.error=scope.error;return result}
  if(hint&&!scope){entry.error='阶段不存在: '+hint;return result}
  const match=findTodo(stages,text,scope)
  if(!match.found){Object.assign(entry,match);return result}
  const {stage,todo}=match.found
  entry.stage=stage.label;entry.todo=todo.text??null
  if(item.remove){stage.todos=stage.todos!.filter(row=>row!==todo);entry.action='remove';result.changed=true;return result}
  // 目标校验先于rename/done；失败项不得被同批成功项带入提交。
  const dest=item.to_stage?resolve(stages,item.to_stage):stage
  if(dest&&'error' in dest){entry.error=dest.error;return result}
  if(!dest){entry.error='目标阶段不存在: '+item.to_stage;return result}
  const ops:string[]=[]
  if(item.new_text){todo.text=item.new_text;ops.push('rename')}
  if(item.done!==undefined){todo.done=item.done;ops.push('done')}
  if(dest!==stage){stage.todos=stage.todos!.filter(row=>row!==todo);(dest.todos??=[]).push(todo as Todo);ops.push('move')}
  if(!ops.length){entry.error='未指定操作（done/new_text/to_stage/remove 至少一个）';return result}
  entry.action=ops.join('+');entry.done=todo.done??null;result.changed=true
  return result
}
