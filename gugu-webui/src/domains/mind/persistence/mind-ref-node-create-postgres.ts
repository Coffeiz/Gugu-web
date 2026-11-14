import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { toUtcIsoWithOffset } from '../../../shared/date-time.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import type {
  MindReferenceType,
  MindReferenceNodeSnapshot,
  MindRefNodeCreateRuntime,
  MindRefNodeTransaction,
  MindRefNodeUndoRecord,
} from '../application/mind-ref-node-create.js'
import { MindRefNodeCreateError } from '../application/mind-ref-node-create.js'
import type { MindNotePersistenceRow } from './mind-note-snapshot.js'

type ReferenceTarget = {
  title: string
  color: string | null
  snapshot: Record<string, unknown> | null
}

function mapNode(row: MindNotePersistenceRow): MindReferenceNodeSnapshot {
  let refSnapshot = row.ref_snapshot
  if (typeof refSnapshot === 'string') {
    try {
      const parsed: unknown = JSON.parse(refSnapshot)
      refSnapshot = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      refSnapshot = null
    }
  }
  return { ...row, id: Number(row.id), version: Number(row.version), ref_snapshot: refSnapshot }
}

async function findTarget(
  client: PoolClient,
  ownerId: string,
  refType: MindReferenceType,
  refId: number,
): Promise<ReferenceTarget | null> {
  if (refType === 'project') {
    const result = await client.query<{
      name: string; color: string | null; client: string | null; status: string
      start_date: string | null; deadline: string | null; done_at: Date | string | null
    }>(
      `SELECT name, color, contact_name AS client, status, start_date, deadline, done_at
       FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [refId, ownerId],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      title: row.name,
      color: row.color,
      snapshot: {
        client: row.client,
        status: row.status,
        startDate: row.start_date,
        deadline: row.deadline,
        doneAt: row.done_at ? toUtcIsoWithOffset(row.done_at) : null,
      },
    }
  }
  if (refType === 'file') {
    const result = await client.query<{ display_name: string; ext: string }>(
      `SELECT display_name, ext FROM files
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [refId, ownerId],
    )
    const row = result.rows[0]
    return row ? { title: row.display_name, color: null, snapshot: { ext: row.ext } } : null
  }
  const result = await client.query<{
    title: string; date: string; time: string | null; end_time: string | null
  }>(
    `SELECT title, date, time, end_time FROM calendar_events
     WHERE id=$1 AND user_id=$2 FOR UPDATE`,
    [refId, ownerId],
  )
  const row = result.rows[0]
  return row ? {
    title: row.title,
    color: null,
    snapshot: { date: row.date, time: row.time, endTime: row.end_time },
  } : null
}

function transaction(client: PoolClient): MindRefNodeTransaction {
  return {
    async create(ownerId, refType, refId) {
      const target = await findTarget(client, ownerId, refType, refId)
      if (!target) throw new MindRefNodeCreateError(404, '引用对象不存在')

      const existing = await client.query<MindNotePersistenceRow>(
        `SELECT id, kind, title, content_md, content_plain, color, captured_at, version,
                created_at, updated_at, deleted_at, ref_type, ref_id, ref_snapshot, origin
         FROM mind_nodes WHERE user_id=$1 AND kind='ref' AND ref_type=$2 AND ref_id=$3 AND deleted_at IS NULL
         ORDER BY id LIMIT 1 FOR UPDATE`,
        [ownerId, refType, refId],
      )
      if (existing.rows[0]) return { node: mapNode(existing.rows[0]), created: false }

      const inserted = await client.query<MindNotePersistenceRow>(
        `INSERT INTO mind_nodes (
           user_id, kind, title, content_md, content_plain, color, ref_type, ref_id,
           ref_snapshot, origin, indexed_at, indexed_hash, version, captured_at,
           created_at, updated_at, deleted_at
         ) VALUES ($1, 'ref', $2, '', '', $3, $4, $5, $6, 'user', NULL, NULL, 1,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
         RETURNING id, kind, title, content_md, content_plain, color, captured_at, version,
                   created_at, updated_at, deleted_at, ref_type, ref_id, ref_snapshot, origin`,
        [ownerId, target.title, target.color, refType, refId, target.snapshot ? JSON.stringify(target.snapshot) : null],
      )
      const node = inserted.rows[0]
      if (!node) throw new Error('引用节点插入后未返回记录')
      return { node: mapNode(node), created: true }
    },

    async recordUndo(record: MindRefNodeUndoRecord) {
      await recordForwardUndoOperation(client, record)
    },
  }
}

/** Reference lookup, node insertion and Undo are one owner-scoped PostgreSQL transaction. */
export function createPostgresMindRefNodeCreateRuntime(
  pool: Pick<Pool, 'connect'>,
  publishChanged: MindRefNodeCreateRuntime['publishChanged'],
  reportFailure?: MindRefNodeCreateRuntime['reportFailure'],
): MindRefNodeCreateRuntime {
  return {
    transaction<T>(_ownerId: string, work: (tx: MindRefNodeTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(transaction(client)))
    },
    publishChanged,
    reportFailure,
  }
}
