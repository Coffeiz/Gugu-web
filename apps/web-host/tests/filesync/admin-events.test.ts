import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {serializeLiveMessage} from '@gugu/core/live-message'
import {registerAdminFileSyncEventsRoute} from '../../src/modules/filesync/admin-events.js'
import {RedisLiveSubscriptionError} from '../../src/adapters/redis-live-subscription.js'

const base={protocol_version:'live-event-v1',event_id:'evt-synthetic',created_at:'2026-11-15T00:00:00.123456+00:00'}
test('完整Python SSE消息协议对照：各资源、通知、present、任务、agent、filesync及字段裁剪', {skip:!process.env.GUGU_WEBUI_TEST_PYTHON&&'需要显式测试Python'},()=>{
 const sync={...base,type:'filesync.run.changed',binding_id:3,run_id:'run-1',revision:4,root_path:'/private/synthetic-root',relative_path:'private.txt'}
 const messages:unknown[]=['bad',null,{},[],{type:'auth.state.changed'},{notification:{id:1}},{present:{file_id:2,name:'合成文件'}},{present:{file_id:true}},{...base,type:'agent.run.changed',session_id:2,status:'running',secret:'drop'},sync,{...sync,type:'filesync.binding.health.changed'},{...sync,binding_id:0},{...sync,revision:true},{...sync,created_at:'not-a-date'},{...sync,created_at:'2026-02-30T00:00:00Z'},{...sync,type:'filesync.unknown'}, {...base,type:'task.progress',task_type:'trash_purge',task_id:3,status:'running',progress_current:1,progress_total:2,failed_count:0}]
 for(const resource of ['projects','calendar','files','mind','scheduled_tasks','sessions','clients','im_channels','terminals','pending_queues','skills','unknown'])messages.push({...base,type:'resource.changed',resource,operation:'refresh',revision:3})
 for(const created_at of ['2026-11-15','20261115T012345','2026-W46-7T01:23:45','2026-11-15🐦01:23:45','2026-11-15T01:23','2026-11-15T01.5','2026-11-15T01:23:45.123456789+01:02:03','2026-11-15T01:23:45+01:99','2026-11-15T25:00:00','2026-11-15T01:00:00+25:00'])messages.push({...sync,created_at})
 const raw=messages.map(value=>typeof value==='string'?value:JSON.stringify(value))
 const references=JSON.parse(execFileSync(process.env.GUGU_WEBUI_TEST_PYTHON!,['-c',"import json,os; from app.api.v1.live import _serialize_message; print(json.dumps([_serialize_message(x) for x in json.loads(os.environ['TEST_MESSAGES'])],ensure_ascii=False))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-admin-events-config',PYTHONPATH:'.',TEST_MESSAGES:JSON.stringify(raw)}})) as Array<string|null>
 raw.forEach((message,index)=>{
  const actual=serializeLiveMessage(message),expected=references[index]
  if(expected===null)assert.equal(actual,null,JSON.stringify(messages[index]))
  else {assert.ok(actual?.startsWith('data: '));assert.ok(actual?.endsWith('\n\n'));assert.deepEqual(JSON.parse(actual!.slice(6)),JSON.parse(expected!.slice(6)))}
 })
})

test('管理员专属订阅、首帧/SSE头/完整协议与Redis断开清理',async()=>{
 const app=Fastify();let subscriptions=0,closed=0,fail=false
 registerAdminFileSyncEventsRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(request.headers.authorization?403:401).send({detail:'拒绝访问'})},subscribe:async channels=>{subscriptions++;assert.deepEqual(channels,['events:filesync-admin']);const messages=[JSON.stringify({notification:{id:1}}),JSON.stringify({...base,type:'filesync.run.changed',run_id:'r',binding_id:1,revision:2,secret:'private'})];return {next:async()=>{if(fail)throw new RedisLiveSubscriptionError();const data=messages.shift();return data?{channel:'events:filesync-admin',data}:null},close:async()=>{closed++}}}})
 try{
  const url='/api/v1/admin/filesync/events'
  assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({url,headers:{authorization:'user'}})).statusCode,403);assert.equal(subscriptions,0)
  const result=await app.inject({url,headers:{authorization:'admin'}})
  assert.equal(result.statusCode,200);assert.equal(result.headers['content-type'],'text/event-stream; charset=utf-8');assert.equal(result.headers['cache-control'],'no-cache, no-transform');assert.equal(result.headers['x-accel-buffering'],'no')
  assert.ok(result.body.startsWith(': connected\n\n'));assert.match(result.body,/notification/);assert.match(result.body,/filesync.run.changed/);assert.doesNotMatch(result.body,/private/);assert.equal(closed,1)
  fail=true;const reset=await app.inject({url,headers:{authorization:'admin'}})
  assert.equal(reset.body,': connected\n\n: live connection reset; client will reconnect\n\n');assert.equal(closed,2)
 }finally{await app.close()}
})
