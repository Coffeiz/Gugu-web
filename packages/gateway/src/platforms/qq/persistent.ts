import {createHash} from 'node:crypto'
import {z} from 'zod'
import {stableJson,type RunIdentity,type RunEvent} from '@gugu/core/agent'
import type {ImRunDeliveryPorts,ImDeliveryAcknowledgement} from '@gugu/core/im/run-delivery'
import {parseQqStreamSnapshot,qqStreamPrefix,type createQqSender,type QqTarget,type QqReceipt} from './sender.js'
import type { ImConversationScope } from '../../ir/inbound.js'

import type { ImPlatformProjectionStore } from '../../runtime/projection-store.js'

export interface QqChartProjection {
  prepare(events: AsyncIterable<RunEvent>): AsyncIterable<RunEvent>
  close(): Promise<void>
  parser(checkpoint?: unknown): {
    snapshot(): unknown
    push(event: RunEvent): Promise<readonly ({ type: 'chart_image'; png: Uint8Array } | { type: 'other' })[]>
  }
  send(png: Uint8Array): Promise<QqReceipt>
}

export interface QqProjectionOptions {
  identity: RunIdentity
  target: QqTarget
  legacyMessageId?: string
  policyVersion: string
  receipts: Pick<ImRunDeliveryPorts<unknown>['receipts'], 'begin' | 'settle'> & { projection?: ImPlatformProjectionStore }
  sender: Pick<ReturnType<typeof createQqSender>, 'privateStream' | 'text' | 'prepareText'>
  authorize(): Promise<boolean>
  acceptedEvidence?: {
    scope: ImConversationScope
    recipient: string
    accept(input: { platformMessageIds: string[]; text: string }): Promise<ImDeliveryAcknowledgement>
  }
  observeAcceptedText?(value: { platformMessageIds: readonly string[]; text: string }): Promise<void>
  now?(): number
  charts?: QqChartProjection
}

