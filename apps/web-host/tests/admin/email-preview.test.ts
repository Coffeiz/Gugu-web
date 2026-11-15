import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {renderEmailPreview} from '@gugu/core/email-preview'
import {registerAdminEmailPreviewRoute} from '../../src/modules/admin/email-preview.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

const python=process.env.GUGU_WEBUI_TEST_PYTHON
function reference(drafts:unknown[]){
 assert.ok(python,'需要显式隔离测试Python')
 return JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from pydantic import ValidationError
from fastapi import HTTPException
from app.api.v1.email_admin import EmailDraft,preview_email
result=[]
for value in json.load(sys.stdin):
 try: result.append({'status':200,'body':asyncio.run(preview_email(EmailDraft.model_validate(value)))})
 except ValidationError: result.append({'status':422})
 except HTTPException as exc: result.append({'status':exc.status_code,'body':{'detail':exc.detail}})
print(json.dumps(result))`],{cwd:resolve('../../backend'),input:JSON.stringify(drafts),encoding:'utf8',maxBuffer:12*1024*1024,env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-email-preview-config'}})) as {status:number,body?:unknown}[]
}
const content={subject:' 项目 <进度> & "引号" ',title:' 标题😀 ',preheader:" 摘要 '安全' ",body:' 第一行\n<script>合成内容</script> ',sections:[{heading:' 分组 ',text:' 已完成\n下一步 & 验证 '},{text:' 无标题 '}],actions:[{label:' 打开 ',url:'https://example.invalid/a?x=1&y=2'},{label:' 联系 ',url:'mailto:synthetic@example.invalid'}]}

test('完整邮件预览与真实Python的10色板、5模板及内嵌PNG逐字节一致',()=>{
 const drafts=[]
 for(const theme of ['light','dark'])for(const palette of ['cafe','neutral','red','blue','green'])drafts.push({...content,theme,palette})
 for(const template of ['notification','reminder','report','security','test'])drafts.push({...content,template,title:content.subject,preheader:'',sections:[],actions:[]})
 drafts.push({...content,subject:' ',title:' ',body:' ',preheader:' ',sections:[],actions:[]})
 const expected=reference(drafts)
 for(const [index,draft] of drafts.entries()){
  assert.equal(expected[index]!.status,200)
  const actual=renderEmailPreview(draft)
  assert.deepEqual(actual,expected[index]!.body)
  assert.equal((actual.html.match(/data:image\/png;base64,/g)||[]).length,2)
  assert.doesNotMatch(actual.html,/<script>|cid:gugu/)
 }
})

test('管理员鉴权、Pydantic边界和renderer的400错误与Python保持一致',async()=>{
 const app=Fastify();installHttpErrorHandler(app);let calls=0
 registerAdminEmailPreviewRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},render:draft=>{calls++;return renderEmailPreview(draft)}})
 try{
  const url='/api/v1/admin/email/preview'
  assert.equal((await app.inject({method:'POST',url,payload:content})).statusCode,401)
  assert.equal((await app.inject({method:'POST',url,payload:content,headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  const drafts=[content,{...content,translations:{'en-US':{...content,body:'translated'}}},
   {...content,body:'😀'.repeat(20000),sections:[],actions:[]},
   {...content,title:'😀'.repeat(201)},{...content,title:''},{...content,title:7},
   {...content,theme:'glass'},{...content,palette:'purple'},{...content,template:'custom'},
   {...content,sections:[{text:' '}]},{...content,actions:[{label:' ',url:'https://example.invalid'}]},
   {...content,actions:[{label:'点击',url:'javascript:alert(1)'}]},
   {...content,actions:[{label:'点击',url:'https://example.invalid/\npath'}]},
   {...content,actions:[{label:'点击',url:'http:relative'}]},
   {...content,actions:[{label:'点击',url:'http://[broken'}]},
   ...['https://[::1]:not-a-port/a','https://[v1.synthetic]/a','https://[fe80::1%eth0]/a','https://exa mple.invalid/a','https://user:pass@example.invalid:999999/a','MAILTO:synthetic@example.invalid'].map(url=>({...content,actions:[{label:'打开',url}]})),
   {...content,sections:Array.from({length:9},()=>({text:'内容'}))},
   {...content,translations:{'de-DE':content}}, {...content,translations:{'en-US':{subject:'无正文'}}},
   {...content,translations:null},{...content,actions:null},{...content,sections:[null]},
   {...content,preheader:null},{...content,body:' '.repeat(20001)}]
  const expected=reference(drafts)
  for(const [index,payload] of drafts.entries()){
   const response=await app.inject({method:'POST',url,payload,headers:{authorization:'admin'}})
   assert.equal(response.statusCode,expected[index]!.status,`case ${index}: ${response.body.slice(0,150)}`)
   if(expected[index]!.body)assert.deepEqual(response.json(),expected[index]!.body)
  }
 }finally{await app.close()}
})
