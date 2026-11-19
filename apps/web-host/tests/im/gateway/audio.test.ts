import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,readdir,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {prepareSilk} from '../../../src/modules/im/gateway/silk-format.js'
import {createImAudioProcessor} from '../../../src/modules/im/gateway/audio.js'

const run=promisify(execFile)
function pcm(seconds=.25,rate=8000){
 const samples=Math.round(seconds*rate),bytes=Buffer.alloc(44+samples*2)
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8)
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22)
 bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34)
 bytes.write('data',36);bytes.writeUInt32LE(samples*2,40)
 for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/rate)*4000),44+i*2)
 return bytes
}
async function fixture(fn:(root:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'gugu-audio-test-'))
 try{await fn(root)}finally{await rm(root,{recursive:true,force:true})}
}
const signal=()=>new AbortController().signal

test('真实WAV探测保留毫秒精度，转码得到16k单声道PCM且全部临时目录清理',async()=>fixture(async root=>{
 const audio=createImAudioProcessor({temporaryRoot:root})
 assert.equal(await audio.probeAudioDuration(pcm(.257),'../../private.wav',signal()),.257)
 const converted=await audio.toWav(pcm(),signal())
 assert.ok(converted)
 assert.equal(Buffer.from(converted).subarray(0,4).toString(),'RIFF')
 assert.equal(await audio.probeAudioDuration(converted,'wav',signal()),.25)
 const bytes=Buffer.from(converted),fmt=bytes.indexOf(Buffer.from('fmt '))+8
 assert.equal(bytes.readUInt16LE(fmt),1);assert.equal(bytes.readUInt16LE(fmt+2),1)
 assert.equal(bytes.readUInt32LE(fmt+4),16000);assert.equal(bytes.readUInt16LE(fmt+14),16)
 assert.deepEqual(await readdir(root),[])
}))

test('真实OGG输入经过固定解码器转换为有效WAV',async()=>fixture(async root=>{
 const input=join(root,'synthetic.wav'),output=join(root,'synthetic.ogg')
 await writeFile(input,pcm())
 await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',input,'-c:a','libvorbis',output],{windowsHide:true,timeout:30_000})
 const audio=createImAudioProcessor({temporaryRoot:root})
 const converted=await audio.toWav(await readFile(output),signal())
 assert.ok(converted)
 // Vorbis存在编解码填充；以同一真实解码器结果为基准，不能把原PCM时长当作精确输出。
 const reference=await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',output,'-map','0:a:0','-vn','-sn','-dn','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav','pipe:1'],{windowsHide:true,timeout:30_000,encoding:'buffer'})
 assert.deepEqual(Buffer.from(converted),reference.stdout)
 assert.equal(await audio.probeAudioDuration(converted,'wav',signal()),await audio.probeAudioDuration(reference.stdout,'wav',signal()))
 assert.deepEqual((await readdir(root)).sort(),['synthetic.ogg','synthetic.wav'])
}))

test('损坏音频、无数据SILK及协议playlist不解码，不信任扩展名也不创建遗留文件',async()=>fixture(async root=>{
 const audio=createImAudioProcessor({temporaryRoot:root})
 for(const value of ['#!SILK_V3secret','#EXTM3U\nhttps://example.invalid/private','ffconcat version 1.0\nfile /private/data','RIFFbrokenWAVEprivate']){
  const raw=Buffer.from(value)
  assert.equal(await audio.toWav(raw,signal()),null)
  assert.equal(await audio.probeAudioDuration(raw,'wav',signal()),null)
 }
 assert.deepEqual(await readdir(root),[])
}))

test('输入和输出上限拒绝处理或截断WAV，缺失工具返回null且不泄露路径',async()=>fixture(async root=>{
 assert.equal(await createImAudioProcessor({temporaryRoot:root,maxInputBytes:44}).toWav(pcm(),signal()),null)
 assert.equal(await createImAudioProcessor({temporaryRoot:root,maxOutputBytes:44}).toWav(pcm(),signal()),null)
 const missing=createImAudioProcessor({temporaryRoot:root,ffmpegPath:join(root,'absent-private-tool'),ffprobePath:join(root,'absent-private-tool')})
 assert.equal(await missing.toWav(pcm(),signal()),null)
 assert.equal(await missing.probeAudioDuration(pcm(),'wav',signal()),null)
 assert.deepEqual(await readdir(root),[])
 assert.throws(()=>createImAudioProcessor({maxConcurrent:0}),/配置无效/)
}))

