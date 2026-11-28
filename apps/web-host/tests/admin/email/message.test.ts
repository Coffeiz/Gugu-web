import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import test from 'node:test'
import {testAdminEmail} from '@gugu/core/email/test-delivery'

test('管理员邮件测试按locale及回退选择完整内容，与Python实际handler的十种色板MIME及状态一致',async()=>{
 const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
 const draft={subject:' 邮件主题 ',title:'邮件标题',body:'正文<&>\n第二行',preheader:'摘要',recipient:'recipient@example.test',sections:[{heading:'章节',text:'正文片段'}],actions:[{label:'进入',url:'https://example.test/?x=1&y=2'}],translations:{'ja-JP':{subject:'翻訳',title:'見出し',body:'本文',sections:[],actions:[]}}}
 const cases=[];for(const theme of ['light','dark'])for(const palette of ['cafe','neutral','red','blue','green'])cases.push({...draft,theme,palette,test_locale:'ja-JP'},{...draft,theme,palette,test_locale:'zh-CN'})
 cases.push({...draft,test_locale:'en-US'},{...draft,test_locale:'zh-CN'})
 const expected=JSON.parse(execFileSync(python,[resolve('tests/admin/fixtures/admin_email_message_python.py')],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend')},input:JSON.stringify(cases),encoding:'utf8'}))
 const settings={host:'smtp.example.test',port:465,user:'sender@example.test',password:'synthetic',from_addr:'测试咕咕',to_addr:'',test_to_addr:'',use_ssl:true}
 for(const [index,item] of cases.entries()){
  let message:unknown
  const result=await testAdminEmail(item,settings,async delivery=>{message={...delivery.message,images:delivery.message.images.map(image=>({cid:image.cid,filename:image.filename,sha256:createHash('sha256').update(Buffer.from(image.base64,'base64')).digest('hex')}))};assert.equal(delivery.toAddress,item.recipient)})
  assert.deepEqual({result,message},expected[index])
 }
})
