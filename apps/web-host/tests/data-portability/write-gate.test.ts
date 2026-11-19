import assert from 'node:assert/strict'
import test from 'node:test'
import { requiresDataReplacementWriteGate } from '@gugu/core/data-portability/write-gate'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'

const owner='00000000-0000-4000-8000-000000000041'
const secret='synthetic-data-replacement-gate-secret'

test('替换任务执行期间认证写请求返回423且不进入业务用例',async()=>{
 let writes=0,gateChecks=0,applyCalls=0,rollbackCalls=0,recoverCalls=0,gateFailure=false
 const app=createApp({
  appName:'替换写门禁测试',isReady:async()=>true,
  userAuth:{secret,async lookupUser(id){return id===owner?{
   id,username:'sample',displayName:'小北',email:'sample@example.invalid',avatarUrl:null,createdAt:null,timezone:null,
   emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1,
  }:null},async isDataReplacementWriteLocked(){gateChecks++;if(gateFailure)throw new Error('synthetic database failure');return true}},
  applyDataImport:async(ownerId,jobId,mode,_token,key)=>{applyCalls++;return {
   id:jobId,user_id:ownerId,status:'queued',stage:'queued',mode,progress_current:0,progress_total:null,
   error_code:null,preview:null,created_at:'2026-11-18T00:00:00.000Z',expires_at:null,rollback_expires_at:null,
   idempotency_key:key,
  }},
  rollbackDataImport:async(ownerId,jobId,key)=>{rollbackCalls++;return {id:jobId,user_id:ownerId,status:'queued',mode:'rollback',idempotency_key:key}},
  recoverDataImport:async(ownerId,jobId)=>{recoverCalls++;return {id:jobId,user_id:ownerId,status:'queued',mode:'replace'}},
  profile:{secret,async updateProfile(){writes++;return {timezoneChanged:false,passwordChanged:false}},
   async lookupUser(){return {id:owner,username:'sample',displayName:'小北',email:'sample@example.invalid',isActive:true,
    avatarUrl:null,createdAt:null,timezone:null,emailSubscribed:false,imChannels:[],securityVersion:1}},
   async bumpContextRevision(){},async publishAuthStateChanged(){return false}},
 })
 try{
  assert.equal(requiresDataReplacementWriteGate('GET','/api/v1/auth/profile'),false)
  assert.equal(requiresDataReplacementWriteGate('POST','/api/v1/data-portability/imports/job/apply'),false)
  assert.equal(requiresDataReplacementWriteGate('PATCH','/api/v1/auth/profile'),true)
  const unauthenticated=await app.inject({method:'PATCH',url:'/api/v1/auth/profile',payload:{display_name:'测试'}})
  assert.equal(unauthenticated.statusCode,401)
  assert.equal(gateChecks,0)
  const response=await app.inject({method:'PATCH',url:'/api/v1/auth/profile',
   headers:{authorization:`Bearer ${createUserToken(owner,1,secret)}`},payload:{display_name:'测试'}})
  assert.equal(response.statusCode,423,response.body)
  assert.equal(response.headers['retry-after'],'5')
  assert.deepEqual(response.json(),{detail:'账号正在替换用户数据，暂时不能修改；请稍后重试'})
  assert.equal(writes,0)
  assert.equal(gateChecks,1)
  const importJob='00000000-0000-4000-8000-000000000042'
  const apply=await app.inject({method:'POST',url:`/api/v1/data-portability/imports/${importJob}/apply`,
   headers:{authorization:`Bearer ${createUserToken(owner,1,secret)}`,'content-type':'application/json'},
   payload:{mode:'incremental',import_token:'synthetic-import-confirmation-token-123456',idempotency_key:'synthetic-import-key'}})
  assert.equal(apply.statusCode,202,apply.body)
  assert.equal(gateChecks,1)
  assert.equal(applyCalls,1)
  const rollback=await app.inject({method:'POST',url:`/api/v1/data-portability/imports/${importJob}/rollback`,
   headers:{authorization:`Bearer ${createUserToken(owner,1,secret)}`,'content-type':'application/json'},
   payload:{idempotency_key:'synthetic-rollback-key'}})
  const recover=await app.inject({method:'POST',url:`/api/v1/data-portability/imports/${importJob}/recover`,
   headers:{authorization:`Bearer ${createUserToken(owner,1,secret)}`}})
  assert.equal(rollback.statusCode,202,rollback.body)
  assert.equal(recover.statusCode,202,recover.body)
  assert.equal(gateChecks,1)
  assert.equal(rollbackCalls,1)
  assert.equal(recoverCalls,1)
  gateFailure=true
  const unavailable=await app.inject({method:'PATCH',url:'/api/v1/auth/profile',
   headers:{authorization:`Bearer ${createUserToken(owner,1,secret)}`},payload:{display_name:'不可写'}})
  assert.equal(unavailable.statusCode,503)
  assert.deepEqual(unavailable.json(),{detail:'账号状态暂不可用，请稍后重试'})
  assert.equal(writes,0)
 }finally{await app.close()}
})
