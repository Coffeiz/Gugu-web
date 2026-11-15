import {emailPreviewImages} from './preview-assets.js'
import {isIP} from 'node:net'
import {strip} from '../shared/values.js'

export interface EmailPreviewDraft {
 subject:string; title:string; body:string; preheader?:string
 template?:string; theme?:string; palette?:string
 sections?:{heading?:string;text:string}[]
 actions?:{label:string;url:string}[]
}
export class EmailPreviewError extends Error {override name='EmailPreviewError'}
const palettes:Record<string,readonly[string,string]>={cafe:['#715653','#be9d98'],neutral:['#565b64','#c0c3c9'],red:['#a66e73','#d0a1a4'],blue:['#65789a','#9aaecd'],green:['#718a7e','#a9c2b5']}
const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;')
function text(value:unknown,field:string,limit:number):string{
 if(value==null)return ''
 if(typeof value!=='string')throw new EmailPreviewError(`${field} 必须是文本`)
 const result=strip(value)
 if(Array.from(result).length>limit)throw new EmailPreviewError(`${field} 不能超过 ${limit} 个字符`)
 return result
}
function actionUrl(value:string):string{
 const url=text(value,'操作链接',2048)
 // 与 urllib.urlparse 相同，只验证协议和 authority 存在；不额外限制端口、用户信息或路径。
 const parseable=url.replace(/[\r\n\t]/g,'').replace(/^[\u0000-\u0020]+/u,'')
 const match=/^([a-z][a-z\d+.-]*):/i.exec(parseable),scheme=match?.[1]?.toLowerCase()
 const authority=match&&parseable.slice(match[0].length).startsWith('//')?parseable.slice(match[0].length+2).split(/[/?#]/,1)[0]!:''
 if(authority.includes('[')||authority.includes(']')){
  const hostAndPort=authority.slice(authority.lastIndexOf('@')+1)
  const bracket=/^\[([^\]]*)\](?::.*)?$/.exec(hostAndPort)
  if(!bracket)throw new EmailPreviewError('Invalid IPv6 URL')
  const host=bracket[1]!
  if(host.startsWith('v')){
   if(!/^v[\da-f]+\..+$/i.test(host))throw new EmailPreviewError('IPvFuture address is invalid')
  }else if(isIP(host)===4)throw new EmailPreviewError('An IPv4 address cannot be in brackets')
  else if(isIP(host)!==6)throw new EmailPreviewError('Invalid IPv6 URL')
 }
 // urllib 拒绝 NFKC 后引入 URL 分隔符的 netloc。
 if(authority&&/[/?#@:]/.test(authority.replace(/[@:#?]/g,'').normalize('NFKC')))throw new EmailPreviewError("netloc contains invalid characters under NFKC normalization")
 if(!scheme||!['http','https','mailto'].includes(scheme)||(scheme!=='mailto'&&!authority))throw new EmailPreviewError('操作链接只支持 http、https 或 mailto 协议')
 if(/[\r\n\x00]/.test(url))throw new EmailPreviewError('操作链接格式不合法')
 return url
}

/** 完整语义邮件预览；静态图片由参考 renderer 生成，不访问 SMTP、磁盘或用户配置。 */
export function renderEmailPreview(draft:EmailPreviewDraft):{html:string;plain:string}{
 const template=draft.template??'notification',theme=draft.theme??'light',palette=draft.palette??'neutral'
 if(!['notification','reminder','report','security','test'].includes(template))throw new EmailPreviewError('不支持的邮件模板')
 const dark=theme==='dark',brand=(palettes[palette]??palettes.neutral)![dark?1:0]
 const token=dark?{canvas:'#171925',surface:'#232638',text:'#f3f4f8',muted:'#b7bbca',border:'#41465c',brand}:{canvas:'#f3f4f8',surface:'#ffffff',text:'#20222b',muted:'#6f7486',border:'#dfe2eb',brand}
 const subject=text(draft.subject,'邮件主题',200),body=text(draft.body,'邮件正文',20000),preheader=text(draft.preheader,'预览摘要',180)
 let title=text(draft.title,'邮件标题',200)||subject
 const defaults:Record<string,string>={reminder:'咕咕 · 日程提醒',report:'咕咕 · 进展报告',security:'咕咕 · 安全通知',test:'咕咕 · SMTP 测试邮件'}
 if(defaults[template]&&title===subject)title=defaults[template]!
 if(!Array.isArray(draft.sections??[])||(draft.sections?.length??0)>8)throw new EmailPreviewError('sections 最多支持 8 个区块')
 const sections=(draft.sections??[]).map(item=>{
  if(!item||typeof item!=='object')throw new EmailPreviewError('sections 必须是对象数组')
  const heading=text(item.heading,'区块标题',120),body=text(item.text,'区块正文',5000)
  if(!body)throw new EmailPreviewError('区块正文不能为空')
  return {heading,text:body}
 })
 if(!Array.isArray(draft.actions??[])||(draft.actions?.length??0)>3)throw new EmailPreviewError('actions 最多支持 3 个操作')
 const actions=(draft.actions??[]).map(item=>{
  if(!item||typeof item!=='object')throw new EmailPreviewError('actions 必须是对象数组')
  const label=text(item.label,'操作名称',80)
  if(!label)throw new EmailPreviewError('操作名称不能为空')
  return {label,url:actionUrl(item.url)}
 })
 const plainParts=[body,...sections.map(item=>item.heading?`${item.heading}\n${item.text}`:item.text)]
 if(actions.length)plainParts.push(actions.map(item=>`${item.label}: ${item.url}`).join('\n'))
 const images=emailPreviewImages[brand]!
 const scrollbarStyle=dark?`<style>html{color-scheme:dark}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:${token.canvas}}::-webkit-scrollbar-thumb{background:${token.border};border-radius:5px}</style>`:''
 const logoHeader=`<div style="text-align:center;padding:0 0 24px;margin:0;border-bottom:1px solid ${token.border}"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td valign="middle" style="width:92px"><img src="data:image/png;base64,${images[0]}" alt="" width="96" height="96" style="display:block;width:96px;height:96px;object-fit:contain"></td><td valign="middle" width="190" style="width:190px;text-align:center"><img src="data:image/png;base64,${images[1]}" alt="咕咕" width="190" height="90" style="display:block;width:190px;height:90px;object-fit:contain;margin:0 auto"><table role="presentation" cellpadding="0" cellspacing="0" style="width:190px;margin:0 auto"><tr><td style="padding:2px 0 0;text-align:center;color:${token.muted};font-size:10px;letter-spacing:.08em">${escape(template.toUpperCase())}</td></tr></table></td></tr></table></div>`
 const rows=[logoHeader,'<div style="height:20px;line-height:20px;font-size:1px">&nbsp;</div>',`<h1 style="margin:0;color:${token.text};font-size:24px;line-height:1.35">${escape(title)}</h1>`]
 if(preheader)rows.push('<div style="height:8px;line-height:8px;font-size:1px">&nbsp;</div>',`<p style="margin:0;color:${token.muted};font-size:13px">${escape(preheader)}</p>`)
 rows.push('<div style="height:24px;line-height:24px;font-size:1px">&nbsp;</div>',`<div style="color:${token.text};font-size:15px;line-height:1.75">${escape(body).replaceAll('\n','<br>')}</div>`)
 for(const item of sections){
  const heading=item.heading?`<strong style="display:block;margin-bottom:6px;color:${token.text};font-size:13px">${escape(item.heading)}</strong>`:''
  rows.push('<div style="height:22px;line-height:22px;font-size:1px">&nbsp;</div>',`<div style="padding:17px;border-left:3px solid ${token.brand};border-radius:0 8px 8px 0;background:${token.canvas};color:${token.muted};font-size:14px;line-height:1.7">${heading}${escape(item.text).replaceAll('\n','<br>')}</div>`)
 }
 if(actions.length)rows.push(actions.map(item=>`<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin:20px 8px 0 0"><tr><td style="padding:9px 13px;background:${token.brand};border:1px solid transparent;border-radius:8px;text-align:center;white-space:nowrap"><a href="${escape(item.url)}" style="display:block;color:#fff;text-decoration:none;font-size:12px;line-height:1.3;font-weight:600">${escape(item.label)}</a></td></tr></table>`).join(''))
 const html=`<!doctype html><html><head>${scrollbarStyle}</head><body style="margin:0;background:${token.canvas};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:${token.text};color-scheme:${dark?'dark':'light'}">
<div style="display:none;max-height:0;overflow:hidden">${escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${token.canvas};padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;background:${token.surface};border:1px solid ${token.border};border-radius:14px"><tr><td style="padding:40px">${rows.join('')}
<p style="margin:28px 0 0;padding:16px 0 0;border-top:1px solid ${token.border};color:${token.muted};font-size:12px">由咕咕发送 · SMTP 已接受不代表最终送达</p></td></tr></table></td></tr></table></body></html>`
 // 参考 preview_html 对整份 HTML 替换 CID，包括语义字段中的同名字面量；纯文本不替换。
 return {html:html.replaceAll('cid:gugu-logo-mark',`data:image/png;base64,${images[0]}`).replaceAll('cid:gugu-logo-wordmark',`data:image/png;base64,${images[1]}`),plain:plainParts.join('\n\n')}
}
