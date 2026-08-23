import { computed, onUnmounted, reactive } from 'vue'
import { confirmDialog } from '@/composables/useConfirmDialog'
export interface MemCleanupPlanItem {
  removed_ids?: string[]
  removed_texts?: string[]
  moved_ids?: string[]
  moved_texts?: string[]
  profile_event_migrated?: number
  profile_event_texts?: string[]
  daily_migrated?: number
  daily_texts?: string[]
  legacy_files?: string[]
  total?: number
  error?: string
}

type AdminStore = { authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }

export function useMemoryMaintenance(adminStore: AdminStore) {
  const state = reactive({
    running: false, done: 0, total: 0, msg: '', error: false,
    status: 'idle' as 'idle' | 'running' | 'done',
    plan: {} as Record<string, MemCleanupPlanItem>,
    expanded: false, applying: false, applyError: false, applyMsg: '',
  })
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => { if (timer) { clearInterval(timer); timer = null } }
  const userCount = computed(() => Object.values(state.plan).filter(p =>
    (p.removed_texts?.length ?? 0) > 0 || (p.moved_texts?.length ?? 0) > 0 ||
    (p.profile_event_texts?.length ?? 0) > 0 || (p.daily_texts?.length ?? 0) > 0 ||
    (p.legacy_files?.length ?? 0) > 0).length)
  const totalRemoved = computed(() => Object.values(state.plan).reduce((n, p) => n + (p.removed_texts?.length ?? 0), 0))
  const totalMoved = computed(() => Object.values(state.plan).reduce((n, p) => n + (p.moved_texts?.length ?? 0), 0))
  const totalProfileEvents = computed(() => Object.values(state.plan).reduce((n, p) => n + (p.profile_event_migrated ?? 0), 0))
  const totalDaily = computed(() => Object.values(state.plan).reduce((n, p) => n + (p.daily_migrated ?? 0), 0))
  const totalLegacy = computed(() => Object.values(state.plan).reduce((n, p) => n + (p.legacy_files?.length ?? 0), 0))
  const applyMsg = computed(() => state.applyMsg)

  async function poll() {
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/memory-cleanup/status')
      const data = await res.json()
      state.status = data.status ?? 'idle'
      if (data.status === 'running') {
        state.running = true; state.done = data.done || 0; state.total = data.total || 0
        state.msg = `预览中 ${state.done}/${state.total}`; state.error = false
        if (!timer) timer = setInterval(() => void poll(), 2000)
      } else if (data.status === 'done') {
        state.running = false; state.error = false; state.plan = data.plan || {}
        state.msg = `预览完成（共 ${data.total || 0} 个用户）`; stop()
      } else {
        state.running = false; stop()
      }
    } catch { /* 保留当前状态，下一次手动预览时重试 */ }
  }

  async function startPreview() {
    state.msg = ''; state.error = false; state.applyMsg = ''; state.expanded = false
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/memory-cleanup/preview', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        state.running = true; state.total = data.total || 0; state.done = 0; state.status = 'running'
        state.msg = `已启动，共 ${data.total} 个用户`
      } else { state.error = true; state.msg = data.message || '启动失败' }
      void poll()
    } catch (error) { state.error = true; state.msg = '请求失败：' + (error instanceof Error ? error.message : String(error)) }
  }

  async function apply() {
    if (!await confirmDialog({ title: '执行记忆整理', message: `确定要删 ${totalRemoved.value} 条、搬 ${totalMoved.value} 条去画像、迁 ${totalProfileEvents.value} 条画像事件到 memory、迁 ${totalDaily.value} 条 daily、清 ${totalLegacy.value} 个遗留文件吗？删除/搬动不可恢复。`, tone: 'danger', confirmText: '执行整理' })) return
    state.applying = true; state.applyMsg = ''; state.applyError = false
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/memory-cleanup/apply', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        state.applyMsg = `完成：删 ${data.total_removed} 条 / 搬 ${data.total_moved} 条 / 迁 ${data.total_profile_events_migrated} 条画像事件 / 迁 ${data.total_daily_migrated} 条 daily / 清 ${data.legacy_files_removed} 个文件（共 ${data.users_applied} 个用户）`
        state.plan = {}; state.status = 'idle'; state.expanded = false
      } else { state.applyError = true; state.applyMsg = data.detail || data.message || '执行失败' }
    } catch (error) { state.applyError = true; state.applyMsg = '请求失败：' + (error instanceof Error ? error.message : String(error)) }
    finally { state.applying = false }
  }

  onUnmounted(stop)
  return { state, stop, userCount, totalRemoved, totalMoved, totalProfileEvents, totalDaily, totalLegacy, applyMsg, poll, startPreview, apply }
}
