import { applyMindUndoInTransaction } from '../../src/mind/undo-adapter.js'
import { utc } from '../../src/data/codec.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql,type Kysely } from 'kysely'
import type { Database } from '../../src/data/schema.js'
import { createSqlMindNoteMutator } from '../../src/mind/note-mutations-sql.js'

/** SQLite/PG共用恢复契约，保护独立事务与借用事务、owner/类型、正文及Undo回滚。 */
export async function noteLifecycleContract(db:Kysely<Database>,backend:'sqlite'|'postgres'){
 const owner=randomUUID(),other=randomUUID(),key=backend==='sqlite'?owner.replaceAll('-',''):owner
 const stamp='2026-11-15 00:00:00.123456+00:00'
 const node=(await sql<{id:number}>`INSERT INTO mind_nodes(user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at,deleted_at) VALUES(${key},'note','摘要','# 正文','正文','gugu',3,${stamp},${stamp},${stamp},${stamp}) RETURNING id`.execute(db)).rows[0]!
 const mutator=createSqlMindNoteMutator(db,backend)
 await assert.rejects(mutator.restore(other,Number(node.id),'foreign'),{statusCode:404})
 const restored=await mutator.restore(owner,Number(node.id),'restored')
 assert.equal(restored.note.version,4);assert.equal(restored.note.deletedAt,null);assert.equal(restored.note.contentMd,'# 正文')
 await assert.rejects(mutator.restore(owner,Number(node.id),'already-live'),{statusCode:404})
 const undo=await db.selectFrom('undo_operations').selectAll().where('undo_context_id','=','restored').executeTakeFirstOrThrow()
 const before=typeof undo.before_state==='string'?JSON.parse(undo.before_state):undo.before_state
 const after=typeof undo.after_state==='string'?JSON.parse(undo.after_state):undo.after_state
 const beforeItem=(before as {items:Record<string,{deleted_at:unknown}>}).items[`note:${node.id}`],afterItem=(after as {items:Record<string,{deleted_at:unknown}>}).items[`note:${node.id}`]
 assert.ok(beforeItem);assert.ok(afterItem);assert.ok(beforeItem.deleted_at);assert.equal(afterItem.deleted_at,null)
 const shape={before_state:before,after_state:after} as {before_state:{items:Record<string,Record<string,unknown>>};after_state:{items:Record<string,Record<string,unknown>>}}
 assert.equal(shape.after_state.items[`note:${node.id}`]!.captured_at,'2026-11-15T00:00:00.123456+00:00')
 await assert.rejects(db.transaction().execute(async tx=>{
   await applyMindUndoInTransaction(tx,backend,owner,{id:undo.id,action:undo.action,...shape},'undo')
   const captured=backend==='postgres'?sql<string>`to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`:sql<string>`captured_at`
   const row=await tx.selectFrom('mind_nodes').select(['deleted_at',captured.as('captured')]).where('id','=',Number(node.id)).executeTakeFirstOrThrow()
   assert.ok(row.deleted_at);assert.equal(utc(row.captured),utc(stamp));throw new Error('合成撤销回滚')
 }),/合成撤销回滚/)
 await assert.rejects(db.transaction().execute(async tx=>{
   const borrowed=createSqlMindNoteMutator(tx,backend)
   await borrowed.delete(owner,Number(node.id),'borrowed');throw new Error('合成外层失败')
 }))
 assert.equal((await db.selectFrom('mind_nodes').select('version').where('id','=',Number(node.id)).executeTakeFirstOrThrow()).version,4)
 assert.equal((await db.selectFrom('undo_operations').select('id').where('undo_context_id','=','borrowed').execute()).length,0)
 await mutator.delete(owner,Number(node.id),'deleted')
 const deleted=await db.selectFrom('mind_nodes').selectAll().where('id','=',Number(node.id)).executeTakeFirstOrThrow()
 await sql`DROP TABLE undo_operations`.execute(db)
 await assert.rejects(mutator.restore(owner,Number(node.id),'must-rollback'))
 const final=await db.selectFrom('mind_nodes').selectAll().where('id','=',Number(node.id)).executeTakeFirstOrThrow()
 assert.deepEqual(final,deleted)
}
