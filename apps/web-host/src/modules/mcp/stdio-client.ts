import {Client} from '@modelcontextprotocol/client'
import type {Transport} from '@modelcontextprotocol/client'
import type {JSONRPCMessage} from '@modelcontextprotocol/client'
import {realpath} from 'node:fs/promises'
import path from 'node:path'
import {createMxcStdioProcess} from '@gugu/sandbox/platform'

interface StdioProcess {
 standardInput:NodeJS.WritableStream|null
 standardOutput:NodeJS.ReadableStream|null
 standardError:NodeJS.ReadableStream|null
 wait():Promise<{exitCode:number;timedOut:boolean}>
 kill():void
 dispose():void
}
type SpawnProcess=(input:{command:string;cwd:string;workspaceRoot:string})=>Promise<StdioProcess>

/** Python MCP 的工作区规则：<storage>/<owner>/workspace/default；禁止符号链接逃逸。 */
export async function resolveMcpWorkspaceRoot(storageRoot:string,owner:string):Promise<string>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner))throw new Error('MCP owner 无效')
 const storageReal=await realpath(storageRoot)
 const expectedOwner=path.resolve(storageReal,owner)
 const ownerRoot=await realpath(expectedOwner)
 if(ownerRoot!==expectedOwner)throw new Error('MCP 工作区路径无效')
 const workspacePath=path.join(ownerRoot,'workspace','default')
 const workspaceRoot=await realpath(workspacePath)
 const relative=path.relative(ownerRoot,workspaceRoot)
 if(relative!=='workspace/default')throw new Error('MCP 工作区路径无效')
 return workspaceRoot
}

/** 把官方 MCP Client 接到 MXC 管理的双向标准流；不经过系统 shell/child_process。 */
export function createMcpStdioClientFactory(options:{resolveWorkspaceRoot:(owner:string)=>Promise<string>;spawn?:SpawnProcess;maxSessions?:number|(()=>number);maxSessionsPerOwner?:number|(()=>number);idleSeconds?:number|(()=>number)}):
 (input:{owner:string;command:string;timeoutSeconds:number})=>Promise<{
  connect():Promise<void>
  listTools():Promise<{tools:unknown[]}>
  callTool(name:string,args:Record<string,unknown>,options?:{signal?:AbortSignal;timeout?:number}):Promise<unknown>
  close():Promise<void>
  isOpen():boolean
 }>{
 const spawn=options.spawn??createMxcStdioProcess
 const active=new Map<symbol,string>()
 return async input=>{
  const maxSessions=typeof options.maxSessions==='function'?options.maxSessions():options.maxSessions??8
  const maxPerOwner=typeof options.maxSessionsPerOwner==='function'?options.maxSessionsPerOwner():options.maxSessionsPerOwner??4
  if(active.size>=maxSessions||[...active.values()].filter(owner=>owner===input.owner).length>=maxPerOwner)
   throw new Error('MCP stdio 会话数已达上限')
  const session=Symbol('mcp-stdio')
  active.set(session,input.owner)
  let process:StdioProcess|undefined
  try{
   const workspaceRoot=await options.resolveWorkspaceRoot(input.owner)
   const spawned=await spawn({command:input.command,cwd:workspaceRoot,workspaceRoot})
   process=spawned
   let open=true
   const release=()=>{if(open){open=false;active.delete(session)}}
   const idleSeconds=typeof options.idleSeconds==='function'?options.idleSeconds():options.idleSeconds??300
   const transport=new MxcStdioTransport(spawned,idleSeconds,release)
   const client=new Client({name:'gugu-webui',version:'2.0.0'},{listMaxPages:8,enforceStrictCapabilities:true})
   const withTimeout=<T>(operation:Promise<T>,label:string)=>{
    let timer:ReturnType<typeof setTimeout>|undefined
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`MCP stdio ${label} timeout`)),input.timeoutSeconds*1000)})
    return Promise.race([operation,timeout]).finally(()=>{if(timer)clearTimeout(timer)})
   }
   return {
    connect:()=>withTimeout(client.connect(transport),'connect'),
    listTools:async()=>withTimeout(client.listTools(),'tools/list'),
    callTool:(name,args,callOptions)=>client.callTool({name,arguments:args},callOptions),
    close:()=>client.close(),
    isOpen:()=>open,
   }
  }catch(error){
   active.delete(session)
   try{process?.kill()}catch{}
   try{await process?.wait()}catch{}
   try{process?.dispose()}catch{}
   throw error
  }
 }
}

