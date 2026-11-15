import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { casefoldSearchText } from '../../search/unicode.js'
import type { SkillMetadata } from './contracts.js'

export interface SkillListEntry {
  id: string; name: string; description_short: string; category: string; related_tools: string[]
  enabled: boolean; source: 'builtin' | 'user'; managed_by?: string
}
/** 目录元数据来自 Markdown head 注册结果；用户项包含停用项，绝不读取正文或摘要。 */
export function createSkillMetadataReader<DB>(db: Kysely<DB>, backend: 'sqlite'|'postgres', builtins: readonly SkillMetadata[]) {
  const builtinEntries: SkillListEntry[] = builtins.map(row=>({id:row.id,name:row.name,description_short:row.description_short??row.description,
    category:row.category??'',related_tools:[...(row.related_tools??[])],enabled:true,source:'builtin'}))
  return async (rawOwner: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const owner = dataContext(rawOwner).ownerId, key = backend === 'sqlite' ? owner.replaceAll('-','') : owner
    const rows = await sql<{skill_id:string;name:string;description_short:string;category:string;related_tools:string[]|string|null;managed_by:string|null;enabled:boolean|number}>`
      SELECT skill_id,name,description_short,category,related_tools,managed_by,enabled FROM user_skills WHERE owner_id=${key} AND source='user' ORDER BY name,skill_id`.execute(db)
    signal.throwIfAborted()
    const skills = [...builtinEntries.map(row=>({...row,related_tools:[...row.related_tools]})),...rows.rows.map(row=>{
      const tools: unknown = typeof row.related_tools === 'string' ? JSON.parse(row.related_tools) : row.related_tools
      if (tools !== null && (!Array.isArray(tools) || !tools.every(value=>typeof value==='string'))) throw new Error('技能关联工具元数据无效')
      return {id:row.skill_id,name:row.name,description_short:row.description_short,category:row.category,related_tools:tools??[],managed_by:row.managed_by||'user',enabled:Boolean(row.enabled),source:'user' as const}
    })]
    const compare = (a:string,b:string) => {
      const left=[...a],right=[...b]
      for(let i=0;i<Math.min(left.length,right.length);i++){const delta=left[i]!.codePointAt(0)!-right[i]!.codePointAt(0)!;if(delta)return delta}
      return left.length-right.length
    }
    skills.sort((a,b)=>compare(casefoldSearchText(a.name),casefoldSearchText(b.name))||compare(a.id,b.id))
    return {count:skills.length,skills}
  }
}
