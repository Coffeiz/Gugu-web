import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {assertRunCapabilities,stableJson,type CanonicalRunContext,type RunCheckpoint,type RunIdentity} from '@gugu/core/agent'
import {ProviderError,type ProviderRuntime} from '@gugu/core/providers'
import {withPostgresTransaction} from '../../../../adapters/database/postgres-transaction.js'
import {commitStagedResponsesReasoning,stageLoadedResponsesReasoning,commitStagedAnthropicReasoning,stageLoadedAnthropicReasoning,validatePrivateContinuation,type ProviderReasoningBinding} from './bridge.js'
import {invalidateReasoningState,loadReasoningState} from './state.js'

export class AgentReasoningUnavailableError extends Error{constructor(){super('私有推理状态暂不可恢复');this.name='AgentReasoningUnavailableError'}}
const invalid=()=>new AgentReasoningUnavailableError()
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
interface Packet{v:1;reference:string;modelIdentity:string;accessScopeHash:string;round:number;areaDigest:string;baseVersion:number;reasoningConfigDigest:string;value:unknown}
interface Row{checkpoint_version:string|number;ref_hash:string;context_hash:string;nonce:Buffer;payload:Buffer;fresh:boolean}
type Provider=Pick<ProviderRuntime,'stageContinuation'|'withStagedContinuation'|'restoreContinuation'>

