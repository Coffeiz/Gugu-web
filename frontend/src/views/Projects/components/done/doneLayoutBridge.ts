import { inject, type InjectionKey } from 'vue'

export type DoneLayoutMutation = (mutate: () => void | Promise<void>) => Promise<unknown>
export type DoneGroupHeightTransition = (element: HTMLElement, open: boolean) => Promise<void>

export const doneLayoutMutationKey: InjectionKey<DoneLayoutMutation> = Symbol('done-layout-mutation')
export const doneGroupHeightKey: InjectionKey<DoneGroupHeightTransition> = Symbol('done-group-height')

let activeDoneLayoutMutation: DoneLayoutMutation | null = null

export function registerDoneLayoutMutation(mutation: DoneLayoutMutation) {
  activeDoneLayoutMutation = mutation
  return () => {
    if (activeDoneLayoutMutation === mutation) activeDoneLayoutMutation = null
  }
}

export function useDoneLayoutMutation() {
  return inject(doneLayoutMutationKey, null)
}

export function useDoneGroupHeightTransition() {
  return inject(doneGroupHeightKey, null)
}
