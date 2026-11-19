import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as proxyServer } from 'node:http'
import { createServer as tlsServer } from 'node:https'
import { connect } from 'node:net'
import { createSecureContext } from 'node:tls'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSafeEgressFileProbe } from '../../src/modules/admin/network.js'
import { encryptEncryptedString } from '../../src/adapters/security/encrypted-string.js'

test('安全出站试测经代理DoH并以公网IP建立固定目标TLS，不跟随跳转', async () => {
 const root=await mkdtemp(join(tmpdir(),'egress-probe-')),cert=join(root,'cert.pem'),key=join(root,'key.pem'),config=join(root,'config.json')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=cloudflare-dns.com','-addext','subjectAltName=DNS:cloudflare-dns.com,DNS:ja.wikipedia.org'],{stdio:'ignore'})
 const badKey=join(root,'bad-key.pem'),badCert=join(root,'bad-cert.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',badKey,'-out',badCert,'-days','1','-subj','/CN=invalid.example'],{stdio:'ignore'})
 let address='192.0.0.9',status=204,deny=false,badTarget=false;const seen:string[]=[],auth:string[]=[]
 const goodContext=createSecureContext({key:await readFile(key),cert:await readFile(cert)}),badContext=createSecureContext({key:await readFile(badKey),cert:await readFile(badCert)})
 const origin=tlsServer({key:await readFile(key),cert:await readFile(cert),SNICallback:(name,cb)=>cb(null,badTarget&&name==='ja.wikipedia.org'?badContext:goodContext)},(req,res)=>{
  seen.push(`${req.headers.host}${req.url}`)
  if(req.headers.host==='cloudflare-dns.com'){res.setHeader('content-type','application/json');res.end(JSON.stringify({Status:0,Answer:req.url?.includes('AAAA')?[]:[{type:1,data:address}]}));return}
  res.writeHead(status,{location:'https://invalid.example/'});res.end()
 })
 await new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve));const port=(origin.address() as {port:number}).port
 const proxy=proxyServer((_req,res)=>{res.writeHead(405);res.end()})
 const sockets=new Set<import('node:stream').Duplex>()
 proxy.on('connect',(req,socket,head)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket))
  seen.push(`CONNECT ${req.url}`)
  auth.push(String(req.headers['proxy-authorization'] ?? ''))
  if(deny){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return}
  const upstream=connect(port,'127.0.0.1');upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket)});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy())
 })
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyPort=(proxy.address() as {port:number}).port
 await writeFile(config,JSON.stringify({safe_egress:{enabled:false,proxy_url:`http://127.0.0.1:${proxyPort}`,proxy_auth_secret:encryptEncryptedString('synthetic-secret',JSON.stringify({username:'tester',password:'synthetic'}))}}))
 try{
  const probe=createSafeEgressFileProbe({SSL_CERT_FILE:cert},config,'synthetic-secret')
  const ok=await probe({});assert.equal(ok.ok,true);assert.equal(ok.stage,'connected');assert.ok(seen.includes('CONNECT cloudflare-dns.com:443'));assert.ok(seen.includes('CONNECT 192.0.0.9:443'));assert.ok(seen.some(value=>value.startsWith('ja.wikipedia.org/wiki/Muque')))
  assert.ok(auth.every(value=>value===`Basic ${Buffer.from('tester:synthetic').toString('base64')}`))
  auth.length=0;assert.equal((await probe({clear_credentials:true})).ok,true);assert.ok(auth.every(value=>value===''))
  address='127.0.0.1';assert.equal((await probe({})).stage,'non_public_destination')
  address='192.0.0.9';status=302;assert.equal((await probe({})).stage,'connected');assert.equal(seen.some(value=>value.includes('invalid.example')),false)
  badTarget=true;assert.equal((await probe({})).stage,'tls_verification_failed');badTarget=false
  deny=true;assert.equal((await probe({})).stage,'proxy_unavailable')
 }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));origin.closeAllConnections();await new Promise<void>(resolve=>origin.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
})
