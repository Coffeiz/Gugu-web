import { createHmac, timingSafeEqual } from 'node:crypto'
import { jobUuid } from './jobs.js'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ExportDownloadError, type createDataExportDownloader } from '@gugu/core/data-portability/download-export'
import type { UserFromRequest } from '../../app.js'
import { parseCookieHeader } from '../../http/cookies.js'

export function signExportDownloadTicket(secret:string,owner:string,job:string,expiry:number):string{
 const user=jobUuid(owner),task=jobUuid(job)
 if(!user||!task||!Number.isSafeInteger(expiry))throw new Error('下载票据参数无效')
 const payload=`${user.replaceAll('-','')}:${task.replaceAll('-','')}:${expiry}`
 return `${payload}:${createHmac('sha256',secret).update(payload,'ascii').digest('hex')}`
}

/** 与Python相同：有效期内可重复下载；一次验证不消费票据。 */
export function verifyExportDownloadTicket(secret:string,ticket:string|undefined,job:string,now:number=Math.floor(Date.now()/1000)):string|null{
 if(!ticket)return null
 const parts=ticket.split(':');if(parts.length!==4)return null
 const [ownerRaw,jobRaw,expiryRaw,signature]=parts as [string,string,string,string],owner=jobUuid(ownerRaw),task=jobUuid(jobRaw),expectedJob=jobUuid(job)
 if(!owner||!task||task!==expectedJob||!/^[+-]?\d+(?:_\d+)*$/.test(expiryRaw)||expiryRaw.length>4300||!/^[0-9a-f]{64}$/.test(signature))return null
 const expiry=BigInt(expiryRaw.replaceAll('_',''));if(expiry<BigInt(now))return null
 const payload=`${owner.replaceAll('-','')}:${task.replaceAll('-','')}:${expiry}`
 const expected=createHmac('sha256',secret).update(payload,'ascii').digest('hex')
 return timingSafeEqual(Buffer.from(signature,'ascii'),Buffer.from(expected,'ascii'))?owner:null
}

export interface DataExportDownloadOptions{secretKey:string;download:ReturnType<typeof createDataExportDownloader>;requireReady(owner:string,job:string):Promise<void>}

function failure(error:unknown,reply:FastifyReply){
 if(!(error instanceof ExportDownloadError))throw error
 const status=error.code==='not_found'?404:error.code==='invalid_range'?416:410
 if(error.code==='invalid_range')reply.header('Content-Range',`bytes */${error.total}`)
 return reply.code(status).send({detail:error.message})
}

async function sendDownload(request:FastifyRequest,reply:FastifyReply,owner:string,job:string,options:DataExportDownloadOptions){
 const abort=new AbortController();let stream:Readable|undefined,close:(()=>Promise<void>)|undefined
 reply.raw.once('close',()=>{abort.abort();stream?.destroy();void close?.().catch(()=>undefined)})
 try{
  const result=await options.download(owner,job,request.headers.range,abort.signal)
  close=result.close
  if(abort.signal.aborted||reply.raw.destroyed){await close();return reply}
  reply.code(result.status).headers({'Accept-Ranges':'bytes','Cache-Control':'no-store','Content-Disposition':`attachment; filename="${result.filename}"`,'Content-Type':'application/zip','X-Content-Type-Options':'nosniff','Content-Length':String(result.length)})
  if(result.status===206)reply.header('Content-Range',`bytes ${result.start}-${result.end}/${result.total}`)
  stream=Readable.from(result.body)
  return reply.send(stream)
 }catch(error){return failure(error,reply)}
}

export function registerDataExportDownloadRoutes(app:FastifyInstance,userFromRequest:UserFromRequest,options:DataExportDownloadOptions):void{
 app.get('/api/v1/data-portability/exports/:job_id/download',(request,reply)=>{
  const owner=userFromRequest(request).id,job=jobUuid((request.params as {job_id:string}).job_id)
  if(!job)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  return sendDownload(request,reply,owner,job,options)
 })
 app.post('/api/v1/data-portability/exports/:job_id/download-ticket',async(request,reply)=>{
  const owner=userFromRequest(request).id,job=jobUuid((request.params as {job_id:string}).job_id)
  if(!job)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  try{await options.requireReady(owner,job)}catch(error){return failure(error,reply)}
  const ticket=signExportDownloadTicket(options.secretKey,owner,job,Math.floor(Date.now()/1000)+120)
  const path=request.url.split('?')[0]!.replace(/\/download-ticket\/?$/,'/download/browser')
  reply.header('Set-Cookie',`gugu_export_ticket=${ticket}; Max-Age=120; Path=${path}; HttpOnly;${request.protocol==='https'?' Secure;':''} SameSite=Lax`)
  return {url:path}
 })
}

/** 浏览器入口只接受限任务/限时HttpOnly能力Cookie，不要求同时存在登录Token。 */
export function registerDataExportBrowserDownloadRoute(app:FastifyInstance,options:DataExportDownloadOptions):void{
 app.get('/api/v1/data-portability/exports/:job_id/download/browser',(request,reply)=>{
  const job=jobUuid((request.params as {job_id:string}).job_id)
  if(!job)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  const owner=verifyExportDownloadTicket(options.secretKey,parseCookieHeader(request.headers.cookie).get('gugu_export_ticket'),job)
  if(!owner)return reply.code(401).send({detail:'下载授权已过期，请重新下载'})
  return sendDownload(request,reply,owner,job,options)
 })
}
