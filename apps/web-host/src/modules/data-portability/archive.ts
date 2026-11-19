import path from 'node:path'
import { openLocalFile, removeLocalFile, writeLocalFileStream } from '@gugu/fs/node'
import type { OpenedExportArtifact } from '@gugu/core/data-portability/download-export'
import type { DataImportPreflightStorage } from '@gugu/core/data-portability/preflight-import'

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

export function createLocalDataImportStagingRemover(storageRoot:string){
 return async(ownerId:string,jobId:string,key:string)=>{
  const expected=`${ownerId.replaceAll('-','')}/.data-portability/imports/${jobId.replaceAll('-','')}.gupi`
  if(key!==expected)throw new Error('导入暂存路径无效')
  await removeLocalFile(storageRoot,key)
 }
}

export function createLocalDataImportArtifactRemover(storageRoot:string){
 return async(ownerId:string,jobId:string,key:string)=>{
  const ownerHex=ownerId.replaceAll('-',''),jobHex=jobId.replaceAll('-','')
  const base=`${ownerHex}/.data-portability/imports/${jobHex}`
  if(key!==`${base}.gupi`&&key!==`${base}.rollback.gupi`)throw new Error('导入暂存路径无效')
  await removeLocalFile(storageRoot,key)
 }
}

function assertStorageKey(key: string): void {
  if (!/^[0-9a-f]{32}\/\.data-portability\/imports\/[0-9a-f]{32}\.gupi$/u.test(key))
    throw new Error('导入暂存路径无效')
}

export function createLocalDataImportPreflightStorage(storageRoot: string): DataImportPreflightStorage {
  return {
    async put(key, content) {
      assertStorageKey(key)
      await writeLocalFileStream(storageRoot, key, content, new AbortController().signal)
    },
    async remove(key) {
      assertStorageKey(key)
      await removeLocalFile(storageRoot, key)
    },
  }
}

export function createLocalDataExportArtifactRemover(storageRoot: string) {
  return async (ownerId: string, jobId: string, key: string) => {
    const ownerHex=ownerId.replaceAll('-',''),jobHex=jobId.replaceAll('-','')
    const expected=`${ownerHex}/.data-portability/exports/${jobHex}.gupa`
    if(key!==expected)throw new Error('导出归档路径无效')
    await removeLocalFile(path.resolve(storageRoot),expected)
  }
}
