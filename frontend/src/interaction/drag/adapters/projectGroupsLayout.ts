import {
  createFlipTransaction,
  createLayoutItems,
  type FlipTransaction,
  type LayoutItem,
} from '../animation/flipCoordinator'

export type ProjectLayoutReason = 'toggle' | 'data-update' | 'filter-change'

export interface ProjectGroupsLayoutAdapter {
  requestLayout(reason: ProjectLayoutReason): void
  waitForGroupAnimations(): void
  measureAndPlay(force?: boolean): Promise<void>
  cancel(): void
  hasPending(): boolean
}

interface PendingLayout {
  transaction: FlipTransaction
  items: LayoutItem[]
  scrollSnapshot: unknown
  reason: ProjectLayoutReason
}

export function createProjectGroupsLayoutAdapter(options: {
  getRoot: () => HTMLElement | null
  captureScroll: () => unknown
  restoreScroll: (snapshot: unknown) => void
  duration?: number
  easing?: string
}): ProjectGroupsLayoutAdapter {
  let pending: PendingLayout | null = null
  let skipNextDataUpdate = false
  let waitingForGroupAnimations = false

  function requestLayout(reason: ProjectLayoutReason) {
    if (reason === 'data-update' && skipNextDataUpdate) {
      skipNextDataUpdate = false
      return
    }
    if (reason === 'toggle') skipNextDataUpdate = true
    cancel()
    const root = options.getRoot()
    if (!root) return
    const elements = Array.from(root.querySelectorAll<HTMLElement>(':scope > .project-group'))
    const items = createLayoutItems(elements, 'group')
    if (!items.length) return
    const transaction = createFlipTransaction({
      duration: options.duration ?? 340,
      easing: options.easing ?? 'cubic-bezier(.22,1,.36,1)',
    })
    transaction.capture(items)
    pending = {
      transaction,
      items,
      scrollSnapshot: options.captureScroll(),
      reason,
    }
  }

  function waitForGroupAnimations() {
    waitingForGroupAnimations = true
  }

  async function measureAndPlay(force = false) {
    if (waitingForGroupAnimations && !force) return
    if (force) waitingForGroupAnimations = false
    const current = pending
    if (!current) return
    pending = null
    options.restoreScroll(current.scrollSnapshot)
    current.transaction.measure(current.items)
    await current.transaction.play()
  }

  function cancel() {
    pending?.transaction.cancel()
    pending = null
  }

  return {
    requestLayout,
    waitForGroupAnimations,
    measureAndPlay,
    cancel,
    hasPending: () => pending !== null,
  }
}
