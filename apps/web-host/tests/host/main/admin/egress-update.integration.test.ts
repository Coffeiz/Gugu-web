import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import type {LightMyRequestResponse} from 'fastify'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startServer } from '../../../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test('生产Host安全出站PATCH只写指定段并由真实Python消费者解密使用',async()=>{
 assert.ok(databaseUrl);const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
 const root=await mkdtemp(join(tmpdir(),'egress-main-')),path=join(root,'override.json')
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  const document={db:{marker:'preserve'},llm_presets:{items:[{id:'keep'}]}}
  await writeFile(path,JSON.stringify(document))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-egress-secret',GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const url='/api/v1/admin/safe-egress'
  assert.equal((await host.app.inject({method:'PATCH',url,payload:{enabled:true}})).statusCode,401)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200)
  const headers={authorization:`Bearer ${login.json().access_token}`}
  const response:LightMyRequestResponse=await host.app.inject({method:'PATCH',url,headers,payload:{enabled:'YES',proxy_url:'http://proxy.example:3128/',proxy_username:'synthetic-user',proxy_password:'synthetic-password'}})
  assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{enabled:true,proxy_url:'http://proxy.example:3128',has_auth:true});assert.equal(response.body.includes('synthetic-password'),false)
  const saved=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(saved.db,document.db);assert.deepEqual(saved.llm_presets,document.llm_presets);assert.ok(saved.safe_egress.proxy_auth_secret.startsWith('gcm1:'));assert.equal((await readFile(path,'utf8')).includes('synthetic-password'),false)
  const consume=(auth:string[]|null)=>assert.equal(execFileSync(python,[resolve('tests/admin/fixtures/safe_egress_consumer.py'),'--allow-isolated-test-config',path],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend')},input:JSON.stringify({proxy_url:'http://proxy.example:3128',auth}),encoding:'utf8'}).trim(),'accepted')
  consume(['synthetic-user','synthetic-password'])
  assert.equal((await host.app.inject({method:'PATCH',url,headers,payload:{proxy_username:'changed-user'}})).statusCode,200);consume(['changed-user','synthetic-password'])
  assert.equal((await host.app.inject({method:'PATCH',url,headers,payload:{clear_credentials:true}})).json().has_auth,false);consume(null)
 }finally{await host?.close();await rm(root,{recursive:true,force:true})}
})
