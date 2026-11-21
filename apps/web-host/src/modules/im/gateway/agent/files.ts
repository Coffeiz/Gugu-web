import {createHmac,randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {openLocalFile} from '@gugu/fs/node'
import type {RunIdentity} from '@gugu/core/agent'
import type {ReadFilePorts,ImSendFilePort,ImSendFileInput} from '@gugu/core/tools'
import type {ImActor} from '@gugu/core/im/access'
import {imCanUseTool} from '@gugu/core/im/access'
import {classifyChatAttachment} from '@gugu/core/agent/attachments/staging'
import type {FileReadOperations} from '../../../files/browse.js'
import {isOwnedFileStorageKey} from '../../../files/store.js'
import type {ImAttachmentScope} from '../inbound/attachments.js'
import type {NodeImBotBinding} from '../inbound/inbox.js'
import type {GatewayPlatformSender} from '../connections.js'
import {createImRunScope} from './scope.js'
import {createImRunArtifactSender} from '../delivery/artifacts.js'

/** 文件ID仅owner私聊；成员/群只开放已入库同scope附件，不将授权根交给模型。 */
export function createImFileTools(options:{pool:Pick<Pool,'query'>;secretKey:string;storageRoot:string;identity:RunIdentity;actor:ImActor;scope:ImAttachmentScope;
  messageIds:readonly string[];payload:Readonly<Record<string,unknown>>;files:Pick<FileReadOperations,'getFile'|'openContent'>;
  sender(binding:NodeImBotBinding):GatewayPlatformSender|null;authorizeTool(name:'read_file'|'send_file',signal?:AbortSignal):Promise<boolean>
}):{readFile?:ReadFilePorts;sendFile:ImSendFilePort}{
 const proof=createImRunScope({...options,authorize:async()=>await options.authorizeTool('read_file')||await options.authorizeTool('send_file')})
 const ownerPrivate=options.actor.role==='owner'&&options.scope.chatType==='c2c'
 const same=(i:RunIdentity)=>i.ownerId===options.identity.ownerId&&i.sessionId===options.identity.sessionId&&i.runId===options.identity.runId
 const allowed=async(name:'read_file'|'send_file',signal?:AbortSignal)=>{signal?.throwIfAborted();if(!imCanUseTool(options.actor,name)||!await options.authorizeTool(name,signal))return false;await proof.read();return true}
 const readFile:ReadFilePorts|undefined=ownerPrivate?{
  async resolveOwnedFile(identity,id,signal){
   if(!same(identity)||!await allowed('read_file',signal))return null
   const row=(await options.pool.query(`SELECT id,display_name,ext,storage_key,mime_type FROM files WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL AND storage_backend='local'`,[identity.ownerId,id])).rows[0]
   if(!row||!isOwnedFileStorageKey(identity.ownerId,row.storage_key)||!await allowed('read_file',signal))return null
   const ext=String(row.ext||'').toLowerCase(),mime=String(row.mime_type||'').toLowerCase()
   const plainExtension=classifyChatAttachment(ext)==='text'&&!['pdf','docx','doc','odt','rtf','xlsx','xls','ods','pptx','ppt','odp'].includes(ext)
   const text=plainExtension||mime.startsWith('text/')||mime==='application/json'||mime.endsWith('+json')||mime.endsWith('+xml')
   return {id:Number(row.id),name:String(row.display_name),root:options.storageRoot,relativePath:row.storage_key,text,extensionless:!ext}
  },
  async openFile(root,key){
   if(root!==options.storageRoot||!isOwnedFileStorageKey(options.identity.ownerId,key)||!await allowed('read_file'))return null
   const live=await options.pool.query('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL AND storage_backend=\'local\'',[options.identity.ownerId,key])
   if(!live.rows.length)return null
   const file=await openLocalFile(root,key)
   if(!file)return null
   return {size:file.size,handle:{read:(buffer,offset,length,position)=>file.handle.read(buffer,offset,length,position),async close(){
    await file.handle.close()
    if(!await allowed('read_file')||!(await options.pool.query('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2 AND deleted_at IS NULL',[options.identity.ownerId,key])).rows.length)throw new Error('IM 文件读取权限已变更')
   }}}
  },
 }:undefined
 const artifactSender=createImRunArtifactSender({...options,authorize:()=>options.authorizeTool('send_file')})
 const digest=(input:ImSendFileInput)=>{
  if(!same(input.identity)||!input.roundId||!input.toolCallId||Boolean(input.fileId)===Boolean(input.attachId)||input.fileId!==undefined&&(!ownerPrivate||!Number.isSafeInteger(input.fileId)||input.fileId<1))throw new Error('IM 文件调用无效')
  const s=options.scope
  return createHmac('sha256',options.secretKey).update('gugu-im-send-file-v1\0').update(JSON.stringify([s.ownerId,s.botId,s.platform,s.chatType,s.chatId,s.platformUserId,input.fileId??null,input.attachId??null])).digest('hex')
 }
 const values=(input:ImSendFileInput)=>[input.identity.ownerId,Number(input.identity.sessionId),input.identity.runId,digest(input)]
 const sendFile:ImSendFilePort={allowFileId:ownerPrivate,
  async send(input){
   if(!same(input.identity)||!await allowed('send_file',input.signal))return 'failed'
   const key=values(input),attempt=randomUUID()
   const row=(await options.pool.query(`INSERT INTO gugu_im_file_tool_receipts(user_id,session_id,run_id,artifact_hash,state,attempt_id) VALUES($1,$2,$3,$4,'pending',$5)
    ON CONFLICT(user_id,session_id,run_id,artifact_hash) DO UPDATE SET artifact_hash=EXCLUDED.artifact_hash RETURNING state,attempt_id`,[...key,attempt])).rows[0]
   if(row?.state==='sent'||row?.state==='failed')return row.state
   if(row?.state!=='pending'||row.attempt_id!==attempt)return 'unknown'
   let state:'sent'|'failed'|'unknown'='unknown'
   try{
    if(!await allowed('send_file',input.signal))state='failed'
    else{
     const acknowledgement=await artifactSender({identity:input.identity,deliveryId:digest(input),artifact:input.fileId?{file_id:input.fileId}:{attach_id:input.attachId!}},input.signal)
     const outcome=typeof acknowledgement==='string'?acknowledgement:acknowledgement.outcome
     state=outcome==='accepted'?'sent':outcome==='rejected'?'failed':'unknown'
    }
    const changed=await options.pool.query(`UPDATE gugu_im_file_tool_receipts SET state=$6 WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND artifact_hash=$4 AND attempt_id=$5 AND state='pending' RETURNING state`,[...key,attempt,state])
    return changed.rowCount===1?state:'unknown'
   }catch{input.signal.throwIfAborted();return 'unknown'}
  },
  async recover(input){try{if(!same(input.identity)||!await allowed('send_file'))return 'unknown';const row=(await options.pool.query('SELECT state FROM gugu_im_file_tool_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND artifact_hash=$4',values(input))).rows[0];return row?.state==='sent'?'sent':row?.state==='failed'?'failed':'unknown'}catch{return 'unknown'}},
 }
 return {...(readFile?{readFile}:{}),sendFile}
}
