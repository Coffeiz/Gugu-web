/**
 * 快速连续的乐观 UI 意图（例如 Runtime regrab、设置按钮连续切换）可能在上一笔持久化
 * 尚未结束时就产生更新意图。这个同步上下文只负责标记「当前结算的请求是否仍代表用户
 * 最新意图」并按 key 排序持久化；它不携带业务状态，具体 apply / rollback 仍由调用方拥有。
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
 * Apply 故意不排队：用户必须立即看到最新意图。只有 persistence 按 key 串行，确保服务端
 * 观察到的写入顺序与用户操作顺序一致，不会因为网络完成顺序反转把旧状态写到最后。
 *
 * release 与 acquire 分开：optimisticMutation 只会在上一笔 commit / rollback bookkeeping
 * 全部完成后释放队列，下一笔 work 不会抢跑进旧事务收尾的 microtask 间隙。
 */
export async function acquireOptimisticIntentWork(intent: OptimisticIntent): Promise<() => void> {
  const predecessors = [...new Set(
    intent.keys
      .map(key => workTails.get(key))
      .filter((tail): tail is Promise<void> => tail != null),
  )]
  let releaseTail!: () => void
  const tail = new Promise<void>(resolve => { releaseTail = resolve })
  // 首个 await 前就挂上自己的 tail；即使当前意图还在等前驱，第三个更新意图也会正确排在它后面。
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
 * 旧请求失败时更新意图已经 apply，不能立刻 rollback 覆盖新 UI。先暂存旧 rollback；等更新
 * 意图结算后，成功就丢弃，失败才按新→旧补做，最终回到最后一个服务端确认状态。
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
 * 更新意图成功即建立新的 confirmed baseline；同一 key 上更早的 deferred rollback 已经过时，
 * 后续无论再发生什么都不能重新执行它们。
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
 * 最新意图也失败：调用方先撤销自己这一层（D→C），再从新到旧重放之前 deferred 的失败
 * （C→B→A），避免停在一个从未被服务端确认过的中间乐观状态。
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
