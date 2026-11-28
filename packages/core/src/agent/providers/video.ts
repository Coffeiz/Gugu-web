import type {Block} from '../models.js'
import type {ProviderConfig,MediaLimits} from './contracts.js'
import {adapterFor} from './registry.js'
import {ProviderError,throwIfCancelled} from './errors.js'
import {prepareMiniMaxVideo,minimaxSupportsVideo} from './minimax/media.js'
import {DEFAULT_MEDIA_LIMITS,type VendorMediaSource,type VendorMediaDependencies} from './media.js'

const messages={unsupported:'当前主模型未开启受支持的视频输入，视频未发送给模型。',source_size:'视频超过当前 Provider 单文件上限，未发送给模型。',
 duration_unknown:'无法确认视频时长，未发送给模型。',duration_limit:'视频达到或超过当前 Provider 时长限制，未发送给模型。',
 conversion:'视频转码失败，未发送给模型。',size:'视频超过当前 Provider 输入大小限制，未发送给模型。',upload:'视频上传失败，未发送给模型。'} as const
export class VideoMediaError extends ProviderError{
 constructor(readonly reason:keyof typeof messages){super(reason==='unsupported'?'unsupported':'input_rejected');this.name='VideoMediaError';this.message=messages[reason]}
}
const number=(limits:MediaLimits,key:string,fallback:number)=>{const value=limits[key]??fallback;if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new ProviderError('input_rejected');return value}
/** 共享聊天/工具的视频决策；Host只提供授权字节、探测、转码及实际上传。 */
export async function prepareProviderVideo(source:VendorMediaSource,config:ProviderConfig,deps:VendorMediaDependencies,signal:AbortSignal):Promise<Block>{
 throwIfCancelled(signal)
 const policy=adapterFor(config),protocol=policy.protocol(config),declared=config.capability_overrides?.video??policy.capabilities(config).video
 if(config.video!==true||declared!==true||!['openai','anthropic'].includes(protocol)||!policy.supportedApiFormats(config).includes(protocol))throw new VideoMediaError('unsupported')
 const limits={...DEFAULT_MEDIA_LIMITS,...policy.mediaLimits(config)},mimes=limits.video_mimes
 if(!Number.isSafeInteger(source.size)||source.size<1||source.size>number(limits,'video_source_max_bytes',500*1024*1024))throw new VideoMediaError('source_size')
 if(!/^video\/[\w.+-]+$/u.test(source.mime)||Array.isArray(mimes)&&mimes.length&&!mimes.includes(source.mime))throw new VideoMediaError('unsupported')
 const probe=await deps.probeVideo?.(source,signal);throwIfCancelled(signal)
 const duration=probe?.duration
 if(limits.max_duration_s!==null){
  const maximum=number(limits,'max_duration_s',120)
  if(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0)throw new VideoMediaError('duration_unknown')
  if(limits.duration_limit_inclusive===true?duration>=maximum:duration>maximum)throw new VideoMediaError('duration_limit')
 }
 let payload:VendorMediaSource={...source,...(typeof duration==='number'?{duration}:{})}
 if(protocol==='anthropic'){
  const maximum=number(limits,'max_size_bytes',90*1024*1024),dimension=number(limits,'compress_max_dim',1920),trigger=number(limits,'compress_trigger_bitrate',16*1024*1024)
  const forced=Array.isArray(limits.transcode_video_mimes)&&limits.transcode_video_mimes.includes(source.mime)
  if(limits.transcode_video===true&&(forced||source.size>maximum||Math.max(probe?.width??0,probe?.height??0)>dimension||(probe?.bitRate??0)>trigger)){
   const bitrate=limits.compress_bitrate
   if(typeof bitrate!=='string')throw new ProviderError('input_rejected')
   const converted=await deps.transcodeVideo?.(payload,{maxDimension:dimension,bitrate},signal);throwIfCancelled(signal)
   if(!converted||!Number.isSafeInteger(converted.size)||converted.size<1)throw new VideoMediaError('conversion')
   payload=converted
  }
  if(payload.size>maximum)throw new VideoMediaError('size')
  if(policy.name==='minimax'&&minimaxSupportsVideo(config.model)){
   const media=await prepareMiniMaxVideo(payload,config,deps,signal);throwIfCancelled(signal)
   return {type:'video',source:media.mode==='file'?{type:'url',url:media.uri,fps:1}:{type:'base64',media_type:media.mime,data:media.data,fps:1}}
  }
  if(payload.size>number(limits,'base64_max',45*1024*1024))throw new VideoMediaError('upload')
 }else if(payload.size>number(limits,'inline_max_bytes',36*1024*1024))throw new VideoMediaError('size')
 const parts:Uint8Array[]=[],stream=payload.bytes?(async function*(){yield payload.bytes!})():payload.stream?.()
 if(!stream)throw new ProviderError('input_rejected')
 let size=0
 for await(const part of stream){throwIfCancelled(signal);if(!(part instanceof Uint8Array))throw new ProviderError('input_rejected');size+=part.length;if(size>payload.size)throw new ProviderError('input_rejected');parts.push(part)}
 if(size!==payload.size)throw new ProviderError('input_rejected')
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}
 let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192))
 const encoded=btoa(binary)
 return protocol==='anthropic'?{type:'video',source:{type:'base64',media_type:payload.mime,data:encoded,fps:1}}:
  {type:'video_url',video_url:{url:`data:${payload.mime};base64,${encoded}`},fps:2,media_resolution:'default'}
}
