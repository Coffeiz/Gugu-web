import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createApp} from '../../src/app.js'
import {createAdminEmailPublishOperations,createEmailPublishTaskLifecycle} from '../../src/modules/admin/email-publish.js'
import {createSmtpTestDelivery} from '../../src/adapters/smtp-test-delivery.js'
import {temporarySmtp} from './fixtures/temporary-smtp.js'

const draft={subject:'公告主题',title:'公告',body:'正文',translations:{'ja-JP':{subject:'お知らせ',title:'公告',body:'本文'}}}

test('管理员邮件发布要求确认和有效收件人，响应不暴露邮箱',async()=>{
 const started:Array<{recipients:Record<string,string[]>;draft:unknown}>=[]
 const app=createApp({appName:'测试应用',isReady:async()=>true,
  adminAuth:{registerRoutes(){},async verifyAdmin(){return true},async requireAdmin(request,reply){if(request.headers.authorization!=='admin')return reply.code(401).send({detail:'需要管理员认证'})}},
  adminEmailPublish:{
   recipients:async()=>({ 'zh-CN':['zh@example.test'],'ja-JP':['ja@example.test'],'en-US':[] }),
   enqueue:(recipients,value)=>{started.push({recipients,draft:value})},close:async()=>{},
  },
 })
 try{
  const call=(payload:unknown,auth='admin')=>app.inject({method:'POST',url:'/api/v1/admin/email/publish',headers:{authorization:auth},payload})
  assert.equal((await call({...draft,confirm:true},'')).statusCode,401)
  assert.equal(started.length,0)
  const invalid=await call({...draft,confirm:false})
  assert.equal(invalid.statusCode,400)
  assert.equal(started.length,0)
  const invalidDto=await call({...draft,confirm:true,template:'unknown'})
  assert.equal(invalidDto.statusCode,422)
  assert.equal(started.length,0)
  const accepted=await call({...draft,confirm:true})
  assert.equal(accepted.statusCode,200)
  assert.deepEqual(accepted.json(),{ok:true,status:'queued',recipient_count:2,locale_counts:{'zh-CN':1,'ja-JP':1,'en-US':0}})
  assert.doesNotMatch(accepted.body,/example\.test/)
  assert.equal(started.length,1)
  assert.deepEqual(started[0]?.recipients,{'zh-CN':['zh@example.test'],'ja-JP':['ja@example.test'],'en-US':[]})
 }finally{await app.close()}
})

test('无有效收件人时拒绝发布',async()=>{
 const app=createApp({appName:'测试应用',isReady:async()=>true,adminAuth:{registerRoutes(){},async verifyAdmin(){return true},async requireAdmin(){return undefined}},adminEmailPublish:{recipients:async()=>({'zh-CN':[],'ja-JP':[],'en-US':[]}),enqueue:async()=>{assert.fail('不能启动空任务')},close:async()=>{}}})
 try{
  const response=await app.inject({method:'POST',url:'/api/v1/admin/email/publish',payload:{...draft,confirm:true}})
  assert.equal(response.statusCode,400)
 }finally{await app.close()}
})

test('关闭邮件发布生命周期时等待已接收任务结束',async()=>{
 const lifecycle=createEmailPublishTaskLifecycle()
 let release!:()=>void
 let finished=false
 lifecycle.enqueue(async()=>{await new Promise<void>(resolve=>{release=resolve});finished=true})
 const closing=lifecycle.close()
 await Promise.resolve()
 assert.equal(finished,false)
 release()
 await closing
 assert.equal(finished,true)
 assert.throws(()=>lifecycle.enqueue(async()=>{}),/已停止接收/)
})

test('发布路由经 Core 批量用例和本地 SMTP 接受全部合成收件人，关闭时排空',async()=>{
 const root=await mkdtemp(join(tmpdir(),'email-publish-')),relay=await temporarySmtp(root)
 const reports:Array<{recipient_count:number;sent:number;failed:number}>=[]
 const operations=createAdminEmailPublishOperations({
  query:async()=>({rows:[{email:'one@example.test',data_json:'{"locale":"zh-CN"}'},{email:'two@example.test',data_json:'{"locale":"ja-JP"}'}]}),
  readSettings:()=>({host:'127.0.0.1',port:relay.port,user:'sender@example.test',password:'synthetic-secret',from_addr:'测试咕咕',to_addr:'',test_to_addr:'',use_ssl:true}),
  send:createSmtpTestDelivery({SSL_CERT_FILE:relay.cert}),
  reportResult:result=>reports.push({recipient_count:result.recipient_count,sent:result.sent,failed:result.failed}),
  reportFailure:()=>assert.fail('合成 SMTP 投递不能失败'),
 })
 const productionApp=createApp({appName:'测试应用',isReady:async()=>true,adminAuth:{registerRoutes(){},async verifyAdmin(){return true},async requireAdmin(){return undefined}},adminEmailPublish:operations})
 try{
  const response=await productionApp.inject({method:'POST',url:'/api/v1/admin/email/publish',payload:{...draft,confirm:true}})
  assert.deepEqual(response.json().locale_counts,{'zh-CN':1,'ja-JP':1,'en-US':0})
  await productionApp.close()
  assert.deepEqual(reports,[{recipient_count:2,sent:2,failed:0}])
  assert.equal(relay.received.length,2)
  assert.deepEqual(relay.received.map(item=>item.to[0]).sort(),['RCPT TO:<one@example.test>','RCPT TO:<two@example.test>'])
 }finally{await productionApp.close().catch(()=>{});await relay.close();await rm(root,{recursive:true,force:true})}
})
