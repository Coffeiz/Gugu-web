/** 在WASM加载前只允许完整、有界的标准/腾讯SILK数据帧；不信扩展名或未知头。 */
export function prepareSilk(raw:Uint8Array,maximumPcmBytes:number):{bytes:Buffer;maximumPcmBytes:number}|null{
 const source=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength)
 const tencent=source.subarray(0,10).equals(Buffer.from('\x02#!SILK_V3'))
 if(!tencent&&!source.subarray(0,9).equals(Buffer.from('#!SILK_V3')))return null
 const start=tencent?10:9
 let at=start,packets=0,end=source.length
 while(at<source.length){
  if(at+2>source.length)return null
  const length=source.readInt16LE(at);at+=2
  if(length===-1){if(at!==source.length)return null;end=at-2;break}
  if(length<1||length>1024||at+length>source.length)return null
  at+=length;packets++
  // 每包至多5个20ms帧，固定24kHz/16bit/单声道；保守多算2包。
  if((packets+2)*5*960>maximumPcmBytes)return null
 }
 if(packets<1)return null
 const normalized=Buffer.concat([Buffer.from('\x02#!SILK_V3'),source.subarray(start,end),Buffer.from([255,255])])
 return {bytes:normalized,maximumPcmBytes:(packets+2)*5*960}
}
