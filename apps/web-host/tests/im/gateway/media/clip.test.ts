import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createImVideoProcessor,ImVideoCleanupError,parseImVideoProbe} from '../../../../src/modules/im/gateway/media/video.js'

const run=promisify(execFile),signal=()=>new AbortController().signal
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'gugu-video-test-'));try{await fn(root)}finally{await rm(root,{recursive:true,force:true})}}
async function sample(root:string,width=80,height=48){
 const path=join(root,'synthetic.mp4')
 await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=blue:s=${width}x${height}:r=10:d=0.4`,
  '-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=0.8','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',path],{timeout:30_000,windowsHide:true})
 return await readFile(path)
}
const source=(bytes:Uint8Array)=>({bytes,size:bytes.byteLength,mime:'video/mp4',name:'合成视频'})
const profile={maxDimension:64,bitrate:'500k'}

test('真实视频probe取容器和视频流时长较大值，不采信传入duration/文件名',async()=>fixture(async root=>{
 const bytes=await sample(root),processor=createImVideoProcessor({temporaryRoot:root})
 const result=await processor.probe({...source(bytes),duration:9999,name:'https://example.invalid/private'},signal())
 assert.ok(result);assert.equal(result.width,80);assert.equal(result.height,48);assert.equal(result.codec,'h264')
 const reference=JSON.parse((await run('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,duration','-of','json',join(root,'synthetic.mp4')],{timeout:10_000,windowsHide:true})).stdout)
 assert.ok(Number(reference.format.duration)>Number(reference.streams.find((s:{codec_type:string})=>s.codec_type==='video').duration))
 // AAC编码器的padding随ffmpeg版本不同；以实际文件容器事实为准，不拿原始正弦时长替代。
 assert.equal(result.duration,Number(reference.format.duration));assert.ok(result.bitRate>0)
 assert.deepEqual((await readdir(root)).sort(),['synthetic.mp4'])
}))

test('正式ffprobe解析保留stream较长水位，缺时长为null且异常尺寸不放行',()=>{
 const raw=(stream:unknown,container:unknown)=>Buffer.from(JSON.stringify({format:{duration:container},streams:[{codec_type:'video',width:80,height:48,codec_name:'h264',duration:stream}]}))
 assert.equal(parseImVideoProbe(raw('125','10'))?.duration,125)
 assert.equal(parseImVideoProbe(raw('10','125'))?.duration,125)
 assert.equal(parseImVideoProbe(raw(undefined,undefined))?.duration,null)
 assert.equal(parseImVideoProbe(raw('Infinity','10')),null)
 assert.equal(parseImVideoProbe(Buffer.from(JSON.stringify({streams:[{codec_type:'video',width:100000,height:100000}]}))),null)
})

test('真实Matroska容器拒绝MP4伪标签，正确MIME族可探测且不从文件名猜格式',async()=>fixture(async root=>{
 await sample(root)
 const path=join(root,'synthetic.mkv')
 await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',join(root,'synthetic.mp4'),'-c','copy','-f','matroska',path],{timeout:30_000,windowsHide:true})
 const bytes=await readFile(path),processor=createImVideoProcessor({temporaryRoot:root})
 assert.equal(await processor.probe(source(bytes),signal()),null)
 assert.equal(await processor.transcode(source(bytes),profile,signal()),null)
 for(const mime of ['video/x-matroska','video/webm']){
  const actual=await processor.probe({...source(bytes),mime,name:'合成伪扩展名.mp4'},signal())
  assert.ok(actual);assert.equal(actual.width,80)
 }
 const mp4=await readFile(join(root,'synthetic.mp4'))
 for(const mime of ['video/mp4','video/quicktime','video/x-m4v',' Video/MP4 ; charset=binary'])assert.ok(await processor.probe({...source(mp4),mime},signal()))
 for(const mime of ['video/webm','application/octet-stream','audio/mp4','video/mp4\nprivate'])assert.equal(await processor.probe({...source(mp4),mime},signal()),null)
 assert.deepEqual((await readdir(root)).sort(),['synthetic.mkv','synthetic.mp4'])
}))

test('真实转码只缩超限长边，保留AAC、H264与faststart且不放大已合规视频',async()=>fixture(async root=>{
 const bytes=await sample(root),processor=createImVideoProcessor({temporaryRoot:root})
 const down=await processor.transcode(source(bytes),profile,signal())
 assert.ok(down);assert.equal(down.mime,'video/mp4');assert.equal(down.probe.width,64);assert.equal(down.probe.height,38)
 const output=Buffer.from(down.bytes)
 assert.ok(output.indexOf(Buffer.from('moov'))<output.indexOf(Buffer.from('mdat')))
 const preserved=await processor.transcode(source(bytes),{...profile,maxDimension:1920},signal())
 assert.ok(preserved);assert.equal(preserved.probe.width,80);assert.equal(preserved.probe.height,48)
 const target=join(root,'output.mp4');await writeFile(target,down.bytes)
 const details=await run('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name','-of','json',target],{timeout:10_000,windowsHide:true})
 assert.deepEqual(JSON.parse(details.stdout).streams.map((s:{codec_name:string})=>s.codec_name),['h264','aac'])
 await rm(target)
 assert.deepEqual((await readdir(root)).sort(),['synthetic.mp4'])
}))

test('受控stream逐块落盘、精确大小和单一来源契约，结束或拒绝都关闭producer',async()=>fixture(async root=>{
 const bytes=await sample(root),processor=createImVideoProcessor({temporaryRoot:root});let closed=0
 const stream=()=>async function*(){try{for(let at=0;at<bytes.length;at+=31)yield bytes.subarray(at,at+31)}finally{closed++}}()
 const value=await processor.probe({size:bytes.length,mime:'video/mp4',name:'合成流',stream},signal())
 assert.ok(value);assert.equal(closed,1)
 const mutable={size:bytes.length,mime:'video/mp4',name:'合成流',stream},pending=processor.probe(mutable,signal())
 mutable.stream=()=>{throw Error('调用后替换的来源不能覆盖已准入producer')}
 assert.ok(await pending);assert.equal(closed,2)
 assert.equal(await processor.probe({size:bytes.length-1,mime:'video/mp4',name:'合成流',stream},signal()),null);assert.equal(closed,3)
 assert.equal(await processor.probe({...source(bytes),stream},signal()),null)
 assert.equal(await createImVideoProcessor({temporaryRoot:root,maxInputBytes:12}).probe(source(bytes),signal()),null)
 assert.deepEqual((await readdir(root)).sort(),['synthetic.mp4'])
}))

test('损坏/未知/playlist与音频不得冒充视频，进程失败不退回原视频',async()=>fixture(async root=>{
 const processor=createImVideoProcessor({temporaryRoot:root})
 for(const text of ['#EXTM3U\nhttps://example.invalid/private','ffconcat version 1.0\nfile /private/data','synthetic-private-content']){
  assert.equal(await processor.probe(source(Buffer.from(text)),signal()),null)
 }
 const bytes=await sample(root)
 assert.equal(await createImVideoProcessor({temporaryRoot:root,ffmpegPath:join(root,'absent-private-binary')}).transcode(source(bytes),profile,signal()),null)
 assert.deepEqual((await readdir(root)).sort(),['synthetic.mp4'])
}))

test('输出容量和实际进程超时拒绝截断结果，槽位和临时资源可再次使用',async()=>fixture(async root=>{
 const bytes=await sample(root)
 assert.equal(await createImVideoProcessor({temporaryRoot:root,maxOutputBytes:100}).transcode(source(bytes),profile,signal()),null)
 assert.equal(await createImVideoProcessor({temporaryRoot:root,probeTimeoutMs:1}).probe(source(bytes),signal()),null)
 assert.equal(await createImVideoProcessor({temporaryRoot:root,transcodeTimeoutMs:1}).transcode(source(bytes),profile,signal()),null)
 assert.deepEqual((await readdir(root)).sort(),['synthetic.mp4'])
 assert.ok(await createImVideoProcessor({temporaryRoot:root}).probe(source(bytes),signal()))
}))

test('取消不泄露原因并关闭受控流，清理失败以typed错误拒绝而非伪空成功',async()=>fixture(async root=>{
 const bytes=await sample(root),controller=new AbortController();let returned=0
 const stream=()=>({[Symbol.asyncIterator](){return this},next:()=>new Promise<IteratorResult<Uint8Array>>(()=>{}),async return(){returned++;return {done:true as const,value:undefined}}})
 const processor=createImVideoProcessor({temporaryRoot:root,maxConcurrent:1})
 const pending=processor.probe({size:bytes.length,mime:'video/mp4',name:'合成流',stream},controller.signal)
 assert.equal(await processor.probe(source(bytes),signal()),null)
 setTimeout(()=>controller.abort('synthetic-private-reason'),10)
 await assert.rejects(pending,{name:'AbortError',message:'IM 视频处理已取消'});assert.equal(returned,1)
 const broken=()=>({[Symbol.asyncIterator](){return this},async next(){return {done:false as const,value:bytes}},async return(){throw Error('synthetic-private-path')}})
 await assert.rejects(processor.probe({size:1,mime:'video/mp4',name:'合成流',stream:broken},signal()),ImVideoCleanupError)
 assert.deepEqual((await readdir(root)).sort(),['synthetic.mp4'])
}))
