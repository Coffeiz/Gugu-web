import { sql, type Kysely, type Transaction } from 'kysely'
import { calendarEventRecord } from './event-projection.js'
import { dataContext } from '../contracts/index.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { databaseTime, nowUtc, type Clock } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import { CalendarEventIdempotencyUniqueViolation, type EventCreatePublication, type EventCreateStore, type EventCreateTransaction } from './application/event-create.js'

/** 此适配器要求宿主使用单写者 SQLite 或 BEGIN IMMEDIATE；PG 使用行锁。 */
export function createKyselyCalendarCreateStore<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres', publish: (event: EventCreatePublication) => Promise<unknown>, clock: Clock = nowUtc): EventCreateStore {
  if (db.isTransaction) throw new Error('借用事务必须使用日历借用事务入口')
  return calendarCreateStore(db, backend, publish, clock)
}

/** 借用外层事务时由外层负责提交后的通知；不得提前发布。 */
export function createBorrowedCalendarCreateStore<DB>(tx: Transaction<DB>, backend: 'sqlite' | 'postgres', clock: Clock = nowUtc): EventCreateStore {
  return calendarCreateStore(tx, backend, async () => {}, clock)
}

function calendarCreateStore<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres', publish: (event: EventCreatePublication) => Promise<unknown>, clock: Clock): EventCreateStore {
  return {
    async transaction(rawOwnerId, work) {
      const owner = dataContext(rawOwnerId).ownerId
      const ownerId = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      const run = async (tx: Transaction<DB>) => {
        const timestamp = backend === 'sqlite' ? sql`${databaseTime(clock(), backend)}` : sql`CURRENT_TIMESTAMP`
        const query: EventCreateTransaction = {
          async findIdempotent(key) {
            const result = await sql<Record<string, unknown>>`SELECT id,title,date,time,end_time,type,contact_name AS client,project_id,description,version,deleted_at,idempotency_fingerprint FROM calendar_events WHERE user_id=${ownerId} AND idempotency_key=${key} LIMIT 1`.execute(tx)
            const row = result.rows[0]
            return row ? { fingerprint: String(row.idempotency_fingerprint ?? ''), event: calendarEventRecord(row, Number(row.version ?? 1)) } : null
          },
          async projectExistsForOwner(id) {
            const result = await sql`SELECT id FROM projects WHERE user_id=${ownerId} AND id=${id} AND deleted_at IS NULL`.execute(tx)
            return result.rows.length > 0
          },
          async insertWithSavepoint(input, idem) {
            const result = await sql<Record<string, unknown>>`INSERT INTO calendar_events(user_id,title,date,time,end_time,type,contact_name,project_id,description,version,created_at,idempotency_key,idempotency_fingerprint)
              VALUES(${ownerId},${input.title},${input.date},${input.time},${input.end_time},${input.type},${input.client},${input.project_id},${input.description},1,${timestamp},${idem?.keyHash ?? null},${idem?.fingerprint ?? null})
              ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id,title,date,time,end_time,type,contact_name AS client,project_id,description,version,deleted_at`.execute(tx)
            const row = result.rows[0]
            if (!row) throw new CalendarEventIdempotencyUniqueViolation()
            return calendarEventRecord(row, Number(row.version ?? 1))
          },
          async enqueueRagIndex(eventId) {
            await enqueueCalendarRagIndex(tx, backend, ownerId, String(eventId), timestamp)
          },
          async recordUndo(record) {
            await recordForwardUndoOperation(tx as unknown as Transaction<Database>, backend, { ...record, userId: rawOwnerId }, clock)
          },
        }
        return work(query)
      }
      return db.isTransaction ? run(db as Transaction<DB>) : db.transaction().execute(run)
    },
    async publishCalendarEvent(event) { await publish(event) },
  }
}

export async function enqueueCalendarRagIndex<DB>(tx: Kysely<DB> | Transaction<DB>, backend: 'sqlite' | 'postgres', owner: string, id: string, timestamp: ReturnType<typeof sql>, operation: 'create' | 'update' | 'delete' = 'create'): Promise<void> {
  if (backend === 'postgres') {
    await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
      VALUES(${owner},'calendar',${id},'',${operation},'queued',1,0,0,CURRENT_TIMESTAMP,NULL,NULL,NULL,NULL,json_build_array(${id}::varchar),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id,source_type) DO UPDATE SET source_id=EXCLUDED.source_id,version='',operation=EXCLUDED.operation,status='queued',generation=rag_index_jobs.generation+1,next_attempt_at=CURRENT_TIMESTAMP,lease_until=NULL,last_error_code=NULL,pending_source_ids=(SELECT COALESCE(json_agg(x.id ORDER BY x.ord),'[]'::json) FROM (SELECT id,MIN(ord) ord FROM (SELECT value id,ordinality ord FROM jsonb_array_elements_text(COALESCE(rag_index_jobs.pending_source_ids::jsonb,'[]'::jsonb)) WITH ORDINALITY UNION ALL SELECT EXCLUDED.source_id,2147483647) a GROUP BY id) x),updated_at=CURRENT_TIMESTAMP`.execute(tx)
    return
  }
  await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
    VALUES(${owner},'calendar',${id},'',${operation},'queued',1,0,0,${timestamp},NULL,NULL,NULL,NULL,json_array(${id}),${timestamp},${timestamp})
    ON CONFLICT(user_id,source_type) DO UPDATE SET source_id=excluded.source_id,version='',operation=excluded.operation,status='queued',generation=rag_index_jobs.generation+1,next_attempt_at=${timestamp},lease_until=NULL,last_error_code=NULL,pending_source_ids=(SELECT json_group_array(value) FROM (SELECT value,MIN(ord) AS first_ord FROM (SELECT value,CAST(key AS INTEGER) AS ord FROM json_each(COALESCE(rag_index_jobs.pending_source_ids,'[]')) UNION ALL SELECT excluded.source_id,2147483647) GROUP BY value ORDER BY first_ord)),updated_at=${timestamp}`.execute(tx)
}
