import {mkdtemp,chmod,open,stat,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import type {VendorMediaSource} from '@gugu/core/providers'
import {runImMediaProcess} from './process.js'

export interface ImVideoProbe {width:number;height:number;bitRate:number;duration:number|null;codec:string|null;fps:number|null}
export interface ImProcessedVideo {bytes:Uint8Array;mime:'video/mp4';probe:ImVideoProbe}
export class ImVideoCleanupError extends Error {constructor(){super('IM 视频临时资源清理失败');this.name='ImVideoCleanupError'}}
const cancelled=()=>new DOMException('IM 视频处理已取消','AbortError')
const check=(signal:AbortSignal)=>{if(signal.aborted)throw cancelled()}
const unavailable=()=>new Error('IM 视频处理未完成')
const maximum=512*1024*1024
const containerMimes:Record<string,readonly string[]>={
 mov:['video/mp4','video/quicktime','video/x-m4v'],
 matroska:['video/x-matroska','video/webm'],avi:['video/x-msvideo','video/avi','video/msvideo'],
 asf:['video/x-ms-asf','video/x-ms-wmv'],flv:['video/x-flv'],mpeg:['video/mpeg'],mpegts:['video/mp2t'],
}
function demuxer(bytes:Buffer):string|null{
 if(bytes.length<12)return null
 if(bytes.subarray(4,8).toString()==='ftyp'||['moov','mdat','wide','free'].includes(bytes.subarray(4,8).toString()))return 'mov'
 if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'matroska'
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='AVI ')return 'avi'
 if(bytes.subarray(0,16).equals(Buffer.from([0x30,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11,0xa6,0xd9,0x00,0xaa,0x00,0x62,0xce,0x6c])))return 'asf'
 if(bytes.subarray(0,3).toString()==='FLV')return 'flv'
 if(bytes.subarray(0,4).equals(Buffer.from([0,0,1,0xba])))return 'mpeg'
 if(bytes.length>376&&bytes[0]===0x47&&bytes[188]===0x47&&bytes[376]===0x47)return 'mpegts'
 return null
}
export function parseImVideoProbe(raw:Uint8Array):ImVideoProbe|null{
 try{
  const value=JSON.parse(Buffer.from(raw).toString()),video=value.streams?.find((s:Record<string,unknown>)=>s.codec_type==='video')
  if(!video)return null
  const width=Number(video.width),height=Number(video.height)
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>16384||height>16384||width*height>64_000_000)return null
  const rawDurations=[video.duration,value.format?.duration]
  if(rawDurations.some(v=>v!=null&&v!=='N/A'&&(typeof v!=='number'&&typeof v!=='string'||!Number.isFinite(Number(v)))))return null
  const durations=rawDurations.map(Number).filter(v=>Number.isFinite(v)&&v>0)
  const parts=String(video.avg_frame_rate??'').split('/').map(Number)
  const fps=parts.length===2&&parts[1]!==0?parts[0]!/parts[1]!:NaN
  const bitrate=Number(video.bit_rate)
  return {width,height,bitRate:Number.isFinite(bitrate)&&bitrate>0?bitrate:0,duration:durations.length?Math.max(...durations):null,
   codec:typeof video.codec_name==='string'&&/^[a-z0-9_]{1,40}$/i.test(video.codec_name)?video.codec_name:null,
   fps:Number.isFinite(fps)&&fps>0&&fps<=240?fps:null}
 }catch{return null}
}

