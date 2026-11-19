import { setTimeout } from 'node:timers/promises'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../../shared/owner-context.js'
import { resolveFileDirectoryRoot } from '../../workspaces/files.js'
import { createDiskTrash } from './disk.js'

const retentionMs = 30 * 24 * 60 * 60 * 1000
const intervalMs = 60 * 60 * 1000

type TrashStorage = Pick<ReturnType<typeof createDiskTrash>, 'list' | 'purge'>

export async function purgeExpiredDiskTrash(storage: TrashStorage, owner: string, now: Date, signal?: AbortSignal) {
  const cutoff = now.getTime() - retentionMs
  const ownerId = normalizeOwnerId(owner)
  let purged = 0
  for (const entry of await storage.list(ownerId)) {
    signal?.throwIfAborted()
    if (Date.parse(entry.deletedAt) <= cutoff && await storage.purge(ownerId, entry.id)) purged++
  }
  return purged
}

export function startDiskTrashRetentionWorker(pool: Pick<Pool, 'query'>, storageRoot: string, onError: () => void) {
  const cancel = new AbortController()
  const { signal } = cancel
  const storage = createDiskTrash(storageRoot, (owner, directory) => resolveFileDirectoryRoot(pool, owner, directory))
  const running = (async () => {
    while (!signal.aborted) {
      try {
        await setTimeout(intervalMs, undefined, { signal, ref: false })
        const now = new Date()
        let cursor: string | null = null
        while (!signal.aborted) {
          const { rows }: { rows: { owner: string }[] } = await pool.query(
            'SELECT id::text AS owner FROM users WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 100', [cursor],
          )
          for (const { owner } of rows) {
            if (signal.aborted) break
            try { await purgeExpiredDiskTrash(storage, owner, now, signal) }
            catch { if (!signal.aborted) onError() }
          }
          if (rows.length < 100) break
          cursor = rows.at(-1)!.owner
        }
      } catch { if (!signal.aborted) onError() }
    }
  })()
  return { async stop() { cancel.abort(); await running } }
}
