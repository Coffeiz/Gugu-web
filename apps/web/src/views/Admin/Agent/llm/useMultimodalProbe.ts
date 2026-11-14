import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LlmMessagePart } from './useLlmPresets'

type ProbeDraft = {
  id?: string | number
  provider: string
  api_key: string
  base_url: string
  model: string
  [key: string]: unknown
}

type ProbeDependencies = {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>
  target: () => ProbeDraft | null
  presets: () => Array<{ id: string | number; [key: string]: unknown }>
  dimensions: () => Array<{ key: string; label: string }>
  probingId: Ref<string | number | null>
  probingDim: Ref<string | null>
  showMsg: (text: string, isError?: boolean, withCheck?: boolean) => void
  showMsgParts: (text: string, parts: LlmMessagePart[]) => void
}

/** 卡片检测反馈归列表，编辑器内的单维度检测反馈只归当前草稿。 */
export function useMultimodalProbe(deps: ProbeDependencies) {
  const { t } = useI18n()
  let generation = 0
  const editorFeedback = ref<{ text: string; isError: boolean } | null>(null)
  const identity = () => {
    const draft = deps.target()
    return draft ? [draft.provider, draft.model, draft.base_url, draft.api_format, draft.api_key].join('|') : ''
  }
  watch([deps.target, identity], () => { editorFeedback.value = null })

  async function probeMedia(id: string | number | undefined, dim?: string) {
    const requestGeneration = ++generation
    const target = deps.target()
    const startedIdentity = identity()
    if (dim && !target) return
    if (dim) {
      deps.probingDim.value = dim
      editorFeedback.value = null
    } else deps.probingId.value = id ?? null
    const stillCurrent = () => !dim || (deps.target() === target && startedIdentity === identity())
    try {
      const preview = Boolean(dim && !id && target)
      const url = preview
        ? `/api/v1/admin/agent/llm-presets/probe-media-preview?dim=${dim}`
        : `/api/v1/admin/agent/llm-presets/${id}/probe-media${dim ? `?dim=${dim}` : ''}`
      const response = await deps.authFetch(url, {
        method: 'POST',
        ...(preview ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: target!.provider, api_key: target!.api_key, base_url: target!.base_url, model: target!.model, api_format: target!.api_format || '' }) } : {}),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('adminAgentUi.operationFailed'))
      if (!stillCurrent()) return
      if (dim) {
        const label = deps.dimensions().find(item => item.key === dim)?.label || dim
        editorFeedback.value = {
          text: data.supported === true ? t('adminAgentUi.dimensionSupported', { label })
            : t(data.supported === false ? 'adminAgentUi.dimensionUnsupported' : 'adminAgentUi.dimensionUnknown', { label, detail: data.detail }),
          isError: data.supported !== true,
        }
        if (typeof data.supported === 'boolean') target![dim] = data.supported
      } else {
        const parts: LlmMessagePart[] = []
        for (const dimension of deps.dimensions()) {
          const result = data.results?.[dimension.key]
          if (!result) continue
          if (typeof result.supported === 'boolean') {
            const preset = deps.presets().find(item => String(item.id) === String(id))
            if (preset) preset[dimension.key] = result.supported
          }
          parts.push({ key: dimension.key, label: dimension.label,
            text: t(result.supported === true ? 'profileByokUi.statusSupported' : result.supported === false ? 'profileByokUi.statusUnsupported' : 'profileByokUi.statusUnknown'),
            status: result.supported === true ? 'supported' : result.supported === false ? 'unsupported' : 'unknown' })
        }
        if (parts.length) deps.showMsgParts(t('adminAgentUi.probeCompleteLabel'), parts)
        else deps.showMsg(t('adminAgentUi.probeNoResult'))
      }
    } catch (cause) {
      if (!stillCurrent()) return
      const text = t('adminAgentUi.probeFailed', { message: cause instanceof Error ? cause.message : String(cause) })
      if (dim) editorFeedback.value = { text, isError: true }
      else deps.showMsg(text, true)
    } finally {
      if (requestGeneration === generation) {
        deps.probingId.value = null
        deps.probingDim.value = null
      }
    }
  }
  return { editorFeedback, probeMedia }
}
