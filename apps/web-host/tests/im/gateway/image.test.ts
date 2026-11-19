import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createImImageProcessor} from '../../../src/modules/im/gateway/media/image.js'

const {createCanvas,loadImage}=createRequire(import.meta.url)('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
const run=promisify(execFile),signal=()=>new AbortController().signal
const normal={preserve_image_source:false},preserve={preserve_image_source:true,image_extensions:['png','jpg','jpeg','gif','webp'],image_mimes:['image/png','image/jpeg','image/gif','image/webp'],image_max_bytes:10_000_000}
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'gugu-image-test-'));try{await fn(root)}finally{await rm(root,{recursive:true,force:true})}}
function png(width=64,height=64,transparent=false){const c=createCanvas(width,height),ctx=c.getContext('2d');if(!transparent){ctx.fillStyle='#1464c8';ctx.fillRect(0,0,width,height)}return c.encodeSync('png')}

test('小原生图片经过完整解码仍保留原字节，格式/MIME错配与只有头部的坏文件不能假成功',async()=>fixture(async root=>{
 const image=createImImageProcessor({temporaryRoot:root}),raw=png()
 const result=await image.fit({bytes:raw,ext:'png',mime:'image/png'},normal,signal())
 assert.ok(result);assert.equal(result.mime,'image/png');assert.deepEqual(result.bytes,raw);assert.equal(result.width,64)
 assert.equal(await image.fit({bytes:raw,ext:'jpg'},normal,signal()),null)
 assert.equal(await image.fit({bytes:raw,ext:'png',mime:'image/jpeg'},normal,signal()),null)
 assert.equal(await image.fit({bytes:raw.subarray(0,33),ext:'png'},normal,signal()),null)
 assert.equal(await image.fit({bytes:raw.subarray(0,33),ext:'png'},preserve,signal()),null)
 assert.deepEqual(await readdir(root),[])
}))

test('长边只降到3840，透明像素铺白后实际JPEG解码成功，原图字节不改',async()=>fixture(async root=>{
 const raw=png(4000,4,true),copy=Buffer.from(raw),image=createImImageProcessor({temporaryRoot:root})
 const result=await image.fit({bytes:raw,ext:'png'},normal,signal())
 assert.ok(result);assert.equal(result.mime,'image/jpeg');assert.equal(result.width,3840);assert.equal(result.height,3)
 const decoded=await loadImage(Buffer.from(result.bytes)),canvas=createCanvas(decoded.width,decoded.height),ctx=canvas.getContext('2d');ctx.drawImage(decoded,0,0)
 const pixel=ctx.getImageData(0,0,1,1).data
 assert.ok(pixel[0]!>=250&&pixel[1]!>=250&&pixel[2]!>=250);assert.equal(pixel[3],255)
 assert.deepEqual(raw,copy);assert.deepEqual(await readdir(root),[])
}))

test('JPEG/GIF/WebP原生格式实际完整解码后按策略原样返回',async()=>fixture(async root=>{
 const canvas=createCanvas(64,64),ctx=canvas.getContext('2d');ctx.fillStyle='blue';ctx.fillRect(0,0,64,64)
 const image=createImImageProcessor({temporaryRoot:root})
 for(const ext of ['jpeg','gif','webp'] as const){
  const raw=ext==='gif'?canvas.encodeSync('gif'):canvas.encodeSync(ext,85),result=await image.fit({bytes:raw,ext},normal,signal())
  assert.ok(result);assert.deepEqual(result.bytes,raw);assert.equal(result.mime,ext==='jpeg'?'image/jpeg':`image/${ext}`)
  assert.ok(await image.fit({bytes:raw,ext},preserve,signal()))
 }
 assert.deepEqual(await readdir(root),[])
}))

test('超过5MiB的合规尺寸PNG普通策略转JPEG，preserve仍保留原字节且不套用该阈值',async()=>fixture(async root=>{
 const canvas=createCanvas(1500,1300),context=canvas.getContext('2d'),pixels=context.createImageData(1500,1300)
 let seed=71
 for(let i=0;i<pixels.data.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels.data[i]=i%4===3?255:seed&255}
 context.putImageData(pixels,0,0)
 const raw=canvas.encodeSync('png'),image=createImImageProcessor({temporaryRoot:root})
 assert.ok(raw.length>5*1024*1024&&raw.length<10_000_000)
 const normalResult=await image.fit({bytes:raw,ext:'png'},normal,signal())
 assert.ok(normalResult);assert.equal(normalResult.mime,'image/jpeg');assert.equal(normalResult.width,1500);assert.equal(normalResult.height,1300)
 const originalResult=await image.fit({bytes:raw,ext:'png'},preserve,signal())
 assert.ok(originalResult);assert.deepEqual(originalResult.bytes,raw);assert.equal(originalResult.mime,'image/png')
 assert.deepEqual(await readdir(root),[])
}))

