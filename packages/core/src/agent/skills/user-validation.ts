import {strip} from '../../shared/values.js'

export interface UserSkillInput {
 name:string;description_short:string;description_long:string|null;category:string;body:string;related_tools:readonly string[]
}
export class UserSkillValidationError extends Error {override name='UserSkillValidationError'}
/** 与 Python 用户技能注册规则一致；关联工具不授予工具执行权限。 */
export function normalizeUserSkill(input:UserSkillInput,knownTools:ReadonlySet<string>,digest:(body:string)=>string){
 const name=strip(input.name||''),description_short=strip(input.description_short||''),description_long=strip(input.description_long||'')||null
 const category=strip(input.category||'personal').toLowerCase(),body=strip(input.body||'')
 const size=(value:string)=>Array.from(value).length
 if(!name||size(name)>120)throw new UserSkillValidationError('Skill 名称长度必须是 1-120 个字符')
 if(!description_short||size(description_short)>100)throw new UserSkillValidationError('Skill 短描述长度必须是 1-100 个字符')
 if(description_long&&size(description_long)>500)throw new UserSkillValidationError('Skill 长描述最多 500 个字符')
 if(!['personal','productivity','research','creative','other'].includes(category))throw new UserSkillValidationError('Skill 分类不受支持')
 if(!body||size(body)>20000)throw new UserSkillValidationError('Skill 正文不能为空且最多 20000 个字符')
 const related_tools=[...new Set((input.related_tools||[]).map(value=>strip(value)).filter(Boolean))]
 if(related_tools.length>32)throw new UserSkillValidationError('Skill 最多关联 32 个工具')
 const missing=related_tools.filter(value=>!knownTools.has(value)&&!value.startsWith('mcp_'))
 if(missing.length)throw new UserSkillValidationError(`Skill 关联了未知工具：${missing.join(', ')}`)
 return {name,description_short,description_long,category,body,related_tools,source:'user' as const,enabled:true,content_digest:digest(body)}
}
