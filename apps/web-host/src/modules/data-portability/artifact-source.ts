import {openLocalFile} from '@gugu/fs/node'
import type {OpenedExportArtifact} from '@gugu/core/data-portability/download-export'

/** 私有归档直接复用受控根内安全只读打开，不在明文临时文件中复制。 */
export function createPortableArtifactOpener(root:string){
 return async(key:string):Promise<OpenedExportArtifact>=>{
  const file=await openLocalFile(root,key)
  if(!file)throw new Error('归档物理文件不存在')
  let closed=false
  return {size:file.size,readAt:async(offset,length)=>{
   const output=Buffer.alloc(length);let total=0
   while(total<length){const result=await file.handle.read(output,total,length-total,offset+total);if(!result.bytesRead)break;total+=result.bytesRead}
   return output.subarray(0,total)
  },close:async()=>{if(!closed){closed=true;await file.handle.close()}}}
 }
}
