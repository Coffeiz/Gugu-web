import assert from 'node:assert/strict'
import test from 'node:test'
import { createEmailRecipientLister } from '../../../src/modules/admin/email.js'

test('发布收件人沿用活跃订阅、有效邮箱和损坏 locale 回退规则',async()=>{
 const list=createEmailRecipientLister(async()=>({rows:[
  {email:' a@example.test ',data_json:'{"locale":"en-US"}'},
  {email:'b@example.test',data_json:'{"locale":"ja-JP"}'},
  {email:'bad',data_json:'{}'},
  {email:'c@example.test',data_json:'broken'},
 ]}))
 assert.deepEqual(await list(),{'zh-CN':['c@example.test'],'ja-JP':['b@example.test'],'en-US':['a@example.test']})
})
