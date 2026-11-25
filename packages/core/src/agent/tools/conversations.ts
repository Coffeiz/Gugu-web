import { z } from 'zod'
import type { RunIdentity, ToolResult } from '../models.js'
import type { ToolDefinition } from './contracts.js'

export interface ImOwnerSessionBindInput { identity: RunIdentity; roundId: string; toolCallId: string; sessionId: number }
export interface ImOwnerSessionBindPort {
 bind(input: ImOwnerSessionBindInput, signal: AbortSignal): Promise<'bound' | 'denied' | 'unknown'>
 recover(input: ImOwnerSessionBindInput): Promise<'bound' | 'denied' | 'unknown'>
}
/** 仅由可信Host在owner私聊装配；不接受平台身份、owner或宿主路径参数。 */
export function createImOwnerSessionBindTool(port: ImOwnerSessionBindPort): ToolDefinition {
 const schema=z.object({session_id:z.number().int().positive().max(2147483647)}).strict()
 const output=(status:'bound'|'denied'|'unknown',sessionId:number):ToolResult=>status==='unknown'?{kind:'unknown'}:
  status==='bound'?{kind:'completed',successful:true,mutated:true,value:{bound:true,session_id:sessionId,message:'已绑定，之后可以在这里继续这段网页对话'}}:
  {kind:'completed',successful:false,mutated:false,value:{error:'网页会话不存在、不属于你，或当前私聊无权绑定'}}
 return {definition:{name:'bind_web_session',schema:{type:'function',function:{name:'bind_web_session',description:'将当前账号的私聊绑定到本人已有网页会话，之后在此私聊继续该对话。',parameters:{type:'object',properties:{session_id:{type:'integer',minimum:1,maximum:2147483647}},required:['session_id'],additionalProperties:false}}}},effect:'write',
  validate:input=>schema.safeParse(input),
  async execute(input,scope,call){const {session_id}=schema.parse(input);scope.signal.throwIfAborted();return output(await port.bind({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,sessionId:session_id},scope.signal),session_id)},
  async reconcile(input,identity,call){const {session_id}=schema.parse(input);return output(await port.recover({identity,roundId:identity.roundId,toolCallId:call.id,sessionId:session_id}),session_id)},
 }
}

export interface ConversationReadPort {
  read(identity:RunIdentity,sessionId:number,limit:number,signal:AbortSignal):Promise<{
    session_id:number;title:string;source:string|null;messages:Array<{role:string;content:string}>
  }|null>
}
/** 历史正文只经可信 Host 的 owner 限定读取；模型不能指定 owner。 */
export function createConversationReadTool(port:ConversationReadPort):ToolDefinition {
 const schema=z.object({session_id:z.number().int().safe(),limit:z.number().int().min(1).max(100).optional()}).passthrough()
 return {definition:{name:'read_conversation',schema:{type:'function',function:{name:'read_conversation',description:'读取指定历史对话的最近消息；先通过历史搜索确定会话 ID。',parameters:{type:'object',properties:{session_id:{type:'integer'},limit:{type:'integer',minimum:1,maximum:100}},required:['session_id']}}}},effect:'read',validate:input=>schema.safeParse(input),
  async execute(input,scope){
   const {session_id,limit}=input as z.infer<typeof schema>
   if(!session_id)return {kind:'completed',successful:false,mutated:false,value:{error:'需提供 session_id（先用 search_conversations 找）'}}
   const value=await port.read(scope.identity,session_id,limit??40,scope.signal)
   scope.signal.throwIfAborted()
   return value?{kind:'completed',successful:true,mutated:false,value}:{kind:'completed',successful:false,mutated:false,value:{error:'对话不存在或不属于你'}}
  }}
}