test('进程超时等待关闭并清理，下一次请求可以正常使用资源',async()=>fixture(async root=>{
 assert.equal(await createImAudioProcessor({temporaryRoot:root,transcodeTimeoutMs:1}).toWav(pcm(),signal()),null)
 assert.equal(await createImAudioProcessor({temporaryRoot:root,probeTimeoutMs:1}).probeAudioDuration(pcm(),'wav',signal()),null)
 assert.deepEqual(await readdir(root),[])
 assert.ok(await createImAudioProcessor({temporaryRoot:root}).toWav(pcm(),signal()))
}))

test('取消不暴露调用者原因、排空进程和目录，并发容量恢复',async()=>fixture(async root=>{
 const audio=createImAudioProcessor({temporaryRoot:root,maxConcurrent:1})
 const controller=new AbortController()
 const first=audio.toWav(pcm(60,16000),controller.signal)
 assert.equal(await audio.toWav(pcm(),signal()),null)
 setTimeout(()=>controller.abort(new Error('private-credential')),10)
 await assert.rejects(first,error=>error instanceof DOMException&&error.name==='AbortError'&&error.message==='IM 音频处理已取消')
 assert.deepEqual(await readdir(root),[])
 assert.ok(await audio.toWav(pcm(),signal()))
 const pre=new AbortController();pre.abort('private-credential')
 await assert.rejects(audio.toWav(pcm(),pre.signal),{name:'AbortError',message:'IM 音频处理已取消'})
}))

test('输入准入后复制字节，调用者修改不能改变已验证音频',async()=>fixture(async root=>{
 const audio=createImAudioProcessor({temporaryRoot:root}),raw=pcm()
 const pending=audio.toWav(raw,signal());raw.fill(0)
 assert.ok(await pending);assert.deepEqual(await readdir(root),[])
}))

test('SILK帧边界拒绝截断、超大长度、零包、非法结束和预测PCM超限，不把输入当作路径',async()=>fixture(async root=>{
 const packet=Buffer.concat([Buffer.from([1,0,1]),Buffer.from([1,0,2])]),header=Buffer.from('\x02#!SILK_V3')
 const valid=Buffer.concat([header,packet])
 assert.ok(prepareSilk(valid,64*1024*1024))
 for(const bytes of [Buffer.concat([header,Buffer.from([255,127,1])]),Buffer.concat([header,packet,Buffer.from([1])]),
  Buffer.concat([header,packet,Buffer.from([255,255,1])]),Buffer.concat([header,Buffer.from([0,0])]),Buffer.concat([header,Buffer.from([1,0])])]){
  assert.equal(prepareSilk(bytes,64*1024*1024),null)
  assert.equal(await createImAudioProcessor({temporaryRoot:root}).toWav(bytes,signal()),null)
 }
 assert.equal(prepareSilk(valid,100),null);assert.deepEqual(await readdir(root),[])
}))

