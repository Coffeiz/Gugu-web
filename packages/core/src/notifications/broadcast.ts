import {strip} from '../shared/values.js'

export interface NotificationBroadcastInput {
 title:string;content:string;color:string;target:string;bubble:boolean;persist:boolean;bubble_ttl_hours:number|null
}
export interface BroadcastNotification {id:number;title:string;content:string;color:string;bubble:boolean;persist:boolean}
export class NotificationBroadcastError extends Error {}
export type NotificationBroadcastQuery=(text:string,params:unknown[])=>Promise<{rows:Array<{id:number}>}>

/** 广播与通知中心独立；写入成功后投递失败不撤销权威记录。 */
export function createNotificationBroadcaster(query:NotificationBroadcastQuery,publish:(target:string,note:BroadcastNotification)=>Promise<unknown>,now:()=>Date=()=>new Date()){
 return async(input:NotificationBroadcastInput)=>{
  if(!strip(input.title)&&!strip(input.content))throw new NotificationBroadcastError('标题和内容不能同时为空')
  if(!input.bubble&&!input.persist)throw new NotificationBroadcastError('气泡 / 通知中心至少选一个')
  const timestamp=now(),expires=input.bubble&&input.bubble_ttl_hours?new Date(timestamp.getTime()+input.bubble_ttl_hours*3600000):null
  if(expires&&!Number.isFinite(expires.getTime()))throw new NotificationBroadcastError('气泡时限超出支持范围')
  const result=await query(`INSERT INTO site_notifications(title,content,color,target,bubble,persist,bubble_expire_at,created_by,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,'admin',$8) RETURNING id`,[input.title,input.content,input.color,input.target,input.bubble,input.persist,expires?.toISOString()??null,timestamp.toISOString()])
  const id=Number(result.rows[0]!.id),note={id,title:input.title,content:input.content,color:input.color,bubble:input.bubble,persist:input.persist}
  let target:string|null=input.target==='all'?'all':null
  if(target===null){const compact=input.target.replace(/^urn:uuid:/i,'').replace(/^\{(.*)\}$/,'$1').replaceAll('-','');if(/^[0-9a-f]{32}$/i.test(compact))target=`${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`.toLowerCase()}
  if(target!==null)try{await publish(target,note)}catch{/* 与Python广播一致：提交后的实时通知为best-effort。 */}
  return {ok:true as const,id}
 }
}
