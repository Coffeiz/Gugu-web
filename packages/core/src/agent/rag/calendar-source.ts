import { dataContext } from '../../contracts/index.js'
import type { CalendarEventReadPort } from '../../calendar/application/event-read.js'
import { buildSourceDocuments } from './index-builder.js'
import type { RagRebuildSource } from './rebuild-worker.js'

/** 复用授权的日历读取服务，为持久重建生成旧版活动投影。 */
export function createCalendarRagSource(port:CalendarEventReadPort):RagRebuildSource {
 return async (rawOwner,sourceId,signal)=>{
  signal?.throwIfAborted()
  const owner=dataContext(rawOwner).ownerId
  if(sourceId!==null&&!/^[1-9]\d*$/u.test(sourceId))throw new Error('RAG 活动标识无效')
  const id=sourceId===null?null:Number(sourceId)
  if(id!==null&&!Number.isSafeInteger(id))throw new Error('RAG 活动标识无效')
  const events=id===null?await port.list(owner,undefined,signal):[await port.get(owner,id,signal)].filter(event=>event!==null)
  signal?.throwIfAborted()
  return buildSourceDocuments({calendar:events.map(event=>({id:String(event.id),title:event.title,date:event.date,time:event.time||'',description:event.description||'',project_id:event.project_id==null?'':String(event.project_id),version_parts:[String(event.id),String(event.version||''),event.date,event.description||''],scope:{scope_type:'owner',scope_id:''}}))})
 }
}
