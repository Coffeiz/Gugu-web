import {mkdtemp,chmod,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {imageSize} from 'image-size'
import type {MediaLimits} from '@gugu/core/providers'
import {runImMediaProcess} from './media-process.js'

export interface ImImageInput {bytes:Uint8Array;ext:string;mime?:string}
export interface ImProcessedImage {bytes:Uint8Array;mime:string;width:number;height:number}
export class ImImageCleanupError extends Error {constructor(){super('IM 图片临时资源清理失败');this.name='ImImageCleanupError'}}
const cancelled=()=>new DOMException('IM 图片处理已取消','AbortError')
const check=(signal:AbortSignal)=>{if(signal.aborted)throw cancelled()}
const aliases:Record<string,string>={jpg:'jpeg',jpeg:'jpeg',png:'png',gif:'gif',webp:'webp',bmp:'bmp',tif:'tiff',tiff:'tiff',heic:'heif',heif:'heif'}
const mimes:Record<string,string>={jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',tiff:'image/tiff',heif:'image/heif'}
function dimensions(bytes:Buffer):ReturnType<typeof imageSize>{
 const little=bytes.subarray(0,4).equals(Buffer.from([73,73,42,0])),big=bytes.subarray(0,4).equals(Buffer.from([77,77,0,42]))
 if(!little&&!big)return imageSize(bytes)
 // image-size的TIFF实现会对部分合法SHORT/LONG内联值越界；首IFD仅用于解码前像素预算。
 const u16=(at:number)=>little?bytes.readUInt16LE(at):bytes.readUInt16BE(at),u32=(at:number)=>little?bytes.readUInt32LE(at):bytes.readUInt32BE(at)
 const offset=u32(4)
 if(offset<8||offset+2>bytes.length)throw Error()
 const count=u16(offset)
 if(count<1||count>4096||offset+2+12*count+4>bytes.length)throw Error()
 let width=0,height=0
 for(let i=0;i<count;i++){
  const at=offset+2+i*12,tag=u16(at)
  if(tag!==256&&tag!==257)continue
  const type=u16(at+2)
  if(u32(at+4)!==1||type!==3&&type!==4)throw Error()
  const value=type===3?u16(at+8):u32(at+8)
  if(tag===256){if(width)throw Error();width=value}else{if(height)throw Error();height=value}
 }
 if(!width||!height)throw Error()
 return {width,height,type:'tiff'}
}

/** 只生成Provider输入副本；不会重写原附件、稳定ref、ID或文件元数据。 */
export function createImImageProcessor(options:{ffmpegPath?:string;temporaryRoot?:string;maxInputBytes?:number;maxOutputBytes?:number;
 maxPixels?:number;timeoutMs?:number;maxConcurrent?:number}={}){
 const inputLimit=options.maxInputBytes??30*1024*1024,outputLimit=options.maxOutputBytes??32*1024*1024
 const pixels=options.maxPixels??32_000_000,timeout=options.timeoutMs??30_000,concurrency=options.maxConcurrent??2
 if(![inputLimit,outputLimit,pixels,timeout,concurrency].every(Number.isSafeInteger)||inputLimit<1||inputLimit>64*1024*1024
  ||outputLimit<1||outputLimit>64*1024*1024||pixels<1||pixels>64_000_000||timeout<1||timeout>60_000||concurrency<1||concurrency>16)throw new TypeError('IM 图片处理配置无效')
 let active=0
 return {async fit(input:ImImageInput,limits:MediaLimits,signal:AbortSignal):Promise<ImProcessedImage|null>{
  check(signal)
  if(!(input.bytes instanceof Uint8Array)||!input.bytes.byteLength||input.bytes.byteLength>inputLimit||active>=concurrency
   ||typeof input.ext!=='string'||!aliases[input.ext.toLowerCase()])return null
  const original=Buffer.from(input.bytes),extension=input.ext.toLowerCase(),format=aliases[extension]!
  let header:ReturnType<typeof imageSize>
  try{header=dimensions(original)}catch{return null}
  const detected=aliases[header.type??'']
  if(detected!==format||!header.width||!header.height||header.width*header.height>pixels)return null
  const mime=mimes[format]!
  if(input.mime!==undefined&&(typeof input.mime!=='string'||/[\x00-\x1f\x7f]/.test(input.mime)
   ||input.mime.split(';',1)[0]!.trim().toLowerCase()!==mime))return null
  // 当前Canvas和现有ffmpeg都没有可验证的HEIC解码器，不能借头部解析冒充已支持。
  if(format==='heif')return null
  let preserve=false
  if(limits.preserve_image_source===true){
   const extensions=limits.image_extensions,acceptedMimes=limits.image_mimes,maxBytes=limits.image_max_bytes
   if(!Array.isArray(extensions)||!Array.isArray(acceptedMimes)||!extensions.includes(extension)||!acceptedMimes.includes(mime)
    ||maxBytes!==null&&(typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||original.length>maxBytes)
    ||original.length>outputLimit)return null
   preserve=true
  }
  const passthrough=preserve||['jpeg','png','gif','webp'].includes(format)&&original.length<=5*1024*1024
   &&Math.max(header.width,header.height)<=3840&&original.length<=outputLimit
  active++;let directory:string|undefined
  try{
   directory=await mkdtemp(join(options.temporaryRoot??tmpdir(),'gugu-im-image-'));await chmod(directory,0o700);check(signal)
   let decoded:Buffer=original
   if(format==='tiff'){
    // TIFF的首IFD可能位于像素数据之后；实际解码器需要可seek的私有固定文件。
    const path=join(directory,'input.tiff');await writeFile(path,original,{flag:'wx',mode:0o600});check(signal)
    const png=await runImMediaProcess({binary:options.ffmpegPath??'ffmpeg',args:['-nostdin','-hide_banner','-loglevel','error',
     '-max_alloc','134217728','-protocol_whitelist','file,pipe','-format_whitelist','tiff_pipe','-f','tiff_pipe','-i',path,
     '-frames:v','1','-threads','1','-f','image2pipe','-vcodec','png','pipe:1'],directory,maxOutputBytes:64*1024*1024,timeoutMs:timeout,signal,cancelled})
    if(!png)return null
    decoded=png
   }
   const worker=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'./image-worker.ts':'./image-worker.js',import.meta.url))
   const result=await runImMediaProcess({binary:process.execPath,args:['--max-old-space-size=64',worker,JSON.stringify({original:passthrough,maxPixels:pixels,maxOutputBytes:outputLimit})],
    directory,maxOutputBytes:outputLimit+4096,timeoutMs:timeout,signal,input:decoded,cancelled})
   if(!result)return null
   const newline=result.indexOf(10)
   if(newline<1||newline>4096)return null
   const metadata=JSON.parse(result.subarray(0,newline).toString())
   if(!Number.isSafeInteger(metadata.width)||!Number.isSafeInteger(metadata.height)||metadata.width<1||metadata.height<1
    ||metadata.width*metadata.height>pixels||typeof metadata.original!=='boolean'||metadata.original!==passthrough)return null
   if(passthrough){
    if(result.length!==newline+1||metadata.width*metadata.height!==header.width*header.height)return null
    return {bytes:original,mime,width:metadata.width,height:metadata.height}
   }
   const bytes=result.subarray(newline+1),size=imageSize(bytes)
   if(bytes.length>Math.min(outputLimit,8*1024*1024)||size.type!=='jpg'||size.width!==metadata.width||size.height!==metadata.height
    ||Math.max(size.width,size.height)>3840)return null
   return {bytes,mime:'image/jpeg',width:metadata.width,height:metadata.height}
  }catch{check(signal);return null}
  finally{active--;if(directory)try{await rm(directory,{recursive:true,force:true,maxRetries:2,retryDelay:10})}catch{throw new ImImageCleanupError()}}
 }}
}
