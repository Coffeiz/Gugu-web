import { nextTick } from 'vue'
import { createFlipTransaction, createLayoutItems, type FlipTransaction } from '@/interaction/drag/animation/flipCoordinator'

export type LayoutPlayResult = 'completed' | 'cancelled'

export function useDoneLayoutCoordinator() {
  let transaction: FlipTransaction | null = null
  let root: HTMLElement | null = null
  let controlledMutationDepth = 0
  const capture = (element: HTMLElement) => {
    root = element
    transaction?.cancel()
    const items = createLayoutItems(Array.from(element.querySelectorAll<HTMLElement>('[data-layout-key]')), 'group')
    transaction = createFlipTransaction({ duration: 340, easing: 'cubic-bezier(.34,1.2,.64,1)' })
    transaction.capture(items)
  }
  const measure = (element: HTMLElement) => {
    if (!transaction) return
    const items = createLayoutItems(Array.from(element.querySelectorAll<HTMLElement>('[data-layout-key]')), 'group')
    transaction.measure(items)
  }
  const play = async (): Promise<LayoutPlayResult> => {
    if (!transaction) return 'completed'
    const active = transaction
    transaction = null
    const result = await active.play()
    return result === 'cancelled' || result === 'stale' ? 'cancelled' : 'completed'
  }
  const cancel = () => { transaction?.cancel(); transaction = null }
  const runLayoutMutation = async (mutate: () => void | Promise<void>) => {
    if (!root) return 'completed' as LayoutPlayResult
    controlledMutationDepth += 1
    capture(root)
    try {
      await mutate()
      await nextTick()
      measure(root)
      return await play()
    } catch (error) {
      cancel()
      throw error
    } finally {
      controlledMutationDepth -= 1
    }
  }
  return { capture, measure, play, cancel, runLayoutMutation, isControlled: () => controlledMutationDepth > 0 }
}
