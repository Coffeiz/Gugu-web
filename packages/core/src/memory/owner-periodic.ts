import type {Json} from '../agent/models.js'
import {strip} from '../shared/values.js'
import {asciiDecimalDigits} from '../shared/unicode-decimal.js'

export type OwnerPeriodicField='profile'|'pattern'
export interface OwnerPeriodicOutput{items:Json[]|null;reason:string;index:number|null;count:number|null}
const types=new Set(['name','address','pronoun','background','preference','note'])
const error=()=>new Error('个人记忆维护数据无效')
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const has=(value:Record<string,unknown>,key:string)=>Object.hasOwn(value,key)
function field(value:OwnerPeriodicField){if(value!=='profile'&&value!=='pattern')throw error()}
function truthy(value:unknown):boolean{
 if(value==null||value===false||value===0||value==='')return false
 if(Array.isArray(value))return value.length>0
 if(object(value))return Object.keys(value).length>0
 return true
}
function repr(value:unknown):string{
 if(typeof value==='string'){
  const quote=value.includes("'")&&!value.includes('"')?'"':"'"
  return quote+value.replace(/\\/gu,'\\\\').replace(/\n/gu,'\\n').replace(/\r/gu,'\\r').replace(/\t/gu,'\\t')
   .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085]/gu,char=>`\\x${char.charCodeAt(0).toString(16).padStart(2,'0')}`)
   .replace(new RegExp(quote,'gu'),`\\${quote}`)+quote
 }
 return pythonString(value)
}
/** JSON值的Python str语义，不用JSON字符串化替代旧profile的文本规范化。 */
function pythonString(value:unknown):string{
 if(value==null)return 'None'
 if(value===true)return 'True';if(value===false)return 'False'
 if(typeof value==='string')return value
 if(typeof value==='number'){if(!Number.isFinite(value))throw error();return String(value)}
 if(Array.isArray(value))return `[${value.map(repr).join(', ')}]`
 if(object(value))return `{${Object.entries(value).map(([key,item])=>`${repr(key)}: ${repr(item)}`).join(', ')}}`
 throw error()
}
function json(value:unknown):Json{
 if(value===null||typeof value==='string'||typeof value==='boolean')return value
 if(typeof value==='number'&&Number.isFinite(value))return value
 if(Array.isArray(value))return value.map(json)
 if(object(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,json(item)]))
 throw error()
}
function numeric(value:unknown,integer=false):number{
 let number:number
 if(typeof value==='number')number=value
 else if(typeof value==='boolean')number=Number(value)
 else if(typeof value==='string'){
  const text=asciiDecimalDigits(strip(value)),digit='[0-9](?:_?[0-9])*'
  const pattern=integer?new RegExp(`^[+-]?${digit}$`,'u'):new RegExp(`^[+-]?(?:(?:${digit})(?:\\.(?:${digit})?)?|\\.(?:${digit}))(?:[eE][+-]?(?:${digit}))?$`,'u')
  if(!pattern.test(text))throw error();number=Number(text.replaceAll('_',''))
 }else throw error()
 // Python会漏过非finite ts或抛未捕获OverflowError；Node JSON和稳定排序不接受这些值。
 if(!Number.isFinite(number))throw error()
 return integer?Math.trunc(number):number
}
function copyState(state:Readonly<Record<string,Json>>):Record<string,Json>{if(!object(state))throw error();return json(state) as Record<string,Json>}
const keys=(kind:OwnerPeriodicField)=>kind==='profile'
 ?{attempt:'profile_last_attempt_at',success:'profile_last_compact_at',count:'profile_compacted_count'}
 :{attempt:'pattern_last_attempt_at',success:'last_review_at',count:'reviewed_count'}

export function ownerPeriodicDue(kind:OwnerPeriodicField,count:number,state:Readonly<Record<string,Json>>,nowSeconds:number):boolean{
 field(kind);copyState(state)
 if(!Number.isSafeInteger(count)||count<0||!Number.isFinite(nowSeconds))throw error()
 const key=keys(kind),last=numeric(truthy(state[key.success])?state[key.success]:0),reviewed=numeric(truthy(state[key.count])?state[key.count]:0,true)
 const attempt=numeric(has(state,key.attempt)?state[key.attempt]:0)
 if(!Number.isSafeInteger(reviewed))throw error()
 return count>=100&&nowSeconds>=Math.max(last+7*24*60*60,attempt+60*60)&&(!reviewed||count>=reviewed+30)
}
export function ownerPeriodicAttemptState(kind:OwnerPeriodicField,state:Readonly<Record<string,Json>>,at:number):Record<string,Json>{
 field(kind);if(!Number.isFinite(at))throw error()
 return{...copyState(state),[keys(kind).attempt]:at}
}
export function ownerPeriodicSuccessState(kind:OwnerPeriodicField,state:Readonly<Record<string,Json>>,at:number,count:number):Record<string,Json>{
 field(kind);if(!Number.isFinite(at)||!Number.isSafeInteger(count)||count<0)throw error()
 const key=keys(kind);return{...copyState(state),[key.success]:at,[key.count]:count}
}

