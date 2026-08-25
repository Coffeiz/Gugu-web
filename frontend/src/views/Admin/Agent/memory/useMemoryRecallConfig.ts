import { reactive, ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import { useEmbeddingRebuild } from '../runtime-config/useEmbeddingRebuild'

export function useMemoryRecallConfig() {
  const configStore = useConfigStore()
  const adminStore = useAdminStore()
  const embeddingDraft = reactive({ ...configStore.cfg.embedding })
  const ragEnabled = ref(Boolean(configStore.cfg.search.rag_enabled))
  const embeddingSaving = ref(false)
  const embeddingSaved = ref(false)
  const embeddingError = ref('')
  const ragSaving = ref(false)
  const ragSaved = ref(false)
  const ragError = ref('')
  const embTest = reactive({ loading: false, ok: false, msg: '' })
  const { rebuild, pollRebuild, startRebuild } = useEmbeddingRebuild(adminStore)

  function resetEmbedding() { Object.assign(embeddingDraft, configStore.cfg.embedding) }
  function resetRag() { ragEnabled.value = Boolean(configStore.cfg.search.rag_enabled) }
  function syncFromStore() {
    Object.assign(embeddingDraft, configStore.cfg.embedding)
    ragEnabled.value = Boolean(configStore.cfg.search.rag_enabled)
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
      await configStore.saveConfig({ search: { rag_enabled: ragEnabled.value } })
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
      await configStore.saveConfig({ search: { rag_enabled: ragEnabled.value }, embedding: { ...embeddingDraft } })
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
    configStore, embeddingDraft, ragEnabled, embeddingSaving, embeddingSaved, embeddingError,
    ragSaving, ragSaved, ragError, embTest, rebuild, pollRebuild, startRebuild,
    resetEmbedding, resetRag, syncFromStore, saveEmbedding, saveRag, saveAll, testEmbedding,
  }
}
