import { reactive, ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import { useEmbeddingRebuild } from '../runtime-config/useEmbeddingRebuild'

// 自动召回来源白名单（与后端 SearchSettings.rag_auto_sources 的 Literal 集合一致）。
export const RAG_SOURCE_KEYS = [
  'memory', 'knowledge', 'project', 'file', 'canvas', 'note', 'calendar', 'scheduled_task', 'conversation',
] as const

export function useMemoryRecallConfig() {
  const configStore = useConfigStore()
  const adminStore = useAdminStore()
  const embeddingDraft = reactive({ ...configStore.cfg.embedding })
  const ragEnabled = ref(Boolean(configStore.cfg.search.rag_enabled))
  const storedSources = Array.isArray(configStore.cfg.search.rag_auto_sources)
    ? configStore.cfg.search.rag_auto_sources.map(String)
    : [...RAG_SOURCE_KEYS]
  const ragAutoSources = ref<string[]>(storedSources.filter(item =>
    (RAG_SOURCE_KEYS as readonly string[]).includes(item)))
  const capabilityRagEnabled = ref(Boolean(configStore.cfg.search.capability_rag_enabled))
  const capabilityRagShadow = ref(Boolean(configStore.cfg.search.capability_rag_shadow ?? true))
  const capabilityRagLimit = ref(Number(configStore.cfg.search.capability_rag_limit || 5))
  const embeddingSaving = ref(false)
  const embeddingSaved = ref(false)
  const embeddingError = ref('')
  const ragSaving = ref(false)
  const ragSaved = ref(false)
  const ragError = ref('')
  const embTest = reactive({ loading: false, ok: false, msg: '' })
  const { rebuild, pollRebuild, startRebuild } = useEmbeddingRebuild(adminStore)

  function resetEmbedding() { Object.assign(embeddingDraft, configStore.cfg.embedding) }
  function resetRag() {
    ragEnabled.value = Boolean(configStore.cfg.search.rag_enabled)
    const stored = Array.isArray(configStore.cfg.search.rag_auto_sources)
      ? configStore.cfg.search.rag_auto_sources.map(String)
      : [...RAG_SOURCE_KEYS]
    ragAutoSources.value = stored.filter(item => (RAG_SOURCE_KEYS as readonly string[]).includes(item))
    capabilityRagEnabled.value = Boolean(configStore.cfg.search.capability_rag_enabled)
    capabilityRagShadow.value = Boolean(configStore.cfg.search.capability_rag_shadow ?? true)
    capabilityRagLimit.value = Number(configStore.cfg.search.capability_rag_limit || 5)
  }
  function toggleRagSource(key: string, checked: boolean) {
    const set = new Set(ragAutoSources.value)
    if (checked) set.add(key)
    else set.delete(key)
    ragAutoSources.value = RAG_SOURCE_KEYS.filter(item => set.has(item))
  }
  function syncFromStore() {
    Object.assign(embeddingDraft, configStore.cfg.embedding)
    resetRag()
  }

  async function saveEmbedding() {
    embeddingSaving.value = true
    embeddingSaved.value = false
    embeddingError.value = ''
    try {
      await configStore.saveConfig({ embedding: { ...embeddingDraft } })
      embeddingSaved.value = true
      Object.assign(embeddingDraft, configStore.cfg.embedding)
      setTimeout(() => { embeddingSaved.value = false }, 3000)
    } catch (e) { embeddingError.value = e instanceof Error ? e.message : String(e) }
    finally { embeddingSaving.value = false }
  }

  async function saveRag() {
    ragSaving.value = true
    ragSaved.value = false
    ragError.value = ''
    try {
      await configStore.saveConfig({ search: { rag_enabled: ragEnabled.value, rag_auto_sources: [...ragAutoSources.value] } })
      ragSaved.value = true
      resetRag()
      setTimeout(() => { ragSaved.value = false }, 3000)
    } catch (e) { ragError.value = e instanceof Error ? e.message : String(e) }
    finally { ragSaving.value = false }
  }

  async function saveAll() {
    ragSaving.value = true
    embeddingSaving.value = true
    ragSaved.value = false
    embeddingSaved.value = false
    ragError.value = ''
    embeddingError.value = ''
    try {
      await configStore.saveConfig({
        search: {
          rag_enabled: ragEnabled.value,
          rag_auto_sources: [...ragAutoSources.value],
          capability_rag_enabled: capabilityRagEnabled.value,
          capability_rag_shadow: capabilityRagShadow.value,
          capability_rag_limit: Math.max(1, Math.min(20, Number(capabilityRagLimit.value) || 5)),
        },
        embedding: { ...embeddingDraft },
      })
      ragSaved.value = true
      embeddingSaved.value = true
      syncFromStore()
      setTimeout(() => { ragSaved.value = false; embeddingSaved.value = false }, 3000)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      ragError.value = message
      embeddingError.value = message
    } finally {
      ragSaving.value = false
      embeddingSaving.value = false
    }
  }

  async function testEmbedding() {
    embTest.loading = true
    embTest.msg = ''
    try {
      const res = await adminStore.authFetch('/api/v1/admin/config/test-embedding', {
        method: 'POST',
        body: JSON.stringify({
          provider: embeddingDraft.provider || '', multimodal: !!embeddingDraft.multimodal,
          base_url: embeddingDraft.base_url || '', api_key: embeddingDraft.api_key || '',
          model: embeddingDraft.model || '', dimensions: embeddingDraft.dimensions || 0,
        }),
      })
      const data = await res.json()
      embTest.ok = !!data.ok
      embTest.msg = data.message || (data.ok ? 'OK' : '失败')
    } catch (e) {
      embTest.ok = false
      embTest.msg = `请求失败：${e instanceof Error ? e.message : String(e)}`
    } finally { embTest.loading = false }
  }

  return {
    configStore, embeddingDraft, ragEnabled, ragAutoSources, capabilityRagEnabled, capabilityRagShadow, capabilityRagLimit,
    embeddingSaving, embeddingSaved, embeddingError,
    ragSaving, ragSaved, ragError, embTest, rebuild, pollRebuild, startRebuild,
    resetEmbedding, resetRag, toggleRagSource, syncFromStore, saveEmbedding, saveRag, saveAll, testEmbedding,
  }
}
