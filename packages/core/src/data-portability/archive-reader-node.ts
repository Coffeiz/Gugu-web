import {createDecipheriv,createHash,hkdfSync,timingSafeEqual} from 'node:crypto'

export interface PortableArchiveSource {size:number;readAt(offset:number,length:number):Promise<Uint8Array>}
const chunkSize=1024*1024,headerSize=120
async function exact(source:PortableArchiveSource,offset:number,length:number):Promise<Buffer>{
 const data=Buffer.from(await source.readAt(offset,length))
 if(data.length!==length)throw new Error('加密归档数据不完整')
 return data
}
function decrypt(key:Uint8Array,nonce:Uint8Array,cipher:Buffer,aad:Uint8Array):Buffer{
 const reader=createDecipheriv('aes-256-gcm',key,nonce)
 reader.setAAD(aad);reader.setAuthTag(cipher.subarray(-16))
 return Buffer.concat([reader.update(cipher.subarray(0,-16)),reader.final()])
}

/** 兼容Python GUGUPV1分块AEAD；每个块通过认证后才输出，不落明文临时文件。 */
export async function openPortableArchive(source:PortableArchiveSource,secretKey:string,context:string){
 if(!Number.isSafeInteger(source.size)||source.size<headerSize+16)throw new Error('加密归档头部不完整')
 const footer=await exact(source,source.size-16,16)
 if(!footer.subarray(0,8).equals(Buffer.from('GGPEND1\0')))throw new Error('加密归档结尾标记无效')
 const size=footer.readBigUInt64BE(8)
 if(size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('加密归档长度超出支持范围')
 const plaintextSize=Number(size),blocks=Math.ceil(plaintextSize/chunkSize)
 if(source.size!==headerSize+plaintextSize+blocks*20+16)throw new Error('加密归档长度与封装数据不一致')
 const header=await exact(source,0,headerSize)
 if(!header.subarray(0,8).equals(Buffer.from('GUGUPV1\0')))throw new Error('加密归档格式无效')
 const contextHash=createHash('sha256').update(context,'utf8').digest()
 if(!timingSafeEqual(header.subarray(8,40),contextHash))throw new Error('加密归档不属于当前任务')
 const master=Buffer.from(hkdfSync('sha256',Buffer.from(secretKey,'utf8'),header.subarray(40,56),Buffer.from('gugu-data-portability-envelope-v1'),32))
 const key=decrypt(master,header.subarray(56,68),header.subarray(68,116),header.subarray(0,68))
 master.fill(0)
 return {
  plaintextSize,
  async *stream(start:number,length:number):AsyncGenerator<Uint8Array>{
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<0||start+length>plaintextSize)throw new Error('加密归档读取范围无效')
   let position=start,remaining=length
   while(remaining){
    const index=Math.floor(position/chunkSize),expected=Math.min(chunkSize,plaintextSize-index*chunkSize)
    const record=await exact(source,headerSize+index*(chunkSize+20),4+expected+16)
    if(record.readUInt32BE(0)!==expected)throw new Error('加密归档分块长度无效')
    const indexBytes=Buffer.alloc(8);indexBytes.writeBigUInt64BE(BigInt(index))
    const nonce=Buffer.concat([header.subarray(116,120),indexBytes])
    const aad=Buffer.concat([contextHash,indexBytes,record.subarray(0,4)])
    const plain=decrypt(key,nonce,record.subarray(4),aad),within=position%chunkSize,take=Math.min(remaining,plain.length-within)
    if(take<=0)throw new Error('加密归档分块长度无效')
    yield plain.subarray(within,within+take)
    position+=take;remaining-=take
   }
  },
 }
}
