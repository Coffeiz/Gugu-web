import type { Kysely } from 'kysely'
import type { ProjectCreateRuntime, ProjectCreatedEvent } from './project-create.js'
import { nowUtc, projectRecord, type Clock } from '../data/codec.js'
import type { Database } from '../data/schema.js'
import type { Backend } from '../data/repositories.js'
import { SqlProjectRepository } from './repository.js'
import { recordForwardUndoOperation } from '../data/undo.js'

/** 创建与撤销记录必须复用同一事务；事件仅在用例提交后发布。 */
export function createKyselyProjectCreateRuntime(options: {
  db: Kysely<Database>
  backend: Backend
  clock?: Clock
  publishProjectCreated(event: ProjectCreatedEvent): Promise<void>
}): ProjectCreateRuntime {
  const clock = options.clock ?? nowUtc
  const ownerKey = (owner: string) => options.backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  return {
    transaction: work => options.db.transaction().execute(async tx => work({
      async findIdempotent(ownerId, keyHash) {
        const row = await tx.selectFrom('projects').selectAll()
          .where('user_id', '=', ownerKey(ownerId)).where('idempotency_key', '=', keyHash).executeTakeFirst()
        return row ? { ...projectRecord(row), idempotency_fingerprint: row.idempotency_fingerprint } : null
      },
      async listActiveColors(ownerId) {
        const rows = await tx.selectFrom('projects').select('color')
          .where('user_id', '=', ownerKey(ownerId)).where('deleted_at', 'is', null).execute()
        return rows.map(row => row.color)
      },
      async insertProject(ownerId, fields, idempotency) {
        const repository = new SqlProjectRepository(tx, ownerKey(ownerId), options.backend, clock)
        const project = await repository.create({ ...fields,
          idempotency_key: idempotency?.keyHash ?? null,
          idempotency_fingerprint: idempotency?.fingerprint ?? null,
        })
        return { ...project, idempotency_fingerprint: idempotency?.fingerprint ?? null }
      },
      recordUndo: record => recordForwardUndoOperation(tx, options.backend, record, clock),
    })),
    publishProjectCreated: options.publishProjectCreated,
    isUniqueViolation(error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null
      return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    },
  }
}
