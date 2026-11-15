import {sql,type Kysely} from 'kysely'

type Scope = {owner_user_id:string;platform:string;bot_id:string;scope_type:string;scope_id:string}
type Cursor = Scope & {last_message_id:number|null;last_reflected_message_id:number|null}
type Tombstone = Scope & {status:string|null}
type Count = Scope & {entries:string;pending:string;failed:string}
const key=(row:Scope)=>JSON.stringify([row.owner_user_id,row.platform,row.bot_id,row.scope_type,row.scope_id])
// Python 字符串按 Unicode 码点排序；不能用依赖运行环境的语言区域排序。
function compareText(left:string,right:string):number {
 const a=Array.from(left),b=Array.from(right)
 for(let i=0;i<Math.min(a.length,b.length);i++){
  const difference=a[i]!.codePointAt(0)!-b[i]!.codePointAt(0)!
  if(difference)return difference
 }
 return a.length-b.length
}

/** 管理员只读汇总。调用方负责管理员认证；不读取记忆内容或向响应暴露 scope 标识。 */
export function createImMemorySummaryReader<DB>(db:Kysely<DB>){
 return async()=>{
  const cursors=(await sql<Cursor>`SELECT owner_user_id,platform,bot_id,scope_type,scope_id,last_message_id,last_reflected_message_id FROM memory_reflection_cursors ORDER BY updated_at DESC LIMIT 10000`.execute(db)).rows
  const tombstones=(await sql<Tombstone>`SELECT owner_user_id,platform,bot_id,scope_type,scope_id,status FROM memory_scope_tombstones`.execute(db)).rows
  const entries=(await sql<Count>`SELECT owner_user_id,platform,bot_id,scope_type,scope_id,COUNT(*) AS entries FROM memory_entries GROUP BY owner_user_id,platform,bot_id,scope_type,scope_id`.execute(db)).rows
  const jobs=(await sql<Count>`SELECT owner_user_id,platform,bot_id,scope_type,scope_id,SUM(CASE WHEN status IN ('pending','retry','running') THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status IN ('dead','failed') THEN 1 ELSE 0 END) AS failed FROM memory_reflection_jobs GROUP BY owner_user_id,platform,bot_id,scope_type,scope_id`.execute(db)).rows
  const tombstoneByKey=new Map(tombstones.map(row=>[key(row),row.status])),entryByKey=new Map(entries.map(row=>[key(row),Number(row.entries)])),jobsByKey=new Map(jobs.map(row=>[key(row),row]))
  const selected=new Set(cursors.map(key))
  const scopes:Array<Cursor & {tombstone:string|null}>=cursors.map(row=>({...row,tombstone:tombstoneByKey.get(key(row))??null}))
  for(const row of tombstones)if(!selected.has(key(row)))scopes.push({...row,last_message_id:null,last_reflected_message_id:null,tombstone:row.status})
  scopes.sort((a,b)=>Number(a.tombstone===null)-Number(b.tombstone===null)||compareText(a.platform,b.platform)||compareText(a.scope_id,b.scope_id))
  const result={total_scopes:0,groups:0,members:0,total_entries:0,pending_jobs:0,needs_maintenance:0,failed_jobs:0,platforms:[] as Array<{platform:string;scopes:number;groups:number;members:number;entries:number}>}
  const platforms=new Map<string,{platform:string;scopes:number;groups:number;members:number;entries:number}>()
  for(const row of scopes.slice(0,10000)){
   const rowKey=key(row),count=entryByKey.get(rowKey)??0,job=jobsByKey.get(rowKey),platform=row.platform||'unknown'
   const stats=platforms.get(platform)??{platform,scopes:0,groups:0,members:0,entries:0}
   stats.scopes++;stats.groups+=Number(row.scope_type==='group');stats.members+=Number(row.scope_type==='platform-user');stats.entries+=count;platforms.set(platform,stats)
   result.total_scopes++;result.groups+=Number(row.scope_type==='group');result.members+=Number(row.scope_type==='platform-user');result.total_entries+=count
   result.pending_jobs+=Number(job?.pending??0);result.failed_jobs+=Number(job?.failed??0)
   result.needs_maintenance+=Number(row.last_message_id!==null&&row.last_message_id>(row.last_reflected_message_id||0))
  }
  result.platforms=[...platforms.values()].sort((a,b)=>compareText(a.platform,b.platform))
  return result
 }
}