/** 不承担Provider选择/阈值/上传；只接受可信字节或受控stream，不接受任意本机路径/URL。 */
export function createImVideoProcessor(options:{ffmpegPath?:string;ffprobePath?:string;temporaryRoot?:string;
 maxInputBytes?:number;maxOutputBytes?:number;probeTimeoutMs?:number;transcodeTimeoutMs?:number;maxConcurrent?:number}={}){
 const inputLimit=options.maxInputBytes??maximum,outputLimit=options.maxOutputBytes??128*1024*1024
 const probeTimeout=options.probeTimeoutMs??10_000,transcodeTimeout=options.transcodeTimeoutMs??180_000,concurrency=options.maxConcurrent??2
 if(![inputLimit,outputLimit,probeTimeout,transcodeTimeout,concurrency].every(Number.isSafeInteger)||inputLimit<1||inputLimit>maximum
  ||outputLimit<1||outputLimit>maximum||probeTimeout<1||probeTimeout>30_000||transcodeTimeout<1||transcodeTimeout>180_000||concurrency<1||concurrency>16)throw new TypeError('IM 视频处理配置无效')
 let active=0
 async function execute(binary:string,args:string[],directory:string,timeoutMs:number,signal:AbortSignal){
  return runImMediaProcess({binary,args,directory,maxOutputBytes:65_536,timeoutMs,signal,cancelled})
 }
 async function probeFile(path:string,format:string,directory:string,signal:AbortSignal){
  const raw=await execute(options.ffprobePath??'ffprobe',['-v','error',...sourceArgs(path,format),'-select_streams','v:0',
   '-show_entries','format=duration:stream=codec_type,codec_name,width,height,bit_rate,duration,avg_frame_rate','-of','json'],directory,probeTimeout,signal)
  return raw?parseImVideoProbe(raw):null
 }
 function sourceArgs(path:string,format:string){return ['-max_alloc','33554432','-protocol_whitelist','file,pipe','-format_whitelist',format,'-f',format,
  ...(format==='mov'?['-enable_drefs','0']:[]),'-i',path]}
 async function process<T>(source:VendorMediaSource,signal:AbortSignal,work:(path:string,format:string,directory:string)=>Promise<T|null>):Promise<T|null>{
  check(signal)
  if(typeof source.mime!=='string'||/[\x00-\x1f\x7f]/.test(source.mime)||!Number.isSafeInteger(source.size)||source.size<1||source.size>inputLimit||active>=concurrency
   ||(source.bytes!==undefined)===(source.stream!==undefined)||source.bytes!==undefined&&(!(source.bytes instanceof Uint8Array)||source.bytes.byteLength!==source.size))return null
  const bytes=source.bytes===undefined?null:Buffer.from(source.bytes)
  const expectedSize=source.size,producer=source.stream,mime=source.mime.split(';',1)[0]!.trim().toLowerCase()
  active++;let directory:string|undefined
  try{
   directory=await mkdtemp(join(options.temporaryRoot??tmpdir(),'gugu-im-video-'));await chmod(directory,0o700);check(signal)
   const path=join(directory,'input.bin'),file=await open(path,'wx',0o600)
   let head=Buffer.alloc(0),total=0
   const readDeadline=Date.now()+30_000
   let iterator:AsyncIterator<Uint8Array>|undefined
   let finished=false
   try{
    iterator=(bytes?(async function*(){yield bytes})():producer!())[Symbol.asyncIterator]()
    while(true){
     check(signal)
     if(Date.now()>=readDeadline)throw unavailable()
     const value=await new Promise<IteratorResult<Uint8Array>>((resolve,reject)=>{
      let settled=false
      const finish=(operation:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);operation()}
      const abort=()=>finish(()=>reject(cancelled())),timer=setTimeout(()=>finish(()=>reject(unavailable())),Math.min(probeTimeout,readDeadline-Date.now()))
      signal.addEventListener('abort',abort,{once:true})
      if(signal.aborted)abort()
      Promise.resolve().then(()=>{check(signal);return iterator!.next()}).then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)))
     })
     if(value.done){finished=true;break}
     const chunk=value.value
     if(!(chunk instanceof Uint8Array)||!chunk.byteLength||total+chunk.byteLength>expectedSize||total+chunk.byteLength>inputLimit)throw unavailable()
     total+=chunk.byteLength
     if(head.length<512)head=Buffer.concat([head,Buffer.from(chunk.subarray(0,512-head.length))])
     await file.writeFile(chunk);check(signal)
    }
   }finally{
    let cleanupFailed=false
    try{await file.close()}catch{cleanupFailed=true}
    if(!finished&&iterator?.return){
     let timer:ReturnType<typeof setTimeout>|undefined
     try{await Promise.race([iterator.return(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ImVideoCleanupError()),1000)})])}
     catch{cleanupFailed=true}
     finally{clearTimeout(timer)}
    }
    if(cleanupFailed)throw new ImVideoCleanupError()
   }
   if(total!==expectedSize)return null
   const format=demuxer(head)
   if(!format||!containerMimes[format]?.includes(mime))return null
   check(signal);return await work(path,format,directory)
  }catch(error){if(error instanceof ImVideoCleanupError)throw error;check(signal);return null}
  finally{active--;if(directory)try{await rm(directory,{recursive:true,force:true,maxRetries:2,retryDelay:10})}catch{throw new ImVideoCleanupError()}}
 }
 return {
  async probe(source:VendorMediaSource,signal:AbortSignal):Promise<ImVideoProbe|null>{return process(source,signal,(path,format,directory)=>probeFile(path,format,directory,signal))},
  async probeVideo(source:VendorMediaSource,signal:AbortSignal):Promise<{duration:number|null}>{
   const result=await process(source,signal,(path,format,directory)=>probeFile(path,format,directory,signal));return {duration:result?.duration??null}
  },
  async transcode(source:VendorMediaSource,profile:{maxDimension:number;bitrate:string},signal:AbortSignal):Promise<ImProcessedVideo|null>{
   if(!Number.isSafeInteger(profile.maxDimension)||profile.maxDimension<2||profile.maxDimension>16384||!/^[1-9]\d{0,2}(?:[kM])?$/.test(profile.bitrate))throw new TypeError('IM 视频转码策略无效')
   return process(source,signal,async(path,format,directory)=>{
    const before=await probeFile(path,format,directory,signal);if(!before)return null
    const downscale=Math.max(before.width,before.height)>profile.maxDimension
    const scale=downscale?['-vf',`scale=${profile.maxDimension}:${profile.maxDimension}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`]:[]
    const output=join(directory,'output.mp4')
    const status=await execute(options.ffmpegPath??'ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-threads','1',...sourceArgs(path,format),
     '-map','0:v:0','-map','0:a:0?','-sn','-dn',...scale,'-c:v','libx264','-preset','fast','-threads','1','-b:v',profile.bitrate,
     '-c:a','aac','-b:a','96k','-map_metadata','-1','-movflags','+faststart','-fs',String(outputLimit),'-f','mp4',output],directory,transcodeTimeout,signal)
    if(!status)return null
    const size=(await stat(output)).size
    if(!size||size>=outputLimit)return null
    const after=await probeFile(output,'mov',directory,signal)
    if(!after||after.codec!=='h264'||Math.max(after.width,after.height)>Math.max(before.width,before.height)
     ||Math.min(after.width,after.height)>Math.min(before.width,before.height)
     ||downscale&&Math.max(after.width,after.height)>profile.maxDimension
     ||before.duration!==null&&(after.duration===null||Math.abs(after.duration-before.duration)>Math.max(.1,1/(before.fps??10))))return null
    const bytes=await readFile(output);check(signal)
    return bytes.length===size?{bytes,mime:'video/mp4',probe:after}:null
   })
  },
 }
}
