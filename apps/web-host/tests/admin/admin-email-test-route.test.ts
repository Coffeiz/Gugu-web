import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import {temporarySmtp} from './fixtures/temporary-smtp.js'
import {createAdminEmailFileTest,registerAdminEmailTestRoute} from '../../src/modules/admin/email.js'
test('管理员测试邮件真实SMTP：认证/匿名、locale、动态配置、DTO限额及失败脱敏',async()=>{
 const root=await mkdtemp(join(tmpdir(),'smtp-probe-')),path=join(root,'override.json'),relay=await temporarySmtp(root),python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
 const settings={host:'127.0.0.1',port:relay.port,user:'sender@example.test',password:'synthetic-secret',from_addr:'测试咕咕',use_ssl:true}
 const original=JSON.stringify({smtp:settings,other:{keep:true}});await writeFile(path,original)
 const app=Fastify();registerAdminEmailTestRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')await reply.code(401).send({detail:'需要管理员认证'})},send:createAdminEmailFileTest({SSL_CERT_FILE:relay.cert},path)})
 const draft={subject:'主题',title:'标题',body:'正文',recipient:'recipient@example.test',test_locale:'ja-JP',translations:{'ja-JP':{subject:'翻訳',title:'見出し',body:'本文'}}},call=(payload:object,auth='admin')=>app.inject({method:'POST',url:'/api/v1/admin/email/test',headers:{authorization:auth},payload})
 async function py(payload:object){const child=execFile(python!,[resolve('tests/admin/fixtures/admin_email_test_python.py'),path],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend'),SSL_CERT_FILE:relay.cert},timeout:20000});child.stdin!.end(JSON.stringify(payload));return new Promise<any>((yes,no)=>{let out='',err='';child.stdout!.on('data',c=>out+=c);child.stderr!.on('data',c=>err+=c);child.on('exit',code=>code===0?yes(JSON.parse(out)):no(Error(err)))})}
 try{
  assert.equal((await call(draft,'')).statusCode,401);assert.equal(relay.received.length,0)
  for(const patch of [{recipient:'bad'},{recipient:'a@b.test\nBcc: intruder@example.test'},{recipient:'x'.repeat(301)},{test_locale:'ko-KR'},{body:'x'.repeat(20001)},{subject:''},{sections:Array.from({length:9},()=>({text:'章节'}))},{actions:Array.from({length:4},()=>({label:'按钮',url:'https://example.test'}))},{translations:{invalid:{subject:'a',title:'b',body:'c'}}}])assert.equal((await call({...draft,...patch})).statusCode,422)
  const result=(await call(draft)).json();assert.deepEqual(result,await py(draft));assert.equal(result.ok,true);assert.equal(relay.received.length,2);for(const item of relay.received){assert.equal(item.auth.length,1);assert.equal(item.encrypted,true);assert.match(item.to[0]!,/recipient@example\.test/)}
  assert.equal(await readFile(path,'utf8'),original)
  relay.implicit=false;await writeFile(path,JSON.stringify({smtp:{...settings,user:'',password:'',from_addr:'sender@example.test',use_ssl:false}}))
  assert.deepEqual((await call({...draft,test_locale:'en-US'})).json(),await py({...draft,test_locale:'en-US'}));assert.equal(relay.received.length,4);for(const item of relay.received.slice(2)){assert.deepEqual(item.auth,[]);assert.equal(item.encrypted,true)}
  relay.implicit=true;relay.rejectAuth=true;await writeFile(path,original);const failure=await call(draft);assert.deepEqual(failure.json(),await py(draft));assert.equal(failure.json().error_code,'smtp_delivery_error');assert.equal(failure.body.includes('synthetic-secret'),false)
  relay.rejectAuth=false
  const untrusted=Fastify();registerAdminEmailTestRoute(untrusted,{requireAdmin:async()=>{},send:createAdminEmailFileTest({},path)})
  const tlsFailure=await untrusted.inject({method:'POST',url:'/api/v1/admin/email/test',payload:draft});assert.equal(tlsFailure.json().error_code,'smtp_tls_error');assert.equal(tlsFailure.body.includes(root),false);await untrusted.close()
  assert.equal((await call({...draft,test_locale:'zh-CN',subject:'主题\nBcc: intruder@example.test'})).json().ok,false)
  assert.equal((await call({...draft,test_locale:'zh-CN',actions:[{label:'按钮',url:'javascript:alert(1)'}]})).json().error_code,'email_template_invalid')
  await writeFile(path,JSON.stringify({smtp:{...settings,host:''}}));assert.deepEqual((await call(draft)).json(),await py(draft));assert.equal((await call(draft)).json().error_code,'smtp_not_configured')
  await writeFile(path,'broken');assert.equal((await call(draft)).statusCode,503);assert.equal(await readFile(path,'utf8'),'broken')
 }finally{await app.close();await relay.close();await rm(root,{recursive:true,force:true})}
})
