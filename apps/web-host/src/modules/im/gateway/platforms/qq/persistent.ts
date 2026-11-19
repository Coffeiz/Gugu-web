import {createHash} from 'node:crypto'
import {z} from 'zod'
import {stableJson,type RunIdentity,type RunEvent} from '@gugu/core/agent'
import type {ImRunDeliveryPorts,ImDeliveryAcknowledgement} from '@gugu/core/im/run-delivery'
import type {ImDeliverySession} from '../../delivery/store.js'
import {imAcceptedEvidence,type ImAcceptedSource} from '../../agent/evidence.js'
import type {ImAttachmentScope} from '../../inbound/attachments.js'
import {parseQqStreamSnapshot,type createQqSender,type QqTarget,type QqReceipt} from './sender.js'
import {createFeishuRunEventProjector,type FeishuChartRenderer} from '../feishu/run-events.js'

const hash=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex')
const segment=z.object({round:z.number().int().nonnegative().safe(),text:z.string(),source:z.string(),boundary:z.string().max(64),ids:z.array(z.string().min(1).max(256)).min(1)}).strict()
const schema=z.object({v:z.literal(1),target:z.string().regex(/^[a-f0-9]{64}$/),eventSequence:z.number().int().nonnegative().safe(),lastEventHash:z.string(),
 segment:z.number().int().nonnegative().safe(),round:z.number().int().nonnegative().safe(),stage:z.enum(['open','paused','finished']),
 mode:z.enum(['stream','plain']),plainBuffer:z.string(),current:z.unknown().nullable(),pendingRoundText:z.string().nullable(),visible:z.array(segment).max(1000),lastFlushAt:z.number().finite().nonnegative(),
 parser:z.unknown(),line:z.string(),chartSource:z.string(),rawRound:z.string(),charts:z.array(z.object({round:z.number().int().nonnegative().safe(),source:z.string()}).strict()).max(1000),
 inflight:z.object({sequence:z.number().int().positive().safe(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable()}).strict()
type State=z.infer<typeof schema>
class Blocked extends Error{constructor(readonly outcome:'unknown'|'rejected'){super('QQ 流式投递未完成')}}

/** 禁自主timer：只有正式有序Run事件可发帧，所有原生回执与状态共用既有加密投递事务。 */
export function createPersistentQqProjection(options:{
 identity:RunIdentity;target:QqTarget;policyVersion:string;receipts:ImDeliverySession;sender:Pick<ReturnType<typeof createQqSender>,'privateStream'|'text'|'prepareText'>
 authorize():Promise<boolean>;acceptedEvidence?:{scope:ImAttachmentScope;recipient:string;source():Promise<ImAcceptedSource>};now?():number
 /** 整次上传+发送共用一个持久op；父Host必须在每次HTTP复核当前授权。 */
 sendChart?(png:Uint8Array):Promise<QqReceipt>
 renderCharts?:FeishuChartRenderer
}):NonNullable<ImRunDeliveryPorts<unknown>['stream']>{
 const identity=Object.freeze({...options.identity}),target=structuredClone(options.target),store=options.receipts.projection
 if(!store||target.chatType!=='c2c'||target.messageFormat!=='markdown'||!target.id||!options.policyVersion)throw new Error('QQ 持久流式投影未配置')
 if(options.acceptedEvidence&&(options.acceptedEvidence.scope.platform!=='qq'||options.acceptedEvidence.scope.ownerId!==identity.ownerId
  ||options.acceptedEvidence.scope.chatType!=='c2c'||options.acceptedEvidence.scope.chatId!==null||options.acceptedEvidence.scope.platformUserId!==target.id||options.acceptedEvidence.recipient!==target.id))throw new Error('QQ 持久流式证据无效')
 const targetHash=hash([target,options.policyVersion,options.acceptedEvidence?.scope??null,!!options.sendChart]),now=options.now??Date.now
 let tail:Promise<unknown>=Promise.resolve()
 async function project(input:Parameters<NonNullable<ImRunDeliveryPorts<unknown>['stream']>['project']>[0]):Promise<ImDeliveryAcknowledgement>{
  if(stableJson(input.identity)!==stableJson(identity)||stableJson(input.event.identity)!==stableJson(identity)||!input.deliveryId)throw new Error('QQ 流式投递身份无效')
  const event=input.event
  if(!Number.isSafeInteger(event.sequence)||event.sequence<1||!Number.isSafeInteger(event.round)||event.round<0)throw new Error('QQ 流式事件顺序无效')
  const read=await store!.read();let version=read.version
  let state:State=read.state===null?{v:1,target:targetHash,eventSequence:0,lastEventHash:'',segment:0,round:event.round,stage:'open',mode:'stream',plainBuffer:'',current:null,pendingRoundText:null,visible:[],lastFlushAt:0,inflight:null,
   parser:createFeishuRunEventProjector().snapshot(),line:'',chartSource:'',rawRound:'',charts:[]}:schema.parse(read.state)
  if(state.target!==targetHash)throw new Error('QQ 流式恢复策略不匹配')
  if(state.current!==null)parseQqStreamSnapshot(state.current)
  let parser=createFeishuRunEventProjector({checkpoint:state.parser,...(options.renderCharts?{renderCharts:options.renderCharts}:{})})
  const resetParser=()=>{parser=createFeishuRunEventProjector(options.renderCharts?{renderCharts:options.renderCharts}:{});state.parser=parser.snapshot()}
  const snapshot=()=>{const value=schema.parse(state);if(Buffer.byteLength(JSON.stringify(value))>1048576)throw new Error('QQ 流式投影状态超限');return value}
  const acknowledged=async():Promise<ImDeliveryAcknowledgement>=>{
   if(event.type!=='final'||event.payload.status!=='completed'||!options.acceptedEvidence)return 'accepted'
   const visible=state.visible.filter(part=>part.round===event.round)
   if(!visible.length)return 'accepted'
   if(!await options.authorize())return 'rejected'
   return imAcceptedEvidence({scope:options.acceptedEvidence.scope,recipient:options.acceptedEvidence.recipient,source:await options.acceptedEvidence.source(),kind:'text',
    receipt:{outcome:'accepted',platformMessageIds:visible.flatMap(part=>part.ids)},text:visible.map(part=>part.text).join('\n\n')})
  }
  if(state.inflight)return 'unknown'
  if(event.sequence<state.eventSequence)return 'accepted'
  if(event.sequence===state.eventSequence)return state.lastEventHash===hash(event)?acknowledged():'unknown'
  if(!await options.authorize())return 'rejected'
  if(state.stage==='finished')return 'rejected'
  if(event.type==='run_resumed'){if(state.stage!=='paused')return 'rejected';state.stage='open'}
  else if(state.stage==='paused'&&!['interaction_resolved','interaction_required','tool_done','final'].includes(event.type))return 'rejected'
  state.inflight={sequence:event.sequence,fingerprint:hash(event)}
  version=await store!.checkpoint(version,snapshot())
  let operation=0
  let stream:ReturnType<ReturnType<typeof createQqSender>['privateStream']>|undefined
  const open=()=>stream??=options.sender.privateStream(target,undefined,{automaticFlush:false,authorize:options.authorize,...(state.current===null?{}:{snapshot:state.current}),
   async checkpoint(value){state.current=value;version=await store!.checkpoint(version,snapshot())}})
  async function send(final:boolean,text?:string){
   const value=open();let key=`qq:${state.segment}:${event.sequence}:${++operation}:${final?'done':'frame'}`
   const fingerprint=hash([targetHash,state.segment,event.sequence,final,text??null,value.snapshot()])
   if(!await options.authorize())throw new Blocked('rejected')
   if(await options.receipts.begin(identity,key,fingerprint)!=='new')throw new Blocked('unknown')
   if(!await options.authorize()){await options.receipts.settle(identity,key,'rejected');throw new Blocked('rejected')}
   const receipt=final?await value.finish(text,{allowRewrite:true}):await value.flush()
   state.current=value.snapshot()
   if(receipt.outcome==='rejected'&&receipt.definitelyUnsent&&value.snapshot().streamId===null&&value.snapshot().index===0&&await options.authorize()){
    await options.receipts.settle(identity,key,'rejected')
    state.mode='plain';state.plainBuffer=value.snapshot().fullText;state.current=null;stream=undefined;state.segment++
    version=await store!.checkpoint(version,snapshot())
    if(final)await sendPlain(text??state.plainBuffer)
    return
   }
   if(receipt.outcome!=='accepted'||final&&!receipt.closed){await options.receipts.settle(identity,key,receipt.outcome==='rejected'?'rejected':'unknown');throw new Blocked(receipt.outcome==='rejected'?'rejected':'unknown')}
   state.lastFlushAt=now()
   if(final){const finished=value.snapshot();state.visible.push({round:state.round,text:finished.lastSentContent,source:finished.fullText,boundary:event.type,ids:[...receipt.platformMessageIds]});state.current=null;state.segment++;stream=undefined}
   version=await store!.accepted(key,version,snapshot())
  }
  async function sendPlain(text:string){
   if(!text.trim())return
   if(!await options.authorize())throw new Blocked('rejected')
   const key=`qq:${state.segment}:${event.sequence}:${++operation}:plain`,fingerprint=hash([targetHash,text])
   if(await options.receipts.begin(identity,key,fingerprint)!=='new')throw new Blocked('unknown')
   if(!await options.authorize()){await options.receipts.settle(identity,key,'rejected');throw new Blocked('rejected')}
   const receipt=await options.sender.text({...target,messageId:undefined},text,undefined,options.authorize)
   if(receipt.outcome!=='accepted'||!receipt.platformMessageIds.length){await options.receipts.settle(identity,key,receipt.outcome==='rejected'?'rejected':'unknown');throw new Blocked(receipt.outcome==='rejected'?'rejected':'unknown')}
   state.visible.push({round:state.round,text:options.sender.prepareText(text),source:text,boundary:event.type,ids:[...receipt.platformMessageIds]});state.plainBuffer='';state.segment++
   version=await store!.accepted(key,version,snapshot())
  }
  async function close(text?:string){
   if(text!==undefined){
    const fullRaw=!!state.rawRound&&(text.trimEnd()===state.rawRound.trimEnd()||text.startsWith(state.rawRound))
    for(const chart of state.charts.filter(value=>value.round===state.round)){
     const at=text.indexOf(chart.source)
     if(at>=0){let end=at+chart.source.length;if(text.slice(end,end+2)==='\r\n')end+=2;else if(text[end]==='\n')end++;text=text.slice(0,at)+text.slice(end)}
    }
    if(fullRaw)for(const part of state.visible.filter(value=>value.round===state.round&&value.boundary!=='chart')){if(text.startsWith(part.source))text=text.slice(part.source.length);else break}
   }
   const has=text?.trim()||state.plainBuffer.trim()||state.current!==null&&parseQqStreamSnapshot(state.current).fullText.trim()
   if(!has)return
   if(state.current===null&&!state.plainBuffer&&text){const last=state.visible.at(-1);if(last?.round===event.round&&last.source.trimEnd()===text.trimEnd())return}
   if(state.mode==='plain'){await sendPlain(text||state.plainBuffer);return}
   if(state.current===null&&text){const last=state.visible.at(-1);if(last?.round===event.round){if(last.source.trimEnd()===text.trimEnd())return;if(event.type==='final'&&last.boundary==='round_end')throw new Blocked('unknown')}open().push(text);state.current=open().snapshot()}
   await send(true,text)
  }
  const append=(text:string)=>{if(text){if(state.mode==='plain')state.plainBuffer+=text;else{open().push(text);state.current=open().snapshot()}}}
  async function chart(png:Uint8Array,source:string){
   await close()
   if(!await options.authorize())throw new Blocked('rejected')
   const key=`qq:${state.segment}:${event.sequence}:${++operation}:chart`,fingerprint=hash([targetHash,source,createHash('sha256').update(png).digest('hex')])
   if(await options.receipts.begin(identity,key,fingerprint)!=='new')throw new Blocked('unknown')
   if(!await options.authorize()){await options.receipts.settle(identity,key,'rejected');throw new Blocked('rejected')}
   let receipt:QqReceipt
   try{receipt=await options.sendChart!(png)}catch{receipt={outcome:'unknown',platformMessageIds:[]}}
   if(receipt.outcome==='accepted'&&(!receipt.platformMessageIds.length||receipt.platformMessageIds.some(id=>typeof id!=='string'||!id)))receipt={outcome:'unknown',platformMessageIds:[]}
   if(receipt.outcome==='unknown'){await options.receipts.settle(identity,key,'unknown');throw new Blocked('unknown')}
   if(receipt.outcome==='rejected'){await options.receipts.settle(identity,key,'rejected');append(source);return}
   state.visible.push({round:state.round,text:'',source,boundary:'chart',ids:[...receipt.platformMessageIds]});state.charts.push({round:state.round,source:source.replace(/\r?\n$/,'')});state.segment++;state.current=null;stream=undefined
   version=await store!.accepted(key,version,snapshot())
  }
  async function line(text:string,final=false){
   const before=parser.snapshot() as {chart:unknown}
   const events=await parser.push({...event,type:'token',payload:{text}})
   if(final)events.push(...await parser.push({...event,type:'final',payload:{text:''}}))
   const after=parser.snapshot() as {chart:unknown}
   state.parser=parser.snapshot()
   if(before.chart!==null||after.chart!==null||state.chartSource){
    state.chartSource+=text
    const rendered=events.find(item=>item.type==='chart_image')
    if(after.chart===null){const source=state.chartSource;state.chartSource=''
     if(rendered?.type==='chart_image'&&options.sendChart)await chart(rendered.png,source)
     else append(source)
    }
   }else append(text)
  }
  async function tokens(text:string){
   if(!options.sendChart){append(text);return}
   state.rawRound+=text;state.line+=text
   let newline:number
   while((newline=state.line.indexOf('\n'))>=0){const value=state.line.slice(0,newline+1);state.line=state.line.slice(newline+1);await line(value)}
  }
  async function finishSource(){
   if(!options.sendChart)return
   if(state.line){const text=state.line;state.line='';await line(text,true)}
   if(state.chartSource){append(state.chartSource);state.chartSource='';resetParser()}
  }
  try{
   if(event.type==='token'&&typeof event.payload.text==='string'){
    if(state.pendingRoundText!==null){await finishSource();await close(state.pendingRoundText);state.pendingRoundText=null;state.rawRound='';resetParser()}
    if(state.round!==event.round){await finishSource();await close();state.round=event.round;state.rawRound='';resetParser()}
    await tokens(event.payload.text)
    if(state.current!==null&&now()-state.lastFlushAt>=500)await send(false)
   }else if(event.type==='round_end'){if(state.round!==event.round){await close();state.round=event.round}state.pendingRoundText=typeof event.payload.text==='string'?event.payload.text:state.mode==='plain'?state.plainBuffer:state.current===null?'':parseQqStreamSnapshot(state.current).fullText}
   else if(event.type==='tool_call'||event.type==='interaction_required'){
    await finishSource();await close(state.pendingRoundText??undefined);state.pendingRoundText=null;if(event.type==='interaction_required')state.stage='paused'
   }else if(event.type==='final'){
    if(state.round!==event.round){await finishSource();await close();state.round=event.round;state.rawRound=''}
    if(options.sendChart&&event.payload.status==='completed'&&typeof event.payload.text==='string'){
     if(!state.rawRound)await tokens(event.payload.text)
     else if(event.payload.text.startsWith(state.rawRound))await tokens(event.payload.text.slice(state.rawRound.length))
    }
    await finishSource()
    if(event.payload.status==='completed')await close(typeof event.payload.text==='string'&&event.payload.text?event.payload.text:state.pendingRoundText??undefined)
    else {await close();if(['failed','unknown'].includes(String(event.payload.status))&&typeof event.payload.text==='string'&&event.payload.text.trim())await close(event.payload.text)}
    state.pendingRoundText=null
    state.stage='finished'
   }
   state.eventSequence=event.sequence;state.lastEventHash=hash(event);state.inflight=null
   version=await store!.checkpoint(version,snapshot())
   return acknowledged()
  }catch(error){if(error instanceof Blocked)return error.outcome;throw error}
 }
 return{project(input){const result=tail.then(()=>project(input));tail=result.catch(()=>undefined);return result}}
}
