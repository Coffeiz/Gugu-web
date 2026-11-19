import type {Json} from '@gugu/core/agent'
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
export function reportedReflectionUsage(value:Json):Json|null{
 if(value===null)return null
 if(!object(value))throw new Error('反思用量无效')
 const names=['input','output','cacheRead','cacheWrite'] as const
 if(names.some(name=>value[name]!==null&&value[name]!==undefined&&(!Number.isSafeInteger(value[name])||Number(value[name])<0)))throw new Error('反思用量无效')
 // 真实driver以contextInput=null标注缺报；此时零计数是legacy占位，不能拿它冒充实际零用量。
 const unknownInput=Object.hasOwn(value,'contextInput')&&value.contextInput===null&&(value.input===0||value.input==null)
 const reported=Object.fromEntries(names.map(name=>[name,value[name]===undefined||unknownInput&&value[name]===0?null:value[name]]))
 return Object.values(reported).every(count=>count===null)?null:reported as Json
}
