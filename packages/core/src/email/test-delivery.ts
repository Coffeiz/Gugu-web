import {renderSmtpDraftMessage,SmtpDeliveryFailure,type SmtpTestSettings,type SmtpTestDelivery} from './smtp-test.js'
import {strip} from '../shared/values.js'
import {validEmail} from '../admin/email-recipient-count.js'
import type {EmailPreviewDraft} from './preview.js'
export interface AdminEmailTestDraft extends EmailPreviewDraft {
 recipient:string;test_locale?:string;translations?:Record<string,EmailPreviewDraft>
}
export interface AdminEmailTestSettings extends SmtpTestSettings {use_ssl:boolean}
export function normalizeEmailTestRecipient(value:string):string|null {const result=strip(value);return validEmail.test(result)?result:null}
/** 管理员只发送一封测试邮件；中文及缺少翻译时使用源内容。 */
export async function testAdminEmail(draft:AdminEmailTestDraft,settings:AdminEmailTestSettings,send:(delivery:SmtpTestDelivery)=>Promise<void>) {
 const fail=(error_code:string,message:string)=>({ok:false,status:'failed',error_code,message})
 if(!settings.host||!draft.recipient)return fail('smtp_not_configured','SMTP 未配置')
 const localized=draft.test_locale&&draft.test_locale!=='zh-CN'?draft.translations?.[draft.test_locale]??draft:draft
 const content={...localized,template:draft.template,theme:draft.theme,palette:draft.palette}
 const from=settings.from_addr||'',user=settings.user
 let message
 try{message=renderSmtpDraftMessage(content);message.plain=strip(localized.body)}catch(error){return fail('email_template_invalid',error instanceof Error&&error.name==='EmailPreviewError'?error.message:'邮件模板无效')}
 if(/[\r\n]/.test(message.subject+from+draft.recipient))return fail('email_template_invalid','邮件头不能包含换行')
 try{
  await send({host:settings.host,port:settings.port,user,password:settings.password,fromName:from&&!from.includes('@')?from:'咕咕',fromAddress:from.includes('@')?from:user,toAddress:strip(draft.recipient),secure:settings.use_ssl,message})
  return {ok:true,status:'sent',delivery:'smtp_accepted',message:'SMTP 已接受邮件'}
 }catch(error){
  if(error instanceof SmtpDeliveryFailure&&error.reason!=='delivery')return fail(error.reason==='tls_mismatch'?'smtp_tls_mismatch':'smtp_tls_error','SMTP TLS 连接失败，请检查端口与 SSL/TLS 设置')
  return fail('smtp_delivery_error','SMTP 连接、认证或发送失败，请检查配置和服务状态')
 }
}
