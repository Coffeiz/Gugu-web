import { watch } from 'vue'
import { useLiveStore } from '@/stores/live'

/**
 * 实时刷新的「通用模板」。订阅一个或多个资源的服务端变更（咕咕在 web/IM 改了东西 → 后端
 * `events.publish(资源)` → Redis → SSE → live store `rev[资源]++`），变了就调 `fn` 刷新。
 *
 * 用它代替各处手写 `watch(() => liveStore.rev.X, fn)`——统一入口，新页面照抄一行就行、不会漏。
 *
 * @param {string|string[]} resources 资源名（live.js 的 RESOURCES 之一）：
 *        'projects' | 'calendar' | 'files' | 'clients' | 'sessions' | 'scheduled_tasks'
 * @param {(resource:string)=>void} fn  变更时调用（拿到具体哪个资源变了）
 * @param {object} [opts]               透传给 watch（如 { immediate:true }）
 * @returns {() => void} 取消订阅（组件卸载会自动停，一般不用手动调）
 *
 * @example
 *   useLiveRefresh('scheduled_tasks', load)           // 单资源
 *   useLiveRefresh(['projects', 'calendar'], refetch) // 多资源
 */
export function useLiveRefresh(resources, fn, opts = {}) {
  const live = useLiveStore()
  const list = Array.isArray(resources) ? resources : [resources]
  const stops = list.map(r => watch(() => live.rev[r], () => fn(r), opts))
  return () => stops.forEach(s => s())
}
