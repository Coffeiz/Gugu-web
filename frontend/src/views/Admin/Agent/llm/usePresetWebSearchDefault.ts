import { ref } from 'vue'
import { providerWebSearchAvailable } from '@/utils/providerWebSearch'

type WebSearchDraft = {
  provider: string
  api_format?: unknown
  model?: unknown
  base_url?: unknown
  ollama_mode?: unknown
  web_search_enabled: boolean
}

export function usePresetWebSearchDefault() {
  const touched = ref(false)

  function reset() {
    touched.value = false
  }

  function sync(draft: WebSearchDraft | null, isNew: boolean) {
    if (!draft || !isNew) return
    const supported = providerWebSearchAvailable(draft)
    if (!supported) draft.web_search_enabled = false
    else if (!touched.value) draft.web_search_enabled = true
  }

  function set(draft: WebSearchDraft | null, enabled: boolean) {
    if (!draft) return
    touched.value = true
    draft.web_search_enabled = enabled
  }

  return { reset, sync, set }
}
