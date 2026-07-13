/**
 * 乐观更新骨架——纯高阶函数：把「乐观改缓存 → 刷新视图 → 试提交 / 失败回滚」的固定时序
 * 收成一处，各站点的具体副作用（改什么、回滚什么、成功后刷不刷用量、错误怎么报）全由回调注入，
 * **不抹平差异**（见 docs/refactor/文件域乐观更新盘点.md：只覆盖 5 处纯对称乐观点；
 * deleteSelected 的夹回滚缺口、deleteFolder 的无回滚、回收站 API 先行组等本轮不并入）。
 *
 * 时序契约（由单测锁定）：
 *   apply() → afterMutate()
 *   成功：await work() → onCommit?()            —— 不触发 rollback
 *   失败：rollback() → afterMutate() → onError(e)
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
  const { apply, work, rollback, afterMutate, onCommit, onError } = opts
  apply()
  afterMutate()
  try {
    await work()
    onCommit?.()
  } catch (e) {
    rollback()
    afterMutate()
    onError(e)
  }
}
