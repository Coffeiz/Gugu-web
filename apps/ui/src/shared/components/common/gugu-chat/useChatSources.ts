import { inject, shallowReactive, watch, watchEffect } from 'vue'
import { agentApi } from '@/services/api'
import { chatToolDetailsKey } from './chatPresentationAccess'
import { readChatSources, type ChatSource } from './chatSources'
import type { ChatMessage } from './chatTypes'

export function useChatSources(
  session: () => number | null,
  messages: () => readonly ChatMessage[],
  visible: () => readonly ChatMessage[],
) {
  const readDetails = inject(chatToolDetailsKey, agentApi.getToolEventDetails)
  const cache = shallowReactive(new Map<string, ChatSource[] | null>())
  const liveCache = new WeakMap<object, ChatSource[]>()
  let sessionGeneration = 0
  watch(session, () => { sessionGeneration++; cache.clear() }, { flush: 'sync' })
  const key = (id: number, tool: ChatMessage) => `${id}:${tool._toolDetailsSource?.messageId}:${tool._toolDetailsSource?.index}`
  const webSearch = (tool: ChatMessage) => tool.role === 'tool' && tool.toolName === 'web_search' && tool.toolStatus === 'success'
  watchEffect(() => {
    const id = session()
    if (id == null) return
    const generation = sessionGeneration
    const runs = new Set(visible().filter(msg => msg.role === 'ai' && !msg.streaming && /https?:\/\//i.test(msg.text)).map(msg => msg.runId).filter(Boolean))
    if (!runs.size) return
    let slots = 4 - [...cache.values()].filter(value => value === null).length
    for (const tool of messages()) {
      if (slots <= 0) break
      const source = tool._toolDetailsSource
      if (!source || !runs.has(tool.runId) || !webSearch(tool) || tool.toolResult !== undefined) continue
      const entry = key(id, tool)
      if (cache.has(entry)) continue
      slots--
      cache.set(entry, null)
      void readDetails(id, source).then(
        details => { if (generation === sessionGeneration) cache.set(entry, readChatSources(details.toolResult)) },
        () => { if (generation === sessionGeneration) cache.set(entry, []) },
      )
    }
  })
  function liveSources(result: unknown) {
    if (!result || typeof result !== 'object') return readChatSources(result)
    const cached = liveCache.get(result)
    if (cached) return cached
    const sources = readChatSources(result)
    liveCache.set(result, sources)
    return sources
  }
  return (msg: ChatMessage, messageIndex: number): ChatSource[] | undefined => {
    if (!msg.runId || msg.streaming || !/https?:\/\//i.test(msg.text)) return
    const id = session()
    const sources = new Map<string, ChatSource>()
    for (const tool of messages().slice(0, messageIndex)) {
      if (tool.runId !== msg.runId || !webSearch(tool)) continue
      const entries = tool.toolResult === undefined
        ? (id != null ? cache.get(key(id, tool)) : undefined)
        : liveSources(tool.toolResult)
      for (const source of entries ?? []) sources.set(source.url, source)
    }
    if (sources.size) return [...sources.values()]
  }
}
