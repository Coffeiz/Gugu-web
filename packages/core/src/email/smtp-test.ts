import type { EmailAttachment } from './attachments.js'
export { createEmailAttachmentResolver, EmailAttachmentError, type EmailAttachmentReferences } from './attachments.js'
import {emailPreviewImages} from './preview-assets.js'
import {normalizeThemePalette,themePaletteColor,type ThemePalette} from '../preferences/palette.js'
import {strip} from '../shared/values.js'
import {renderEmailPreview,type EmailPreviewDraft} from './preview.js'

export interface SmtpTestMessage {subject:string;plain:string;html:string;images:{cid:string;filename:string;base64:string}[]}
export function emailTemplateImages(theme: 'light' | 'dark', palette: ThemePalette): SmtpTestMessage['images'] {
 return emailPreviewImages[themePaletteColor(palette, theme)]!.map((base64, index) => ({
  base64, cid: index === 0 ? 'gugu-logo-mark' : 'gugu-logo-wordmark',
  filename: index === 0 ? 'logo-mark.png' : 'logo-wordmark.png',
 }))
}
/** 仅适配受控模板的输出；不接受任意HTML，不作为通用HTML净化器。 */
export function renderSmtpDraftMessage(draft:EmailPreviewDraft):SmtpTestMessage {
 const rendered=renderEmailPreview(draft),subject=strip(draft.subject)
 const images=emailTemplateImages(draft.theme === 'dark' ? 'dark' : 'light', normalizeThemePalette(draft.palette))
 let html=rendered.html
 for(const image of images) html=html.replaceAll(`data:image/png;base64,${image.base64}`,`cid:${image.cid}`)
 // Python _build_msg 去掉文档包装，并过滤模板中不在邮件白名单内的静态CSS。
 const properties=new Set('background background-color border border-bottom border-left border-radius border-top color display color-scheme font-family font-size font-weight height line-height margin max-height max-width object-fit overflow padding text-align text-decoration width filter'.split(' '))
 html=html.replace(/<style>[\s\S]*?<\/style>/gi,'').replace(/<!doctype html>|<\/?(?:html|head|body)\b[^>]*>/gi,'').replace(/style="([^"]*)"/g,(_,style:string)=>{
  const safe=style.split(';').flatMap(declaration=>{const colon=declaration.indexOf(':');if(colon<0)return [];const key=declaration.slice(0,colon).trim(),value=declaration.slice(colon+1).trim();return properties.has(key)&&value?[`${key}:${value}`]:[]}).join(';')
  return `style="${safe}"`
 }).replaceAll('&nbsp;','\u00a0')
 return {subject,plain:rendered.plain,html,images}
}
/** 将投递模板的内嵌图片还原为预览用数据，预览中的操作链接不可点击。 */
export function smtpDraftPreviewHtml(message: SmtpTestMessage): string {
 let html = message.html.replace(/<a\b[^>]*>/gu, tag => tag.replace(/\shref="[^"]*"/u, ''))
 for (const image of message.images) html = html.replaceAll(`src="cid:${image.cid}"`, `src="data:image/png;base64,${image.base64}"`)
 return html
}
export function emailComposePresentation(format: 'plain' | 'html' | 'template', message: SmtpTestMessage) {
 return { format, ...(format === 'plain' ? {} : { templateHtml: smtpDraftPreviewHtml(message) }) }
}
export function smtpTestMessage():SmtpTestMessage {
 return renderSmtpDraftMessage({subject:'咕咕 · 邮件样式测试',title:'邮件样式测试',preheader:'咕咕为你整理了一封结构清晰的邮件',body:'这是来自咕咕开发页面的邮件样式测试，收到即表示 SMTP 配置和邮件模板均可用。',sections:[{heading:'模板预览',text:'当前模板：test'}],template:'test'})
}
export class SmtpDeliveryFailure extends Error {
 override name='SmtpDeliveryFailure'
 constructor(readonly reason:'tls'|'tls_mismatch'|'delivery'){super('SMTP发送失败')}
}
export interface SmtpTestSettings {host:string;port:number;user:string;password:string;from_addr:string;to_addr:string;test_to_addr:string}
export interface SmtpTestInput {host:string;port:number;user:string;password?:string;from_addr?:string;to_addr:string;use_ssl?:boolean}
export interface SmtpTestDelivery {host:string;port:number;user:string;password:string;fromName:string;fromAddress:string;toAddress:string;toName?:string;additionalRecipients?:string[];cc?:string[];bcc?:string[];secure:boolean;message:SmtpTestMessage;attachments?:readonly (EmailAttachment & { cid?: string })[]}
export async function testSmtp(input:SmtpTestInput,settings:SmtpTestSettings,send:(delivery:SmtpTestDelivery)=>Promise<void>):Promise<{ok:boolean;message:string}> {
 const host=input.host||settings.host,toAddress=input.to_addr||settings.test_to_addr||settings.to_addr,user=input.user||settings.user,from=input.from_addr||settings.from_addr||user
 if(!host)return {ok:false,message:'SMTP 服务器未配置'}
 if(!toAddress)return {ok:false,message:'收件人地址未配置'}
 try{
  if(/[\r\n]/.test(from)||/[\r\n]/.test(toAddress))throw new Error('邮件地址不能包含换行')
  await send({host,port:input.port||settings.port,user,password:input.password||settings.password,fromName:from&&!from.includes('@')?from:'咕咕',fromAddress:from.includes('@')?from:user,toAddress,secure:input.use_ssl??true,message:smtpTestMessage()})
  return {ok:true,message:`测试邮件已发送至 ${toAddress}`}
 }catch{return {ok:false,message:'SMTP 测试失败，请检查服务器、TLS 和认证配置'}}
}

export { sanitizeEmailHtml } from './html.js'