/** 成功跨Run状态与活动精确引用分开保存；不能拿上一成功Run补当前丢失ref。 */
export function createProviderReasoningPersistence(options:{pool:Pick<Pool,'query'|'connect'>;secretKey:string;provider:Provider;
 binding:ProviderReasoningBinding;mode:'off'|'continuation';authorize(signal?:AbortSignal):Promise<boolean>}){
 const binding=structuredClone(options.binding),identity:RunIdentity={ownerId:binding.identity.ownerId,sessionId:binding.identity.sessionId,runId:binding.runId}
 if(!options.secretKey||!['off','continuation'].includes(options.mode)||typeof options.authorize!=='function'
  ||!Number.isSafeInteger(binding.expectedVersion)||binding.expectedVersion<0)throw invalid()
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(options.secretKey),Buffer.alloc(0),Buffer.from('gugu-active-reasoning-v1'),32))
 const mac=(value:unknown)=>createHmac('sha256',key).update(stableJson(value)).digest('hex')
 const aad=()=>Buffer.from(stableJson([1,identity.ownerId,identity.sessionId,identity.runId]))
 const crossRun=binding.identity.apiFormat==='responses'||binding.identity.apiFormat==='anthropic'
 let baseVersion=binding.expectedVersion
 function effective(context:CanonicalRunContext):ProviderReasoningBinding{
  if(context.capabilities)assertRunCapabilities(context.capabilities)
  const tools=[...(context.capabilities?.tools??[])].map(tool=>({name:tool.name,schema:tool.schema})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
  const reasoningConfigDigest=createHash('sha256').update(stableJson([binding.identity.reasoningConfigDigest,tools])).digest('hex')
  return{...binding,identity:{...binding.identity,reasoningConfigDigest}}
 }
 function validate(context:CanonicalRunContext){
  if(context.identity.ownerId!==identity.ownerId||context.identity.sessionId!==identity.sessionId||context.identity.runId!==identity.runId
   ||context.modelIdentity!==binding.modelIdentity||context.accessScopeHash!==binding.accessScopeHash)throw invalid()
 }
 function validatePacket(packet:unknown,context:CanonicalRunContext):Packet{
  if(!object(packet)||packet.v!==1||packet.reference!==context.continuationRef||packet.modelIdentity!==context.modelIdentity||packet.accessScopeHash!==context.accessScopeHash
   ||packet.reasoningConfigDigest!==effective(context).identity.reasoningConfigDigest
   ||!Number.isSafeInteger(packet.round)||Number(packet.round)<0||!Number.isSafeInteger(packet.baseVersion)||Number(packet.baseVersion)<0
   ||typeof packet.areaDigest!=='string'||!packet.areaDigest)throw invalid()
  validatePrivateContinuation(packet.value,effective(context))
  return packet as unknown as Packet
 }
 function open(row:Row,context:CanonicalRunContext):Packet{
  try{
   if(!row.fresh||!row.nonce||row.nonce.length!==12||!row.payload||row.payload.length<16||row.payload.length>16*1024*1024+16||row.ref_hash!==mac(context.continuationRef))throw invalid()
   const decipher=createDecipheriv('aes-256-gcm',key,row.nonce);decipher.setAAD(aad());decipher.setAuthTag(row.payload.subarray(-16))
   return validatePacket(JSON.parse(Buffer.concat([decipher.update(row.payload.subarray(0,-16)),decipher.final()]).toString('utf8')),context)
  }catch{throw invalid()}
 }
 function seal(packet:Packet){
  const value=Buffer.from(stableJson(packet));if(value.length>16*1024*1024)throw invalid()
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad())
  return{nonce,payload:Buffer.concat([cipher.update(value),cipher.final(),cipher.getAuthTag()])}
 }
 async function authorized(signal?:AbortSignal){signal?.throwIfAborted();if(!await options.authorize(signal))throw invalid();signal?.throwIfAborted()}
 return{
  async initialize(context:CanonicalRunContext,signal:AbortSignal,areaDigest:string):Promise<string|null>{
   try{
    validate(context);await authorized(signal)
    if(!['responses','anthropic','openai','ollama'].includes(binding.identity.apiFormat))throw invalid()
    const result=await withPostgresTransaction(options.pool,async client=>{
     await client.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE',[identity.ownerId,identity.sessionId])
     const prior=(await client.query<{version:number}>('SELECT version FROM provider_reasoning_states WHERE user_id=$1 AND session_id=$2 FOR UPDATE',[identity.ownerId,identity.sessionId])).rows[0]
     const frozen={...effective(context),expectedVersion:prior?.version??0}
     if(options.mode==='off'){
      const loaded=await loadReasoningState(client,frozen.identity,'off',()=>options.secretKey)
      return{continuationRef:null,version:loaded.version}
     }
     if(!crossRun)return{continuationRef:null,version:frozen.expectedVersion}
     return (binding.identity.apiFormat==='anthropic'?stageLoadedAnthropicReasoning:stageLoadedResponsesReasoning)(client,options.provider,identity,frozen,areaDigest,()=>options.secretKey)
    })
    baseVersion=result.version;await authorized(signal);return result.continuationRef
   }catch{throw invalid()}
  },
  /** RunStore当前CAS事务专用；TTL过期只续存精确previous行，不借连接或请求模型。 */
  async checkpointHook(client:PoolClient,run:RunIdentity,next:RunCheckpoint<CanonicalRunContext>,previous:RunCheckpoint<CanonicalRunContext>|null):Promise<void>{
   try{
    if(run.ownerId!==identity.ownerId||run.sessionId!==identity.sessionId||run.runId!==identity.runId)throw invalid()
    const context=next.context
    if(context===null||!context.continuationRef){
     if(previous?.context?.continuationRef)await client.query('DELETE FROM gugu_agent_active_reasoning WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])
     return
    }
    validate(context);if(binding.identity.apiFormat==='responses'&&options.mode!=='continuation')throw invalid()
    if(previous?.context?.continuationRef===context.continuationRef&&effective(previous.context).identity.reasoningConfigDigest!==effective(context).identity.reasoningConfigDigest)throw invalid()
    let packet:Packet
    try{packet=await options.provider.withStagedContinuation(context,async staged=>validatePacket({v:1,reference:context.continuationRef,
      modelIdentity:context.modelIdentity,accessScopeHash:context.accessScopeHash,round:staged.round,areaDigest:staged.areaDigest,baseVersion,
      reasoningConfigDigest:effective(context).identity.reasoningConfigDigest,value:staged.value},context))}
    catch(error){
     if(!(error instanceof ProviderError)||error.code!=='input_rejected')throw error
     if(!previous?.context||previous.context.continuationRef!==context.continuationRef||previous.context.modelIdentity!==context.modelIdentity||previous.context.accessScopeHash!==context.accessScopeHash)throw invalid()
     const row=(await client.query<Row>(`SELECT *,expires_at>clock_timestamp() AS fresh FROM gugu_agent_active_reasoning
       WHERE user_id=$1 AND session_id=$2 AND run_id=$3 FOR UPDATE`,[identity.ownerId,identity.sessionId,identity.runId])).rows[0]
     if(!row||Number(row.checkpoint_version)!==previous.version||row.context_hash!==mac(previous.context))throw invalid()
     packet=open(row,previous.context);options.provider.restoreContinuation({identity,...packet});baseVersion=packet.baseVersion
    }
    if(packet.round>next.round)throw invalid()
    if(['completed','cancelled','failed'].includes(next.status)){
     await client.query('DELETE FROM gugu_agent_active_reasoning WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])
     return
    }
    const encrypted=seal(packet)
    await client.query(`INSERT INTO gugu_agent_active_reasoning(user_id,session_id,run_id,checkpoint_version,ref_hash,context_hash,nonce,payload,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '24 hours')
      ON CONFLICT(user_id,session_id,run_id) DO UPDATE SET checkpoint_version=EXCLUDED.checkpoint_version,ref_hash=EXCLUDED.ref_hash,
        context_hash=EXCLUDED.context_hash,nonce=EXCLUDED.nonce,payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`,
     [identity.ownerId,identity.sessionId,identity.runId,next.version,mac(context.continuationRef),mac(context),encrypted.nonce,encrypted.payload])
   }catch{throw invalid()}
  },
  async ensure(context:CanonicalRunContext,signal:AbortSignal):Promise<void>{
   try{
    validate(context);await authorized(signal);if(!context.continuationRef)return
    if(binding.identity.apiFormat==='responses'&&options.mode!=='continuation')throw invalid()
    const rows=(await options.pool.query<Row>(`SELECT a.*,a.expires_at>clock_timestamp() AS fresh FROM gugu_agent_active_reasoning a
      JOIN agent_run_checkpoints c ON c.user_id=a.user_id AND c.session_id=a.session_id AND c.run_id=a.run_id AND c.version=a.checkpoint_version
      WHERE a.user_id=$1 AND a.session_id=$2 AND a.run_id=$3`,[identity.ownerId,identity.sessionId,identity.runId])).rows
    if(rows.length!==1||rows[0]!.context_hash!==mac(context))throw invalid()
    const packet=open(rows[0]!,context);await authorized(signal);options.provider.restoreContinuation({identity,...packet});baseVersion=packet.baseVersion
   }catch{throw invalid()}
  },
  async invalidate(context:CanonicalRunContext,signal:AbortSignal):Promise<void>{
   try{
    validate(context);await authorized(signal)
    if(!crossRun)return
    await withPostgresTransaction(options.pool,async client=>{
     await invalidateReasoningState(client,effective(context).identity,baseVersion,binding.identity.apiFormat==='responses'?'responses_incompatible':'provider_rejected')
     // 活动行供随后失败checkpoint按previous精确续存；只能由终态同事务hook清理。
    })
    await authorized(signal)
   }catch{throw invalid()}
  },
  /** 仅成功history事务调用；round0不是本Run新推理，不重新发布。 */
  async commitSuccess(client:PoolClient,context:CanonicalRunContext):Promise<void>{
   try{
    validate(context);if(!context.continuationRef)return
    if(binding.identity.apiFormat==='responses'&&options.mode!=='continuation')throw invalid()
    if(options.mode!=='continuation'||!crossRun)return
    const staged=await options.provider.withStagedContinuation(context,async value=>value)
    if(staged.round===0)return
    await (binding.identity.apiFormat==='anthropic'?commitStagedAnthropicReasoning:commitStagedResponsesReasoning)(client,options.provider,context,{...effective(context),expectedVersion:baseVersion},options.secretKey,1)
   }catch{throw invalid()}
  },
 }
}
