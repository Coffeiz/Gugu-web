import assert from 'node:assert/strict'
import test from 'node:test'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
import {startServer} from '../../src/main.js'
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产Host调用正式Python容量helper：只改临时sysctl，一档/并发/动态硬上限及Python API对照',async()=>{
 const python=process.env.GUGU_CORE_GOLDEN_PYTHON,databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL;assert.ok(python);assert.ok(databaseUrl)
 const root=await mkdtemp(join(tmpdir(),'watch-main-')),path=join(root,'override.json'),socketPath=join(root,'helper.sock'),fixture=resolve('tests/admin/fixtures/watch_limit_helper.py'),pythonEnv={...process.env,PYTHONPATH:resolve('../../backend')}
 await writeFile(path,JSON.stringify({filesync:{watch_hard_limit:131072},db:{keep:true}}))
 const helper=spawn(python,[fixture,'--serve-isolated',root],{cwd:resolve('../../backend'),env:pythonEnv,stdio:['pipe','pipe','pipe']});let host:Awaited<ReturnType<typeof startServer>>|undefined;let err='';helper.stderr.on('data',c=>err+=c)
 try{
  await new Promise<void>((yes,no)=>{helper.stdout.once('data',c=>c.toString().trim()==='ready'?yes():no(Error('helper未就绪')));helper.once('error',no);helper.once('exit',code=>{if(code!==null)no(Error(err||`helper退出${code}`))})})
  host=await startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-watch-secret',GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',FILESYNC__WATCH_LIMIT_SOCKET:socketPath,ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const url='/api/v1/admin/filesync/watcher-capacity/expand'
  assert.equal((await host.app.inject({method:'POST',url})).statusCode,401);assert.equal((await readFile(join(root,'max_user_watches'),'utf8')).trim(),'65536')
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const results=await Promise.all([1,2].map(()=>host!.app.inject({method:'POST',url,headers,payload:{operation:'other',hardLimit:1024000}})))
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);const expanded=results.find(r=>r.statusCode===200)!.json();assert.equal(expanded.ok,true);assert.equal(expanded.limit,131072);assert.equal(expanded.previousLimit,65536);assert.equal(expanded.usage,1);assert.equal(expanded.hardLimit,131072);assert.equal((await readFile(join(root,'max_user_watches'),'utf8')).trim(),'131072')
  const callPython=()=>JSON.parse(execFileSync(python,[fixture,'--call-isolated',root],{cwd:resolve('../../backend'),env:pythonEnv,encoding:'utf8'}))
  assert.deepEqual(callPython(),{status:409,body:{detail:'当前容量已达到配置硬上限'}})
  await writeFile(join(root,'next.json'),JSON.stringify({filesync:{watch_hard_limit:262144},db:{keep:true}}));await rename(join(root,'next.json'),path)
  const py=callPython();assert.equal(py.status,200);assert.equal(py.body.limit,262144);assert.equal(py.body.previousLimit,131072);assert.equal(py.body.usage,1);assert.equal((await readFile(join(root,'max_user_watches'),'utf8')).trim(),'262144')
  assert.equal((await host.app.inject({method:'POST',url,headers})).statusCode,409)
  await writeFile(path,'broken-json');const broken=await host.app.inject({method:'POST',url,headers});assert.equal(broken.statusCode,503);assert.equal(broken.body.includes(root),false);assert.equal((await readFile(join(root,'max_user_watches'),'utf8')).trim(),'262144')
  helper.stdin.end();await once(helper,'exit');const offline=await host.app.inject({method:'POST',url,headers});assert.equal(offline.statusCode,503);assert.deepEqual(offline.json(),{detail:'宿主机 watcher 管理服务不可用'})
 }finally{await host?.close();helper.stdin.end();if(helper.exitCode===null){helper.kill();await once(helper,'exit')}await rm(root,{recursive:true,force:true})}
})
