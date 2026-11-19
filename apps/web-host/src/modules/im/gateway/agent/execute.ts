import type {Pool} from 'pg'
import type {Kysely} from 'kysely'
import {Executor,createMxcExecutor} from '@gugu/core/executor/platform'
import {messages} from '@gugu/core/executor/runtime'
import {ExecutionError,type ExecutionBackend,type HarnessExecutorPorts,type HarnessExecutionScope,type ExecutionRequest,type ExecutionGrant} from '@gugu/core/executor'
import {classifyShellCommandRisk} from '@gugu/core/agent/security/shell-command-risk'
import type {RunIdentity} from '@gugu/core/agent'
import type {ImActor} from '@gugu/core/im/access'
import {createTerminalWorkspaceMounts} from '../../../terminals/sandbox/mounts.js'

/** 正式Harness ports，始终通过实际Executor/MXC；未配置危险执行确认时拒绝。 */
export function createImHarnessExecutorPorts<DB>(options:{pool:Pick<Pool,'connect'|'query'>;db:Kysely<DB>;storageRoot:string;
 identity:RunIdentity;actor:ImActor;authorize(signal?:AbortSignal):Promise<boolean>;
 confirmed?(scope:HarnessExecutionScope,request:Readonly<ExecutionRequest>,signal?:AbortSignal):Promise<boolean>;
 /** 测试可控原生进程适配；生产默认实际MXC SDK。 */
 backend?():Promise<ExecutionBackend>
}):HarnessExecutorPorts{
 const mounts=createTerminalWorkspaceMounts(options.pool,options.db,options.storageRoot)
 let backend:Promise<Executor>|undefined
 type Mounts=Awaited<ReturnType<typeof mounts>>
 const held=new Map<string,{grant:ExecutionGrant;mounts:Mounts;scope:HarnessExecutionScope;release():Promise<void>}>(),preparing=new Set<string>()
 const denied=()=>new ExecutionError('denied',messages.denied)
 async function authorized(scope:HarnessExecutionScope,signal?:AbortSignal){
  signal?.throwIfAborted()
  if(scope.ownerId!==options.identity.ownerId||scope.sessionId!==options.identity.sessionId||scope.runId!==options.identity.runId
   ||options.actor.ownerId!==scope.ownerId||options.actor.role!=='owner'||options.actor.chatType!=='c2c'||!await options.authorize(signal))throw denied()
  const rows=await options.pool.query(`SELECT 1 FROM filesystem_authorization_grants g JOIN conversation_sessions s ON s.id::text=g.subject_id AND s.user_id=g.user_id
   WHERE g.user_id=$1 AND s.id=$2 AND g.subject_type='session' AND g.scope='user_sandbox' AND g.permission='read_write'
    AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())`,[scope.ownerId,scope.sessionId])
  if(!rows.rows.length)throw denied()
 }
 const safe=(error:unknown,signal?:AbortSignal)=>{const code=signal?.aborted?'cancelled':error instanceof ExecutionError?error.code:'denied';return new ExecutionError(code,messages[code])}
 return {
  async authorize(scope,request,signal){
   let pinned:Mounts|undefined
   if(preparing.has(request.id)||held.has(request.id)||held.size+preparing.size>=64)throw denied()
   preparing.add(request.id)
   try{
    await authorized(scope,signal)
    if(held.size>=64||held.has(request.id))throw denied()
    const dangerous=request.destructive||classifyShellCommandRisk(request.command)==='dangerous'
    const confirmed=!dangerous||!!options.confirmed&&await options.confirmed(scope,request,signal)
    if(!confirmed)throw denied()
    pinned=await mounts(scope.ownerId,null,true,request.cwd)
    await authorized(scope,signal)
    const grant:ExecutionGrant={requestId:request.id,backend:'mxc',command:request.command,cwd:pinned.cwd,confirmed,
     readonlyPaths:pinned.readonlyPaths,readwritePaths:pinned.readwritePaths,environment:pinned.environment,timeoutMs:request.timeoutMs,maxOutputBytes:1_048_576}
    const owned=pinned;let released=false
    const abort=()=>{void release().catch(()=>{})}
    async function release(){if(released)return;released=true;signal?.removeEventListener('abort',abort);held.delete(request.id);await owned.close()}
    held.set(request.id,{grant,mounts:owned,scope:Object.freeze({...scope}),release});pinned=undefined
    signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted){await release();throw denied()}
    return grant
   }catch(error){await pinned?.close().catch(()=>{});throw safe(error,signal)}finally{preparing.delete(request.id)}
  },
  executor:{async execute(request,grant,signal,onOutput){
   const entry=held.get(request.id)
   if(!entry||entry.grant!==grant)throw denied()
   try{
    signal?.throwIfAborted()
    backend??=(options.backend?options.backend():createMxcExecutor()).then(value=>new Executor([value])).catch(error=>{backend=undefined;throw error})
    const executor=await backend
    await authorized(entry.scope,signal)
    return await executor.execute({...request,cwd:entry.mounts.cwd},grant,signal,onOutput)
   }catch(error){throw safe(error,signal)}finally{await entry.release()}
  }},
 }
}
