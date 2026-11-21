import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import {temporarySmtp} from '../fixtures/temporary-smtp.js'
import {createSmtpFileProbe,registerSmtpProbeRoute} from '../../../src/modules/admin/smtp.js'

test('管理员SMTP真实TLS/STARTTLS、无认证/密码回退、动态只读配置与Python一致',async()=>{
 const root=await mkdtemp(join(tmpdir(),'smtp-probe-')),path=join(root,'override.json')
 const relay=await temporarySmtp(root),{cert,received}=relay
 const settings={host:'127.0.0.1',port:relay.port,user:'sender@example.test',password:'synthetic-secret',from_addr:'测试咕咕',test_to_addr:'recipient@example.test',to_addr:'fallback@example.test'}
 await writeFile(path,JSON.stringify({smtp:settings,db:{preserve:true}}));const original=await readFile(path,'utf8')
 const env={SMTP:JSON.stringify({...settings,host:'wrong.example.test'}),smtp__host:'127.0.0.1',SSL_CERT_FILE:cert}
 const app=Fastify();registerSmtpProbeRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')await reply.code(401).send({detail:'需要管理员认证'})},probe:createSmtpFileProbe(env,path)})
 const body={host:'',port:0,user:'',to_addr:''},call=(payload:object,auth='admin')=>app.inject({method:'POST',url:'/api/v1/admin/config/test-smtp',headers:{authorization:auth},payload})
 const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
 async function py(payload:object){const child=execFile(python!,[resolve('tests/admin/fixtures/smtp_probe_python.py'),path],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend'),...env,SMTP:JSON.stringify(settings)},timeout:20000});child.stdin!.end(JSON.stringify(payload));return new Promise<any>((yes,no)=>{let out='',err='';child.stdout!.on('data',c=>out+=c);child.stderr!.on('data',c=>err+=c);child.on('exit',code=>code===0?yes(JSON.parse(out)):no(Error(err)))})}
 try{
  assert.equal((await call(body,'')).statusCode,401);assert.equal(received.length,0)
  assert.equal((await call({})).statusCode,422)
  for(const patch of [{host:null},{user:12},{port:1.5},{port:'2e3'},{use_ssl:[]},{use_ssl:null},{to_addr:[]}])assert.equal((await call({...body,...patch})).statusCode,422)

  const node=(await call(body)).json();assert.deepEqual(node,await py(body));assert.equal(node.ok,true)
  assert.equal(received.length,2);for(const msg of received){assert.equal(msg.encrypted,true);assert.equal(Buffer.from(msg.auth[0]!.split(' ')[2]!,'base64').toString(),'\0sender@example.test\0synthetic-secret');assert.match(msg.from,/sender@example\.test/);assert.match(msg.to[0]!,/recipient@example\.test/)}
  // MIME解析比较用户可观察内容，忽略边界、Date、Message-ID和传输编码等无关差异。
  const parse=String.raw`import sys,json,email,hashlib
from email import policy
m=email.message_from_string(sys.stdin.read(),policy=policy.default)
print(json.dumps({'subject':str(m['Subject']),'from':str(m['From']),'to':str(m['To']),'types':[p.get_content_type() for p in m.walk()],'plain':m.get_body(preferencelist=('plain',)).get_content().rstrip('\r\n'),'html':m.get_body(preferencelist=('html',)).get_content().replace('\r\n','\n').rstrip('\n'),'images':[(p['Content-ID'],p.get_filename(),p['Content-Disposition'].split(';')[0],hashlib.sha256(p.get_payload(decode=True)).hexdigest()) for p in m.walk() if p.get_content_maintype()=='image']},ensure_ascii=False))`
  const parsed=[];for(const item of received){const child=execFile(python!,['-c',parse]);child.stdin!.end(item.data);parsed.push(await new Promise<string>((yes,no)=>{let out='';child.stdout!.on('data',c=>out+=c);child.on('exit',code=>code===0?yes(out):no(Error('MIME解析失败')))}))}assert.deepEqual(JSON.parse(parsed[0]!),JSON.parse(parsed[1]!))
  assert.equal(await readFile(path,'utf8'),original,'SMTP测试必须保持原JSON及其他配置段原样')
  const previous=received.length
  assert.equal((await call({...body,to_addr:'recipient@example.test\nBcc: intruder@example.test'})).json().ok,false)
  assert.equal((await py({...body,to_addr:'recipient@example.test\nBcc: intruder@example.test'})).ok,false)
  assert.equal(received.length,previous,'非法邮件头不得发送')
  relay.implicit=false;await writeFile(path,JSON.stringify({smtp:{...settings,user:'',password:'',from_addr:'sender@example.test',test_to_addr:'',to_addr:'fallback@example.test'}}))
  assert.deepEqual((await call({...body,use_ssl:'NO'})).json(),await py({...body,use_ssl:'NO'}));assert.equal(received.length,4);for(const msg of received.slice(2)){assert.deepEqual(msg.auth,[]);assert.equal(msg.encrypted,true);assert.match(msg.to[0]!,/fallback@example\.test/)}
  relay.advertiseStartTls=false;assert.equal((await call({...body,use_ssl:false})).json().ok,false);assert.equal((await py({...body,use_ssl:false})).ok,false);assert.equal(received.length,4,'服务端不支持STARTTLS时不能降级发送或认证');relay.advertiseStartTls=true
  relay.implicit=true
  await writeFile(path,JSON.stringify({smtp:{},db:{preserve:true}}))
  assert.equal((await call({...body,port:String(settings.port)+'.0',use_ssl:'YES'})).json().ok,true)
  assert.equal(received.length,5,'override缺省字段应遵循SMTP JSON与nested环境优先级')
  const untrusted=Fastify();registerSmtpProbeRoute(untrusted,{requireAdmin:async()=>{},probe:createSmtpFileProbe({SMTP:JSON.stringify(settings)},path)})
  const rejected=await untrusted.inject({method:'POST',url:'/api/v1/admin/config/test-smtp',payload:body});assert.equal(rejected.json().ok,false);assert.equal(received.length,5,'不能绕过证书验证发送');await untrusted.close()
  relay.implicit=true;relay.rejectAuth=true;await writeFile(path,original);const failed=await call(body);assert.equal(failed.statusCode,200);assert.equal(failed.json().ok,false);assert.equal(failed.body.includes('synthetic-secret'),false)
  await writeFile(path,JSON.stringify({smtp:{host:'',test_to_addr:''}}));const blankApp=Fastify();registerSmtpProbeRoute(blankApp,{requireAdmin:async()=>{},probe:createSmtpFileProbe({SSL_CERT_FILE:cert},path)});assert.deepEqual((await blankApp.inject({method:'POST',url:'/api/v1/admin/config/test-smtp',payload:body})).json(),{ok:false,message:'SMTP 服务器未配置'});await blankApp.close()
  await writeFile(path,JSON.stringify({smtp:{...settings,test_to_addr:'',to_addr:''}}));const missingTo=Fastify();registerSmtpProbeRoute(missingTo,{requireAdmin:async()=>{},probe:createSmtpFileProbe({SSL_CERT_FILE:cert},path)});assert.deepEqual((await missingTo.inject({method:'POST',url:'/api/v1/admin/config/test-smtp',payload:body})).json(),{ok:false,message:'收件人地址未配置'});await missingTo.close()
  await writeFile(path,'broken');assert.equal((await call(body)).statusCode,503);assert.equal(await readFile(path,'utf8'),'broken')
 }finally{await app.close();await relay.close();await rm(root,{recursive:true,force:true})}
})
