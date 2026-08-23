import { reactive, ref } from 'vue'

type AdminStore = { authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }
type AgentDraft = { worker_concurrency: number; [key: string]: unknown }

export function useLlmPresets(adminStore: AdminStore, configStore: { saveConfig: (value: unknown) => Promise<unknown> }, agentDraft: AgentDraft) {
  const presets = ref<any[]>([])
  const activePresetId = ref('')
  const strategy = ref('active')
  const poolMode = ref('random')
  const presetsLoading = ref(false)
  const llmMsg = ref('')
  const llmMsgError = ref(false)
  const testingId = ref<any | null>(null)
  const activatingId = ref<any | null>(null)
  const probingId = ref<any | null>(null)
  const probingDim = ref<string | null>(null)

  function showMsg(msg: string, isError = false) {
    llmMsg.value = msg; llmMsgError.value = isError
    setTimeout(() => { llmMsg.value = '' }, isError ? 5000 : 3000)
  }
  async function fetchPresets() {
    presetsLoading.value = true
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets')
      const data = await res.json(); presets.value = data.items || []; activePresetId.value = data.active_id || ''
      strategy.value = data.strategy || 'active'; poolMode.value = data.pool_mode || 'random'
    } catch (error) { showMsg('加载失败：' + (error instanceof Error ? error.message : String(error)), true) }
    finally { presetsLoading.value = false }
  }
  async function setStrategy(value: string) {
    const previous = strategy.value; strategy.value = value
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: value }) })
      if (!res.ok) throw new Error((await res.json()).detail || '设置失败')
      showMsg(value === 'pool' ? '已切到多 key 分流（勾选要参与分流的预设）' : value === 'router' ? '已切到智能路由（待 Router 接入，暂等同单一激活）' : '已切到单一激活')
    } catch (error) { strategy.value = previous; showMsg('切换策略失败：' + (error instanceof Error ? error.message : String(error)), true) }
  }
  async function setPoolMode(value: string) {
    const previous = poolMode.value; poolMode.value = value
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool_mode: value }) })
      if (!res.ok) throw new Error('设置失败')
      showMsg(({ random: '分流方式：随机', round_robin: '分流方式：轮询', least_loaded: '分流方式：最少在途（自动避开慢 key）' } as Record<string, string>)[value] || '分流方式已更新')
    } catch (error) { poolMode.value = previous; showMsg('设置分流方式失败：' + (error instanceof Error ? error.message : String(error)), true) }
  }
  async function saveConcurrency() {
    const value = agentDraft.worker_concurrency
    if (!Number.isFinite(value) || value < 1) { agentDraft.worker_concurrency = 16; return }
    try { await configStore.saveConfig({ agent: { ...agentDraft } }); showMsg(`并发量已设为 ${value}（worker ≤30s 热生效）`) }
    catch (error) { showMsg('保存并发量失败：' + (error instanceof Error ? error.message : String(error)), true) }
  }
  async function activatePreset(id: any) {
    activatingId.value = id
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/activate`, { method: 'POST' })
      if (!res.ok) throw new Error(`切换失败（${res.status}）`)
      activePresetId.value = id; showMsg('已切换，即时生效')
    } catch (error) { showMsg(error instanceof Error ? error.message : String(error), true) }
    finally { activatingId.value = null }
  }
  async function deletePreset(id: any) {
    if (!confirm('确定删除该预设？')) return
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}`, { method: 'DELETE' })
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.detail || `删除失败（${res.status}）`) }
      await fetchPresets()
    } catch (error) { showMsg(error instanceof Error ? error.message : String(error), true) }
  }
  async function testPreset(id: any) {
    testingId.value = id
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/test`, { method: 'POST' }); const data = await res.json()
      showMsg(data.ok ? `连通正常（${data.status}）` : `连接失败（${data.status}）：${data.detail}`, !data.ok)
    } catch (error) { showMsg('测试失败：' + (error instanceof Error ? error.message : String(error)), true) }
    finally { testingId.value = null }
  }
  return { presets, activePresetId, strategy, poolMode, presetsLoading, llmMsg, llmMsgError, testingId, activatingId, probingId, probingDim, showMsg, fetchPresets, setStrategy, setPoolMode, saveConcurrency, activatePreset, deletePreset, testPreset }
}