export interface ConversationSearchHit {
 session_id?:unknown;message_id?:unknown;source_id?:unknown;title?:unknown;summary?:unknown
 session_source?:unknown;session_updated_at?:unknown;role?:unknown;text?:unknown
}
export interface ConversationSearchPort {
 /** 三个方法均由可信 Host 限定 owner；resolve 必须验证最终会话归属。 */
 recent(identity:RunIdentity,limit:number,signal:AbortSignal):Promise<Array<{session_id:number;title:string;summary:string;source:string|null;updated_at:string}>>
 search(identity:RunIdentity,queries:string[],mode:'OR'|'AND',limit:number,signal:AbortSignal):Promise<ConversationSearchHit[]>
 resolve(identity:RunIdentity,hit:ConversationSearchHit,signal:AbortSignal):Promise<number|null>
}
function formatSearchTimestamp(value:unknown):string {
 if(typeof value!=='string')return ''
 const calendar=/^(\d{4})(?:-(\d{2})-(\d{2})|(\d{2})(\d{2}))/u.exec(value)
 const week=calendar?null:/^(\d{4})(?:-W(\d{2})(?:-(\d))?|W(\d{2})(\d)?)/u.exec(value)
 const match=calendar??week
 if(!match)return ''
 const year=Number(match[1]);if(year<1)return ''
 const date=new Date(0)
 if(calendar){
  const month=Number(calendar[2]??calendar[4]),day=Number(calendar[3]??calendar[5])
  date.setUTCFullYear(year,month-1,day)
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return ''
 }else{
  const number=Number(week![2]??week![4]),weekday=Number(week![3]??week![5]??1)
  if(number<1||number>53||weekday<1||weekday>7)return ''
  date.setUTCFullYear(year,0,4)
  const monday=(date.getUTCDay()+6)%7
  date.setUTCDate(date.getUTCDate()-monday+(number-1)*7+weekday-1)
  if(date.getUTCFullYear()<1||date.getUTCFullYear()>9999)return ''
 }
 const remainder=value.slice(match[0].length)
 let hour='00',minute='00'
 if(remainder){
  const points=[...remainder];if(points.length<2)return ''
  const text=points.slice(1).join('')
  const parsed=/^(\d{2})(?:(:?)(\d{2})(?:\2(\d{2})(?:[.,]\d+)?)?)?(Z|[+-].+)?$/u.exec(text)
  if(!parsed)return ''
  hour=parsed[1]!;minute=parsed[3]??'00'
  if(Number(hour)>23||Number(minute)>59||Number(parsed[4]??0)>59)return ''
  if(parsed[5]&&parsed[5]!=='Z'){
   const offset=/^[+-](\d{2})(?:(:?)(\d{2})(?:\2(\d{2})(?:[.,](\d+))?)?)?$/u.exec(parsed[5])
   if(!offset||Number(offset[1])*3600+Number(offset[3]??0)*60+Number(offset[4]??0)>=86400)return ''
  }
 }
 const y=String(date.getUTCFullYear()).padStart(4,'0'),m=String(date.getUTCMonth()+1).padStart(2,'0'),d=String(date.getUTCDate()).padStart(2,'0')
 return `${y}-${m}-${d} ${hour}:${minute}`
}
/** RAG 查询与旧索引定位由 Host 注入；没有完整可信来源时不得注册。 */
export function createConversationSearchTool(port:ConversationSearchPort):ToolDefinition {
 const schema=z.object({query:z.string().optional(),keyword:z.string().optional(),queries:z.array(z.string()).optional(),mode:z.enum(['OR','AND']).optional(),limit:z.number().int().safe().optional()}).passthrough().refine(value=>['query','keyword','queries'].filter(key=>Object.hasOwn(value,key)).length<=1)
 return {definition:{name:'search_conversations',schema:{type:'function',function:{name:'search_conversations',description:'搜索历史对话；不传关键词时列出最近对话。',parameters:{type:'object',properties:{query:{type:'string'},keyword:{type:'string'},queries:{type:'array',items:{type:'string'}},mode:{type:'string',enum:['OR','AND']},limit:{type:'integer'}},oneOf:[{required:['query'],not:{anyOf:[{required:['keyword']},{required:['queries']}]}},{required:['keyword'],not:{anyOf:[{required:['query']},{required:['queries']}]}},{required:['queries'],not:{anyOf:[{required:['query']},{required:['keyword']}]}},{not:{anyOf:[{required:['query']},{required:['keyword']},{required:['queries']}]}}]}}}},effect:'read',strictArrayFields:['queries'],validate:input=>schema.safeParse(input),
  async execute(input,scope){
   const {normalizeGlobalSearchQueries}=await import('@gugu/search')
   const args=input as z.infer<typeof schema>,raw=args.queries?.length?args.queries:[args.query||args.keyword||''],terms:string[]=[]
   for(const value of raw){terms.push(...value.trim().split(/\s+/u).filter(Boolean));if(terms.length>=8)break}
   const queries=normalizeGlobalSearchQueries('',terms),limit=Math.max(1,Math.min(args.limit||6,20))
   scope.signal.throwIfAborted()
   if(!queries.length){const recent=await port.recent(scope.identity,limit,scope.signal);scope.signal.throwIfAborted();return {kind:'completed',successful:true,mutated:false,value:{recent}}}
   const hits=await port.search(scope.identity,queries,args.mode??'OR',limit*4,scope.signal),seen=new Set<number>(),matches:Array<Record<string,unknown>>=[]
   let unresolved=false
   for(const hit of hits){
    scope.signal.throwIfAborted()
    const id=await port.resolve(scope.identity,hit,scope.signal)
    if(!Number.isSafeInteger(id)||!id||id<1){unresolved=true;continue}
    if(seen.has(id))continue
    seen.add(id)
    matches.push({session_id:id,title:hit.title||'未命名对话',summary:hit.summary||'',source:hit.session_source||'web',updated_at:formatSearchTimestamp(hit.session_updated_at),match:{role:hit.role==='user'?'你':'咕咕',snippet:[...String(hit.text||'')].slice(0,140).join('')}})
    if(matches.length>=limit)break
   }
   scope.signal.throwIfAborted()
   return {kind:'completed',successful:matches.length>0||!unresolved,mutated:false,value:matches.length?{matches,note:'用 read_conversation(session_id) 看某条对话的完整内容'}:unresolved?{matches:[],error:'找到历史消息片段，但无法定位所属会话，不能安全读取正文；请重试历史对话搜索。'}:{matches:[],hint:`没找到提到「${queries.join(' / ')}」的过去对话`}}
  }}
}
