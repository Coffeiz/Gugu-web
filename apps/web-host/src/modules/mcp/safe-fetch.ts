import type {ProviderTransport} from '@gugu/core/providers'

/** 为 MCP SDK 复用固定 DNS 目标的传输，禁止任何重定向。 */
export function createMcpSafeFetch(transport: ProviderTransport): typeof fetch {
 return async (input, init) => {
  const request = new Request(input, init)
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) throw new TypeError('不支持的 MCP 请求方法')
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
  const response = await transport.request({url:request.url,method:request.method as 'GET'|'POST'|'DELETE',headers:Object.fromEntries(request.headers),body},request.signal)
  if (response.status >= 300 && response.status < 400) {
   await response.cancel()
   throw new TypeError('MCP 请求不允许重定向')
  }
  if ([204, 205, 304].includes(response.status)) {
   await response.cancel()
   return new Response(null,{status:response.status,headers:response.headers})
  }
  const iterator=response.body[Symbol.asyncIterator]()
  let aborted=false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const cleanup=()=>request.signal.removeEventListener('abort',abort)
  const abort=()=>{aborted=true;cleanup();void response.cancel();controller.error(request.signal.reason)}
  const stream=new ReadableStream<Uint8Array>({
   start(value){controller=value;request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort()},
   async pull(value){try{const next=await iterator.next();if(aborted)return;if(next.done){cleanup();value.close()}else value.enqueue(next.value)}catch(error){cleanup();if(!aborted)value.error(error)}},
   async cancel(){cleanup();await response.cancel();await iterator.return?.()},
  })
  return new Response(stream,{status:response.status,headers:response.headers})
 }
}
