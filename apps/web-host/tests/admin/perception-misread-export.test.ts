import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,chmod,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import Fastify from 'fastify'
import {createMisreadMarkdownExporter} from '@gugu/core/perception-misread-export'
import {createLocalMisreadTextReader,registerAdminMisreadExportRoute} from '../../src/modules/admin/perception.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('固定Local错读文件与Python读端一致，空/缺失/UTF8替换及安全路径',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON
 assert.ok(python,'需要显式隔离测试Python')
 const root=await mkdtemp(join(tmpdir(),'gugu-misread-markdown-')),storage=join(root,'storage'),directory=join(storage,'_analytics'),file=join(directory,'misread.md')
 await mkdir(directory,{recursive:true})
 const read=createMisreadMarkdownExporter(createLocalMisreadTextReader(storage))
 const reference=()=>JSON.parse(execFileSync(python,['-c',`import asyncio,json,os
from pathlib import Path
from agent.memory import store
from app.services.storage import LocalStorageBackend
from app.api.v1.agent_perception import misread_export
store.get_storage=lambda:LocalStorageBackend(Path(os.environ['TEST_STORAGE']))
response=asyncio.run(misread_export())
print(json.dumps({'body':response.body.decode(),'type':response.headers['content-type'],'disposition':response.headers['content-disposition']}))`],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-misread-md',TEST_STORAGE:storage}}))
 try{
  assert.equal(await read(),reference().body)
  for(const bytes of [Buffer.from(' \n\t '),Buffer.from('\u0085合成错读记录 😀\n\n正文\u0085'),Buffer.from([0xff,0x61,0xc3])]){await writeFile(file,bytes);assert.equal(await read(),reference().body)}
  await chmod(directory,0)
  try{await assert.rejects(()=>read(),(error:NodeJS.ErrnoException)=>error.code==='EACCES')}finally{await chmod(directory,0o700)}
  await rm(file);const outside=join(root,'outside.md');await writeFile(outside,'synthetic-outside-content');await symlink(outside,file)
  await assert.rejects(()=>read());
 }finally{await chmod(directory,0o700).catch(()=>undefined);await rm(root,{recursive:true,force:true})}
})
test('Markdown附件仅管理员可读，固定文件缺失正常，真实权限错误500且不泄露路径',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-misread-http-')),directory=join(root,'_analytics');await mkdir(directory)
 const app=Fastify();installHttpErrorHandler(app)
 registerAdminMisreadExportRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},read:createMisreadMarkdownExporter(createLocalMisreadTextReader(root))})
 try{
  const url='/api/v1/admin/perception/misread/export',headers={authorization:'admin'}
  assert.equal((await app.inject(url)).statusCode,401);assert.equal((await app.inject({url,headers:{authorization:'user'}})).statusCode,403)
  const empty=await app.inject({url,headers});assert.equal(empty.statusCode,200);assert.match(empty.body,/暂无/)
  assert.equal(empty.headers['content-disposition'],'attachment; filename="misread_reflections.md"');assert.equal(empty.headers['content-type'],'text/markdown; charset=utf-8')
  await writeFile(join(directory,'misread.md'),' \n合成记录\n ')
  assert.equal((await app.inject({url:url+'?path=../../outside',headers})).body,'合成记录')
  await chmod(directory,0)
  const error=await app.inject({url,headers});assert.equal(error.statusCode,500);assert.doesNotMatch(error.body,/gugu-misread|EACCES|_analytics|misread.md/)
 }finally{await chmod(directory,0o700);await app.close();await rm(root,{recursive:true,force:true})}
})
