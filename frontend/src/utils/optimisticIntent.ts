/**
 * Runtime card moves may be regrabbed while the previous persistence request is still in flight.
 * This tiny synchronous context lets optimistic mutations know whether the request that is failing
 * still represents the user's latest intent. It deliberately carries no business state: Runtime
 * owns the interaction transaction; stores/caches still own apply/rollback.
 */
export interface OptimisticIntent {
  readonly revision: number
  readonly keys: readonly string[]
}

let revisionSeq = 0
let activeIntent: OptimisticIntent | null = null
const latestRevision = new Map<string, number>()

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
