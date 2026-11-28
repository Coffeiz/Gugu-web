import {once} from 'node:events'

// 仅受限独立Node进程使用；不接受路径/网络/配置或第三方加载位置。
const maximum=64*1024*1024
try{
 if(!process.execArgv.includes('--wasm-max-mem-pages=2048')||!process.execArgv.includes('--max-old-space-size=64'))throw Error()
 const {prepareSilk}=await import(new URL(import.meta.url.endsWith('.ts')?'./silk.ts':'./silk.js',import.meta.url).href) as typeof import('./silk.js')
 const chunks:Buffer[]=[];let length=0
 for await(const value of process.stdin){length+=value.length;if(length>maximum)throw Error();chunks.push(value)}
 const validated=prepareSilk(Buffer.concat(chunks,length),maximum)
 if(!validated)throw Error()
 // 仅加载锁定包内部的纯解码模块，禁止导入WebAudio入口或传wasmUrl触发网络。
 const entry=import.meta.resolve('@zpowertech/audio-player')
 const {loadSilk}=await import(new URL('./silk/loader.js',entry).href)
 const decoder=await loadSilk(),stream=decoder.stream(24000)
 try{
  let written=0
  for(const packet of decoder.packets(validated.bytes)){
   const samples=stream.decode(packet)
   if(!(samples instanceof Int16Array)||!samples.length||samples.length>2400||stream.sampleRate!==24000)throw Error()
   written+=samples.byteLength
   if(written>maximum||written>validated.maximumPcmBytes)throw Error()
   const pcm=Buffer.allocUnsafe(samples.byteLength)
   for(let i=0;i<samples.length;i++)pcm.writeInt16LE(samples[i]!,i*2)
   if(!process.stdout.write(pcm))await once(process.stdout,'drain')
  }
  if(!written)throw Error()
  process.stdout.end()
 }finally{stream.dispose();decoder.dispose()}
}catch{process.exitCode=1}
