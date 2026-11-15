import { dataContext } from '../../contracts/index.js'
import { utc } from '../../data/codec.js'
import type { createSqlMindNoteReader } from '../../mind/note-read.js'
import { buildSourceDocuments } from './index-builder.js'
import type { RagRebuildSource } from './rebuild-worker.js'

/** 使用共享 Mind 查询，只重建已授权 owner 的时间流记录。 */
export function createNoteRagSource(reader:ReturnType<typeof createSqlMindNoteReader>):RagRebuildSource {
 return async (rawOwner,sourceId,signal)=>{
  signal?.throwIfAborted()
  const owner=dataContext(rawOwner).ownerId
  if(sourceId!==null&&!/^[1-9]\d*$/u.test(sourceId))throw new Error('RAG 便签标识无效')
  const id=sourceId===null?null:Number(sourceId)
  if(id!==null&&!Number.isSafeInteger(id))throw new Error('RAG 便签标识无效')
  const notes=await reader.listForRag(owner,id,signal)
  signal?.throwIfAborted()
  return buildSourceDocuments({note:notes.map(note=>({id:String(note.id),kind:note.kind,title:note.title||'',content_plain:note.content_plain||'',content_md:note.content_md||'',version_parts:[String(note.id),String(note.version||''),note.indexed_hash||''],updated_at:utc(note.updated_at).replace(' ','T'),scope:{scope_type:'owner',scope_id:''}}))})
 }
}
