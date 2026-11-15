import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {EmailPreviewDraft} from '@gugu/core/email-preview'

export interface AdminEmailPreviewOptions {
 requireAdmin:preHandlerHookHandler
 render(draft:EmailPreviewDraft):{html:string;plain:string}
}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function string(value:unknown,min:number,max:number):value is string{return typeof value==='string'&&Array.from(value).length>=min&&Array.from(value).length<=max}
function localized(value:unknown):value is EmailPreviewDraft{
 if(!object(value)||!string(value.subject,1,200)||!string(value.title,1,200)||!string(value.body,1,20000))return false
 if(value.preheader!==undefined&&!string(value.preheader,0,180))return false
 if(value.sections!==undefined&&(!Array.isArray(value.sections)||value.sections.length>8||!value.sections.every(item=>object(item)&&string(item.text,1,5000)&&(item.heading===undefined||string(item.heading,0,120)))))return false
 if(value.actions!==undefined&&(!Array.isArray(value.actions)||value.actions.length>3||!value.actions.every(item=>object(item)&&string(item.label,1,80)&&string(item.url,1,2048))))return false
 return true
}
export function draft(value:unknown):value is EmailPreviewDraft{
 if(!localized(value))return false
 const body=value as unknown as Record<string,unknown>
 for(const [field,allowed] of [['template',['notification','reminder','report','security','test']],['theme',['light','dark']],['palette',['cafe','neutral','red','blue','green']]] as const){
  if(body[field]!==undefined&&!(allowed as readonly unknown[]).includes(body[field]))return false
 }
 if(body.translations!==undefined&&(!object(body.translations)||Object.keys(body.translations).length>3||!Object.entries(body.translations).every(([locale,content])=>['zh-CN','ja-JP','en-US'].includes(locale)&&localized(content))))return false
 return true
}
/** 只渲染管理员草稿；身份与 DTO 属于 Host，模板和安全链接规则属于 Core。 */
export function registerAdminEmailPreviewRoute(app:FastifyInstance,options:AdminEmailPreviewOptions):void{
 app.post('/api/v1/admin/email/preview',{preHandler:options.requireAdmin},(request,reply)=>{
  if(!draft(request.body))return reply.code(422).send({detail:'邮件草稿参数无效'})
  try{return options.render(request.body)}catch(error){
   if(error instanceof Error&&error.name==='EmailPreviewError')return reply.code(400).send({detail:error.message})
   throw error
  }
 })
}
