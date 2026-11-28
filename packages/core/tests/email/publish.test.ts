import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverAdminEmailBulk } from '../../src/email/publish.js'

const draft={subject:'主题',title:'标题',body:'正文',translations:{'ja-JP':{subject:'件名',title:'見出し',body:'本文'}}}
const settings={host:'smtp.example.test',port:465,user:'sender@example.test',password:'secret',from_addr:'咕咕',to_addr:'',test_to_addr:'',use_ssl:true}

test('批量发布使用目标语言内容，隔离单封失败并限制并发',async()=>{
 let active=0,maxActive=0
 const deliveries:Array<{to:string;subject:string;body:string}>=[]
 const metrics:Array<{status:string;elapsed_ms:number;error_code?:string}> = []
 const result=await deliverAdminEmailBulk({'zh-CN':['zh1@example.test','zh2@example.test'],'ja-JP':['ja@example.test'],'en-US':['en@example.test']},draft,settings,async delivery=>{
  active++;maxActive=Math.max(active,maxActive)
  try{
   deliveries.push({to:delivery.toAddress,subject:delivery.message.subject,body:delivery.message.plain})
   await new Promise(resolve=>setTimeout(resolve,5))
   if(delivery.toAddress==='zh2@example.test')throw new Error('synthetic SMTP failure')
  }finally{active--}
 },2,metric=>metrics.push(metric))
 assert.deepEqual(result,{recipient_count:4,sent:3,failed:1,locale_counts:{'zh-CN':2,'ja-JP':1,'en-US':1}})
 assert.equal(maxActive,2)
 assert.deepEqual(deliveries.map(item=>item.subject),['主题','主题','件名','主题'])
 assert.equal(deliveries.find(item=>item.to==='ja@example.test')?.body,'本文')
 assert.doesNotMatch(JSON.stringify(result),/@example\.test/)
 assert.deepEqual(metrics.map(item=>item.status).sort(),['failed','sent','sent','sent'])
 assert.equal(metrics.find(item=>item.status==='failed')?.error_code,'smtp_delivery_error')
 assert.doesNotMatch(JSON.stringify(metrics),/@example\.test/)
})