/** 复刻store读取后的来源形状；pattern不发明id/默认kind，也不做旧文件迁移。 */
export function normalizeOwnerPeriodicItems(kind:OwnerPeriodicField,raw:unknown):Json[]{
 field(kind);if(!Array.isArray(raw))return[]
 if(kind==='pattern'){
  if(raw.some(item=>object(item)&&truthy(item.text)&&typeof item.text!=='string'))return[]
  return raw.filter(item=>object(item)&&typeof item.text==='string'&&strip(item.text)).map(json)
 }
 return raw.flatMap(item=>{
  if(typeof item!=='string'&&!object(item))return[]
  const text=strip(typeof item==='string'?item:pythonString(truthy(item.text)?item.text:''))
  if(!text)return[]
  const type=typeof item==='string'?'note':strip(pythonString(truthy(item.type)?item.type:'note'))
  return[{type:types.has(type)?type:'note',text,ts:typeof item==='string'?null:has(item,'ts')?json(item.ts):null}]
 })
}

export function checkOwnerPeriodicOutput(kind:OwnerPeriodicField,value:unknown,sourceItems:readonly Json[]):OwnerPeriodicOutput{
 field(kind)
 const rejected=(reason:string,index:number|null=null,count:number|null=Array.isArray(value)?value.length:null):OwnerPeriodicOutput=>({items:null,reason:`${kind}_${reason}`,index,count})
 if(!Array.isArray(value))return rejected('result_not_array')
 if(!value.length)return rejected('result_empty')
 if(value.length>70)return rejected('count_over_target')
 const result:Array<Record<string,Json>>=[],seen=new Set<string>(),sourceIds=new Set<string>()
 if(kind==='pattern'){
  if(!Array.isArray(sourceItems))throw error()
  for(const item of sourceItems)if(object(item))sourceIds.add(pythonString(truthy(item.id)?item.id:''))
 }
 for(const[index,item]of value.entries()){
  if(!object(item))return rejected('item_not_object',index)
  let text:string
  try{text=strip(pythonString(truthy(item.text)?item.text:''))}catch{return rejected('text_missing',index)}
  if(!text)return rejected('text_missing',index)
  if(kind==='profile'){
   let type:string;try{type=pythonString(truthy(item.type)?item.type:'note')}catch{return rejected('type_invalid',index)}
   if(!types.has(type))return rejected('type_invalid',index)
   try{result.push({type,text,ts:has(item,'ts')?json(item.ts):null})}catch{return rejected('numeric_field_invalid',index)}
   continue
  }
  let id:string;try{id=pythonString(truthy(item.id)?item.id:'')}catch{return rejected('source_id_invalid',index)}
  if(!id||!sourceIds.has(id))return rejected('source_id_invalid',index)
  if(seen.has(id))return rejected('source_id_duplicate',index);seen.add(id)
  if(item.kind!=='observed'&&item.kind!=='inferred')return rejected('kind_invalid',index)
  try{
   const conf=Math.min(.97,Math.max(0,numeric(has(item,'conf')?item.conf:.6)))
   const imp=Math.min(5,Math.max(1,numeric(has(item,'importance')?item.importance:has(item,'imp')?item.imp:3,true)))
   const ts=numeric(truthy(item.ts)?item.ts:0)
   result.push({id,text,kind:item.kind,conf,imp,ts})
  }catch{return rejected('numeric_field_invalid',index)}
 }
 if(kind==='pattern')result.sort((left,right)=>Number(right.kind==='observed')-Number(left.kind==='observed')
  ||Number(right.conf)-Number(left.conf)||Number(right.imp)-Number(left.imp)||Number(right.ts)-Number(left.ts))
 return{items:result,reason:'',index:null,count:value.length}
}
