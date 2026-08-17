/**
 * Runtime card moves may be regrabbed while the previous persistence request is still in flight.
 * This tiny synchronous context lets optimistic mutations know whether the request that is settling
 * still represents the user's latest intent. It deliberately carries no business state: Runtime
 * owns the interaction transaction; stores/caches still own apply/rollback.
 */
export interface OptimisticIntent {
  readonly revision: number
  readonly keys: readonly string[]
}

interface DeferredRollback {
  readonly intent: OptimisticIntent
  readonly rollback: () => void
  readonly afterMutate: () => void
}

let revisionSeq = 0
let activeIntent: OptimisticIntent | null = null
const latestRevision = new Map<string, number>()
const deferredRollbacks = new Map<number, DeferredRollback[]>()

export function beginOptimisticIntent(keys: readonly string[]): OptimisticIntent {
  const uniqueKeys = [...new Set(keys)]
  const intent = { revision: ++revisionSeq, keys: uniqueKeys }
  for (const key of uniqueKeys) latestRevision.set(key, intent.revision)
  return intent
}

/**
 * Only the synchronous part of callback is scoped. optimisticMutation captures the intent before
 * its first await, so concurrent requests never share mutable global async context.
 */
export function withOptimisticIntent<T>(intent: OptimisticIntent, callback: () => T): T {
  const previous = activeIntent
  activeIntent = intent
  try {
    return callback()
  } finally {
    activeIntent = previous
  }
}

export function captureOptimisticIntent(): OptimisticIntent | null {
  return activeIntent
}

export function isOptimisticIntentCurrent(intent: OptimisticIntent): boolean {
  return intent.keys.every(key => latestRevision.get(key) === intent.revision)
}

function overlaps(left: OptimisticIntent, right: OptimisticIntent): boolean {
  const rightKeys = new Set(right.keys)
  return left.keys.some(key => rightKeys.has(key))
}

/**
 * A stale request failed after a newer regrab already applied. Its rollback must not run yet: doing
 * so would overwrite the newer visual/data state. Keep the closure until a newer request settles.
 */
export function deferOptimisticRollback(
  intent: OptimisticIntent,
  rollback: () => void,
  afterMutate: () => void,
): void {
  const entries = deferredRollbacks.get(intent.revision) ?? []
  entries.push({ intent, rollback, afterMutate })
  deferredRollbacks.set(intent.revision, entries)
}

/**
 * A successful absolute move establishes a newer confirmed baseline. Any deferred rollback at or
 * before this revision for the same objects is obsolete and must never run later.
 */
export function commitOptimisticIntent(intent: OptimisticIntent): void {
  for (const [revision, entries] of deferredRollbacks) {
    if (revision > intent.revision) continue
    const remaining = entries.filter(entry => !overlaps(entry.intent, intent))
    if (remaining.length) deferredRollbacks.set(revision, remaining)
    else deferredRollbacks.delete(revision)
  }
}

/**
 * The latest intent failed too. The caller first performs its own local rollback (D→C), then this
 * function replays older deferred failures newest-to-oldest (C→B→A), restoring the last confirmed
 * state instead of stopping on an optimistic intermediate that never reached the server.
 */
export function rollbackDeferredOptimisticIntents(intent: OptimisticIntent): void {
  const revisions = [...deferredRollbacks.keys()]
    .filter(revision => revision < intent.revision)
    .sort((a, b) => b - a)
  for (const revision of revisions) {
    const entries = deferredRollbacks.get(revision)
    if (!entries) continue
    const remaining: DeferredRollback[] = []
    for (const entry of entries) {
      if (!overlaps(entry.intent, intent)) {
        remaining.push(entry)
        continue
      }
      entry.rollback()
      entry.afterMutate()
    }
    if (remaining.length) deferredRollbacks.set(revision, remaining)
    else deferredRollbacks.delete(revision)
  }
}
