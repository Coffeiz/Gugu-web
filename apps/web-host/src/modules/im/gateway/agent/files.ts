import {createHmac,randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {RunIdentity} from '@gugu/core/agent'
import { downloadSendFileImage } from '@gugu/core/tools'
import type {ImSendFilePort,ImSendFileInput} from '@gugu/core/tools'
import type {ImActor} from '@gugu/core/im/access'
import { imCanUseTool, isVerifiedImOwner } from '@gugu/core/agent/scenes/im'
import type {FileReadOperations} from '../../../files/browse.js'
import type {ImAttachmentScope} from '../inbound/attachments.js'
import type {NodeImBotBinding} from '../inbound/inbox.js'
import type {GatewayPlatformSender} from '../connections.js'
import {createImRunScope} from './scope.js'
import {createImRunArtifactSender} from '../delivery/artifacts.js'

/** 已验证的 owner 可使用文件库路径；成员只能使用获准的来源。 */
export function createImFileTools(options:{pool:Pick<Pool,'query'>;secretKey:string;storageRoot:string;identity:RunIdentity;actor:ImActor;scope:ImAttachmentScope;
  messageIds:readonly string[];payload:Readonly<Record<string,unknown>>;files:Pick<FileReadOperations,'getFile'|'openContent'>;
  openImage?: Parameters<typeof downloadSendFileImage>[1];
  sender(binding:NodeImBotBinding):GatewayPlatformSender|null;authorizeTool(name:'send_item',signal?:AbortSignal):Promise<boolean>
}):{sendFile:ImSendFilePort}{
 const proof=createImRunScope({...options,authorize:async()=>await options.authorizeTool('send_item')})
 const canSendPath=isVerifiedImOwner(options.actor)
 const same=(i:RunIdentity)=>i.ownerId===options.identity.ownerId&&i.sessionId===options.identity.sessionId&&i.runId===options.identity.runId
 const allowed=async(name:'send_item',signal?:AbortSignal)=>{signal?.throwIfAborted();if(!imCanUseTool(options.actor,name)||!await options.authorizeTool(name,signal))return false;await proof.read();return true}
 const artifactSender=createImRunArtifactSender({...options,authorize:()=>options.authorizeTool('send_item')})
 const digest=(input:ImSendFileInput)=>{
  if(!same(input.identity)||!input.roundId||!input.toolCallId||[input.filePath,input.attachId,input.url].filter(value=>value!==undefined).length!==1||input.filePath!==undefined&&!canSendPath)throw new Error('IM 文件调用无效')
  const s=options.scope
  return createHmac('sha256',options.secretKey).update('gugu-im-send-file-v1\0').update(JSON.stringify([s.ownerId,s.botId,s.platform,s.chatType,s.chatId,s.platformUserId,input.filePath??null,input.attachId??null,...(input.url ? [input.url] : [])])).digest('hex')
 }
 const values=(input:ImSendFileInput)=>[input.identity.ownerId,Number(input.identity.sessionId),input.identity.runId,digest(input)]
 const sendFile:ImSendFilePort={allowFilePath:canSendPath,allowRemoteImage:Boolean(options.openImage),
  async send(input){
   if(!same(input.identity)||!await allowed('send_item',input.signal))return 'failed'
   const key=values(input),attempt=randomUUID()
   const row=(await options.pool.query(`INSERT INTO gugu_im_file_tool_receipts(user_id,session_id,run_id,artifact_hash,state,attempt_id) VALUES($1,$2,$3,$4,'pending',$5)
    ON CONFLICT(user_id,session_id,run_id,artifact_hash) DO UPDATE SET artifact_hash=EXCLUDED.artifact_hash RETURNING state,attempt_id`,[...key,attempt])).rows[0]
   if(row?.state==='sent'||row?.state==='failed')return row.state
   if(row?.state!=='pending'||row.attempt_id!==attempt)return 'unknown'
   let state:'sent'|'failed'|'unknown'='unknown'
   try{
    if(!await allowed('send_item',input.signal))state='failed'
    else{
     const image = input.url && options.openImage ? await downloadSendFileImage(input.url, options.openImage, input.signal) : undefined
     const acknowledgement = image && 'error' in image ? 'rejected' : await artifactSender(
       { identity: input.identity, deliveryId: digest(input), artifact: input.filePath ? { file_path: input.filePath } : input.attachId ? { attach_id: input.attachId } : {} },
       input.signal, image)
     const outcome=typeof acknowledgement==='string'?acknowledgement:acknowledgement.outcome
     state=outcome==='accepted'?'sent':outcome==='rejected'?'failed':'unknown'
    }
    const changed=await options.pool.query(`UPDATE gugu_im_file_tool_receipts SET state=$6 WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND artifact_hash=$4 AND attempt_id=$5 AND state='pending' RETURNING state`,[...key,attempt,state])
    return changed.rowCount===1?state:'unknown'
   }catch{input.signal.throwIfAborted();return 'unknown'}
  },
  async recover(input){try{if(!same(input.identity)||!await allowed('send_item'))return 'unknown';const row=(await options.pool.query('SELECT state FROM gugu_im_file_tool_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND artifact_hash=$4',values(input))).rows[0];return row?.state==='sent'?'sent':row?.state==='failed'?'failed':'unknown'}catch{return 'unknown'}},
 }
 return {sendFile}
}
