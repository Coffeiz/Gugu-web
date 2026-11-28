import {createHash} from 'node:crypto'
import {dataContext} from '../contracts/index.js'
import {strip} from '../shared/values.js'
import {asciiDecimalDigits} from '../shared/unicode-decimal.js'
import {openPortableArchive,type PortableArchiveSource} from './archive-reader-node.js'
import type {PortabilityJobQuery} from './read-jobs.js'

export class ExportDownloadError extends Error{
 constructor(readonly code:'not_found'|'checksum_failed'|'decrypt_failed'|'invalid_range',readonly total?:number){
  super({not_found:'导出文件不存在或已过期',checksum_failed:'导出文件校验失败',decrypt_failed:'导出文件无法解密',invalid_range:'下载范围无效'}[code])
 }
}
export interface OpenedExportArtifact extends PortableArchiveSource{close():Promise<void>}
function integer(value:string):bigint{
 const normalized=asciiDecimalDigits(strip(value))
 if(!/^[+-]?\d+(?:_\d+)*$/.test(normalized)||normalized.replace(/\D/g,'').length>4300)throw new Error('无效范围整数')
 return BigInt(normalized.replaceAll('_',''))
}
function range(header:string|undefined,total:number){
 if(!header)return {start:0,end:total-1,status:200}
 try{
  const equal=header.indexOf('='),unit=header.slice(0,equal),value=header.slice(equal+1),dash=value.indexOf('-')
  if(equal<0||dash<0||unit!=='bytes')throw new Error()
  const first=value.slice(0,dash),last=value.slice(dash+1),size=BigInt(total)
  let start:bigint,end:bigint
  if(!first){const suffix=integer(last);if(suffix<=0n)throw new Error();start=size>suffix?size-suffix:0n;end=size-1n}
  else{start=integer(first);end=last?integer(last):size-1n;if(end>=size)end=size-1n}
  if(start<0n||start>=size||end<start)throw new Error()
  return {start:Number(start),end:Number(end),status:206}
 }catch{throw new ExportDownloadError('invalid_range',total)}
}

export async function requireExportReadyForTicket(query:PortabilityJobQuery,owner:string,job:string,now:Date=new Date()):Promise<void>{
 const result=await query("SELECT id FROM data_export_jobs WHERE user_id=$1 AND id=$2 AND status='ready' AND expires_at>$3",[dataContext(owner).ownerId,dataContext(job).ownerId,now.toISOString()])
 if(!result.rows.length)throw new ExportDownloadError('not_found')
}

/** 先校验完整密文的size/SHA，再按需解密认证块；错误不写任务或删除归档。 */
export function createDataExportDownloader(query:PortabilityJobQuery,openArtifact:(key:string)=>Promise<OpenedExportArtifact>,secretKey:string,now:()=>Date=()=>new Date()){
 return async(owner:string,job:string,rangeHeader?:string,signal?:AbortSignal)=>{
  signal?.throwIfAborted()
  const ownerId=dataContext(owner).ownerId,jobId=dataContext(job).ownerId
  const row=(await query("SELECT artifact_key,artifact_size,artifact_sha256 FROM data_export_jobs WHERE user_id=$1 AND id=$2 AND status='ready' AND expires_at>$3",[ownerId,jobId,now().toISOString()])).rows[0]
  if(!row?.artifact_key)throw new ExportDownloadError('not_found')
  signal?.throwIfAborted()
  let source:OpenedExportArtifact
  try{source=await openArtifact(row.artifact_key as string)}catch{throw new ExportDownloadError('decrypt_failed')}
  let closed=false
  const close=async()=>{if(!closed){closed=true;await source.close()}}
  try{
   if(source.size!==Number(row.artifact_size))throw new ExportDownloadError('checksum_failed')
   const digest=createHash('sha256')
   for(let offset=0;offset<source.size;offset+=1024*1024){const expected=Math.min(1024*1024,source.size-offset),chunk=await source.readAt(offset,expected);signal?.throwIfAborted();if(chunk.length!==expected)throw new ExportDownloadError('checksum_failed');digest.update(chunk)}
   if(digest.digest('hex')!==row.artifact_sha256)throw new ExportDownloadError('checksum_failed')
   let archive:Awaited<ReturnType<typeof openPortableArchive>>
   try{archive=await openPortableArchive(source,secretKey,`data-portability:${ownerId.replaceAll('-','')}:${jobId.replaceAll('-','')}`)}catch{throw new ExportDownloadError('decrypt_failed')}
   const selected=range(rangeHeader,archive.plaintextSize),length=Math.max(0,selected.end-selected.start+1)
   async function* body(){try{yield* archive.stream(selected.start,length)}finally{await close()}}
   return {...selected,total:archive.plaintextSize,length,filename:`gugu-export-${jobId.replaceAll('-','').slice(0,12)}.zip`,body:body(),close}
  }catch(error){await close();if(error instanceof ExportDownloadError)throw error;throw new ExportDownloadError('decrypt_failed')}
 }
}
