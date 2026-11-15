import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../../contracts/index.js'
import {openAuthorizedRelativeFile} from '../../files/read.js'

type Metadata=Record<string,unknown>
export interface AttachmentDownloadPorts<Handle>{
 readLegacy(ownerId:string,attachId:string):Promise<string|null>
 open(relativePath:string):Promise<{handle:Handle;size:number}|null>
 isUnsafe(error:unknown):boolean
}
function metadata(value:unknown):Metadata|null{
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Metadata:null
}
/** DB决定所有权；只有缺行才读取同owner的旧Redis元数据，基础设施错误不伪装成缺失。 */
export function createAttachmentDownloader<DB,Handle>(db:Kysely<DB>,ports:AttachmentDownloadPorts<Handle>){
 return async(ownerId:string,attachId:string)=>{
  const owner=dataContext(ownerId).ownerId
  const row=(await sql<Metadata>`SELECT attach_id,name,ext,mime,size,storage_key,extra FROM chat_attachments WHERE user_id=${owner} AND attach_id=${attachId}`.execute(db)).rows[0]
  let meta:Metadata|null=row?{...row,...metadata(row.extra)}:null
  if(!row){
   const raw=await ports.readLegacy(owner,attachId)
   if(raw){try{meta=metadata(JSON.parse(raw))}catch{meta=null}}
  }
  if(!meta)throw new CoreError('not_found','附件不存在或已过期')
  const key=meta.storage_key
  if(typeof key!=='string'||(!key.startsWith(`${owner}/`)&&!key.startsWith(`${owner.replaceAll('-','')}/.data-portability/imported/`)))throw new CoreError('not_found','附件已过期或物理文件丢失')
  let opened:{handle:Handle;size:number}|null
  try{opened=await openAuthorizedRelativeFile(key,ports.open,ports.isUnsafe)}catch(error){
   if(error instanceof CoreError&&error.code==='not_found')throw new CoreError('not_found','附件已过期或物理文件丢失')
   throw error
  }
  if(!opened)throw new CoreError('not_found','附件已过期或物理文件丢失')
  const name=typeof meta.name==='string'?meta.name:'file',ext=typeof meta.ext==='string'?meta.ext:''
  return {
   ...opened,fileName:`${name}.${ext}`,mimeType:typeof meta.mime==='string'&&meta.mime?meta.mime:'application/octet-stream',
   ext,kind:typeof meta.kind==='string'?meta.kind:null,qqFace:Boolean(meta.qq_face),
  }
 }
}
