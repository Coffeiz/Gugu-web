import {sql,type Kysely} from 'kysely'

export interface RecentMisreadQuery {n?:number;excludeDev?:boolean}
export type PerceptionListReader=(key:string,start:number,stop:number)=>Promise<readonly string[]>

/** 读取已由反思生产者枚举化的错读诊断；Redis 截取发生在解析和开发者筛选之前。 */
export function createAdminMisreadReader<DB>(db:Kysely<DB>,readList:PerceptionListReader){
 return async({n=30,excludeDev=false}:RecentMisreadQuery={}):Promise<{total:number;cases:unknown[]}>=>{
  const count=Math.max(1,Math.min(n||30,200))
  const raw=await readList('perc:misread_cases',0,excludeDev?199:count-1)
  let cases:unknown[]=[]
  for(const item of raw){try{cases.push(JSON.parse(item))}catch{/* 与参考 handler 一致跳过损坏 JSON。 */}}
  if(excludeDev){
   const rows=(await sql<{id:string}>`SELECT id FROM users WHERE is_developer = true`.execute(db)).rows
   const developers=new Set(rows.map(row=>String(row.id).slice(0,8)))
   cases=cases.filter(value=>{
    // Python 在该分支要求字典；损坏的非对象记录不得被默默视为正常案例。
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('错读案例记录格式无效')
    return !developers.has((value as Record<string,unknown>).u as string)
   }).slice(0,count)
  }
  return {total:cases.length,cases}
 }
}
