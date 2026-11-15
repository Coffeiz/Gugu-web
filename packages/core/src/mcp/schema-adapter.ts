const KEEP = new Set(['type','description','enum','const','format','minimum','maximum','minLength','maxLength','properties','required','items','additionalProperties','default'])
const NAME = /^[A-Za-z0-9_]+$/
const MAX_DEPTH = 8

export function descriptionShortOf(description: string | null | undefined): string {
 const first=(description??'').trim().split(/\r?\n/).map(line=>line.trim()).find(Boolean)??''
 return first.length>100?`${first.slice(0,99)}…`:first
}
export function descriptionForProvider(description: string | null | undefined,fallback=''): string {
 return typeof description==='string'&&description.trim()?description:fallback
}
export function prefixedToolName(serverName: string,toolName: string,romanize:(value:string)=>string): string|null {
 const raw=serverName.trim(),romanized=raw?romanize(raw):''
 let safe=romanized.replace(/[^A-Za-z0-9_]/g,'_')
 if(!/[A-Za-z0-9_]/.test(safe)) safe=[...raw].map(c=>c.charCodeAt(0)>127?`u${c.codePointAt(0)!.toString(16)}`:c).join('_')
 safe=safe||'server'
 const tool=toolName.trim(),name=`mcp_${safe}_${tool}`
 return NAME.test(tool)&&NAME.test(name)&&name.length<=64?name:null
}
export function validateInputSchema(schema: unknown): string|null {
 if(!schema||typeof schema!=='object'||Array.isArray(schema))return 'inputSchema 不是对象'
 const value=schema as Record<string,unknown>
 if(value.type!=='object')return `inputSchema 顶层类型必须是 object（实际 ${JSON.stringify(value.type)??'undefined'}）`
 if(value.properties!==undefined&&(!value.properties||typeof value.properties!=='object'||Array.isArray(value.properties)))return 'inputSchema.properties 必须是对象'
 return null
}
const degraded=()=>({type:'string',description:'该参数结构过于复杂，已降级为字符串'})
function sanitize(node:unknown,depth:number,defs:Record<string,unknown>,resolving:Set<string>):unknown {
 if(depth>MAX_DEPTH)return degraded()
 if(Array.isArray(node))return node.map(v=>sanitize(v,depth+1,defs,resolving))
 if(!node||typeof node!=='object')return node
 const value=node as Record<string,any>
 if('$ref' in value){const ref=String(value.$ref),match=ref.match(/^#\/(\$defs|definitions)\/([^/]+)$/),key=match?.[2],target=key?defs[key]:undefined
  if(!target||typeof target!=='object'||resolving.has(ref))return degraded()
  const next=new Set(resolving);next.add(ref);const resolved=sanitize(target,depth+1,defs,next)
  if(!resolved||typeof resolved!=='object'||Array.isArray(resolved))return resolved
  return sanitize({...resolved,...Object.fromEntries(Object.entries(value).filter(([k])=>k!=='$ref'))},depth,defs,resolving)
 }
 for(const key of ['oneOf','anyOf'])if(key in value){const branches=(value[key]??[]).filter((b:any)=>b&&typeof b==='object'&&b.type!=='null');if(!branches.length)return degraded();const rest=Object.fromEntries(Object.entries(value).filter(([k])=>!['oneOf','anyOf','allOf'].includes(k)));return sanitize({...sanitize(branches[0],depth,defs,resolving) as object,...rest},depth,defs,resolving)}
 if('allOf'in value){const merged=Object.fromEntries(Object.entries(value).filter(([k])=>k!=='allOf')),props={...(merged.properties??{})},required=[...(merged.required??[])];for(const branch of value.allOf??[]){const item=sanitize(branch,depth+1,defs,resolving);if(item&&typeof item==='object'&&!Array.isArray(item)){Object.assign(props,(item as any).properties??{});for(const key of (item as any).required??[])if(!required.includes(key))required.push(key)}}if(Object.keys(props).length){merged.type=merged.type||'object';merged.properties=props}if(required.length)merged.required=required;return sanitize(merged,depth,defs,resolving)}
 const out:Record<string,unknown>={};for(const [key,item] of Object.entries(value)){if(!KEEP.has(key))continue;if(key==='properties'&&item&&typeof item==='object'&&!Array.isArray(item))out[key]=Object.fromEntries(Object.entries(item).slice(0,64).map(([name,v])=>[name,sanitize(v,depth+1,defs,resolving)]));else if(key==='required')out[key]=Array.isArray(item)?item.filter(v=>typeof v==='string'):[];else if(key==='items')out[key]=sanitize(item,depth+1,defs,resolving);else out[key]=item}return out
}
export function sanitizeInputSchema(schema:unknown):Record<string,unknown>{const value=schema&&typeof schema==='object'&&!Array.isArray(schema)?schema as Record<string,unknown>:{};const defs={...((value.$defs&&typeof value.$defs==='object'?value.$defs:{}) as object),...((value.definitions&&typeof value.definitions==='object'?value.definitions:{}) as object)};let result=sanitize(value,0,defs,new Set());if(!result||typeof result!=='object'||Array.isArray(result))result={};const out={...(result as Record<string,unknown>)};delete out.$defs;delete out.definitions;if(out.type===undefined)out.type='object';if(out.type!=='object')return {type:'object',properties:{}};if(out.properties===undefined)out.properties={};return out}
