import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { i18n } from '@/i18n'
import { DesktopBridgeError, type DesktopAgentMessage, type DesktopAgentSession } from '@desktop/bridge/bridge'
import { requestDesktopAgentSessions, streamDesktopAgentMessage } from '../agent-session-transport'
import { useChatHistoryPagination } from '@/components/common/gugu-chat/composables/useChatHistoryPagination'
import { mapSessionInteraction, mapSessionMessageDelta, mergeSessionMessageDelta, sortSessionTimelineMessages } from '@/components/common/gugu-chat/composables/sessionMessageSync'
import { localizedToolStatusLabel } from '@/components/common/gugu-chat/messageDisplay'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'

type DisplayEvent = NonNullable<DesktopAgentMessage['toolTimeline']>[number]
type StreamStatus = { type: 'retry'; attempt: number; maxRetries: number; seconds: number }
  | { type: 'compaction'; active: boolean }
  | { type: 'tool'; item: DisplayEvent }

function toolStatus(item: DisplayEvent): StreamStatus | undefined {
  if (item.kind === 'tool' && (item.toolStatus === 'running' || item.toolStatus === 'queued'))
    return { type: 'tool', item }
}

function applyStreamEvent(event: { type: string; [key: string]: unknown },
  display: (item: DisplayEvent) => void, status: (value: StreamStatus | undefined) => void) {
  if (event.type === 'display_event' && event.item && typeof event.item === 'object') {
    display(event.item as DisplayEvent)
  } else if (event.type === 'retry') {
    status({ type: 'retry', attempt: Number(event.attempt), maxRetries: Number(event.max_retries), seconds: Number(event.next_retry_in) })
  } else if (event.type === '_context_compaction') {
    status({ type: 'compaction', active: event.phase === 'started' })
  } else if (event.type === 'done' || event.type === 'error') {
    status(undefined)
  }
}

