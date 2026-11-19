import { createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes,randomUUID } from 'node:crypto'
import type { Pool,PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import { createImRunScope } from '../agent/scope.js'
import { createImInboundEnvelope } from '../inbound/envelope.js'
import { imAttachmentScopeKey } from '../inbound/attachments.js'
import { assertImQuotedVoiceSource } from '../attention/quote.js'
import type { ImAudioInput } from '../inbound/message.js'
import type { ImVoiceSelection } from './config.js'
import type { ImAttentionVoiceIdentity,ImAttentionVoiceSource,ImAttentionVoiceResult,ImVoiceRunProof } from '../attention/voice.js'

export class ImVoiceCacheError extends Error {
  constructor(readonly code:'unavailable'|'uncertain'|'mismatch'|'unauthorized'='unavailable'){
    super('语音识别收据暂不可用');this.name='ImVoiceCacheError'
  }
}
interface Row {source_key:string;user_id:string;session_id:number;message_id:number;attach_id:string;platform:string;bot_id:string;scope_hash:string;event_hash:string;
  selection_hash:string;input_hash:string;state:string;attempt:string;nonce:Buffer|null;sealed_result:Buffer|null}
const fail=(code:ImVoiceCacheError['code']='unavailable')=>new ImVoiceCacheError(code)
const bounded=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/u.test(v)
const positive=(v:string)=>/^[1-9]\d*$/u.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)<=2147483647
const hex=(v:string)=>/^[a-f0-9]{64}$/u.test(v)

