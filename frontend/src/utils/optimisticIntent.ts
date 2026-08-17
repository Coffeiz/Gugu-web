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
const workTails = new Map<string, Promise<void>>()

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

/**
 * Apply is deliberately not queued: the user must see the regrab destination immediately. Only the
 * persistence turn is serialized per object key so the server can never observe B→C before A→B.
 *
 * The returned release callback is intentionally separate from acquisition. optimisticMutation
 * calls it only after success commit / failure rollback bookkeeping has finished, so the next work
 * cannot race ahead in the microtask gap between `work()` settling and the previous transaction's
 * rollback-chain update.
 */
export async function acquireOptimisticIntentWork(intent: OptimisticIntent): Promise<() => void> {
  const predecessors = [...new Set(
    intent.keys
      .map(key => workTails.get(key))
      .filter((tail): tail is Promise<void> => tail != null),
  )]
  let releaseTail!: () => void
  const tail = new Promise<void>(resolve => { releaseTail = resolve })
  // Install our tail before the first await so a third regrab queues behind this intent even while
  // this one itself is still waiting for its predecessor.
  for (const key of intent.keys) workTails.set(key, tail)
  await Promise.all(predecessors.map(previous => previous.catch(() => undefined)))

  let released = false
  return () => {
    if (released) return
    released = true
    releaseTail()
    for (const key of intent.keys) {
      if (workTails.get(key) === tail) workTails.delete(key)
    }
  }
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