class MxcStdioTransport implements Transport{
 onclose?:()=>void
 onerror?:(error:Error)=>void
 onmessage?:<T extends JSONRPCMessage>(message:T)=>void
 private readonly stdin:NodeJS.WritableStream
 private buffer=''
 private started=false
 private closed=false
 private closePromise?:Promise<void>
 private readonly stdout:NodeJS.ReadableStream
 private readonly stderr:NodeJS.ReadableStream
 private idleTimer?:ReturnType<typeof setTimeout>
 constructor(private readonly process:StdioProcess,private readonly idleSeconds:number,private readonly onClosed:()=>void){
  if(!process.standardInput||!process.standardOutput||!process.standardError)throw new Error('MXC stdio 通道不可用')
  this.stdin=process.standardInput;this.stdout=process.standardOutput;this.stderr=process.standardError
  this.stdout.setEncoding('utf8')
 }
 async start(){
  if(this.started)return
  if(this.closed)throw new Error('MCP stdio 已关闭')
  this.started=true
  this.stdout.on('data',this.onStdout)
  this.stdout.on('error',this.onStreamError)
  this.stdout.on('end',this.onEnd)
  // stderr 必须持续排空，且绝不能进入产品日志或 MCP 响应。
  this.stderr.on('data',()=>{})
  this.stderr.on('error',this.onStreamError)
  this.touch()
  void this.process.wait().then(()=>this.finish(),this.onStreamError)
 }
 async send(message:JSONRPCMessage){
  if(!this.started||this.closed)throw new Error('MCP stdio 未连接')
  this.touch()
  const line=`${JSON.stringify(message)}\n`
  await new Promise<void>((resolve,reject)=>this.stdin.write(line,'utf8',error=>error?reject(error):resolve()))
 }
 close(){
  if(this.closePromise)return this.closePromise
  this.closed=true
  if(this.idleTimer)clearTimeout(this.idleTimer)
  this.closePromise=(async()=>{
   this.stdout.off('data',this.onStdout);this.stdout.off('error',this.onStreamError);this.stdout.off('end',this.onEnd)
   this.stderr.removeAllListeners('data');this.stderr.off('error',this.onStreamError)
   try{this.stdin.end()}catch{}
   try{this.process.kill()}catch{}
   try{await this.process.wait()}catch{}
   try{this.process.dispose()}catch{}
   this.onClosed()
   this.onclose?.()
  })()
  return this.closePromise
 }
 private readonly onStdout=(chunk:string|Buffer)=>{
  this.touch()
  this.buffer+=String(chunk)
  if(this.buffer.length>1_048_576&&!this.buffer.includes('\n')){this.onStreamError(new Error('MCP stdio 响应过长'));return}
  let newline:number
  while((newline=this.buffer.indexOf('\n'))>=0){
   const line=this.buffer.slice(0,newline).replace(/\r$/,'');this.buffer=this.buffer.slice(newline+1)
   if(!line)continue
   if(line.length>1_048_576){this.onStreamError(new Error('MCP stdio 响应过长'));return}
   try{this.onmessage?.(JSON.parse(line) as JSONRPCMessage)}catch{this.onStreamError(new Error('MCP stdio 返回无效 JSON-RPC'));return}
  }
 }
 private readonly onStreamError=(error:Error)=>{this.onerror?.(error);void this.close()}
 private readonly onEnd=()=>{if(!this.closed)void this.close()}
 private finish(){if(!this.closed){this.closed=true;if(this.idleTimer)clearTimeout(this.idleTimer);try{this.process.dispose()}catch{};this.onClosed();this.onclose?.()}}
 private touch(){
  if(this.closed)return
  if(this.idleTimer)clearTimeout(this.idleTimer)
  this.idleTimer=setTimeout(()=>{void this.close()},this.idleSeconds*1000)
  this.idleTimer.unref?.()
 }
}
