import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createDataImportPreflighter } from '@gugu/core/data-portability/preflight-import'
import { openPortableArchive } from '../../../../packages/core/src/data-portability/archive-reader-node.js'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'

const ownerA='00000000-0000-4000-8000-000000000011'
const ownerB='00000000-0000-4000-8000-000000000012'
const jobId='00000000-0000-4000-8000-000000000031'
const token='synthetic-one-time-import-confirmation-token'
const secret='synthetic-import-envelope-secret'

test('归档预检上传经认证 owner 流式加密暂存并返回一次性确认令牌',async()=>{
 const events:string[]=[]
 const jobs=new Map<string,{owner:string;status:string;tokenHash:string;digest?:string;stagingKey?:string}|null>()
 const files=new Map<string,Buffer>()
 const preflight=createDataImportPreflighter({
  async begin(owner,id,tokenHash){
   events.push('begin')
   if([...jobs.values()].some(row=>row?.owner===owner&&['uploading','queued','running','applying','rolling_back','needs_recovery'].includes(row.status)))
    throw Object.assign(new Error('已有数据迁移任务正在处理'),{code:'conflict'})
   jobs.set(id,{owner,status:'uploading',tokenHash})
  },
  async finish(owner,id,digest,key){
   const row=jobs.get(id);assert.equal(row?.owner,owner);assert.equal(row?.status,'uploading')
   row.status='queued';row.digest=digest;row.stagingKey=key;events.push('finish');return 'queued'
  },
  async fail(owner,id,key){
   const row=jobs.get(id);if(row?.owner===owner&&row.status==='uploading'){row.status='failed';row.tokenHash='';row.stagingKey=key??undefined}
   events.push(`failed:${key??''}`)
  },
 },{
  async put(key,chunks){const output:Buffer[]=[];for await(const chunk of chunks)output.push(Buffer.from(chunk));files.set(key,Buffer.concat(output));events.push('stored')},
  async remove(key){files.delete(key);events.push('removed')},
 },{secretKey:secret,jobId:()=>jobId,token:()=>token,now:()=>new Date('2026-11-18T00:00:00.000Z')})
 const app=createApp({
  appName:'归档预检测试应用',isReady:async()=>true,preflightDataImport:preflight,
  portabilityJobs:{async getImport(owner,id){const row=jobs.get(id);if(row?.owner!==owner)throw new Error('missing');return {
   id,status:row.status,stage:row.status,mode:'preflight',progress_current:0,progress_total:null,error_code:null,
   preview:null,created_at:'2026-11-18T00:00:00.000Z',expires_at:'2026-11-19T00:00:00.000Z',rollback_expires_at:null,
  }}} as never,
  userAuth:{secret:'synthetic-import-host-secret',async lookupUser(id){return [ownerA,ownerB].includes(id)?{
   id,username:'sample',displayName:'小北',email:'sample@example.invalid',avatarUrl:null,createdAt:null,timezone:null,
   emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1,
  }:null}},
 })
 try{
  const headers={authorization:`Bearer ${createUserToken(ownerA,1,'synthetic-import-host-secret')}`,'content-type':'application/octet-stream','x-user-id':ownerB}
  const absent=await app.inject({method:'POST',url:'/api/v1/data-portability/imports/preflight',headers:{'content-type':'application/octet-stream'},payload:'private archive'})
  assert.equal(absent.statusCode,401)
  const unauthenticatedInvalidType=await app.inject({method:'POST',url:'/api/v1/data-portability/imports/preflight',headers:{'content-type':'text/plain'},payload:'private archive'})
  assert.equal(unauthenticatedInvalidType.statusCode,401)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/data-portability/imports/preflight',headers:{...headers,'content-type':'text/plain'},payload:'private archive'})).statusCode,415)
  assert.deepEqual(events,[])

  const payload=Buffer.from('synthetic portable zip bytes')
  const response=await app.inject({method:'POST',url:'/api/v1/data-portability/imports/preflight',headers,payload})
  assert.equal(response.statusCode,202,response.body)
  assert.equal(response.headers['cache-control'],'no-store')
  assert.equal(response.json().id,jobId)
  assert.equal(response.json().status,'queued')
  assert.equal(response.json().import_token,token)
  assert.notEqual(jobs.get(jobId)?.tokenHash,token)
  assert.equal(jobs.get(jobId)?.tokenHash,createHash('sha256').update(token).digest('hex'))
  assert.equal(jobs.get(jobId)?.owner,ownerA)
  assert.equal(jobs.get(jobId)?.digest,createHash('sha256').update(payload).digest('hex'))
  assert.deepEqual(events,['begin','stored','finish'])

  const storageKey=`${ownerA.replaceAll('-','')}/.data-portability/imports/${jobId.replaceAll('-','')}.gupi`
  const encrypted=files.get(storageKey);assert.ok(encrypted)
  const opened=await openPortableArchive({size:encrypted.length,async readAt(offset,length){return encrypted.subarray(offset,offset+length)}},secret,`data-portability-staging:${ownerA.replaceAll('-','')}:${jobId.replaceAll('-','')}`)
  const plain:Buffer[]=[]
  for await(const chunk of opened.stream(0,opened.plaintextSize))plain.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(plain),payload)
 }finally{await app.close()}
})

