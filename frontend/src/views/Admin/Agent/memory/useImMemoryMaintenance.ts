import { onUnmounted, reactive } from 'vue'
import { confirmDialog } from '@/composables/useConfirmDialog'

type AdminStore = { authFetch: (url: string, options?: RequestInit) => Promise<Response> }
interface PlatformSummary { platform: string; scopes: number; groups: number; members: number; entries: number }
interface Summary {
  total_scopes: number; groups: number; members: number; total_entries: number
  pending_jobs: number; needs_maintenance: number; failed_jobs: number; platforms: PlatformSummary[]
}

export function useImMemoryMaintenance(adminStore: AdminStore) {
  const state = reactive({
    loading: false, error: '', message: '',
    summary: { total_scopes: 0, groups: 0, members: 0, total_entries: 0, pending_jobs: 0, needs_maintenance: 0, failed_jobs: 0, platforms: [] } as Summary,
    applying: false,
  })
  const preview = reactive({ hasRun: false, running: false, message: '', done: 0, total: 0, needsReview: 0, failed: 0, planReady: false })
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null } }

  async function loadScopes() {
    state.loading = true; state.error = ''; state.message = ''
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/preview', { method: 'POST' })
      const data = await res.json(); if (!res.ok) throw new Error(data.detail || data.message || '加载失败')
      state.summary = {
        total_scopes: data.total_scopes || 0, groups: data.groups || 0, members: data.members || 0,
        total_entries: data.total_entries || 0, pending_jobs: data.pending_jobs || 0,
        needs_maintenance: data.needs_maintenance || 0, failed_jobs: data.failed_jobs || 0, platforms: data.platforms || [],
      }
    } catch (error) { state.error = error instanceof Error ? error.message : '加载失败' }
    finally { state.loading = false }
  }

  async function pollPreview() {
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview/status')
      const data = await res.json(); if (!res.ok) throw new Error(data.detail || data.message || '读取模型预览失败')
      preview.running = data.status === 'running'; preview.done = Number(data.done || 0); preview.total = Number(data.total || 0)
      preview.needsReview = Number(data.needs_review || 0); preview.failed = Number(data.failed || 0)
      preview.planReady = data.plan_ready === undefined ? data.status === 'done' && preview.needsReview > 0 : Boolean(data.plan_ready)
      if (preview.running) preview.message = `模型预览中 ${preview.done}/${preview.total}`
      else if (data.status === 'done') {
        preview.hasRun = true
        preview.message = `模型预览完成：${preview.needsReview} 个作用域有可提炼内容${preview.failed ? `，失败 ${preview.failed} 个` : ''}`
        stop(); await loadScopes()
      }
    } catch (error) { preview.running = false; preview.message = error instanceof Error ? error.message : '读取模型预览失败'; stop() }
  }
  function startPolling() { stop(); void pollPreview(); timer = setInterval(() => void pollPreview(), 1500) }
  async function startPreview() {
    preview.hasRun = false; preview.planReady = false; preview.message = ''
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview', { method: 'POST' })
      const data = await res.json(); if (!res.ok) throw new Error(data.detail || data.message || '启动模型预览失败')
      preview.running = true; preview.message = data.ok ? `已启动模型预览，共 ${data.total || 0} 个作用域` : (data.message || '已有模型预览正在运行')
      startPolling()
    } catch (error) { preview.running = false; preview.message = error instanceof Error ? error.message : '启动模型预览失败' }
  }
  async function apply() {
    if (!await confirmDialog({ title: '整理 IM 记忆', message: '确定整理全部 IM 记忆中尚未反思的消息吗？不会删除已有记忆。', tone: 'warning', confirmText: '开始整理' })) return
    state.applying = true; state.error = ''; state.message = ''
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
      const data = await res.json(); if (!res.ok) throw new Error(data.detail || '执行整理失败')
      preview.planReady = false; state.message = `已应用 ${Number(data.applied || 0)} 个模型预览结果`; await loadScopes()
    } catch (error) { state.error = error instanceof Error ? error.message : '执行整理失败' }
    finally { state.applying = false }
  }
  onUnmounted(stop)
  return { state, preview, stop, loadScopes, pollPreview, startPreview, apply }
}
