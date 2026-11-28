import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { agentApi } from '@/services/api'
import type { ChatMessage } from '../chatTypes'
import { mapSessionMessageDelta, mergeSessionMessageDelta } from './sessionMessageSync'

export interface ChatHistoryState { hasMore: boolean; loading: boolean; error: boolean }
interface HistoryPage { hasMore?: boolean; oldestId?: number | null }

/** 历史游标独立于搜索跳转窗口；切会话和卸载后丢弃迟到响应。 */
export function useChatHistoryPagination(options: {
  messages: Ref<ChatMessage[]>
  sessionId: Ref<number | null>
  settling: Ref<boolean>
  getViewGeneration?: () => number
  beforeMerge: () => void
} & { mkid?: () => number; resolveSpeaker?: Parameters<typeof mapSessionMessageDelta>[2]; loadPage?: (session: number, cursor: number) => Promise<{ messages: ChatMessage[]; pagination?: HistoryPage }> }) {
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
      const page = options.loadPage
        ? await options.loadPage(session, cursor)
        : await agentApi.getMessages(session, { beforeId: cursor, limit: 50 }).then(data => {
          if (!isCurrent()) return null
          if (!options.mkid || !options.resolveSpeaker) throw new Error('聊天历史映射器未配置')
          return { pagination: data.pagination, messages: mapSessionMessageDelta(data, options.mkid, options.resolveSpeaker) }
        })
      if (!page || !isCurrent()) return
      const next = page.pagination?.oldestId as number | null | undefined
      // 游标按发生时间前进，较早到达的 IM 消息可能有更大的数据库 ID。
      if (next === cursor || (page.pagination?.hasMore && next == null)) throw new Error('历史游标未前进')
      options.beforeMerge()
      options.messages.value = mergeSessionMessageDelta(options.messages.value, page.messages)
      oldestId = next ?? null
      hasMore.value = Boolean(page.pagination?.hasMore && oldestId != null)
    } catch {
      if (isCurrent()) error.value = true
    } finally {
      if (request === generation) loading.value = false
    }
  }

  return {
    state: computed<ChatHistoryState>(() => ({ hasMore: hasMore.value, loading: loading.value, error: error.value })),
    currentPage: () => ({ hasMore: hasMore.value, oldestId }),
    reset, loadOlder,
  }
}
