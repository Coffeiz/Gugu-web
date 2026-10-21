import { reactive, ref, type Ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import { i18n } from '@/i18n'

async function saveSection(
  save: () => Promise<unknown>,
  state: { saving: Ref<boolean>; saved: Ref<boolean>; error: Ref<string> },
  afterSave?: () => void,
) {
  state.saving.value = true
  state.saved.value = false
  state.error.value = ''
  try {
    await save()
    state.saved.value = true
    afterSave?.()
    setTimeout(() => { state.saved.value = false }, 3000)
  } catch (error) {
    state.error.value = error instanceof Error ? error.message : String(error)
  } finally {
    state.saving.value = false
  }
}

export function useAgentRuntimeConfig() {
  const t = i18n.global.t
  const configStore = useConfigStore(); const adminStore = useAdminStore()
  const agentDraft = reactive({ ...configStore.cfg.agent }); const behaviorSaving = ref(false); const behaviorSaved = ref(false); const behaviorError = ref('')
  function resetBehavior() { Object.assign(agentDraft, configStore.cfg.agent) }
  async function saveBehavior() {
    await saveSection(() => configStore.saveConfig({ agent: { ...agentDraft } }), { saving: behaviorSaving, saved: behaviorSaved, error: behaviorError })
  }
  const generalSearchDraft = reactive({ tavily_api_key: configStore.cfg.search.tavily_api_key, searxng_url: configStore.cfg.search.searxng_url, searxng_engines: configStore.cfg.search.searxng_engines, searxng_image_engines: configStore.cfg.search.searxng_image_engines, max_results: configStore.cfg.search.max_results })
  const deepResearchDraft = reactive({ deep_research_provider: configStore.cfg.search.deep_research_provider || 'tavily', tavily_api_key: configStore.cfg.search.tavily_api_key, deep_research_baidu_api_key: configStore.cfg.search.deep_research_baidu_api_key, deep_research_you_api_key: configStore.cfg.search.deep_research_you_api_key })
  const similarImageDraft = reactive({ similar_image_provider: configStore.cfg.search.similar_image_provider || 'baidu_qianfan', baidu_qianfan_api_key: configStore.cfg.search.baidu_qianfan_api_key, similar_image_default_count: configStore.cfg.search.similar_image_default_count, similar_image_timeout_seconds: configStore.cfg.search.similar_image_timeout_seconds, similar_image_limit_daily: configStore.cfg.search.similar_image_limit_daily })
  const generalSearchSaving = ref(false); const generalSearchSaved = ref(false); const generalSearchError = ref(''); const similarImageSaving = ref(false); const similarImageSaved = ref(false); const similarImageError = ref('')
  const deepResearchSaving = ref(false); const deepResearchSaved = ref(false); const deepResearchError = ref('')
  function resetGeneralSearch() { Object.assign(generalSearchDraft, { tavily_api_key: configStore.cfg.search.tavily_api_key, searxng_url: configStore.cfg.search.searxng_url, searxng_engines: configStore.cfg.search.searxng_engines, searxng_image_engines: configStore.cfg.search.searxng_image_engines, max_results: configStore.cfg.search.max_results }) }
  function resetSimilarImageSearch() { Object.assign(similarImageDraft, { similar_image_provider: configStore.cfg.search.similar_image_provider || 'baidu_qianfan', baidu_qianfan_api_key: configStore.cfg.search.baidu_qianfan_api_key, similar_image_default_count: configStore.cfg.search.similar_image_default_count, similar_image_timeout_seconds: configStore.cfg.search.similar_image_timeout_seconds, similar_image_limit_daily: configStore.cfg.search.similar_image_limit_daily }) }
  function resetDeepResearch() { Object.assign(deepResearchDraft, { deep_research_provider: configStore.cfg.search.deep_research_provider || 'tavily', tavily_api_key: configStore.cfg.search.tavily_api_key, deep_research_baidu_api_key: configStore.cfg.search.deep_research_baidu_api_key, deep_research_you_api_key: configStore.cfg.search.deep_research_you_api_key }) }
  const searchTest = reactive({ searxng: { loading: false, ok: false, msg: '' }, searxng_images: { loading: false, ok: false, msg: '' }, tavily: { loading: false, ok: false, msg: '' }, deep_research: { loading: false, ok: false, msg: '' }, baidu_similar_images: { loading: false, ok: false, msg: '' } })
  const deepResearchTest = searchTest.deep_research
  async function testSearch(target: keyof typeof searchTest) { const state = searchTest[target]; state.loading = true; state.msg = ''; try { const payload = target === 'deep_research' ? { target, ...deepResearchDraft } : target === 'tavily' ? { target, tavily_api_key: generalSearchDraft.tavily_api_key || '' } : target === 'baidu_similar_images' ? { target, baidu_qianfan_api_key: similarImageDraft.baidu_qianfan_api_key || '' } : target === 'searxng_images' ? { target, searxng_url: generalSearchDraft.searxng_url || '', searxng_image_engines: generalSearchDraft.searxng_image_engines || '' } : { target, searxng_url: generalSearchDraft.searxng_url || '', searxng_engines: generalSearchDraft.searxng_engines || '' }; const res = await adminStore.authFetch('/api/v1/admin/config/test-search', { method: 'POST', body: JSON.stringify(payload) }); const data = await res.json(); state.ok = !!data.ok; state.msg = data.message || (data.ok ? 'OK' : t('adminRuntimeUi.failed')) } catch (e) { state.ok = false; state.msg = t('adminRuntimeUi.requestFailed', { message: e instanceof Error ? e.message : String(e) }) } finally { state.loading = false } }
  async function testDeepResearch() { await testSearch('deep_research') }
  async function saveDeepResearch() {
    await saveSection(() => configStore.saveConfig({ search: { ...deepResearchDraft } }),
      { saving: deepResearchSaving, saved: deepResearchSaved, error: deepResearchError }, resetDeepResearch)
  }
  async function saveSearch(source: 'general' | 'similar') {
    const similar = source === 'similar'
    await saveSection(() => configStore.saveConfig({ search: similar ? { ...similarImageDraft } : { ...generalSearchDraft } }), {
      saving: similar ? similarImageSaving : generalSearchSaving,
      saved: similar ? similarImageSaved : generalSearchSaved,
      error: similar ? similarImageError : generalSearchError,
    }, () => { if (similar) resetSimilarImageSearch(); else resetGeneralSearch() })
  }
  return { configStore, agentDraft, behaviorSaving, behaviorSaved, behaviorError, resetBehavior, saveBehavior, generalSearchDraft, deepResearchDraft, similarImageDraft, generalSearchSaving, generalSearchSaved, generalSearchError, deepResearchSaving, deepResearchSaved, deepResearchError, deepResearchTest, similarImageSaving, similarImageSaved, similarImageError, resetGeneralSearch, resetDeepResearch, resetSimilarImageSearch, searchTest, testSearch, testDeepResearch, saveDeepResearch, saveSearch }
}