test('空上传标记失败并清除令牌',async()=>{
 const job='00000000-0000-4000-8000-000000000032'
 let row:{owner:string;status:string;tokenHash:string;stagingKey?:string}|undefined
 const removed:string[]=[]
 const preflight=createDataImportPreflighter({
  async begin(owner,_id,tokenHash){row={owner,status:'uploading',tokenHash}},
  async finish(){throw new Error('unexpected finish')},
  async fail(owner,_id,key){if(row?.owner===owner){row.status='failed';row.tokenHash='';row.stagingKey=key??undefined}},
 },{
  async put(_key,chunks){for await(const _chunk of chunks){}},
  async remove(key){removed.push(key)},
 },{secretKey:secret,jobId:()=>job,token:()=>token,now:()=>new Date('2026-11-18T00:00:00.000Z')})
 await assert.rejects(preflight(ownerA,(async function*(){})()),error=>{
  assert.equal((error as {statusCode?:number}).statusCode,400);return true
 })
 assert.equal(row?.status,'failed')
 assert.equal(row?.tokenHash,'')
 assert.equal(row?.stagingKey,undefined)
 assert.deepEqual(removed,[`${ownerA.replaceAll('-','')}/.data-portability/imports/${job.replaceAll('-','')}.gupi`])
})

test('上传过期且文件清理失败时把孤儿键交给过期回收器',async()=>{
 const job='00000000-0000-4000-8000-000000000034'
 const failedKeys:string[]=[]
 const preflight=createDataImportPreflighter({
  async begin(){},
  async finish(){return 'expired'},
  async fail(_owner,_id,key){if(key)failedKeys.push(key)},
 },{
  async put(_key,chunks){for await(const _chunk of chunks){}},
  async remove(){throw new Error('synthetic cleanup failure')},
 },{secretKey:secret,jobId:()=>job,token:()=>token,now:()=>new Date('2026-11-18T00:00:00.000Z')})
 await assert.rejects(preflight(ownerA,(async function*(){yield Buffer.from('payload')})()),error=>{
  assert.equal((error as {code?:string}).code,'conflict');return true
 })
 assert.deepEqual(failedKeys,[`${ownerA.replaceAll('-','')}/.data-portability/imports/${job.replaceAll('-','')}.gupi`])
})

test('上传已暂存但任务提交失败时尽力清理并保留回收键',async()=>{
 const job='00000000-0000-4000-8000-000000000033'
 let row:{owner:string;status:string;tokenHash:string;stagingKey?:string}|undefined
 const removed:string[]=[]
 const preflight=createDataImportPreflighter({
  async begin(owner,_id,tokenHash){row={owner,status:'uploading',tokenHash}},
  async finish(){throw new Error('synthetic database failure')},
  async fail(owner,_id,key){if(row?.owner===owner){row.status='failed';row.tokenHash='';row.stagingKey=key??undefined}},
 },{
  async put(_key,chunks){for await(const _chunk of chunks){}},
  async remove(key){removed.push(key);throw new Error('synthetic cleanup failure')},
 },{secretKey:secret,jobId:()=>job,token:()=>token,now:()=>new Date('2026-11-18T00:00:00.000Z')})
 await assert.rejects(preflight(ownerA,(async function*(){yield Buffer.from('payload')})()),error=>{
  assert.equal((error as {statusCode?:number}).statusCode,503);return true
 })
 const key=`${ownerA.replaceAll('-','')}/.data-portability/imports/${job.replaceAll('-','')}.gupi`
 assert.deepEqual(removed,[key])
 assert.equal(row?.status,'failed')
 assert.equal(row?.tokenHash,'')
 assert.equal(row?.stagingKey,key)
})
