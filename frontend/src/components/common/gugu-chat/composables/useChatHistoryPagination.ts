import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { agentApi } from '@/services/api'
import type { ChatMessage } from '../chatTypes'
import { mapSessionMessageDelta, mergeSessionMessageDelta, sortSessionTimelineMessages } from './sessionMessageSync'

export interface ChatHistoryState { hasMore: boolean; loading: boolean; error: boolean }
interface HistoryPage { hasMore?: boolean; oldestId?: number | null }

/** 历史游标独立于搜索跳转窗口；切会话和卸载后丢弃迟到响应。 */
export function useChatHistoryPagination(options: {
  messages: Ref<ChatMessage[]>
  sessionId: Ref<number | null>
  settling: Ref<boolean>
  mkid: () => number
  resolveSpeaker: Parameters<typeof mapSessionMessageDelta>[2]
  getViewGeneration?: () => number
  beforeMerge: () => void
}) {
  const hasMore = ref(false)
  const loading = ref(false)
  const error = ref(false)
  let oldestId: number | null = null
  let generation = 0

  function reset(page?: HistoryPage) {
    generation++
    oldestId = page?.oldestId ?? null
    hasMore.value = Boolean(page?.hasMore && oldestId != null)
    loading.value = false
    error.value = false
  }
  watch(options.sessionId, () => reset(), { flush: 'sync' })
  onScopeDispose(() => reset())

  async function loadOlder(retry = false) {
    const session = options.sessionId.value
    const cursor = oldestId
    if (!session || !cursor || !hasMore.value || loading.value || options.settling.value || (error.value && !retry)) return
    const request = generation
    const view = options.getViewGeneration?.()
    const isCurrent = () => request === generation && options.sessionId.value === session && options.getViewGeneration?.() === view
    loading.value = true
    error.value = false
    try {
      const data = await agentApi.getMessagesBefore(String(session), cursor, 50)
      if (!isCurrent()) return
      const next = data.pagination?.oldestId as number | null | undefined
      if (data.messages?.length && (next == null || next >= cursor)) throw new Error('历史游标未前进')
      const incoming = mapSessionMessageDelta(data, options.mkid, options.resolveSpeaker)
      options.beforeMerge()
      options.messages.value = sortSessionTimelineMessages(mergeSessionMessageDelta(options.messages.value, incoming))
      oldestId = next ?? null
      hasMore.value = Boolean(data.pagination?.hasMore && oldestId != null)
    } catch {
      if (isCurrent()) error.value = true
    } finally {
      if (request === generation) loading.value = false
    }
  }

  return {
    state: computed<ChatHistoryState>(() => ({ hasMore: hasMore.value, loading: loading.value, error: error.value })),
    reset, loadOlder,
  }
}
