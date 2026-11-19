import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes} from 'node:crypto'
import {adapterFor,prepareProviderVideo,uploadMiniMaxVideo,VideoMediaError,ProviderError,type ProviderConfig,type ProviderTransport,type VendorMediaSource} from '@gugu/core/providers'
import type {Block} from '@gugu/core/agent'
import type {ImVideoInput} from '../inbound/message.js'
import type {ImAgentReconstructionResources} from '../agent/reconstruct.js'
import {createNodeProviderTransportFactory} from '@gugu/core/providers/node'
import {createImVideoProcessor,ImVideoCleanupError} from './video.js'

export class ImVideoAuthorizationError extends Error{constructor(){super('IM 视频授权或来源已变更');this.name='ImVideoAuthorizationError'}}
/** 探测/传输均来自当前授权源；缓存只保存加密远端引用，不保存凭据或视频正文。 */
export function createImVideoRuntime(options:{ownerId:string;scopeKey:string;secretKey:string;config:ProviderConfig;
 authorize():Promise<boolean>;provider:ImAgentReconstructionResources['provider'];redis:{get(key:string):Promise<string|null>;set(key:string,value:string,ttlSeconds:number):Promise<boolean>};
 processor?:ReturnType<typeof createImVideoProcessor>;diagnose(code:'im_video_failed'):void}){
 if(!options.secretKey||!options.ownerId||!options.scopeKey)throw new TypeError('IM 视频运行配置无效')
 const selected=structuredClone(options.config),config={...selected,base_url:selected.base_url?.trim()||adapterFor(selected).baseUrl(selected)},processor=options.processor??createImVideoProcessor()
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(options.secretKey),Buffer.alloc(0),Buffer.from('gugu-im-video-upload-v1'),32))
 const hmac=(v:unknown)=>createHmac('sha256',key).update(JSON.stringify(v)).digest('hex')
 const report=()=>{try{options.diagnose('im_video_failed')}catch{/* 固定诊断不能改变结果。 */}}
 function seal(cacheKey:string,fileId:string){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(cacheKey));return Buffer.concat([nonce,cipher.update(JSON.stringify({fileId,expires:Date.now()+6*3600000})),cipher.final(),cipher.getAuthTag()]).toString('base64')}
 function open(cacheKey:string,encoded:unknown):string|null{
  try{if(typeof encoded!=='string'||encoded.length>2048)return null;const raw=Buffer.from(encoded,'base64');if(raw.length<29)return null
   const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAAD(Buffer.from(cacheKey));decipher.setAuthTag(raw.subarray(-16))
   const value=JSON.parse(Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString())
   return typeof value.fileId==='string'&&/^[\w-]{1,256}$/u.test(value.fileId)&&Number.isFinite(value.expires)&&value.expires>Date.now()?value.fileId:null
  }catch{return null}
 }
 return {async prepare(input:ImVideoInput,signal=new AbortController().signal):Promise<{block:Block|null;note:string}>{
  let denied=false,owned:(ProviderTransport&{close():Promise<void>})|undefined
  const cancel=()=>{if(signal.aborted)throw new ProviderError('cancelled')}
  const allowed=async()=>{cancel();try{if(!await options.authorize())throw new ImVideoAuthorizationError();await input.assertCurrent(signal)}catch{denied=true;cancel();throw new ImVideoAuthorizationError()}cancel()}
  let transport:ProviderTransport|undefined
  const actual=()=>{
   if(transport)return transport
   if(options.provider.transport)transport=options.provider.transport
   else{owned=options.provider.transportFactory?options.provider.transportFactory.snapshot(config).create():options.provider.createTransport?options.provider.createTransport(config):createNodeProviderTransportFactory().snapshot(config).create();transport=owned}
   return transport
  }
  const guarded:ProviderTransport={async request(request,requestSignal){await allowed();const result=await actual().request(request,requestSignal);try{await allowed();return result}catch(error){await result.cancel();throw error}}}
  try{
   await allowed()
   const block=await prepareProviderVideo(input,config,{
    transport:guarded,digest:v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),diagnose:report,
    async probeVideo(source,s){await allowed();const result=await processor.probe(source,s);await allowed();return result??{duration:null}},
    async transcodeVideo(source,profile,s){await allowed();const result=await processor.transcode(source,profile,s);await allowed();return result?{name:'video.mp4',mime:result.mime,size:result.bytes.length,bytes:result.bytes,...(result.probe.duration?{duration:result.probe.duration}:{})}:null},
    async uploadVideo(source:VendorMediaSource,selected,s){
     await allowed()
     const digest=await input.digest(s),cacheKey='im:node:video-upload:'+hmac([options.ownerId,options.scopeKey,selected,digest,source.mime,source.size])
     let cached:string|null=null
     try{cached=open(cacheKey,await options.redis.get(cacheKey))}catch{report()}
     await allowed();if(cached)return cached
     const id=await uploadMiniMaxVideo(source,selected,{transport:guarded,digest:v=>hmac(v),diagnose:report},s)
     await allowed();if(!id||! /^[\w-]{1,256}$/u.test(id))return null
     try{if(!await options.redis.set(cacheKey,seal(cacheKey,id),21600))report()}catch{report()}
     await allowed();return id
    },
   },signal)
   await allowed();return{block,note:'（用户上传的视频已随附，请根据实际内容回应。）'}
  }catch(error){
   cancel();await allowed()
   report()
   if(denied||error instanceof ImVideoAuthorizationError||error instanceof ImVideoCleanupError)throw error
   if(error instanceof VideoMediaError)return{block:null,note:`（${error.message}）`}
   if(error instanceof ProviderError&&error.code==='cancelled')throw error
   return{block:null,note:'（视频读取或上传失败，视频未发送给模型。）'}
  }finally{if(owned)try{await owned.close()}catch{report();throw new Error('IM 视频传输资源清理未完成')}}
 }}
}
