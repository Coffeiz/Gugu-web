import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../../contracts/index.js'
import {normalizeUserSkill,type UserSkillInput} from './user-validation.js'

type Row={skill_id:string;name:string;description_short:string;description_long:string|null;category:string;body:string;related_tools:string[]|string;source:string;managed_by:string|null;enabled:boolean;content_digest:string;created_at:Date|string|null;updated_at:Date|string|null}
type Input=UserSkillInput&{enabled?:boolean;managed_by?:'user'|'assistant'}
type Patch={name?:string|null;description_short?:string|null;description_long?:string|null;category?:string|null;body?:string|null;related_tools?:string[]|null;enabled?:boolean|null}
function view(row:Row){
 const date=(value:Date|string|null)=>value instanceof Date?value.toISOString().replace(/\.000Z$/,'+00:00').replace(/Z$/,'+00:00'):value
 return {id:row.skill_id,name:row.name,description_short:row.description_short,description_long:row.description_long,category:row.category,related_tools:typeof row.related_tools==='string'?JSON.parse(row.related_tools):row.related_tools,body:row.body,source:row.source,managed_by:row.managed_by||'user',enabled:Boolean(row.enabled),content_digest:row.content_digest,created_at:date(row.created_at),updated_at:date(row.updated_at)}
}
/** 用户管理目录与事务，不混入 Agent 的内置技能元数据目录。 */
export function createUserSkillManager<DB>(db:Kysely<DB>,backend:'postgres'|'sqlite',options:{knownTools(owner:string,related:readonly string[]):Promise<ReadonlySet<string>>;digest(text:string):string;publish(owner:string):Promise<unknown>}){
 const ownerKey=(raw:string)=>{const owner=dataContext(raw).ownerId;return {owner,key:backend==='sqlite'?owner.replaceAll('-',''):owner}}
 const changed=async(owner:string)=>{try{await options.publish(owner)}catch{/* 提交后通知失败不撤回变更。 */}}
 const list=async(raw:string)=>{const {key}=ownerKey(raw);const rows=await sql<Row>`SELECT skill_id,name,description_short,description_long,category,body,related_tools,source,managed_by,enabled,content_digest,created_at,updated_at FROM user_skills WHERE owner_id=${key} ORDER BY updated_at DESC,id DESC`.execute(db);return rows.rows.map(view)}
 const create=async(raw:string,input:Input)=>{const {owner,key}=ownerKey(raw),known=await options.knownTools(owner,input.related_tools||[]),value=normalizeUserSkill(input,known,options.digest)
  const row=await db.transaction().execute(async tx=>{
   const sequence=(await sql<{next_skill_sequence:number}>`UPDATE users SET next_skill_sequence=next_skill_sequence+1 WHERE id=${key} RETURNING next_skill_sequence`.execute(tx)).rows[0]
   if(!sequence)throw new CoreError('invalid_request','当前用户不存在，无法分配 Skill ID')
   const tools=JSON.stringify(value.related_tools),id=`U${sequence.next_skill_sequence-1}`
   const rows=await sql<Row>`INSERT INTO user_skills(owner_id,skill_id,name,description_short,description_long,category,body,related_tools,source,managed_by,enabled,content_digest,created_at,updated_at) VALUES(${key},${id},${value.name},${value.description_short},${value.description_long},${value.category},${value.body},${tools},'user',${input.managed_by??'user'},${input.enabled??true},${value.content_digest},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING skill_id,name,description_short,description_long,category,body,related_tools,source,managed_by,enabled,content_digest,created_at,updated_at`.execute(tx)
   return rows.rows[0]!
  });await changed(owner);return view(row)
 }
 const update=async(raw:string,id:string,patch:Patch)=>{const {owner,key}=ownerKey(raw),known=await options.knownTools(owner,patch.related_tools||[])
  const row=await db.transaction().execute(async tx=>{
   const old=(await sql<Row>`SELECT skill_id,name,description_short,description_long,category,body,related_tools,source,managed_by,enabled,content_digest,created_at,updated_at FROM user_skills WHERE owner_id=${key} AND skill_id=${id}`.execute(tx)).rows[0]
   if(!old)throw new CoreError('not_found','Skill 不存在')
   const original=view(old),value=normalizeUserSkill({name:patch.name===undefined?original.name:patch.name||'',description_short:patch.description_short===undefined?original.description_short:patch.description_short||'',description_long:patch.description_long===undefined?original.description_long:patch.description_long,category:patch.category===undefined?original.category:patch.category||'',body:patch.body===undefined?original.body:patch.body||'',related_tools:patch.related_tools===undefined?original.related_tools:patch.related_tools||[]},known,options.digest)
   const rows=await sql<Row>`UPDATE user_skills SET name=${value.name},description_short=${value.description_short},description_long=${value.description_long},category=${value.category},body=${value.body},related_tools=${JSON.stringify(value.related_tools)},managed_by=${original.managed_by},enabled=${patch.enabled??original.enabled},content_digest=${value.content_digest},updated_at=CURRENT_TIMESTAMP WHERE owner_id=${key} AND skill_id=${id} RETURNING skill_id,name,description_short,description_long,category,body,related_tools,source,managed_by,enabled,content_digest,created_at,updated_at`.execute(tx)
   return rows.rows[0]!
  });await changed(owner);return view(row)
 }
 return {list,create,update}
}
