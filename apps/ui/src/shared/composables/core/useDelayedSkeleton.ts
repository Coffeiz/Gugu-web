import { inject, ref, watch, type InjectionKey, type Ref } from 'vue'

export const SKELETON_DELAY_MS = 150
export const skeletonDeadlineKey: InjectionKey<Ref<number | undefined>> = Symbol('skeletonDeadline')

export function useDelayedSkeleton(active: () => boolean, deadline?: Ref<number | undefined>) {
  const navigationDeadline = deadline ?? inject(skeletonDeadlineKey, undefined)
  const visible = ref(false)
  watch(active, (loading, _previous, onCleanup) => {
    visible.value = false
    if (!loading) return
    const remaining = (navigationDeadline?.value ?? performance.now() + SKELETON_DELAY_MS) - performance.now()
    if (remaining <= 0) {
      visible.value = true
      return
    }
    const timer = setTimeout(() => { visible.value = true }, Math.ceil(remaining))
    onCleanup(() => clearTimeout(timer))
  }, { immediate: true, flush: 'sync' })
  return visible
}
