import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer,type Socket} from 'node:net'
import {TLSSocket,createSecureContext} from 'node:tls'
export async function temporarySmtp(root:string) {
 const key=join(root,'key.pem'),cert=join(root,'cert.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
 const context=createSecureContext({key:await readFile(key),cert:await readFile(cert)})
 const received:{auth:string[];data:string;encrypted:boolean;from:string;to:string[]}[]=[],sockets=new Set<Socket>()
 let implicit=true,rejectAuth=false,advertiseStartTls=true
 const server=createServer(raw=>{
  sockets.add(raw);raw.on('close',()=>sockets.delete(raw))
  const record={auth:[] as string[],data:'',encrypted:false,from:'',to:[] as string[]};let socket:Socket=raw,buffer='',data=false
  const install=(next:Socket)=>{socket=next;socket.on('data',onData);socket.on('error',()=>{})}
  const onData=(chunk:Buffer)=>{buffer+=chunk.toString();for(;;){const i=buffer.indexOf('\r\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+2);if(data){if(line==='.'){data=false;received.push(record);socket.write('250 delivered\r\n')}else record.data+=line+'\r\n';continue}
   if(/^EHLO|^HELO/i.test(line))socket.write('250-localhost\r\n'+(advertiseStartTls?'250-STARTTLS\r\n':'')+'250 AUTH PLAIN\r\n')
   else if(line.toUpperCase()==='STARTTLS'&&!advertiseStartTls)socket.write('502 STARTTLS unavailable\r\n')
   else if(line.toUpperCase()==='STARTTLS'){socket.write('220 start TLS\r\n');socket.removeListener('data',onData);buffer='';const tls=new TLSSocket(socket,{isServer:true,secureContext:context});record.encrypted=true;install(tls)}
   else if(line.toUpperCase().startsWith('AUTH ')){record.auth.push(line);socket.write(rejectAuth?'535 synthetic-secret rejected\r\n':'235 authenticated\r\n')}
   else if(line.toUpperCase().startsWith('MAIL FROM:')){record.from=line;socket.write('250 OK\r\n')}
   else if(line.toUpperCase().startsWith('RCPT TO:')){record.to.push(line);socket.write('250 OK\r\n')}
   else if(line.toUpperCase()==='DATA'){data=true;socket.write('354 continue\r\n')}
   else if(line.toUpperCase()==='QUIT'){socket.end('221 bye\r\n')}
   else socket.write('250 OK\r\n')
  }}
  if(implicit){record.encrypted=true;install(new TLSSocket(raw,{isServer:true,secureContext:context}))}else install(raw)
  socket.write('220 isolated SMTP\r\n')
 })
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string')
 return {cert,port:address.port,received,set implicit(value:boolean){implicit=value},set rejectAuth(value:boolean){rejectAuth=value},set advertiseStartTls(value:boolean){advertiseStartTls=value},async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()))}}
}
