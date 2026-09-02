import { reactive, ref } from 'vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { i18n } from '@/i18n'

type AdminStore = { authFetch: (url: string, options?: RequestInit) => Promise<Response> }
type AgentDraft = { worker_concurrency: number; [key: string]: unknown }
type LlmPresetSummary = {
  id: string | number
  name: string
  provider: string
  model: string
  in_pool?: boolean
  capability_probe?: Record<string, { status?: string; detail?: string }>
  capability_checked_at?: string
  capability_fingerprint?: string
  capability_overrides?: Record<string, boolean>
  api_key?: string
  [key: string]: unknown
}
export type LlmMessagePart = {
  key: string
  label: string
  text: string
  status: 'supported' | 'unsupported' | 'unknown'
}

export function useLlmPresets(adminStore: AdminStore, configStore: { saveConfig: (value: Record<string, Record<string, unknown>>) => Promise<unknown> }, agentDraft: AgentDraft) {
  const t = i18n.global.t
  const presets = ref<LlmPresetSummary[]>([])
  const activePresetId = ref('')
  const strategy = ref('active')
  const poolMode = ref('random')
  const presetsLoading = ref(false)
  const llmMsg = ref('')
  const llmMsgParts = ref<LlmMessagePart[]>([])
  const llmMsgError = ref(false)
  const llmMsgSuccess = ref(false)
  const testingId = ref<string | number | null>(null)
  const activatingId = ref<string | number | null>(null)
  const probingId = ref<string | number | null>(null)
  const probingDim = ref<string | null>(null)

  function showMsg(msg: string, isError = false, withCheck = false) {
    llmMsgParts.value = []
    llmMsg.value = msg; llmMsgError.value = isError; llmMsgSuccess.value = withCheck && !isError
    setTimeout(() => { llmMsg.value = '' }, isError ? 5000 : 3000)
  }
  function showMsgParts(msg: string, parts: LlmMessagePart[]) {
    llmMsg.value = msg
    llmMsgParts.value = parts
    llmMsgError.value = false
    llmMsgSuccess.value = false
    setTimeout(() => { llmMsg.value = ''; llmMsgParts.value = [] }, 3000)
  }
  async function fetchPresets() {
    presetsLoading.value = true
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets')
      const data = await res.json(); presets.value = data.items || []; activePresetId.value = data.active_id || ''
      strategy.value = data.strategy || 'active'; poolMode.value = data.pool_mode || 'random'
    } catch (error) { showMsg(t('adminAgentUi.loadFailed', { message: error instanceof Error ? error.message : String(error) }), true) }
    finally { presetsLoading.value = false }
  }
  async function setStrategy(value: string) {
    const previous = strategy.value; strategy.value = value
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: value }) })
      if (!res.ok) throw new Error((await res.json()).detail || t('adminAgentUi.operationFailed'))
      showMsg(value === 'pool' ? t('adminAgentUi.strategyPool') : value === 'router' ? t('adminAgentUi.strategyRouter') : t('adminAgentUi.strategyActive'))
    } catch (error) { strategy.value = previous; showMsg(t('adminAgentUi.strategyFailed', { message: error instanceof Error ? error.message : String(error) }), true) }
  }
  async function setPoolMode(value: string) {
    const previous = poolMode.value; poolMode.value = value
    try {
      const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool_mode: value }) })
      if (!res.ok) throw new Error(t('adminAgentUi.operationFailed'))
      showMsg(({ random: t('agent.random'), round_robin: t('agent.roundRobin'), least_loaded: t('agent.leastLoaded') } as Record<string, string>)[value] || t('adminAgentUi.routingUpdated'))
    } catch (error) { poolMode.value = previous; showMsg(t('adminAgentUi.routingFailed', { message: error instanceof Error ? error.message : String(error) }), true) }
  }
  async function saveConcurrency() {
    const value = agentDraft.worker_concurrency
    if (!Number.isFinite(value) || value < 1) { agentDraft.worker_concurrency = 16; return }
    try { await configStore.saveConfig({ agent: { ...agentDraft } }); showMsg(t('adminAgentUi.concurrencySaved', { value })) }
    catch (error) { showMsg(t('adminAgentUi.concurrencyFailed', { message: error instanceof Error ? error.message : String(error) }), true) }
  }
  async function activatePreset(id: string | number) {
    activatingId.value = id
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/activate`, { method: 'POST' })
      if (!res.ok) throw new Error(t('adminAgentUi.switchFailed', { status: res.status }))
      activePresetId.value = String(id); showMsg(t('adminAgentUi.switched'))
    } catch (error) { showMsg(error instanceof Error ? error.message : String(error), true) }
    finally { activatingId.value = null }
  }
  async function deletePreset(id: string | number) {
    if (!await confirmDialog({ title: t('adminAgentUi.deletePresetTitle'), message: t('adminAgentUi.deletePresetMessage'), tone: 'danger', confirmText: t('adminAgentUi.deletePresetConfirm') })) return
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}`, { method: 'DELETE' })
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.detail || `删除失败（${res.status}）`) }
      await fetchPresets()
    } catch (error) { showMsg(error instanceof Error ? error.message : String(error), true) }
  }
  async function testPreset(id: string | number) {
    testingId.value = id
    try {
      const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/test`, { method: 'POST' }); const data = await res.json()
      showMsg(data.ok ? t('adminAgentUi.connectionOk', { status: data.status }) : t('adminAgentUi.connectionFailed', { status: data.status, detail: data.detail }), !data.ok)
    } catch (error) { showMsg(t('adminAgentUi.testFailed', { message: error instanceof Error ? error.message : String(error) }), true) }
    finally { testingId.value = null }
  }
  return { presets, activePresetId, strategy, poolMode, presetsLoading, llmMsg, llmMsgParts, llmMsgError, llmMsgSuccess, testingId, activatingId, probingId, probingDim, showMsg, showMsgParts, fetchPresets, setStrategy, setPoolMode, saveConcurrency, activatePreset, deletePreset, testPreset }
}