/** 仅保存原消息的ASR收据；requesting跨重启没有可证明的未发送事实，禁止自动重发。 */
export function createImVoiceCache(options:{pool:Pick<Pool,'connect'|'query'>;secretKey:string;
  voice:{select(ownerId:string,signal?:AbortSignal):Promise<ImVoiceSelection>};
  transcribeSelected(source:ImAttentionVoiceSource,selected:ImVoiceSelection,signal:AbortSignal):Promise<string|null>}){
  if(!options.secretKey||typeof options.voice?.select!=='function'||typeof options.transcribeSelected!=='function')throw fail()
  const key=Buffer.from(hkdfSync('sha256',Buffer.from(options.secretKey),Buffer.alloc(0),Buffer.from('gugu-im-voice-cache-v1'),32))
  const hmac=(value:unknown)=>createHmac('sha256',key).update(JSON.stringify(value)).digest('hex')
  const sourceKey=(id:ImAttentionVoiceIdentity)=>hmac([id.ownerId,id.platform,id.botId,id.sessionId,id.messageId,id.attachId,id.scopeHash,id.eventHash])
  const selectionHash=(selected:ImVoiceSelection)=>hmac([selected.ownerId,selected.version])
  const inputHash=(input:ImAudioInput)=>{
    if(!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>64*1024*1024||!bounded(input.attachId)
      ||!bounded(input.mime,120)||!bounded(input.ext,32)||input.duration!==null&&(!Number.isFinite(input.duration)||input.duration<0))throw fail('mismatch')
    return hmac([createHash('sha256').update(input.bytes).digest('hex'),input.mime,input.ext,input.duration])
  }
  function validIdentity(id:ImAttentionVoiceIdentity){
    if(!/^[a-f0-9-]{36}$/u.test(id.ownerId)||!positive(id.sessionId)||!positive(id.messageId)||!positive(id.botId)
      ||!bounded(id.attachId)||!bounded(id.eventId)||!['feishu','qq','telegram','wechat'].includes(id.platform)||!hex(id.scopeHash)||!hex(id.eventHash))throw fail('mismatch')
  }
  const aad=(row:Row)=>Buffer.from(JSON.stringify([1,row.source_key,row.selection_hash,row.input_hash,row.attempt]))
  function seal(row:Row,text:string|null){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(row))
    const encoded=Buffer.from(JSON.stringify({v:1,text}));return{nonce,sealed:Buffer.concat([cipher.update(encoded),cipher.final(),cipher.getAuthTag()])}}
  function open(row:Row):string|null{
    try{if(!row.nonce||row.nonce.length!==12||!row.sealed_result||row.sealed_result.length>1024*1024+128)throw fail()
      const decipher=createDecipheriv('aes-256-gcm',key,row.nonce);decipher.setAAD(aad(row));decipher.setAuthTag(row.sealed_result.subarray(-16))
      const value:unknown=JSON.parse(Buffer.concat([decipher.update(row.sealed_result.subarray(0,-16)),decipher.final()]).toString('utf8'))
      if(!value||typeof value!=='object'||!('v'in value)||value.v!==1||!('text'in value)||value.text!==null&&typeof value.text!=='string')throw fail()
      return value.text as string|null
    }catch{throw fail()}
  }
  function result(row:Row,version:string,digest:string):string|null{
    if(row.selection_hash!==version||row.input_hash!==digest)throw fail('mismatch')
    if(row.state==='requesting'||row.state==='unknown'||row.state==='prepared')throw fail('uncertain')
    if(!['completed','empty','unavailable'].includes(row.state))throw fail()
    const text=open(row)
    if(row.state==='unavailable'){if(text!==null)throw fail();return null}
    if(typeof text!=='string'||(row.state==='empty')!==(text.length===0))throw fail()
    return text
  }
  async function current(source:ImAttentionVoiceSource,selected:ImVoiceSelection,signal:AbortSignal){
    signal.throwIfAborted();await source.assertCurrent(signal)
    if(selected.ownerId!==source.identity.ownerId||!hex(selected.version)||!await selected.authorizeCurrent())throw fail('unauthorized')
    signal.throwIfAborted()
  }
  async function prepareOne(source:ImAttentionVoiceSource,signal:AbortSignal):Promise<ImAttentionVoiceResult>{
    const id={...source.identity};validIdentity(id)
    if(source.input.attachId!==id.attachId)throw fail('mismatch')
    const input={...source.input,bytes:new Uint8Array(source.input.bytes)};source={...source,identity:Object.freeze(id),input:Object.freeze(input)}
    const digest=inputHash(input),selected=await options.voice.select(id.ownerId,signal)
    await current(source,selected,signal)
    const version=selectionHash(selected),sourceId=sourceKey(id),attempt=randomUUID()
    const reserved=await withPostgresTransaction(options.pool,async client=>{
      if(source.mayRequest){await client.query(`INSERT INTO gugu_im_voice_cache
        (source_key,user_id,session_id,message_id,attach_id,platform,bot_id,scope_hash,event_hash,selection_hash,input_hash,state,attempt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared',$12) ON CONFLICT DO NOTHING`,
        [sourceId,id.ownerId,id.sessionId,id.messageId,id.attachId,id.platform,id.botId,id.scopeHash,id.eventHash,version,digest,attempt])}
      const rows=(await client.query<Row>('SELECT * FROM gugu_im_voice_cache WHERE source_key=$1 FOR UPDATE',[sourceId])).rows
      const row=rows[0];if(!row){if(source.mayRequest)throw fail('mismatch');return null}
      if(row.state!=='prepared'||!source.mayRequest)return{row,request:false}
      if(row.input_hash!==digest)throw fail('mismatch')
      const claimed=await client.query("UPDATE gugu_im_voice_cache SET state='requesting',selection_hash=$2,attempt=$3,updated_at=clock_timestamp() WHERE source_key=$1 AND state='prepared'",[sourceId,version,attempt])
      if(claimed.rowCount!==1)throw fail('uncertain')
      return{row:{...row,state:'requesting',selection_hash:version,attempt},request:true}
    })
    if(!reserved)return{eventId:id.eventId,attachId:id.attachId,text:null}
    if(!reserved.request){const text=result(reserved.row,version,digest);await current(source,selected,signal);return{eventId:id.eventId,attachId:id.attachId,text}}
    let text:string|null
    try{await current(source,selected,signal);text=await options.transcribeSelected(source,selected,signal)
      if(text!==null&&(typeof text!=='string'||Buffer.byteLength(text)>1024*1024))throw fail()
      await current(source,selected,signal)
      const encrypted=seal(reserved.row,text)
      await withPostgresTransaction(options.pool,async client=>{
        const written=await client.query(`UPDATE gugu_im_voice_cache SET state=$4,nonce=$5,sealed_result=$6,updated_at=clock_timestamp()
          WHERE source_key=$1 AND attempt=$2 AND state='requesting' AND selection_hash=$3`,[sourceId,attempt,version,text===null?'unavailable':text===''?'empty':'completed',encrypted.nonce,encrypted.sealed])
        if(written.rowCount!==1)throw fail('uncertain')
      })
      await current(source,selected,signal)
    }catch{
      // 标记失败也可能断库；持久requesting同样禁止重发，不用内存成功覆盖未知提交。
      try{await options.pool.query("UPDATE gugu_im_voice_cache SET state='unknown',updated_at=clock_timestamp() WHERE source_key=$1 AND attempt=$2 AND state='requesting'",[sourceId,attempt])}catch{}
      throw fail('uncertain')
    }
    return{eventId:id.eventId,attachId:id.attachId,text}
  }
  const proofReader=(client:Pick<Pool,'query'>,proof:ImVoiceRunProof)=>createImRunScope({...proof,pool:client,secretKey:options.secretKey})
  return{
    async prepare(sources:readonly ImAttentionVoiceSource[],signal=new AbortController().signal):Promise<readonly ImAttentionVoiceResult[]>{
      try{if(!Array.isArray(sources)||sources.length>128)throw fail();const results:ImAttentionVoiceResult[]=[]
        const seen=new Set<string>();for(const source of sources){const id=sourceKey(source.identity);if(seen.has(id))throw fail('mismatch');seen.add(id);results.push(await prepareOne(source,signal))}return results
      }catch(error){if(error instanceof ImVoiceCacheError)throw error;throw fail()}
    },
    /** 调用方必须持有真实enqueue事务；在全部m/r更新为dispatched后、同一commit之前调用。 */
    async bindRunLocked(client:PoolClient,proof:ImVoiceRunProof,signal=new AbortController().signal):Promise<void>{
      try{signal.throwIfAborted();const reader=proofReader(client,proof);await reader.read()
        const rows=(await client.query<Row>(`SELECT c.* FROM gugu_im_voice_cache c
          JOIN gugu_im_inbound_receipts r ON r.user_id=c.user_id AND r.session_id=c.session_id AND r.message_id=c.message_id
            AND r.scope_hash=c.scope_hash AND r.event_hash=c.event_hash AND r.platform=c.platform AND r.bot_id=c.bot_id
          JOIN chat_attachments a ON a.user_id=c.user_id AND a.message_id=c.message_id AND a.attach_id=c.attach_id AND a.state='attached'
          WHERE c.user_id=$1 AND c.session_id=$2 AND c.message_id=ANY($3::integer[]) AND c.platform=$4 AND c.bot_id=$5
            AND r.run_id=$6 AND r.state='dispatched' FOR UPDATE OF c`,
          [proof.identity.ownerId,proof.identity.sessionId,proof.messageIds,proof.scope.platform,proof.scope.botId,proof.identity.runId])).rows
        for(const row of rows){await assertReceiptAttachment(client,proof,row)
          await client.query(`INSERT INTO gugu_im_voice_run_bindings(source_key,user_id,session_id,run_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [row.source_key,proof.identity.ownerId,proof.identity.sessionId,proof.identity.runId])}
        await reader.read();signal.throwIfAborted()
      }catch{throw fail('unauthorized')}
    },
    async readForRun(proof:ImVoiceRunProof,input:ImAudioInput,selected:ImVoiceSelection,signal=new AbortController().signal):Promise<{text:string}|null>{
      try{return await withPostgresTransaction(options.pool,async client=>{
        signal.throwIfAborted();const reader=proofReader(client,proof);await reader.read()
        if(selected.ownerId!==proof.identity.ownerId||!hex(selected.version)||!await selected.authorizeCurrent())throw fail('unauthorized')
        // 全owner/附件查找让已有但尚未绑定、跨Run或错scope的收据明确拒绝，不能回落再次ASR。
        const rows=(await client.query<Row&{bound:boolean}>(`SELECT c.*,EXISTS(SELECT 1 FROM gugu_im_voice_run_bindings b
          WHERE b.source_key=c.source_key AND b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3) AS bound
          FROM gugu_im_voice_cache c WHERE c.user_id=$1 AND c.attach_id=$4 FOR UPDATE OF c`,
          [proof.identity.ownerId,proof.identity.sessionId,proof.identity.runId,input.attachId])).rows
        if(!rows.length){await reader.read();return null}
        if(rows.length!==1)throw fail('mismatch')
        const row=rows[0]!
        if(!row.bound||!proof.messageIds.includes(String(row.message_id))||String(row.session_id)!==proof.identity.sessionId||row.platform!==proof.scope.platform||row.bot_id!==proof.scope.botId)throw fail('unauthorized')
        await assertReceiptAttachment(client,proof,row)
        const text=result(row,selectionHash(selected),inputHash(input));if(text===null)throw fail('unavailable')
        await reader.read();if(!await selected.authorizeCurrent())throw fail('unauthorized');signal.throwIfAborted();return{text}
      })}catch(error){if(error instanceof ImVoiceCacheError)throw error;throw fail()}
    },
  }
  async function assertReceiptAttachment(client:PoolClient,proof:ImVoiceRunProof,row:Row){
    const receipt=(await client.query<Record<string,unknown>&{sealed_payload:Record<string,unknown>;scope_hash:string;event_hash:string}>(`SELECT a.*,r.sealed_payload,r.scope_hash,r.event_hash
      FROM gugu_im_inbound_receipts r JOIN chat_attachments a ON a.user_id=r.user_id AND a.message_id=r.message_id
      WHERE r.user_id=$1 AND r.session_id=$2 AND r.message_id=$3 AND r.run_id=$4 AND r.state='dispatched'
        AND a.attach_id=$5 AND a.state='attached' AND a.platform=$6 AND a.extra->>'im_ingress_scope'=$7`,
      [proof.identity.ownerId,proof.identity.sessionId,row.message_id,proof.identity.runId,row.attach_id,proof.scope.platform,imAttachmentScopeKey(proof.scope)])).rows
    if(receipt.length!==1)throw fail('unauthorized')
    const r=receipt[0]!,payload=createImInboundEnvelope(options.secretKey).open({ownerId:proof.identity.ownerId,botId:proof.scope.botId,platform:proof.scope.platform},r.sealed_payload)
    const attachments=Array.isArray(payload.attachments)?payload.attachments:[]
    if(!attachments.some(value=>value===row.attach_id||value&&typeof value==='object'&&'attach_id'in value&&value.attach_id===row.attach_id)
      ||row.source_key!==sourceKey({ownerId:row.user_id,platform:row.platform as ImAttentionVoiceIdentity['platform'],botId:row.bot_id,sessionId:String(row.session_id),messageId:String(row.message_id),attachId:row.attach_id,scopeHash:r.scope_hash,eventHash:r.event_hash,eventId:'verified'}))throw fail('unauthorized')
    if(r.extra&&typeof r.extra==='object'&&'quoted'in r.extra&&r.extra.quoted===true&&['voice','audio'].includes(String(r.kind)))
      await assertImQuotedVoiceSource({pool:client,secretKey:options.secretKey,scope:proof.scope,payload,attachment:r})
  }
}
