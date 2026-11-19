import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {AsrDependencies} from '@gugu/core/providers'
import {prepareSilk} from './silk-format.js'
import {runImMediaProcess} from './media-process.js'

const maximum=64*1024*1024
export class ImAudioCleanupError extends Error {
 constructor(){super('IM 音频临时资源清理失败');this.name='ImAudioCleanupError'}
}
const cancelled=()=>new DOMException('IM 音频处理已取消','AbortError')
const check=(signal:AbortSignal)=>{if(signal.aborted)throw cancelled()}

/** 内容魔数决定固定demuxer，不接受调用方提供的文件路径、协议或ffmpeg参数。 */
function format(raw:Uint8Array):string|null{
 const bytes=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength)
 if(bytes.length<8)return null
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')return 'wav'
 if(bytes.subarray(0,4).toString()==='OggS')return 'ogg'
 if(bytes.subarray(0,4).toString()==='fLaC')return 'flac'
 if(bytes.subarray(0,3).toString()==='ID3')return 'mp3'
 if(bytes[0]===0xff&&((bytes[1]!&0xf6)===0xf0))return 'aac'
 if(bytes[0]===0xff&&(bytes[1]!&0xe0)===0xe0&&(bytes[1]!&0x06)!==0)return 'mp3'
 if(bytes.subarray(0,5).toString()==='#!AMR')return 'amr'
 if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'matroska'
 if(bytes.subarray(4,8).toString()==='ftyp')return 'mov'
 if(bytes.subarray(0,16).equals(Buffer.from([0x30,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11,0xa6,0xd9,0x00,0xaa,0x00,0x62,0xce,0x6c])))return 'asf'
 return null // 未知格式及文本playlist/concat不能猜测为音频。
}
function wav(raw:Buffer):boolean{
 if(raw.length<44||raw.subarray(0,4).toString()!=='RIFF'||raw.subarray(8,12).toString()!=='WAVE')return false
 let pcm=false
 for(let at=12;at+8<=raw.length;){
  const name=raw.subarray(at,at+4).toString(),size=raw.readUInt32LE(at+4),start=at+8
  if(name==='fmt '&&size>=16&&start+16<=raw.length)pcm=raw.readUInt16LE(start)===1&&raw.readUInt16LE(start+2)===1&&raw.readUInt32LE(start+4)===16000&&raw.readUInt16LE(start+14)===16
  if(name==='data')return pcm&&raw.length>start&&size>0
  const next=start+size+(size%2);if(next<=at||next>raw.length)return false;at=next
 }
 return false
}

/** 实际安全进程边界；与Core ASR dependencies同签名，不负责选模、密钥或网络。 */
export function createImAudioProcessor(options:{
 ffmpegPath?:string;ffprobePath?:string;temporaryRoot?:string;maxInputBytes?:number;maxOutputBytes?:number
 probeTimeoutMs?:number;transcodeTimeoutMs?:number;maxConcurrent?:number
}={}):Pick<AsrDependencies,'probeAudioDuration'|'toWav'>{
 const inputLimit=options.maxInputBytes??maximum,outputLimit=options.maxOutputBytes??maximum
 const probeTimeout=options.probeTimeoutMs??30_000,convertTimeout=options.transcodeTimeoutMs??60_000,concurrency=options.maxConcurrent??2
 if(!Number.isSafeInteger(inputLimit)||inputLimit<1||inputLimit>maximum||!Number.isSafeInteger(outputLimit)||outputLimit<44||outputLimit>maximum
  ||!Number.isSafeInteger(probeTimeout)||probeTimeout<1||probeTimeout>30_000||!Number.isSafeInteger(convertTimeout)||convertTimeout<1||convertTimeout>60_000
  ||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>16)throw new TypeError('IM 音频处理配置无效')
 let active=0
 async function execute(binary:string,args:string[],directory:string,limit:number,timeout:number,signal:AbortSignal,input?:Uint8Array):Promise<Buffer|null>{
  return runImMediaProcess({binary,args,directory,maxOutputBytes:limit,timeoutMs:timeout,signal,input,cancelled})
 }
 async function processAudio(raw:Uint8Array,signal:AbortSignal,operation:'probe'|'wav'):Promise<Buffer|null>{
  check(signal)
  if(!(raw instanceof Uint8Array)||!raw.byteLength||raw.byteLength>inputLimit||active>=concurrency)return null
  let demuxer=format(raw)
  const silk=demuxer?null:prepareSilk(raw,outputLimit)
  if(!demuxer&&!silk)return null
  // 在第一次await前复制已准入字节，避免调用方修改header或内容改变已验证输入。
  const copy=Buffer.from(raw);active++
  let directory:string|undefined
  try{
   directory=await mkdtemp(join(options.temporaryRoot??tmpdir(),'gugu-im-audio-'))
   await chmod(directory,0o700);check(signal)
   let input:Buffer=copy
   if(silk){
    const worker=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'./silk-worker.ts':'./silk-worker.js',import.meta.url))
    const pcm=await execute(process.execPath,['--wasm-max-mem-pages=2048','--max-old-space-size=64',worker],directory,
     Math.min(outputLimit,silk.maximumPcmBytes),operation==='probe'?probeTimeout:Math.min(convertTimeout,30_000),signal,silk.bytes)
    if(!pcm||!pcm.length||pcm.length%2)return null
    if(operation==='probe')return Buffer.from(JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:pcm.length/48000}}))
    input=pcm;demuxer='s16le'
   }
   const file=join(directory,'input.bin')
   await writeFile(file,input,{flag:'wx',mode:0o600});check(signal)
   const source=['-max_alloc','33554432','-protocol_whitelist','file,pipe','-format_whitelist',demuxer!,'-f',demuxer!,
    ...(silk?['-ar','24000','-ac','1']:[]),
    ...(demuxer==='mov'?['-enable_drefs','0']:[]),'-i',file]
   if(operation==='probe')return await execute(options.ffprobePath??'ffprobe',['-v','error',...source,'-select_streams','a:0','-show_entries','format=duration:stream=codec_type','-of','json'],directory,16_384,probeTimeout,signal)
   return await execute(options.ffmpegPath??'ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-threads','1',...source,
    '-map','0:a:0','-vn','-sn','-dn','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav','pipe:1'],directory,outputLimit,convertTimeout,signal)
  }catch{check(signal);return null}
  finally{
   active--
   if(directory)try{await rm(directory,{recursive:true,force:true,maxRetries:2,retryDelay:10})}catch{throw new ImAudioCleanupError()}
  }
 }
 return {
  async probeAudioDuration(raw,_extension,signal){
   const bytes=await processAudio(raw,signal,'probe');if(!bytes)return null
   try{
    const value=JSON.parse(bytes.toString()) as {format?:{duration?:unknown};streams?:Array<{codec_type?:unknown}>}
    const duration=Number(value.format?.duration)
    return value.streams?.some(s=>s.codec_type==='audio')&&Number.isFinite(duration)&&duration>0?Math.round(duration*1000)/1000:null
   }catch{return null}
  },
  async toWav(raw,signal){const bytes=await processAudio(raw,signal,'wav');return bytes&&wav(bytes)?bytes:null},
 }
}