export function useDesktopAgentSessions(beforeHistoryMerge: () => void) {
  const { t, locale } = i18n.global
  const sessions = ref<DesktopAgentSession[]>([])
  const selected = ref<DesktopAgentSession | null>(null)
  const messages = ref<ChatMessage[]>([])
  const listing = ref(false)
  const reading = ref(false)
  const creating = ref(false)
  const failed = ref(false)
  const sendFailed = ref('')
  const sending = ref(false)
  const inputText = ref('')
  let historyRequest = 0
  const activeSend = ref<{ id: number; operationId: string; stopped: boolean; user: ChatMessage; reply: ChatMessage; timeline: ChatMessage[]; status?: StreamStatus }>()
  const resumedRun = ref<{ id: number; runId: string; controller: AbortController; status?: StreamStatus }>()
  const sendingHere = computed(() => selected.value !== null
    && (activeSend.value?.id === selected.value.id || resumedRun.value?.id === selected.value.id))
  const sessionBadges = computed<Record<number, 'running'>>(() => {
    const badges: Record<number, 'running'> = {}
    for (const session of sessions.value) {
      if (session.isRunning || activeSend.value?.id === session.id || resumedRun.value?.id === session.id)
        badges[session.id] = 'running'
    }
    return badges
  })
  const streamStatus = computed(() => {
    const id = selected.value?.id
    const run = activeSend.value?.id === id ? activeSend.value : resumedRun.value?.id === id ? resumedRun.value : undefined
    const status = run?.status
    if (status?.type === 'tool') {
      const { toolName, toolLabelOverride } = status.item
      return localizedToolStatusLabel({ name: toolName, custom: toolLabelOverride })
    }
    if (status?.type === 'retry') return t('chatUi.retrying', { n: status.attempt, max: status.maxRetries, seconds: status.seconds })
    return status?.type === 'compaction' && status.active ? t('chatUi.contextCompacting') : ''
  })
  function detachResumedRun() {
    resumedRun.value?.controller.abort()
    resumedRun.value = undefined
  }
  onScopeDispose(() => {
    historyRequest++
    detachResumedRun()
  })
  const uncertain = new Map<number, { text: string; modelId?: string; operationId: string }>()
  let nextOptimisticId = -1
  let pendingCreate: { action: 'create'; operationId: string; title: string } | undefined
  const pendingReplies = new Set<number>()
  const uncertainReplies = new Map<number, { value: string; operationId: string }>()
  const refreshedExpiries = new Set<number>()

  watch(() => {
    if (!selected.value) return null
    let next: { id: number; runId: string; promptId: number; expiresAt: number } | null = null
    for (const { interaction, runId } of messages.value) {
      if (!runId || !interaction?.expiresAt || interaction.submitting || (interaction.resolved && !interaction.expired)
        || refreshedExpiries.has(interaction.promptId)) continue
      const expiresAt = Date.parse(interaction.expiresAt)
      if (Number.isFinite(expiresAt) && (!next || expiresAt < next.expiresAt))
        next = { id: selected.value.id, runId, promptId: interaction.promptId, expiresAt }
    }
    return next
  }, (next, _previous, cleanup) => {
    if (!next) return
    const generation = historyRequest
    const timer = setTimeout(async () => {
      refreshedExpiries.add(next.promptId)
      try {
        await syncInteractions(next.id, generation, next.runId)
        if (generation !== historyRequest) return
        const page = await requestDesktopAgentSessions({ action: 'history', id: next.id })
        if (generation === historyRequest) messages.value = mergeSessionMessageDelta(messages.value, displayMessages(page.messages))
      } catch {
        if (generation === historyRequest) failed.value = true
      }
    }, Math.max(0, next.expiresAt - Date.now()))
    cleanup(() => clearTimeout(timer))
  })

  async function syncInteractions(id: number, generation: number, runId?: string) {
    let page = await requestDesktopAgentSessions({ action: 'events', id, runId })
    while (generation === historyRequest && selected.value?.id === id) {
      for (const event of page.events ?? []) {
        if (event.type !== 'interaction_required') continue
        const existing = messages.value.find(item => item.interaction?.promptId === Number(event.prompt_id))
        const card = mapSessionInteraction({ ...event, run_id: event.core_run_id }, () => nextOptimisticId--, existing)
        if (card) messages.value = mergeSessionMessageDelta(messages.value, [card])
      }
      if (!page.hasMore || !page.runId) break
      page = await requestDesktopAgentSessions({ action: 'events', id, runId: page.runId, after: page.cursor })
    }
    return page
  }

  async function respond(message: ChatMessage, reply: { token: string } | { text: string }) {
    const id = selected.value?.id, runId = message.runId, prompt = message.interaction
    if (!id || !runId || !prompt || prompt.resolved || pendingReplies.has(prompt.promptId)) return
    const generation = historyRequest
    const value = JSON.stringify(reply)
    const previous = uncertainReplies.get(prompt.promptId)
    const operationId = previous?.value === value ? previous.operationId : crypto.randomUUID()
    uncertainReplies.set(prompt.promptId, { value, operationId })
    sendFailed.value = ''
    pendingReplies.add(prompt.promptId)
    prompt.submitting = true
    try {
      const result = await requestDesktopAgentSessions({ action: 'respond', id, runId, promptId: prompt.promptId,
        operationId, ...reply })
      uncertainReplies.delete(prompt.promptId)
      await syncInteractions(id, generation, runId)
      if (!result.awaitingText && generation === historyRequest) void resumeSession(id, runId, generation)
    } catch (error) {
      try {
        const state = await syncInteractions(id, generation, runId)
        if (generation !== historyRequest) return
        const restored = messages.value.find(item => item.interaction?.promptId === prompt.promptId)?.interaction
        if (restored?.resolved && !restored.expired && ['running', 'completed'].includes(state.status)) {
          uncertainReplies.delete(prompt.promptId)
          if (state.status === 'running') void resumeSession(id, runId, generation)
          else {
            const page = await requestDesktopAgentSessions({ action: 'history', id })
            if (generation === historyRequest) messages.value = mergeSessionMessageDelta(messages.value, displayMessages(page.messages))
          }
          return
        }
      } catch { /* 本次回复状态未知，允许使用原请求标识重试。 */ }
      if (generation === historyRequest)
        sendFailed.value = error instanceof DesktopBridgeError ? error.message : t('chatUi.desktopSendFailed')
    } finally {
      prompt.submitting = false
      pendingReplies.delete(prompt.promptId)
    }
  }

  function timelineCards(timelineEvents: NonNullable<DesktopAgentMessage['toolTimeline']>) {
    return mapSessionMessageDelta({ timelineEvents }, () => nextOptimisticId--, role => ({ role }))
  }

  function applyLiveDisplay(current: ChatMessage[], item: NonNullable<DesktopAgentMessage['toolTimeline']>[number], legacyId: number) {
    const cards = timelineCards([item])
    if (item.kind === 'tool') return mergeSessionMessageDelta(current, cards)
    const next = current.filter(message => message.id !== legacyId)
    for (const message of next) if (message.runId === item.runId) message.streaming = false
    for (const card of cards) card.streaming = Boolean(card.text)
    return mergeSessionMessageDelta(next, cards)
  }

  function displayMessages(rows: DesktopAgentMessage[]): ChatMessage[] {
    const time = new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' })
    return sortSessionTimelineMessages(rows.flatMap(row => [...(row.assistantTimeline?.length
      ? timelineCards(row.assistantTimeline).map(card => ({ ...card, streaming: false }))
      : [{
      id: row.id, dbId: row.id, role: row.role === 'assistant' ? 'ai' : 'user', text: row.text,
      time: time.format(new Date(row.createdAt)), _createdAt: row.createdAt,
      _timelineOrder: row.id * 1_000_000,
      _syncKey: row.clientMessageId ? `client:${row.clientMessageId}` : `message:${row.id}`,
      clientMessageId: row.clientMessageId, runOutcome: row.runOutcome,
    } as ChatMessage]), ...timelineCards(row.toolTimeline ?? []),
    ...(row.interactions ?? []).flatMap(item => {
      const card = mapSessionInteraction(item, () => nextOptimisticId--)
      return card ? [card] : []
    })]))
  }

  const history = useChatHistoryPagination({
    messages,
    sessionId: computed(() => selected.value?.id ?? null),
    settling: reading,
    getViewGeneration: () => historyRequest,
    beforeMerge: beforeHistoryMerge,
    async loadPage(id, before) {
      const page = await requestDesktopAgentSessions({ action: 'history', id, before })
      return { ...page, messages: displayMessages(page.messages) }
    },
  })

  async function loadSessions() {
    if (listing.value) return
    listing.value = true
    failed.value = false
    try {
      const rows = await requestDesktopAgentSessions({ action: 'list' })
      sessions.value = rows
    } catch {
      failed.value = true
    } finally {
      listing.value = false
    }
  }

  async function resumeSession(id: number, runId: string, generation: number) {
    const controller = new AbortController()
    const observation = reactive({ id, runId, controller, status: undefined as StreamStatus | undefined })
    resumedRun.value = observation
    const time = new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(new Date())
    const reply = reactive<ChatMessage>({ id: nextOptimisticId--, role: 'ai', text: '', time, streaming: true })
    const current = () => generation === historyRequest && !controller.signal.aborted
    try {
      await streamDesktopAgentMessage({ action: 'resume', id, runId, operationId: crypto.randomUUID() }, delta => {
        if (!current()) return
        observation.status = undefined
        reply.text += delta
        if (!messages.value.some(message => message.id === reply.id)) messages.value.push(reply)
      }, controller.signal, undefined, event => applyStreamEvent(event, item => {
        if (!current()) return
        observation.status = toolStatus(item)
        messages.value = applyLiveDisplay(messages.value, item, reply.id)
      }, status => {
        if (current()) observation.status = status
      }))
    } catch (error) {
      if (current() && (!(error instanceof DesktopBridgeError) || error.code !== 'cancelled'))
        sendFailed.value = error instanceof DesktopBridgeError ? error.message : t('chatUi.desktopSendFailed')
    } finally {
      reply.streaming = false
      if (current()) {
        for (const item of messages.value) if (item.runId === runId) item.streaming = false
      }
      if (current()) {
        try {
          const page = await requestDesktopAgentSessions({ action: 'history', id })
          if (current()) {
            messages.value = mergeSessionMessageDelta(messages.value.filter(message => message.id !== reply.id), displayMessages(page.messages))
            await syncInteractions(id, generation, runId)
          }
        } catch {
          if (current()) failed.value = true
        } finally {
          if (resumedRun.value?.controller === controller) resumedRun.value = undefined
          void loadSessions()
        }
      }
    }
  }

  async function loadSession(id: number) {
    const session = sessions.value.find(row => row.id === id)
    if (!session) return
    detachResumedRun()
    const request = ++historyRequest
    selected.value = session
    history.reset()
    messages.value = []
    failed.value = false
    sendFailed.value = ''
    reading.value = true
    try {
      const page = await requestDesktopAgentSessions({ action: 'history', id })
      if (request !== historyRequest) return
      messages.value = displayMessages(page.messages)
      history.reset(page.pagination)
      const operation = activeSend.value
      if (operation?.id === id) {
        if (!page.messages.some(row => row.clientMessageId === operation.operationId))
          messages.value.push(operation.user)
        if (operation.reply.text && !operation.timeline.some(item => item.role === 'ai')) messages.value.push(operation.reply)
        messages.value = mergeSessionMessageDelta(messages.value, operation.timeline)
      } else {
        const active = await syncInteractions(id, request)
        if (request !== historyRequest || !active.runId) return
        if (active.status === 'waiting') {
          const latest = messages.value.findLast(message => message.runId === active.runId && message.interaction)?.interaction
          if (!latest?.resolved || latest.expired) return
          await requestDesktopAgentSessions({ action: 'respond', id, runId: active.runId, promptId: latest.promptId, recover: true })
        } else if (!['preparing', 'running'].includes(active.status)) return
        if (request === historyRequest) void resumeSession(id, active.runId, request)
      }
    } catch {
      if (request === historyRequest) failed.value = true
    } finally {
      if (request === historyRequest) reading.value = false
    }
  }

  async function createSession() {
    if (creating.value || listing.value) return
    creating.value = true
    failed.value = false
    pendingCreate ??= { action: 'create', title: t('chatUi.newConversation'), operationId: crypto.randomUUID() }
    try {
      const session = await requestDesktopAgentSessions(pendingCreate)
      pendingCreate = undefined
      sessions.value = [session, ...sessions.value.filter(row => row.id !== session.id)]
      detachResumedRun()
      historyRequest++
      selected.value = session
      messages.value = []
      reading.value = false
    } catch {
      failed.value = true
    } finally {
      creating.value = false
    }
  }

  async function send(modelId?: string) {
    const draft = inputText.value
    const text = draft.trim()
    if (!text || sending.value || sendingHere.value || reading.value || creating.value || listing.value) return
    if (messages.value.some(({ interaction }) => interaction && !interaction.resolved && !interaction.expired
      && (!interaction.expiresAt || Date.parse(interaction.expiresAt) > Date.now()))) {
      sendFailed.value = t('chatUi.waitingConfirmation')
      return
    }
    sending.value = true
    sendFailed.value = ''
    try {
      if (!selected.value) await createSession()
      const id = selected.value?.id
      if (!id) return
      const retry = uncertain.get(id)
      const operationId = retry?.text === text && retry.modelId === modelId ? retry.operationId : crypto.randomUUID()
      uncertain.set(id, { text, modelId, operationId })
      const time = new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(new Date())
      const operation = reactive({
        id, operationId, stopped: false,
        user: { id: nextOptimisticId--, role: 'user', text, time, clientMessageId: operationId, _syncKey: `client:${operationId}` } as ChatMessage,
        reply: { id: nextOptimisticId--, role: 'ai', text: '', time, streaming: true } as ChatMessage,
        timeline: [] as ChatMessage[],
        status: undefined as StreamStatus | undefined,
      })
      activeSend.value = operation
      messages.value = [...messages.value.filter(message => message.dbId || message.clientMessageId !== operationId), operation.user]
      if (inputText.value === draft) inputText.value = ''
      const rows = await streamDesktopAgentMessage({ action: 'send', id, text, ...(modelId ? { modelId } : {}), operationId }, delta => {
        operation.status = undefined
        operation.reply.text += delta
        if (selected.value?.id === id && !reading.value && !messages.value.some(message => message.id === operation.reply.id))
          messages.value.push(operation.reply)
      }, undefined, undefined, event => applyStreamEvent(event, item => {
        operation.status = toolStatus(item)
        operation.timeline = applyLiveDisplay(operation.timeline, item, operation.reply.id)
        if (selected.value?.id === id && !reading.value)
          messages.value = applyLiveDisplay(messages.value, item, operation.reply.id)
      }, status => {
        operation.status = status
      }))
      uncertain.delete(id)
      activeSend.value = undefined
      if (selected.value?.id === id) {
        if (reading.value) await loadSession(id)
        else {
          const current = messages.value.filter(message => message.id !== operation.user.id && message.id !== operation.reply.id)
          messages.value = mergeSessionMessageDelta(current, displayMessages(rows))
          await syncInteractions(id, historyRequest)
        }
      }
      await loadSessions()
    } catch (error) {
      const operation = activeSend.value
      if (operation) {
        operation.reply.streaming = false
        for (const item of operation.timeline) {
          const visible = messages.value.find(message => message._syncKey === item._syncKey)
          if (visible) visible.streaming = false
        }
        operation.user.runOutcome = { status: operation.stopped ? 'interrupted' : 'failed' }
        const generation = historyRequest
        try {
          const page = await requestDesktopAgentSessions({ action: 'history', id: operation.id })
          const admitted = page.messages.find(row => row.clientMessageId === operation.operationId)
          if (admitted) {
            uncertain.delete(operation.id)
            if (generation === historyRequest && selected.value?.id === operation.id) {
              const current = messages.value.filter(message => message.id !== operation.user.id && message.id !== operation.reply.id)
              messages.value = mergeSessionMessageDelta(current, displayMessages(page.messages))
              if (admitted.runId && error instanceof DesktopBridgeError && ['closed', 'transport_failed'].includes(error.code)) {
                const run = await syncInteractions(operation.id, generation, admitted.runId)
                if (generation === historyRequest && run.runId) {
                  if (['preparing', 'running'].includes(run.status)) {
                    void resumeSession(operation.id, run.runId, generation)
                    return
                  }
                  if (run.status === 'waiting' || run.status === 'completed') {
                    void loadSessions()
                    return
                  }
                }
              }
            }
          }
        } catch { /* 读取结果未知时保留原消息标识，供同一输入重试。 */ }
        if (uncertain.has(operation.id) && !inputText.value && selected.value?.id === operation.id) inputText.value = draft
      }
      if (!operation?.stopped && (!operation || selected.value?.id === operation.id)) {
        sendFailed.value = error instanceof DesktopBridgeError && error.code === 'model_unavailable'
          ? error.message : t('chatUi.desktopSendFailed')
      }
    } finally {
      activeSend.value = undefined
      sending.value = false
    }
  }

  async function stopStreaming() {
    const operation = activeSend.value
    const resumed = resumedRun.value
    if (resumed && resumed.id === selected.value?.id) {
      try { await requestDesktopAgentSessions({ action: 'cancelRun', id: resumed.id, runId: resumed.runId }) }
      catch { if (resumedRun.value === resumed) sendFailed.value = t('chatUi.cancelFailed') }
      return
    }
    if (!operation || operation.stopped || operation.id !== selected.value?.id) return
    operation.stopped = true
    try {
      await requestDesktopAgentSessions({ action: 'cancel', id: operation.id, operationId: operation.operationId })
    } catch {
      operation.stopped = false
      if (activeSend.value === operation) sendFailed.value = t('chatUi.cancelFailed')
    }
  }

  const sessionEdits = new Set<number>()

  async function renameSession(id: number, title: string) {
    const target = sessions.value.find(session => session.id === id)
    const trimmed = title.trim()
    if (!target || !trimmed || trimmed === target.title || sessionEdits.has(id)) return
    sessionEdits.add(id)
    sendFailed.value = ''
    try {
      const updated = await requestDesktopAgentSessions({ action: 'rename', id, title: trimmed, operationId: crypto.randomUUID() })
      sessions.value = sessions.value.map(session => session.id === id ? { ...session, title: updated.title } : session)
      if (selected.value?.id === id) selected.value = { ...selected.value, title: updated.title }
    } catch {
      sendFailed.value = t('chatUi.desktopRenameFailed')
    } finally {
      sessionEdits.delete(id)
    }
  }

  async function deleteSession(id: number) {
    const session = sessions.value.find(item => item.id === id)
    if (!session || sessionEdits.has(id)) return
    sessionEdits.add(id)
    try {
      if (!await confirmDialog({
        title: t('chatUi.desktopDeleteTitle'),
        message: t('chatUi.desktopDeleteMessage', { title: session.title }),
        confirmText: t('common.actions.delete'),
        tone: 'danger',
      })) return
      sendFailed.value = ''
      await requestDesktopAgentSessions({ action: 'delete', id, operationId: crypto.randomUUID() })
      sessions.value = sessions.value.filter(item => item.id !== id)
      if (selected.value?.id !== id) return
      detachResumedRun()
      historyRequest++
      history.reset()
      selected.value = null
      messages.value = []
      reading.value = false
      inputText.value = ''
    } catch (error) {
      sendFailed.value = error instanceof DesktopBridgeError && error.code === 'conflict'
        ? t('chatUi.desktopDeleteBusy') : t('chatUi.desktopDeleteFailed')
    } finally {
      sessionEdits.delete(id)
    }
  }

  return { historyState: history.state, loadOlder: history.loadOlder, stopStreaming, sessions, sessionBadges, selected, messages, listing, reading, creating, failed, sendFailed, sendingHere, streamStatus, inputText, send, respond, loadSessions, loadSession, createSession, renameSession, deleteSession }
}
