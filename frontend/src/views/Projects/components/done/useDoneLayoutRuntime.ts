import { nextTick } from 'vue'
import { createFlipTransaction, createGroupLayoutTransaction, createLayoutItems, type FlipTransaction, type GroupLayoutTransaction } from '@/interaction/drag/animation/flipCoordinator'

export type LayoutPlayResult = 'completed' | 'cancelled'

function collectLayoutNodes(root: HTMLElement) {
  // recent 容器和内部卡片不能同时做 transform：卡片会继承父容器位移，
  // 视觉上表现为 recent 卡片二次 FLIP。recent 的空间变化由 card FLIP 承担，
  // 年/月组仍由 group FLIP 负责。
  return Array.from(root.querySelectorAll<HTMLElement>('[data-layout-role="group"]'))
    .filter((element) => element.dataset.layoutKey !== 'recent')
}

function collectRecentCards(root: HTMLElement) {
  // recent 的实际布局节点是 done-card-item 包装层。若捕获内部 ProjectCard，
  // 离场时包装层先被隐藏/卸载，卡片事务会和父层回流错开，表现为顶部卡片
  // 先被压缩、再向上补位。
  return Array.from(root.querySelectorAll<HTMLElement>('.recent-done .done-card-item'))
    // TransitionGroup 会短暂保留离场卡；隐藏节点不能再次参与布局事务。
    .filter((element) => element.getClientRects().length > 0)
}

/** 已完成列的唯一布局事务入口，负责 group/recent FLIP 和主动 mutation 门禁。 */
export function useDoneLayoutRuntime() {
  let transaction: FlipTransaction | null = null
  let recentTransaction: FlipTransaction | null = null
  let root: HTMLElement | null = null
  let controlledMutationDepth = 0
  const groupTransactions = new Set<GroupLayoutTransaction>()

  const cancelGroupTransactions = () => {
    groupTransactions.forEach((transaction) => transaction.cancel())
    groupTransactions.clear()
  }

  const capture = (element: HTMLElement) => {
    root = element
    cancelGroupTransactions()
    transaction?.cancel()
    recentTransaction?.cancel()
    const items = createLayoutItems(collectLayoutNodes(element), 'group')
    const recentItems = createLayoutItems(collectRecentCards(element), 'card')
    transaction = createFlipTransaction({ duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    recentTransaction = createFlipTransaction({ duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    transaction.capture(items)
    recentTransaction.capture(recentItems)
  }

  const measure = (element: HTMLElement) => {
    if (!transaction) return
    const groups = createLayoutItems(collectLayoutNodes(element), 'group')
    const recent = createLayoutItems(collectRecentCards(element), 'card')
    transaction.measure(groups)
    recentTransaction?.measure(recent)
  }

  const play = async (beforeRecentPlay?: () => void): Promise<LayoutPlayResult> => {
    if (!transaction) return 'completed'
    const active = transaction
    const activeRecent = recentTransaction
    // 先写入 group 的 inverse，再交接 recent 占位。否则占位释放会先让年组
    // 真实回流一次，随后 group FLIP 又从旧位置播放，表现为二次位移。
    const groupPlay = active.play()
    beforeRecentPlay?.()
    const recentPlay = activeRecent?.play() ?? Promise.resolve('finished' as const)
    const [result, recentResult] = await Promise.all([groupPlay, recentPlay])
    if (transaction !== active || recentTransaction !== activeRecent
      || result === 'cancelled' || result === 'stale'
      || recentResult === 'cancelled' || recentResult === 'stale') return 'cancelled'
    if (transaction === active) transaction = null
    if (recentTransaction === activeRecent) recentTransaction = null
    return 'completed'
  }

  const cancel = () => {
    cancelGroupTransactions()
    transaction?.cancel()
    recentTransaction?.cancel()
    transaction = null
    recentTransaction = null
  }

  const playGroupHeight = (element: HTMLElement, open: boolean) => {
    const groupTransaction = createGroupLayoutTransaction(element, 340, 'cubic-bezier(0.22, 1, 0.36, 1)')
    groupTransactions.add(groupTransaction)
    return groupTransaction.play(open).then(() => {
      groupTransactions.delete(groupTransaction)
    })
  }

  const runLayoutMutation = async (mutate: () => void | Promise<void>, beforeRecentPlay?: () => void) => {
    if (!root) return 'completed' as LayoutPlayResult
    controlledMutationDepth += 1
    capture(root)
    try {
      await mutate()
      await nextTick()
      measure(root)
      return await play(beforeRecentPlay)
    } catch (error) {
      cancel()
      throw error
    } finally {
      controlledMutationDepth -= 1
    }
  }

  return { capture, measure, play, cancel, runLayoutMutation, playGroupHeight, isControlled: () => controlledMutationDepth > 0 }
}
