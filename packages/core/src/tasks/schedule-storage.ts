import {
  createKyselyOnceTaskRepository as createOnceRepository,
  createKyselyRepeatingTaskRepository as createRepeatingRepository,
  createKyselyScheduledFireReceipts as createFireReceipts,
  type ScheduleDatabaseBackend,
  type ScheduleDatabaseCodec,
} from '@gugu/database/scheduled-tasks'
import type { Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, uuid, type Clock } from '../data/codec.js'
import { enqueueScheduledTaskRagIndex } from '../agent/rag/scheduled-task-index-job.js'
import { revokeLockedTaskFilesystemAccess, type TaskFilesystemRevokeEffects } from '../workspaces/task-filesystem-revoke.js'

export type { RepeatingTask } from '@gugu/database/scheduled-tasks'

function scheduleCodec(backend: ScheduleDatabaseBackend): ScheduleDatabaseCodec {
  return {
    writeTime: at => databaseTime(new Date(at).toISOString(), backend),
    readTime: utc,
    readOwner: uuid,
    writeOwner(raw) {
      const { ownerId } = dataContext(raw)
      return backend === 'sqlite' ? ownerId.replaceAll('-', '') : ownerId
    },
  }
}

export function createKyselyOnceTaskRepository<DB>(db: Kysely<DB>, backend: ScheduleDatabaseBackend) {
  return createOnceRepository(db, scheduleCodec(backend),
    (tx, owner, taskId) => enqueueScheduledTaskRagIndex(tx, backend, owner, taskId))
}

export function createKyselyRepeatingTaskRepository<DB>(db: Kysely<DB>, backend: ScheduleDatabaseBackend) {
  return createRepeatingRepository<DB, TaskFilesystemRevokeEffects>(db, backend, scheduleCodec(backend), {
    onDelete: (tx, owner, taskId) => enqueueScheduledTaskRagIndex(tx, backend, owner, taskId),
    async onStop(tx, owner, row, effects) {
      if (backend === 'postgres') await revokeLockedTaskFilesystemAccess(tx, owner, row.id, row, effects)
    },
  })
}

export function createKyselyScheduledFireReceipts<DB>(db: Kysely<DB>, backend: ScheduleDatabaseBackend, clock: Clock = nowUtc): ReturnType<typeof createFireReceipts<DB>> {
  return createFireReceipts(db, backend, scheduleCodec(backend).writeTime, () => databaseTime(clock(), backend))
}
