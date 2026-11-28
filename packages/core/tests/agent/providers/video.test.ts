import {describe,it,expect} from 'vitest'
import {prepareProviderVideo} from '../../../src/agent/providers/video.js'
import type {ProviderConfig,VendorMediaDependencies,VendorMediaSource} from '../../../src/agent/providers/index.js'
const signal=new AbortController().signal
const source:VendorMediaSource={name:'合成视频.mp4',mime:'video/mp4',size:3,bytes:new Uint8Array([1,2,3])}
const config:ProviderConfig={provider:'openai',model:'synthetic-model',api_format:'openai',video:true,capability_overrides:{video:true}}
const deps=(duration:number|null=1):VendorMediaDependencies=>({digest:()=>'',transport:{async request(){throw Error('不调用外部服务')}},async probeVideo(){return{duration,width:16,height:16,bitRate:1000}}})
describe('共享Provider视频决策，媒体端口明确替身',()=>{
 it('未启用、Responses和原生Ollama均在探测和读字节前拒绝',async()=>{
  const d=deps();d.probeVideo=async()=>{throw Error('不应探测')}
  for(const c of [{...config,video:false},{...config,api_format:'responses'},{...config,provider:'ollama',ollama_api_mode:'native' as const}])await expect(prepareProviderVideo(source,c,d,signal)).rejects.toMatchObject({reason:'unsupported'})
 })
 it('通用时长120秒为含边界限制，无法探测时不信source.duration',async()=>{
  await expect(prepareProviderVideo({...source,duration:1},config,deps(null),signal)).rejects.toMatchObject({reason:'duration_unknown'})
  await expect(prepareProviderVideo(source,config,deps(120),signal)).rejects.toMatchObject({reason:'duration_limit'})
  expect(await prepareProviderVideo(source,config,deps(119.999),signal)).toEqual({type:'video_url',video_url:{url:'data:video/mp4;base64,AQID'},fps:2,media_resolution:'default'})
 })
 it('OpenAI按Python实际分支不转码，inline超限先拒绝源读取',async()=>{
  const d=deps();d.probeVideo=async()=>({duration:1,width:4000,height:2000,bitRate:999999999});d.transcodeVideo=async()=>{throw Error('OpenAI分支不调用转码')}
  expect((await prepareProviderVideo(source,config,d,signal)).type).toBe('video_url')
  await expect(prepareProviderVideo({...source,size:36*1024*1024+1,bytes:undefined,stream:async function*(){throw Error('不应读完整源')}},config,d,signal)).rejects.toMatchObject({reason:'size'})
 })
 it('Anthropic只有策略触发才转码，保留固定fps与输出MIME；失败不能原图兜底',async()=>{
  const c={...config,provider:'anthropic',api_format:'anthropic'},d=deps();let calls=0
  d.probeVideo=async()=>({duration:1,width:3840,height:2160,bitRate:1000})
  d.transcodeVideo=async(_s,p)=>{calls++;expect(p).toEqual({maxDimension:1920,bitrate:'5M'});return{...source,bytes:new Uint8Array([4,5,6])}}
  expect(await prepareProviderVideo(source,c,d,signal)).toMatchObject({type:'video',source:{type:'base64',media_type:'video/mp4',data:'BAUG',fps:1}})
  expect(calls).toBe(1);d.transcodeVideo=async()=>null
  await expect(prepareProviderVideo(source,c,d,signal)).rejects.toMatchObject({reason:'conversion'})
 })
 it('MiniMax1800秒可用、超过拒绝，超过4MiB调用正式注入上传端口且不转码',async()=>{
  const c={...config,provider:'minimax',model:'MiniMax-M3',api_format:'anthropic'},d=deps(1800)
  expect((await prepareProviderVideo(source,c,d,signal)).type).toBe('video')
  await expect(prepareProviderVideo(source,c,deps(1800.1),signal)).rejects.toMatchObject({reason:'duration_limit'})
  d.transcodeVideo=async()=>{throw Error('M3不转码')};let uploads=0
  d.uploadVideo=async(s,selected)=>{uploads++;expect(s.size).toBe(4*1024*1024+1);expect(selected.api_format).toBe('anthropic');return'synthetic-id'}
  expect(await prepareProviderVideo({...source,bytes:undefined,size:4*1024*1024+1,stream:async function*(){throw Error('由上传端口消费，不重复聚合')}},c,d,signal)).toMatchObject({type:'video',source:{type:'url',url:'mm_file://synthetic-id',fps:1}})
  expect(uploads).toBe(1)
 })
 it('声明大小与真实源不一致拒绝，取消不回显取消原因',async()=>{
  await expect(prepareProviderVideo({...source,size:2},config,deps(),signal)).rejects.toMatchObject({code:'input_rejected'})
  await expect(prepareProviderVideo(source,config,deps(),AbortSignal.abort('synthetic-secret'))).rejects.toMatchObject({code:'cancelled'})
 })
})
