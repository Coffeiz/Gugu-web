import { sql,type Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import type { Backend } from '../data/repositories.js'
import type { MindNoteReadResponse } from './note-create.js'
import { createSqlMindNoteMutator } from './note-mutations-sql.js'
import { MindNoteMutationError } from './note-mutations.js'
import { agentMindNodeDetail } from './note-read.js'

export type NoteLifecycleIntent={action:'delete'|'restore';node_id:number}|{action:'undo'}
export type NoteLifecyclePublication={ownerId:string;operation:'delete';nodeId:number}|{ownerId:string;operation:'restore';note:MindNoteReadResponse}
/** 普通note生命周期：目标解析和既有CAS/Undo共用事务，不触及画布节点或正文。 */
export async function applyNoteLifecycle(tx:Transaction<Database>,backend:Backend,rawOwner:string,intent:NoteLifecycleIntent,context:string,signal:AbortSignal){
  signal.throwIfAborted()
  const canonical=dataContext(rawOwner).ownerId,owner=backend==='sqlite'?canonical.replaceAll('-',''):canonical
  let query=tx.selectFrom('mind_nodes').select(['id','version']).where('user_id','=',owner).where('kind','=','note')
  if(intent.action==='undo')query=query.where('origin','=','gugu').where('deleted_at','is',null).orderBy('created_at','desc').orderBy('id','desc').limit(1)
  else query=query.where('id','=',intent.node_id).where('deleted_at',intent.action==='restore'?'is not':'is',null)
  if(backend==='postgres')query=query.forUpdate()
  const before=await query.executeTakeFirst();signal.throwIfAborted()
  if(!before)throw new MindNoteMutationError(intent.action==='undo'?'没有可撤销的咕咕记录':intent.action==='restore'?'找不到可恢复的便签':'找不到这条便签',404)
  const id=Number(before.id),mutator=createSqlMindNoteMutator(tx,backend)
  if(intent.action!=='restore'){
    await mutator.delete(canonical,id,context);signal.throwIfAborted()
    return {value:{deleted_node_id:id,can_restore:true},publication:{ownerId:canonical,operation:'delete',nodeId:id} as NoteLifecyclePublication}
  }
  const result=await mutator.restore(canonical,id,context);signal.throwIfAborted()
  const stamp=backend==='postgres'?sql<string>`to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`:sql<string>`captured_at`
  const row=await tx.selectFrom('mind_nodes').selectAll().select(stamp.as('captured_at')).where('id','=',id).where('user_id','=',owner).where('kind','=','note').where('deleted_at','is',null).executeTakeFirstOrThrow()
  signal.throwIfAborted()
  return {value:{note:agentMindNodeDetail(row)},publication:{ownerId:canonical,operation:'restore',note:result.note} as NoteLifecyclePublication}
}
