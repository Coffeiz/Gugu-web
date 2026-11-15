import { dataContext, type ProjectRecord } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import { buildSourceDocuments } from './index-builder.js'
import type { RagRebuildSource } from './rebuild-worker.js'

/** 复用项目领域查询；索引只包含旧版项目事实，不读取文件正文。 */
export function createProjectRagSource(core:SqlDataRuntime):RagRebuildSource {
 return async (rawOwner,sourceId,signal)=>{
  signal?.throwIfAborted()
  const owner=dataContext(rawOwner)
  if(sourceId!==null&&!/^[1-9]\d*$/u.test(sourceId))throw new Error('RAG 项目标识无效')
  const id=sourceId===null?null:Number(sourceId)
  if(id!==null&&!Number.isSafeInteger(id))throw new Error('RAG 项目标识无效')
  const projects=await core.transaction(owner,async data=>{
   if(id===null)return data.projects.list(false)
   const project=await data.projects.get(id)
   return project&&!project.archived?[project]:[]
  },{signal})
  signal?.throwIfAborted()
  const ordered=[...projects].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||b.id-a.id)
  return buildSourceDocuments({project:ordered.map(project=>record(project))})
 }
}
function record(project:ProjectRecord) {
 const stages=JSON.parse(project.stages_json) as unknown
 if(!Array.isArray(stages))throw new Error('项目阶段数据无效')
 const lines=[`项目：${project.name||'未命名项目'}`]
 if(project.client)lines.push(`联系人：${project.client}`)
 if(project.status)lines.push(`状态：${project.status}`)
 if(project.priority)lines.push(`优先级：${project.priority}`)
 if(project.progress!==null)lines.push(`进度：${project.progress}%`)
 if(project.current_stage)lines.push(`当前阶段：${project.current_stage}`)
 if(project.start_date)lines.push(`开始日期：${project.start_date}`)
 if(project.deadline)lines.push(`截止日期：${project.deadline}`)
 const names=stages.filter((stage):stage is Record<string,unknown>=>stage!==null&&typeof stage==='object'&&!Array.isArray(stage)).map(stage=>String(stage.name||''))
 if(names.length)lines.push(`阶段：${names.join('、')}`)
 const content=lines.join('\n')
 return {source_type:'project',id:String(project.id),source_id:String(project.id),parent_id:`project:${project.id}`,title:project.name||'未命名项目',summary:[...content].slice(0,240).join(''),content,document_version:'',version_parts:[project.id,project.version||1],updated_at:project.updated_at,scope:{scope_type:'owner',scope_id:''},metadata:{project_id:String(project.id),status:project.status||'pending'}}
}