test('真实pilk合成SILK经独立受限WASM解码，与24k PCM参考相符、标准头兼容且取消超时清理',{
 skip:process.env.GUGU_IM_FIXTURE_PYTHON?false:'需显式已安装pilk的隔离Python，仅用于生成合成参考，不参与生产解码',
},async()=>fixture(async root=>{
 const input=join(root,'synthetic.pcm'),encoded=join(root,'synthetic.silk'),decoded=join(root,'reference.pcm')
 await writeFile(input,pcm(1,24000).subarray(44))
 await run(process.env.GUGU_IM_FIXTURE_PYTHON!,['-c','import pilk,sys; pilk.encode(sys.argv[1],sys.argv[2],pcm_rate=24000,tencent=True); pilk.decode(sys.argv[2],sys.argv[3])',input,encoded,decoded],{timeout:30_000,windowsHide:true})
 const bytes=await readFile(encoded),reference=await readFile(decoded)
 const normalized=prepareSilk(bytes,64*1024*1024)
 assert.ok(normalized)
 const audio=createImAudioProcessor({temporaryRoot:root}),duration=Math.round(reference.length/48000*1000)/1000
 assert.ok(duration>.9&&duration<1.1)
 assert.equal(await audio.probeAudioDuration(bytes,'silk',signal()),duration)
 const actual=await audio.toWav(bytes,signal());assert.ok(actual)
 const expected=await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','s16le','-ar','24000','-ac','1','-i',decoded,
  '-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav','pipe:1'],{timeout:30_000,windowsHide:true,encoding:'buffer'})
 assert.ok(Buffer.from(actual).equals(expected.stdout),'真实WASM输出须与pilk参考经同参数ffmpeg转换的PCM一致')
 assert.equal(await audio.probeAudioDuration(actual,'wav',signal()),duration)
 const standard=bytes[0]===2?bytes.subarray(1):bytes
 assert.deepEqual(await audio.toWav(standard,signal()),actual)
 await assert.rejects(run(process.execPath,[fileURLToPath(new URL('../../../src/modules/im/gateway/silk-worker.ts',import.meta.url))],{timeout:5000,windowsHide:true}),
  error=>!!error&&typeof error==='object'&&'code'in error&&error.code===1)
 assert.equal(await createImAudioProcessor({temporaryRoot:root,transcodeTimeoutMs:1}).toWav(bytes,signal()),null)
 assert.equal(await createImAudioProcessor({temporaryRoot:root,probeTimeoutMs:1}).probeAudioDuration(bytes,'silk',signal()),null)
 const controller=new AbortController(),pending=audio.toWav(bytes,controller.signal)
 setTimeout(()=>controller.abort('synthetic-private-reason'),10)
 await assert.rejects(pending,{name:'AbortError',message:'IM 音频处理已取消'})
 assert.deepEqual((await readdir(root)).sort(),['reference.pcm','synthetic.pcm','synthetic.silk'])
}))

test('四种采样率和音调/静音/扫频/噪声的标准与腾讯SILK经正式worker均与pilk逐字节一致',{
 skip:process.env.GUGU_IM_FIXTURE_PYTHON?false:'需显式已有pilk隔离Python以生成跨实现参考',timeout:120_000,
},async()=>fixture(async root=>{
 const generate=`import pathlib,math,struct,pilk,random,sys,json
root=pathlib.Path(sys.argv[1]); rng=random.Random(71); cases=[]
for rate in (8000,12000,16000,24000):
 for pattern in ('tone','silence','chirp','noise'):
  name=f'{rate}-{pattern}'; samples=[]
  for i in range(rate):
   value=0 if pattern=='silence' else rng.randrange(-4000,4001) if pattern=='noise' else round(math.sin(i*440*2*math.pi/rate)*4000) if pattern=='tone' else round(math.sin(2*math.pi*(200*i/rate+600*(i/rate)**2))*4000)
   samples.append(struct.pack('<h',value))
  (root/(name+'.pcm')).write_bytes(b''.join(samples))
  pilk.encode(str(root/(name+'.pcm')),str(root/(name+'.silk')),pcm_rate=rate,tencent=True)
  pilk.decode(str(root/(name+'.silk')),str(root/(name+'.reference.pcm')))
  cases.append(name)
print(json.dumps(cases))`
 const {stdout}=await run(process.env.GUGU_IM_FIXTURE_PYTHON!,['-c',generate,root],{timeout:30_000,windowsHide:true})
 const audio=createImAudioProcessor({temporaryRoot:root})
 for(const name of JSON.parse(stdout) as string[]){
  const input=await readFile(join(root,name+'.silk'))
  const expected=await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','s16le','-ar','24000','-ac','1','-i',join(root,name+'.reference.pcm'),
   '-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav','pipe:1'],{timeout:30_000,windowsHide:true,encoding:'buffer'})
  for(const bytes of [input,input.subarray(1)]){
   const actual=await audio.toWav(bytes,signal())
   assert.ok(actual&&Buffer.from(actual).equals(expected.stdout),`${name}的真实SILK解码与参考不符`)
  }
 }
}))