test('preserve_source使用Provider原格式与精确字节边界，不套用3840限制、不转码绕限制',async()=>fixture(async root=>{
 const raw=png(5000,4),image=createImImageProcessor({temporaryRoot:root})
 const result=await image.fit({bytes:raw,ext:'png'},preserve,signal())
 assert.ok(result);assert.equal(result.width,5000);assert.equal(result.height,4);assert.deepEqual(result.bytes,raw)
 assert.ok(await image.fit({bytes:raw,ext:'png'},{...preserve,image_max_bytes:raw.length},signal()))
 assert.equal(await image.fit({bytes:raw,ext:'png'},{...preserve,image_max_bytes:raw.length-1},signal()),null)
 assert.equal(await image.fit({bytes:raw,ext:'png'},{...preserve,image_extensions:['jpg']},signal()),null)
 assert.equal(await image.fit({bytes:raw,ext:'png'},{...preserve,image_mimes:['image/jpeg']},signal()),null)
 assert.deepEqual(await readdir(root),[])
}))

test('实际BMP和TIFF完整解码成JPEG副本，Provider不支持格式时直接拒绝',async()=>fixture(async root=>{
 const path=join(root,'input.png');await writeFile(path,png())
 const image=createImImageProcessor({temporaryRoot:root})
 for(const ext of ['bmp','tiff']){
  const target=join(root,'synthetic.'+ext)
  await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',path,'-frames:v','1',target],{timeout:10_000,windowsHide:true})
  const raw=await readFile(target),result=await image.fit({bytes:raw,ext},normal,signal())
  assert.ok(result);assert.equal(result.mime,'image/jpeg');assert.equal(result.width,64);assert.equal(result.height,64)
  assert.ok(await loadImage(Buffer.from(result.bytes)))
  assert.equal(await image.fit({bytes:raw,ext},preserve,signal()),null)
 }
 assert.deepEqual((await readdir(root)).sort(),['input.png','synthetic.bmp','synthetic.tiff'])
}))

test('JPEG采用85起始质量和降级阶梯，输出硬上限不足时拒绝、不返回截断图片',async()=>fixture(async root=>{
 const canvas=createCanvas(512,512),context=canvas.getContext('2d'),pixels=context.createImageData(512,512)
 let seed=71
 for(let i=0;i<pixels.data.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels.data[i]=i%4===3?255:seed&255}
 context.putImageData(pixels,0,0)
 const raw=canvas.encodeSync('png'),decoded=await loadImage(raw),target=createCanvas(512,512),ctx=target.getContext('2d')
 ctx.fillStyle='white';ctx.fillRect(0,0,512,512);ctx.drawImage(decoded,0,0)
 const q85=target.encodeSync('jpeg',85),q75=target.encodeSync('jpeg',75)
 assert.ok(q85.length>q75.length&&raw.length>q85.length)
 const first=await createImImageProcessor({temporaryRoot:root,maxOutputBytes:q85.length}).fit({bytes:raw,ext:'png'},normal,signal())
 assert.ok(first&&Buffer.from(first.bytes).equals(q85))
 const second=await createImImageProcessor({temporaryRoot:root,maxOutputBytes:q75.length}).fit({bytes:raw,ext:'png'},normal,signal())
 assert.ok(second&&Buffer.from(second.bytes).equals(q75))
 assert.equal(await createImImageProcessor({temporaryRoot:root,maxOutputBytes:100}).fit({bytes:raw,ext:'png'},normal,signal()),null)
 assert.deepEqual(await readdir(root),[])
}))

test('输入/像素/进程超时/取消和并发边界均关闭排空，调用者秘密原因不进入错误',async()=>fixture(async root=>{
 const raw=png(),image=createImImageProcessor({temporaryRoot:root,maxConcurrent:1}),controller=new AbortController()
 assert.equal(await createImImageProcessor({temporaryRoot:root,maxInputBytes:1}).fit({bytes:raw,ext:'png'},normal,signal()),null)
 assert.equal(await createImImageProcessor({temporaryRoot:root,maxPixels:10}).fit({bytes:raw,ext:'png'},normal,signal()),null)
 assert.equal(await createImImageProcessor({temporaryRoot:root,timeoutMs:1}).fit({bytes:raw,ext:'png'},normal,signal()),null)
 const pending=image.fit({bytes:raw,ext:'png'},normal,controller.signal)
 assert.equal(await image.fit({bytes:raw,ext:'png'},normal,signal()),null)
 setTimeout(()=>controller.abort('synthetic-private-reason'),10)
 await assert.rejects(pending,{name:'AbortError',message:'IM 图片处理已取消'})
 assert.ok(await image.fit({bytes:raw,ext:'png'},normal,signal()))
 assert.deepEqual(await readdir(root),[])
}))
