import { createCipheriv,createDecipheriv,createHmac,hkdfSync,randomBytes } from 'node:crypto'
import { stableJson } from '@gugu/core/agent'
import type { ImReflectionJob } from './reflection-contracts.js'

export function reflectionScopeHash(job:Pick<ImReflectionJob,'identity'|'actor'|'scope'>,secretKey:string):string{
  return createHmac('sha256',secretKey).update('gugu-im-reflection-scope-v1\0').update(stableJson([job.identity.ownerId,job.actor.platform,job.actor.botId,job.scope])).digest('hex')
}
export function createImReflectionCodec(secretKey:string){
  if(!secretKey)throw new Error('反思任务密钥未配置')
  const key=Buffer.from(hkdfSync('sha256',Buffer.from(secretKey),Buffer.alloc(0),Buffer.from('gugu-im-reflection-v1'),32))
  const aad=(id:string,owner:string,session:string,run:string,scope:string,purpose:'job'|'plan')=>Buffer.from(stableJson([1,id,owner,session,run,scope,purpose]))
  return{
    seal(job:ImReflectionJob,value:unknown,purpose:'job'|'plan'){
      let raw:string;try{raw=JSON.stringify(value);if(!raw||Buffer.byteLength(raw)>(purpose==='job'?1048576:16*1048576))throw Error()}catch{throw new Error('反思任务数据无效')}
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce)
      cipher.setAAD(aad(job.id,job.identity.ownerId,job.identity.sessionId,job.identity.runId,reflectionScopeHash(job,secretKey),purpose))
      return{nonce,payload:Buffer.concat([cipher.update(raw),cipher.final(),cipher.getAuthTag()])}
    },
    open(row:{id:string;user_id:string;session_id:number;run_id:string;scope_hash:string},nonce:Buffer,payload:Buffer,purpose:'job'|'plan'):unknown{
      try{if(nonce.length!==12||payload.length<16||payload.length>(purpose==='job'?1048592:16*1048576+16))throw Error()
        const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(row.id,row.user_id,String(row.session_id),row.run_id,row.scope_hash,purpose));cipher.setAuthTag(payload.subarray(-16))
        return JSON.parse(Buffer.concat([cipher.update(payload.subarray(0,-16)),cipher.final()]).toString('utf8')) as unknown
      }catch{throw new Error('反思任务数据无效')}
    },
  }
}
