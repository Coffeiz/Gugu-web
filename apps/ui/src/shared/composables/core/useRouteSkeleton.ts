import { computed, nextTick, onScopeDispose, provide, shallowRef } from 'vue'
import { useRouter, type RouteLocationNormalized } from 'vue-router'
import { SKELETON_DELAY_MS, skeletonDeadlineKey, useDelayedSkeleton } from './useDelayedSkeleton'

export function useRouteSkeleton({ desktop = false } = {}) {
  const router = useRouter()
  const pending = shallowRef<RouteLocationNormalized>()
  const deadline = shallowRef<number>()
  let latestNavigation: RouteLocationNormalized | undefined
  provide(skeletonDeadlineKey, deadline)
  const visible = useDelayedSkeleton(() => !!pending.value, deadline)
  const skeletonRoute = computed(() => visible.value ? pending.value : undefined)

  const stopStart = router.beforeEach((to, from) => {
    latestNavigation = to
    pending.value = undefined
    deadline.value = undefined
    if (to.path === from.path) return
    deadline.value = performance.now() + SKELETON_DELAY_MS
    if (desktop ? to.name !== 'notes' && to.name !== 'canvases' : !to.matched.some(record => from.matched[0] === record)) return
    pending.value = to
  })
  function finish(to: RouteLocationNormalized) {
    if (latestNavigation !== to) return
    if (pending.value === to) pending.value = undefined
    const currentDeadline = deadline.value
    // 路由确认后的同一轮渲染中，新页面的首载骨架继承导航截止时间。
    void nextTick(() => {
      if (deadline.value === currentDeadline) deadline.value = undefined
    })
  }
  const stopFinish = router.afterEach(finish)
  const stopError = router.onError((_error, to) => finish(to))
  onScopeDispose(() => {
    stopStart()
    stopFinish()
    stopError()
  })

  return skeletonRoute
}
