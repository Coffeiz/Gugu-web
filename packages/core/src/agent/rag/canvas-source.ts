import { dataContext } from '../../contracts/index.js'
import type { createSqlMindCanvasReader } from '../../mind/canvas-read.js'
import type { CanvasSourceRecord } from './adapters/canvas.js'
import { buildSourceDocuments } from './index-builder.js'
import type { RagRebuildSource } from './rebuild-worker.js'

/** 复用 owner 隔离的 Mind 读服务，按旧版画布节点投影重建索引。 */
export function createCanvasRagSource(reader:ReturnType<typeof createSqlMindCanvasReader>):RagRebuildSource {
 return async(rawOwner,sourceId,signal)=>{
  signal?.throwIfAborted()
  const owner=dataContext(rawOwner).ownerId
  if(sourceId!==null&&(!/^[1-9]\d*$/u.test(sourceId)||!Number.isSafeInteger(Number(sourceId))))throw new Error('RAG 画布来源标识无效')
  const wanted=sourceId===null?undefined:Number(sourceId),records:CanvasSourceRecord[]=[]
  let afterId=0
  while(true){
   signal?.throwIfAborted()
   const page=await reader.listForRag(owner,{...(wanted===undefined?{afterId}:{itemId:wanted}),limit:500,signal})
   for(const row of page){
    let view:Record<string,unknown>={}
    try{const parsed=typeof row.data_json==='string'?JSON.parse(row.data_json||'{}'):row.data_json;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))view=parsed as Record<string,unknown>}catch(error){if(!(error instanceof SyntaxError))throw error}
    records.push({
     id:String(row.id),canvas_id:String(row.canvas_id),canvas_title:row.canvas_title||'未命名画布',
     node_id:String(row.node_id),node_title:row.node_title||'未命名节点',node_type:row.node_type,
     content:row.content_plain||row.content_md||'',group_path:String(view.group_path||view.groupPath||''),
     project_id:row.project_id,version_parts:[String(row.id),row.item_updated_at,String(row.node_version||1)],
     updated_at:row.item_updated_at,scope:{scope_type:'owner',scope_id:''},
    })
    afterId=Number(row.id)
   }
   if(wanted!==undefined||page.length<500)break
  }
  signal?.throwIfAborted()
  return buildSourceDocuments({canvas:records})
 }
}
