import {createHmac,timingSafeEqual} from 'node:crypto'
import {jobUuid} from './read-jobs.js'
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
