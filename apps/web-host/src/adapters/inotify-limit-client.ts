import {createConnection} from 'node:net'
import {WatcherCapacityUnavailable} from '@gugu/core/filesync/watcher-capacity'
export const defaultWatchLimitSocket='/run/gugu-inotify-limitd/limitd.sock'
/** 正式Python helper的单行JSON协议；不接受HTTP请求指定路径、操作或sysctl值。 */
export function createWatcherCapacityRequester(env:NodeJS.ProcessEnv) {
 return async():Promise<Record<string,unknown>>=>new Promise((resolve,reject)=>{
  const socket=createConnection({path:env.FILESYNC__WATCH_LIMIT_SOCKET??defaultWatchLimitSocket})
  let pending=Buffer.alloc(0),done=false
  let timer=setTimeout(()=>finish(),2000)
  function finish(result?:Record<string,unknown>){if(done)return;done=true;clearTimeout(timer);socket.destroy();if(result)resolve(result);else reject(new WatcherCapacityUnavailable())}
  socket.once('connect',()=>{clearTimeout(timer);timer=setTimeout(()=>finish(),3000);socket.write('{"operation":"expand"}\n')})
  function parse(raw:Buffer){
   try{const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(!result||typeof result!=='object'||Array.isArray(result)||(result as Record<string,unknown>).ok!==true){finish();return}finish(result as Record<string,unknown>)}catch{finish()}
  }
  socket.on('error',()=>finish());socket.once('end',()=>{if(pending.length&&pending.length<=4096)parse(pending);else finish()})
  socket.on('data',chunk=>{
   pending=Buffer.concat([pending,Buffer.from(chunk)]);const end=pending.indexOf(10)
   if(end<0){if(pending.length>4096)finish();return}
   if(end+1>4096){finish();return}
   parse(pending.subarray(0,end))
  })
 })
}
