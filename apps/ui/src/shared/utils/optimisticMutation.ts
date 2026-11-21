import {
  acquireOptimisticIntentWork,
  captureOptimisticIntent,
  commitOptimisticIntent,
  deferOptimisticRollback,
  isOptimisticIntentCurrent,
  rollbackDeferredOptimisticIntents,
} from './optimisticIntent'

/**
 * 乐观更新骨架——纯高阶函数：把「乐观改缓存 → 刷新视图 → 试提交 / 失败回滚」的固定时序
 * 收成一处，各站点的具体副作用（改什么、回滚什么、成功后刷不刷用量、错误怎么报）全由回调注入，
 * **不抹平差异**（见 docs/refactor/文件域乐观更新盘点.md：只覆盖 5 处纯对称乐观点；
 * deleteSelected 的夹回滚缺口、deleteFolder 的无回滚、回收站 API 先行组等本轮不并入）。
 *
 * 时序契约（由单测锁定）：
 *   apply() → afterMutate()
 *   成功：await work() → onCommit?()            —— 不触发 rollback
 *   失败（普通调用）：rollback() → afterMutate() → onError(e)
 *   失败（已被更新意图 supersede）：暂存旧 rollback，保留最新乐观状态
 *
 * 带 OptimisticIntent 的连续操作仍然立即 apply；只有 work 按 intent key 串行，避免后发请求
 * 先于前一笔到达服务端，造成最终状态被旧写覆盖。队列在 commit/rollback bookkeeping
 * 完整结束后才释放，下一笔 work 不会抢跑到旧事务收尾之前。
 */
export interface OptimisticMutationOptions {
  /** 乐观改动缓存 + 任何提交前的本地状态变更（如清空选择/剪贴板）。 */
  apply: () => void
  /** 实际的异步提交（API 调用）。 */
  work: () => Promise<unknown>
  /** 失败时用备份还原缓存。 */
  rollback: () => void
  /** 每次改动后重投视图（通常是 loadContents），apply 后与 rollback 后都会调用。 */
  afterMutate: () => void
  /** 成功后的副作用（如 fetchStorage 刷用量）；无则不传。 */
  onCommit?: () => void
  /** 失败上报（各站点日志前缀/格式不同，故由调用方决定）。 */
  onError: (e: unknown) => void
}

export async function optimisticMutation(opts: OptimisticMutationOptions): Promise<void> {
  // intent 只在同步调用栈里存在；必须在 apply/work 前捕获，不能跨 await 读取全局上下文。
  // 普通调用拿到 null，完整保持原来的回滚语义。
  const intent = captureOptimisticIntent()
  const { apply, work, rollback, afterMutate, onCommit, onError } = opts
  apply()
  afterMutate()
  let releaseIntentWork: (() => void) | null = null
  try {
    if (intent) {
      releaseIntentWork = await acquireOptimisticIntentWork(intent)
      await work()
    } else {
      await work()
    }
    if (intent) commitOptimisticIntent(intent)
    onCommit?.()
  } catch (e) {
    if (!intent) {
      rollback()
      afterMutate()
    } else if (isOptimisticIntentCurrent(intent)) {
      // 当前最新意图也失败：先撤自己这一层，再按新→旧依次补做之前暂缓的 rollback，
      // 最终落到最后一个真正被服务端确认的状态。
      rollback()
      afterMutate()
      rollbackDeferredOptimisticIntents(intent)
    } else {
      // 更新意图已经 apply。现在执行旧 rollback 会覆盖新的视觉/数据状态，因此先暂存；
      // 后续更新意图成功时丢弃，失败时再作为 rollback chain 的一部分执行。
      deferOptimisticRollback(intent, rollback, afterMutate)
    }
    onError(e)
  } finally {
    // 必须在上面的 commit / rollback / defer 全做完以后才放行下一笔持久化。
    releaseIntentWork?.()
  }
}
