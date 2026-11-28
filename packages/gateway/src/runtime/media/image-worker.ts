import {createRequire} from 'node:module'

// 只在受限子进程内完整解码/绘制；不接受路径、URL或模型提供的Canvas操作。
try{
 if(!process.execArgv.includes('--max-old-space-size=64'))throw Error()
 const options=JSON.parse(process.argv[2]??'') as {original:boolean;maxPixels:number;maxOutputBytes:number}
 if(typeof options.original!=='boolean'||!Number.isSafeInteger(options.maxPixels)||options.maxPixels<1||options.maxPixels>64_000_000
  ||!Number.isSafeInteger(options.maxOutputBytes)||options.maxOutputBytes<1||options.maxOutputBytes>64*1024*1024)throw Error()
 const chunks:Buffer[]=[];let length=0
 for await(const chunk of process.stdin){length+=chunk.length;if(length>64*1024*1024)throw Error();chunks.push(chunk)}
 const {loadImage,createCanvas}=createRequire(import.meta.url)('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
 const image=await loadImage(Buffer.concat(chunks,length)),width=image.width,height=image.height
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>options.maxPixels)throw Error()
 // 首次真实draw触发像素解码；不能把头部尺寸当成可用图片返回。
 const canvas=createCanvas(width,height),context=canvas.getContext('2d')
 context.drawImage(image,0,0);context.getImageData(0,0,1,1)
 if(options.original){process.stdout.end(JSON.stringify({width,height,original:true})+'\n')}
 else{
  const scale=Math.min(1,3840/Math.max(width,height)),targetWidth=Math.max(1,Math.floor(width*scale)),targetHeight=Math.max(1,Math.floor(height*scale))
  const target=createCanvas(targetWidth,targetHeight),out=target.getContext('2d')
  out.fillStyle='#ffffff';out.fillRect(0,0,targetWidth,targetHeight);out.drawImage(canvas,0,0,targetWidth,targetHeight)
  let encoded:Buffer|undefined
  for(const quality of [85,75,65,55,45]){
   encoded=target.encodeSync('jpeg',quality)
   if(encoded.length<=Math.min(8*1024*1024,options.maxOutputBytes))break
  }
  if(!encoded||encoded.length>Math.min(8*1024*1024,options.maxOutputBytes))throw Error()
  process.stdout.write(JSON.stringify({width:targetWidth,height:targetHeight,original:false})+'\n')
  process.stdout.end(encoded)
 }
}catch{process.exitCode=1}