const hash=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex')
const segment=z.object({round:z.number().int().nonnegative().safe(),text:z.string(),source:z.string(),boundary:z.string().max(64),ids:z.array(z.string().min(1).max(256)).min(1)}).strict()
const schema=z.object({v:z.literal(1),target:z.string().regex(/^[a-f0-9]{64}$/),eventSequence:z.number().int().nonnegative().safe(),lastEventHash:z.string(),
 segment:z.number().int().nonnegative().safe(),round:z.number().int().nonnegative().safe(),stage:z.enum(['open','paused','finished']),
 mode:z.enum(['stream','plain']),plainBuffer:z.string(),current:z.unknown().nullable(),pendingRoundText:z.string().nullable(),visible:z.array(segment).max(1000),lastFlushAt:z.number().finite().nonnegative(),
 parser:z.unknown(),line:z.string(),lineEmitted:z.number().int().nonnegative().optional(),chartSource:z.string(),rawRound:z.string(),charts:z.array(z.object({round:z.number().int().nonnegative().safe(),source:z.string()}).strict()).max(1000),
 inflight:z.object({sequence:z.number().int().positive().safe(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable()}).strict()
type State=z.infer<typeof schema>
class Blocked extends Error{constructor(readonly outcome:'unknown'|'rejected'){super('QQ 流式投递未完成')}}

/** QQ 刷新与 Run 事件共用串行投递队列和持久回执。 */
export function createPersistentQqProjection(options:QqProjectionOptions):NonNullable<ImRunDeliveryPorts<unknown>['stream']> & {prepare?(events:AsyncIterable<RunEvent>):AsyncIterable<RunEvent>;close?():Promise<void>}{
 const identity=Object.freeze({...options.identity}),currentTarget=structuredClone(options.target),store=options.receipts.projection
 if(!store||currentTarget.chatType!=='c2c'||currentTarget.messageFormat!=='markdown'||!currentTarget.id||!options.policyVersion)throw new Error('QQ 持久流式投影未配置')
 if(options.acceptedEvidence&&(options.acceptedEvidence.scope.platform!=='qq'||options.acceptedEvidence.scope.ownerId!==identity.ownerId
  ||options.acceptedEvidence.scope.chatType!=='c2c'||options.acceptedEvidence.scope.chatId!==null||options.acceptedEvidence.scope.platformUserId!==currentTarget.id||options.acceptedEvidence.recipient!==currentTarget.id))throw new Error('QQ 持久流式证据无效')
 const targetDigest=(target:QqTarget)=>hash([target,options.policyVersion,options.acceptedEvidence?.scope??null,!!options.charts])
 const legacyTarget=options.legacyMessageId?{...currentTarget,messageId:options.legacyMessageId}:null
 const currentHash=targetDigest(currentTarget),legacyHash=legacyTarget&&targetDigest(legacyTarget),now=options.now??Date.now
 const preparation=options.charts
 let tail:Promise<unknown>=Promise.resolve()
 type Input=Parameters<NonNullable<ImRunDeliveryPorts<unknown>['stream']>['project']>[0]
 let timer:ReturnType<typeof setTimeout>|undefined
 let stopped=false
 let flushOutcome:ImDeliveryAcknowledgement='accepted'
 function enqueue(work:()=>Promise<ImDeliveryAcknowledgement>){
  const result=tail.then(work)
  tail=result.catch(()=>undefined)
  return result
 }
 function scheduleFlush(input:Input,wait:number){
  timer=setTimeout(()=>{
   timer=undefined
   void enqueue(async()=>{
    if(stopped||flushOutcome!=='accepted')return flushOutcome
    try{flushOutcome=await project(input,true)}catch{flushOutcome='unknown'}
    return flushOutcome
   })
  },wait)
  timer.unref()
 }
 async function project(input:Input,timed=false):Promise<ImDeliveryAcknowledgement>{
  if(stableJson(input.identity)!==stableJson(identity)||stableJson(input.event.identity)!==stableJson(identity)||!input.deliveryId)throw new Error('QQ 流式投递身份无效')
  const event=input.event
  if(!Number.isSafeInteger(event.sequence)||event.sequence<1||!Number.isSafeInteger(event.round)||event.round<0)throw new Error('QQ 流式事件顺序无效')
  const read=await store!.read();let version=read.version
  let state:State=read.state===null?{v:1,target:currentHash,eventSequence:0,lastEventHash:'',segment:0,round:event.round,stage:'open',mode:'stream',plainBuffer:'',current:null,pendingRoundText:null,visible:[],lastFlushAt:0,inflight:null,
   parser:preparation?.parser().snapshot() ?? null,line:'',chartSource:'',rawRound:'',charts:[]}:schema.parse(read.state)
  // 旧投影继续使用原目标，避免把已发送的流切到另一个被动消息 ID。
  const target=legacyTarget&&state.target===legacyHash?legacyTarget:currentTarget
  const targetHash=target===legacyTarget?legacyHash:currentHash
  if(state.target!==targetHash)throw new Error('QQ 流式恢复策略不匹配')
  if(state.current!==null)parseQqStreamSnapshot(state.current)
  let parser=preparation?.parser(state.parser)
  const resetParser=()=>{parser=preparation?.parser();state.parser=parser?.snapshot() ?? null}
  const snapshot=()=>{const value=schema.parse(state);if(Buffer.byteLength(JSON.stringify(value))>1048576)throw new Error('QQ 流式投影状态超限');return value}
  const acknowledged=async():Promise<ImDeliveryAcknowledgement>=>{
   if(event.type!=='final'||event.payload.status!=='completed'||!options.acceptedEvidence&&!options.observeAcceptedText)return 'accepted'
   const visible=state.visible.filter(part=>part.round===event.round)
   if(!visible.length&&!options.observeAcceptedText)return 'accepted'
   if(!await options.authorize())return 'rejected'
   if(options.observeAcceptedText){
    for(const segment of state.visible)if(segment.text.trim()){
     if(!await options.authorize())return 'rejected'
     await options.observeAcceptedText({platformMessageIds:segment.ids,text:segment.text})
    }
   }
   if(!options.acceptedEvidence||!visible.length)return 'accepted'
   return options.acceptedEvidence.accept({platformMessageIds:visible.flatMap(part=>part.ids),text:visible.map(part=>part.text).join('\n\n')})
  }
  if(state.inflight)return 'unknown'
  if(event.sequence<state.eventSequence)return 'accepted'
  if(timed){
   if(event.sequence!==state.eventSequence||state.stage!=='open'||state.current===null)return 'accepted'
   if(state.lastEventHash!==hash(event))return 'unknown'
  }else if(event.sequence===state.eventSequence)return state.lastEventHash===hash(event)?acknowledged():'unknown'
  if(timer){clearTimeout(timer);timer=undefined}
  if(!await options.authorize())return 'rejected'
  if(state.stage==='finished')return 'rejected'
  // 检查点续跑也会发出 run_resumed，已有正文投影应继续使用原段。
  if(event.type==='run_resumed'&&state.stage==='paused')state.stage='open'
  else if(state.stage==='paused'&&!['interaction_resolved','interaction_required','tool_done','final'].includes(event.type))return 'rejected'
  state.inflight={sequence:event.sequence,fingerprint:hash(event)}
  version=await store!.checkpoint(version,snapshot())
  let operation=0
  let stream:ReturnType<ReturnType<typeof createQqSender>['privateStream']>|undefined
  const open=()=>stream??=options.sender.privateStream(target,undefined,{automaticFlush:false,partialText:true,authorize:options.authorize,...(state.current===null?{}:{snapshot:state.current}),
   async checkpoint(value){state.current=value;version=await store!.checkpoint(version,snapshot())}})
  async function send(final:boolean,text?:string){
   const value=open();let key=`qq:${state.segment}:${event.sequence}:${++operation}:${timed?'timed-frame':final?'done':'frame'}`
   const before=value.snapshot()
   const fingerprint=hash([targetHash,state.segment,event.sequence,final,text??null,before])
   if(!await options.authorize())throw new Blocked('rejected')
   if(await options.receipts.begin(identity,key,fingerprint)!=='new')throw new Blocked('unknown')
   if(!await options.authorize()){await options.receipts.settle(identity,key,'rejected');throw new Blocked('rejected')}
   const startedAt=now()
   const receipt=final?await value.finish(text,{allowRewrite:true}):await value.flush()
   const after=value.snapshot()
   state.current=after
   if(receipt.outcome==='rejected'&&receipt.definitelyUnsent&&value.snapshot().streamId===null&&value.snapshot().index===0&&await options.authorize()){
    await options.receipts.settle(identity,key,'rejected')
    state.mode='plain';state.plainBuffer=value.snapshot().fullText;state.current=null;stream=undefined;state.segment++
    version=await store!.checkpoint(version,snapshot())
    if(final)await sendPlain(text??state.plainBuffer)
    return
   }
   if(receipt.outcome!=='accepted'||final&&!receipt.closed){await options.receipts.settle(identity,key,receipt.outcome==='rejected'?'rejected':'unknown');throw new Blocked(receipt.outcome==='rejected'?'rejected':'unknown')}
   if(!final&&after.index>before.index)state.lastFlushAt=startedAt
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
   const fullRaw=text!==undefined&&!!state.rawRound&&(text.trimEnd()===state.rawRound.trimEnd()||text.startsWith(state.rawRound))
   if(text!==undefined){
    for(const chart of state.charts.filter(value=>value.round===state.round)){
     const at=text.indexOf(chart.source)
     if(at>=0){let end=at+chart.source.length;if(text.slice(end,end+2)==='\r\n')end+=2;else if(text[end]==='\n')end++;text=text.slice(0,at)+text.slice(end)}
    }
    if(fullRaw)for(const part of state.visible.filter(value=>value.round===state.round&&value.boundary!=='chart')){if(text.startsWith(part.source))text=text.slice(part.source.length);else break}
   }
   const has=text?.trim()||state.plainBuffer.trim()||state.current!==null&&parseQqStreamSnapshot(state.current).fullText.trim()
   if(!has)return
   if(state.current===null&&!state.plainBuffer&&text){const last=state.visible.at(-1);if(last?.round===event.round&&last.source.trimEnd()===text.trimEnd())return}
   if(state.current===null&&!state.plainBuffer&&text&&event.type==='final'){
    const last=state.visible.at(-1)
    if(last?.round===event.round&&['text_end','round_end'].includes(last.boundary)&&!fullRaw){
     if(!text.startsWith(last.source))throw new Blocked('unknown')
     text=text.slice(last.source.length)
     if(!text.trim())return
    }
   }
   if(state.mode==='plain'){await sendPlain(text||state.plainBuffer);return}
   if(state.current===null&&text){open().push(text);state.current=open().snapshot()}
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
   try{receipt=await preparation!.send(png)}catch{receipt={outcome:'unknown',platformMessageIds:[]}}
   if(receipt.outcome==='accepted'&&(!receipt.platformMessageIds.length||receipt.platformMessageIds.some(id=>typeof id!=='string'||!id)))receipt={outcome:'unknown',platformMessageIds:[]}
   if(receipt.outcome==='unknown'){await options.receipts.settle(identity,key,'unknown');throw new Blocked('unknown')}
   if(receipt.outcome==='rejected'){await options.receipts.settle(identity,key,'rejected');append(source);return}
   state.visible.push({round:state.round,text:'',source,boundary:'chart',ids:[...receipt.platformMessageIds]});state.charts.push({round:state.round,source:source.replace(/\r?\n$/,'')});state.segment++;state.current=null;stream=undefined
   version=await store!.accepted(key,version,snapshot())
  }
  async function line(text:string,final=false){
   const emitted=state.lineEmitted??0
   state.lineEmitted=0
   const before=parser!.snapshot() as {chart:unknown}
   const events=[...await parser!.push({...event,type:'token',payload:{text}})]
   if(final)events.push(...await parser!.push({...event,type:'final',payload:{text:''}}))
   const after=parser!.snapshot() as {chart:unknown}
   state.parser=parser!.snapshot()
   if(before.chart!==null||after.chart!==null||state.chartSource){
    state.chartSource+=text
    const rendered=events.find(item=>item.type==='chart_image')
    if(after.chart===null){const source=state.chartSource;state.chartSource=''
     if(rendered?.type==='chart_image'&&preparation)await chart(rendered.png,source)
     else append(source)
    }
   }else append(text.slice(emitted))
  }
  async function tokens(text:string){
   if(!preparation){append(text);return}
   state.rawRound+=text;state.line+=text
   let newline:number
   while((newline=state.line.indexOf('\n'))>=0){const value=state.line.slice(0,newline+1);state.line=state.line.slice(newline+1);await line(value)}
   if(!state.chartSource&&(parser!.snapshot() as {chart:unknown}).chart===null){
    const prefix=qqStreamPrefix(state.line)
    if(prefix.trim()&&prefix.length>(state.lineEmitted??0)){
     append(prefix.slice(state.lineEmitted??0));state.lineEmitted=prefix.length
    }
   }
  }
  async function finishSource(){
   if(!preparation)return
   if(state.line){const text=state.line;state.line='';await line(text,true)}
   if(state.chartSource){append(state.chartSource);state.chartSource='';resetParser()}
  }
  async function closeText(text?:string){
   await finishSource()
   await close(text??state.pendingRoundText??undefined)
   // 仅旧检查点可能带有尚未发送的轮次正文。
   state.pendingRoundText=null
  }
  function pendingFrame(){
   if(state.current===null)return
   const frame=parseQqStreamSnapshot(state.current),complete=qqStreamPrefix(frame.fullText)
   if(complete.trim()&&complete!==frame.lastSentText)return frame
  }
  try{
   if(timed){
    if(pendingFrame())await send(false)
   }else if(event.type==='token'&&typeof event.payload.text==='string'){
    if(state.pendingRoundText!==null){await closeText();state.rawRound='';resetParser()}
    if(state.round!==event.round){await finishSource();await close();state.round=event.round;state.rawRound='';resetParser()}
    await tokens(event.payload.text)
    const frame=pendingFrame()
    // 每段首帧独立发送。空刷和上一段的 DONE 不占用新段的节流窗口。
    if(frame&&(frame.index===0||now()-state.lastFlushAt>=frame.flushInterval))await send(false)
   }else if(event.type==='text_end'||event.type==='round_end'){
    if(state.round!==event.round){await finishSource();await close();state.round=event.round;state.rawRound=''}
    await closeText(typeof event.payload.text==='string'?event.payload.text:undefined)
   }
   else if(event.type==='tool_call'||(event.type==='compaction'&&event.payload.phase==='started')||event.type==='run_waiting'||event.type==='interaction_required'){
    await closeText();if(event.type==='interaction_required')state.stage='paused'
   }else if(event.type==='final'){
    if(state.round!==event.round){await finishSource();await close();state.round=event.round;state.rawRound=''}
    if(preparation&&event.payload.status==='completed'&&typeof event.payload.text==='string'){
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
   const frame=pendingFrame()
   if(!timed&&!stopped&&state.stage==='open'&&frame)scheduleFlush(input,Math.max(0,frame.flushInterval-(now()-state.lastFlushAt)))
   return acknowledged()
  }catch(error){if(error instanceof Blocked)return error.outcome;throw error}
 }
 return{
  ...(preparation?{prepare:preparation.prepare}:{}),
  project(input){return enqueue(()=>flushOutcome==='accepted'?project(input):Promise.resolve(flushOutcome))},
  async close(){
   stopped=true
   if(timer)clearTimeout(timer)
   const closing=preparation?.close()
   await tail
   await closing
  },
 }
}
