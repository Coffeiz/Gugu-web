import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createServer as netServer, connect } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startServer } from '../../../../src/main.js'

async function freePort(){const s=netServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产管理员安全出站试测使用动态配置与隔离代理',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL;assert.ok(databaseUrl)
 const root=await mkdtemp(join(tmpdir(),'egress-main-')),cert=join(root,'cert.pem'),key=join(root,'key.pem'),config=join(root,'override.json')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=cloudflare-dns.com','-addext','subjectAltName=DNS:cloudflare-dns.com,DNS:ja.wikipedia.org'],{stdio:'ignore'})
 let requests=0
 const origin=httpsServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{requests++;if(req.headers.host==='cloudflare-dns.com'){res.setHeader('content-type','application/json');res.end(JSON.stringify({Status:0,Answer:req.url?.includes('AAAA')?[]:[{type:1,data:'192.0.0.9'}]}));return}res.writeHead(204);res.end()})
 await new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve));const port=(origin.address() as {port:number}).port
 const proxy=httpServer((_req,res)=>{res.writeHead(405);res.end()}),sockets=new Set<import('node:stream').Duplex>()
 proxy.on('connect',(_req,socket,head)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const upstream=connect(port,'127.0.0.1');upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket)});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy())})
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyPort=(proxy.address() as {port:number}).port
 const original=JSON.stringify({safe_egress:{enabled:false,proxy_url:`http://127.0.0.1:${proxyPort}`,proxy_auth_secret:''},db:{keep:true}});await writeFile(config,original)
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  host=await startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-egress-secret',GUGU_CONFIG_OVERRIDE_FILE:config,SSL_CERT_FILE:cert,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const url='/api/v1/admin/safe-egress/test';assert.equal((await host.app.inject({method:'POST',url,payload:{}})).statusCode,401);assert.equal(requests,0)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  assert.equal((await host.app.inject({method:'POST',url,headers,payload:{extra:true}})).statusCode,422)
  const result=await host.app.inject({method:'POST',url,headers,payload:{}});assert.equal(result.statusCode,200);assert.equal(result.json().stage,'connected');assert.equal(result.json().status_code,204);assert.equal(requests,3);assert.equal(await readFile(config,'utf8'),original)
 }finally{await host?.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));origin.closeAllConnections();await new Promise<void>(resolve=>origin.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
})
