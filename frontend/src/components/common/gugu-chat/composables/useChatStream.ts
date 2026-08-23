import { ref, type Ref } from 'vue'
import { trackApi, agentApi, CLIENT_ID, getToken } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { playGuguSfx } from '@/services/sfx'
import type { ChatMessage, ChatFile, ChatSession } from '../chatTypes'
import { renderMd } from '../markdown'
import { API_BASE } from '../chatConstants'
import { FILE_TOOLS, PROJECT_TOOLS, CALENDAR_TOOLS } from './useChatActions'
import type GuguChatComposer from '../GuguChatComposer.vue'

interface StatusItem { kind: 'text' | 'dots' | 'hide'; label?: string }

interface QueuedMessage {
  text: string
  attachments: ChatFile[]
  sessionId: number | null
  viewGeneration: number
}

/**
 * SSE 收发的唯一状态所有权：streaming、AbortController、生成中消息排队、
 * 当前会话已发轮次（埋点用）。send（POST /chat）和续看 resumeStream
 * （GET .../stream）共用同一套 consumeStream 消费逻辑。
 *
 * 不拥有 messages/sessionId/sessions 本身（由调用方——useChatConversation /
 * useChatSessions 传入读写）、也不拥有会话列表刷新的触发时机之外的逻辑。
 *
 * getViewGeneration 是只读依赖：只在切会话时递增，这里只用来判断"写回
 * messages 前，用户是不是还停在发起这次请求时的那个视图"，递增的所有权
 * 在 useChatSessions（loadSession/newSession 才会切视图）。
 */
export function useChatStream(options: {
  messages: Ref<ChatMessage[]>
  mkid: () => number
  now: () => string
  inputText: Ref<string>
  sessionId: Ref<number | null>
  sessions: Ref<ChatSession[]>
  getViewGeneration: () => number
  pendingAtt: Ref<ChatFile[]>
  composerRef: Ref<InstanceType<typeof GuguChatComposer> | null>
  setStatus: (item: StatusItem) => void
  clearStatus: () => void
  thinkingItem: () => StatusItem
  scrollBottom: (force?: boolean) => Promise<void>
  fetchSessions: () => Promise<void>
  refreshAfterTools: (usedTools: Set<string>) => Promise<void>
  loadQuota: () => void
  playIncomingMessageSfx: () => void
  onContentReset?: () => void
}) {
  const liveStore = useLiveStore()
  const { messages, mkid, now, sessionId, sessions } = options

  const streaming = ref(false)
  const abortCtrl = ref<AbortController | null>(null)
  // 新会话首轮在 session_id SSE 到达前仍是 null；记录后台生成归属，
  // 让中断按钮不会因为前端尚未切换 sessionId 而漏发取消请求。
  let activeSessionId: number | null = null
  // 生成中发的消息，排队等流式结束后接着发。每条都带上入队那一刻的 sessionId/
  // viewGeneration——切会话/新建会话时 useChatSessions 会调 clearPendingQueue()
  // 清空，但万一切换和这里的消费之间有竞态，消费前再核对一次身份，防止把
  // A 会话排队的消息发进已经切到的 B 会话（真实复现过的 bug，见 PR review）。
  const pendingQueue = ref<QueuedMessage[]>([])
  let _sessionTurn = 0                      // 当前 session 已发消息轮次（埋点用），切会话由 useChatSessions 调 resetSessionTurn 重置
  function resetSessionTurn() { _sessionTurn = 0 }

  function stopStreaming() {
    pendingQueue.value = []   // 停止=放弃排队中的消息
    const id = activeSessionId ?? sessionId.value
    abortCtrl.value?.abort()
    if (id != null) agentApi.cancelSession(String(id)).catch(() => {})
  }

  function clearPendingQueue() {
    pendingQueue.value = []
  }

  // 新对话第一轮发送时 sessionId 还是 null——后端稍后通过 session_id 事件回传真实 id。
  // 把这个真实 id 回填到所有「入队时 sessionId == null 且属于当前 viewGeneration」的排队项上，
  // 否则下一轮消费时 null !== realId 会被当作"已经离开的会话"丢弃（PR #8 复查的 P1）。
  // 消费条件也放宽：sessionId == null 表示"入队时还没拿到"，允许在同 viewGeneration 内消费。
  function resolvePendingSession(realId: number) {
    const curView = options.getViewGeneration()
    pendingQueue.value = pendingQueue.value.map(it =>
      it.sessionId == null && it.viewGeneration === curView ? { ...it, sessionId: realId } : it
    )
  }

  // 消费一条 SSE 流，把事件渲染进消息列表。send（POST /chat）和续看（GET .../stream）共用。
  // 返回 { aiIdx, usedTools }，供调用方做收尾（首条空回复兜底、刷新视图）。
  async function consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    ownerSid: number | null,
    viewGeneration: number,
    replayText = '',
  ) {
    const streamStartedAt = Date.now()
    const decoder = new TextDecoder()
    let buf = '', aiIdx = -1, aborted = false, interactionPaused = false
    let sid = ownerSid           // 本流归属的会话（新对话在 session_id 事件前为 null）
    let detached = false         // 一旦用户切到别的会话，本流永久脱离、不再污染当前视图
    let replaySuppressed = false
    const displayedGreeting = ownerSid == null
      ? (messages.value.find(m => m._greeting)?._greetFull || '').trim()
      : ''
    const usedTools = new Set<string>()
    let currentRoundId = ''
    let currentRunId = ''
    const toolMessageIndexes = new Map<string, number>()
    let timelineOrder = messages.value.reduce(
      (max, message) => Math.max(max, message._timelineOrder ?? 0),
      0,
    )
    const nextTimelineOrder = () => ++timelineOrder
    const sortLiveTimeline = () => {
      messages.value.sort((a, b) => {
        if (a._timelineOrder == null || b._timelineOrder == null) return 0
        return a._timelineOrder - b._timelineOrder
      })
    }
    // 每个 round 的正文必须是独立气泡。工具调用前的草稿属于上一轮，
    // 下一轮 token 不能继续写入同一个 aiIdx，否则 UI 会把多轮正文拼成一条消息。
    const finishRoundMessage = () => {
      if (aiIdx === -1 || !messages.value[aiIdx]) return
      const message = messages.value[aiIdx]
      message.streaming = false
      if (message.text.trim()) message.html = renderMd(message.text)
      aiIdx = -1
    }
    // 当前看的还是本流的会话吗？切走后置 detached（之后切回靠 loadSession 干净重载，不半路重接）
    const live = () => {
      if (detached || viewGeneration !== options.getViewGeneration()) {
        detached = true
        return false
      }
      if (sessionId.value !== (sid ?? ownerSid)) { detached = true; return false }
      return true
    }
    try {
      while (true) {
        let chunk
        try { chunk = await reader.read() }
        catch (e: any) { if (e?.name === 'AbortError') { aborted = true; break; } throw e }   // 切会话会 abort：优雅收尾，别当网络错
        const { done, value } = chunk
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim(); if (!raw) continue
          let evt; try { evt = JSON.parse(raw) } catch { continue }
          if (evt.type === 'session_id') {
            const isNew = sessionId.value !== evt.session_id
            // 仅当用户仍停在本流视图（旧会话或新对话）才把视图切到新 id，否则别抢走用户当前会话
            if (viewGeneration === options.getViewGeneration() && sessionId.value === (sid ?? ownerSid)) {
              sessionId.value = evt.session_id
            }
            // 真实 id 到位后立即回填排队项：上面分支只在视图未切换时才更新 sessionId.value，
            // 但排队项仍可能在视图已切换的情况下属于旧视图——这里只看"是否本流视图"，
            // 不强求 sessionId.value 已同步。否则新会话首轮排队的第二条消息仍会被丢弃。
            if (viewGeneration === options.getViewGeneration()) {
              resolvePendingSession(evt.session_id)
            }
            sid = evt.session_id
            activeSessionId = evt.session_id
            if (isNew) await options.fetchSessions()
          } else if (evt.type === 'session_title') {
            const s = sessions.value.find(s => s.id === sid)   // 按本流会话更新标题，与当前视图无关
            if (s) s.title = evt.title
          } else if (evt.type === 'round_start') {
            finishRoundMessage()
            currentRunId = String(evt.run_id || currentRunId)
            currentRoundId = String(evt.round_id || `round-${toolMessageIndexes.size + 1}`)
          } else if (evt.type === '_new_round') {
            // 兼容旧事件：新版 round_start 已先建立身份，旧客户端只看到这里也不会报错。
            finishRoundMessage()
            currentRunId = String(evt.run_id || currentRunId)
            if (evt.round_id) currentRoundId = String(evt.round_id)
          } else if (evt.type === 'tool_call') {
            if (evt.name && !evt.name.startsWith('_')) usedTools.add(evt.name)  // 跳过 _preparing 占位
            const toolCallId = String(evt.tool_call_id || `${evt.round_id || currentRoundId || 'round'}-tool-${toolMessageIndexes.size + 1}`)
            if (live() && !evt.name?.startsWith('_')) {
              const messageId = mkid()
              messages.value.push({
                id: messageId, role: 'tool', text: '', time: now(),
                _timelineOrder: nextTimelineOrder(),
                runId: evt.run_id, roundId: evt.round_id || currentRoundId,
                toolCallId, toolName: evt.name, toolLabel: evt.label,
                toolStatus: evt.status || 'running', toolInput: evt.input,
                _toolStartedAt: Date.now(),
              })
              sortLiveTimeline()
              toolMessageIndexes.set(toolCallId, messages.value.findIndex(item => item.id === messageId))
              await options.scrollBottom()
            }
            // label 已由后端解析（含「状态命名」覆盖 + 复查前缀）；气泡常驻，仅替换文字。
            if (live()) options.setStatus({ kind: 'text', label: evt.label || evt.name })
          } else if (evt.type === 'tool_done') {
            // 改动类工具一完成就即时 bump 对应资源（走已连好的对话流，不等回合末、不靠 best-effort
            // 的 events SSE）→ 文件预览 / 项目卡 / 日历当场刷新。视图是全局的，切走也该刷，故不受 live() 限制。
            if (evt.name) {
              if (FILE_TOOLS.has(evt.name)) liveStore.bump('files')
              else if (PROJECT_TOOLS.has(evt.name)) liveStore.bump('projects')
              else if (CALENDAR_TOOLS.has(evt.name)) liveStore.bump('calendar')
            }
            const toolCallId = evt.tool_call_id ? String(evt.tool_call_id) : ''
            const toolIndex = toolCallId ? toolMessageIndexes.get(toolCallId) : undefined
            if (toolIndex !== undefined && messages.value[toolIndex]) {
              messages.value[toolIndex].toolStatus = evt.status || 'success'
              if (evt.result !== undefined) messages.value[toolIndex].toolResult = evt.result
              const startedAt = (messages.value[toolIndex] as ChatMessage & { _toolStartedAt?: number })._toolStartedAt
              if (startedAt) messages.value[toolIndex].toolDurationMs = Math.max(0, Date.now() - startedAt)
            }
            // 任一工具结束都回到思考态；下一轮工具调用会继续替换文字，不能让气泡闪退。
            if (live()) options.setStatus(options.thinkingItem())
          } else if (evt.type === 'interaction_required') {
            interactionPaused = true
            if (live() && evt.prompt_id && Array.isArray(evt.options)) {
              const promptId = Number(evt.prompt_id)
              const existing = messages.value.find(item =>
                item.role === 'interaction' && item.interaction?.promptId === promptId,
              )
              if (existing?.interaction) {
                // loadSession 先恢复历史、resumeStream 再收到快照时会命中这里；
                // 合并而不是追加，避免刷新后同一个交互出现两张卡。
                existing.runId = evt.run_id
                existing.roundId = evt.round_id
                existing.interaction.toolCallId = evt.tool_call_id ? String(evt.tool_call_id) : existing.interaction.toolCallId
                existing.interaction.title = String(evt.title || existing.interaction.title || '需要确认')
                existing.interaction.body = String(evt.body || existing.interaction.body || '')
                if (!existing.interaction.resolved) existing.interaction.options = evt.options
              } else {
                messages.value.push({
                  id: mkid(), role: 'interaction', text: '', time: now(),
                  _timelineOrder: nextTimelineOrder(),
                  runId: evt.run_id, roundId: evt.round_id,
                  interaction: {
                    promptId, kind: String(evt.kind || 'confirm'),
                    toolCallId: evt.tool_call_id ? String(evt.tool_call_id) : null,
                    title: String(evt.title || '需要确认'), body: String(evt.body || ''),
                    options: evt.options,
                  },
                })
                sortLiveTimeline()
              }
              options.setStatus({ kind: 'text', label: '等待你的确认' })
              await options.scrollBottom()
            }
          } else if (evt.type === 'token') {
            if (live()) {
              // 切回会话时，历史接口可能已经拿到完整助手消息，而 active 标记
              // 尚未来得及清掉。resume 的首个 token 是同一段 Redis snapshot，
              // 这时跳过它；真正后续新增 token 仍正常创建/追加流式气泡。
              if (!replaySuppressed && replayText && String(evt.content || '').trim() === replayText) {
                replaySuppressed = true
                continue
              }
              options.clearStatus()   // 真回复开始 → 打断状态队列、收起指示，让位给流式正文
              if (aiIdx === -1) options.playIncomingMessageSfx()
              if (aiIdx === -1) {
                const messageId = mkid()
                messages.value.push({
                  id: messageId, role: 'ai', text: '', time: now(), streaming: true,
                  runId: evt.run_id || currentRunId || undefined,
                  roundId: evt.round_id || currentRoundId || undefined,
                  _timelineOrder: nextTimelineOrder(),
                })
                sortLiveTimeline()
                aiIdx = messages.value.findIndex(item => item.id === messageId)
              }
              messages.value[aiIdx].text += evt.content
              await options.scrollBottom()
            }
          } else if (evt.type === 'file') {
            if (live()) {
              options.clearStatus()
              if (aiIdx === -1) options.playIncomingMessageSfx()
              if (aiIdx === -1) {
                const messageId = mkid()
                messages.value.push({
                  id: messageId, role: 'ai', text: '', time: now(), streaming: true,
                  runId: evt.run_id || currentRunId || undefined,
                  roundId: evt.round_id || currentRoundId || undefined,
                  _timelineOrder: nextTimelineOrder(),
                })
                sortLiveTimeline()
                aiIdx = messages.value.findIndex(item => item.id === messageId)
              }
              const m = messages.value[aiIdx]
              if (!m.files) m.files = []
              m.files.push(evt.file)
              await options.scrollBottom()
            }
          } else if (evt.type === 'done') {
            if (live()) options.clearStatus()
          } else if (evt.type === 'error') {
            if (live()) {
              options.clearStatus()
              playGuguSfx('error')
              messages.value.push({ id: mkid(), role: 'ai', text: evt.message || evt.detail || '咕咕开小差了 😵‍💫 麻烦再说一遍好吗？', time: now() })
              aiIdx = messages.value.length - 1
              await options.scrollBottom()
            }
          }
        }
      }
    } finally {
      if (!detached && viewGeneration === options.getViewGeneration() && aiIdx !== -1 && messages.value[aiIdx]) {
        const m = messages.value[aiIdx]
        // 新会话打开时默认问候已经展示在列表里。若模型仍原样复述，
        // 丢掉这条重复流，只保留原来的问候气泡，避免用户看到两条相同回复。
        const duplicateGreeting = Boolean(displayedGreeting && !m.files?.length && m.text.trim() === displayedGreeting)
        m.streaming = false
        m.html = renderMd(m.text)
        if (duplicateGreeting || (!m.text?.trim() && !m.files?.length)) {
          messages.value.splice(aiIdx, 1)
        }
      }
    }
    // 工具执行成功后，后端可能已经持久化最终 assistant 消息，但最后一段 SSE
    // 正文在连接收尾竞态中没有被浏览器消费到。此时不能直接显示“没有回复”，
    // 先用本轮工具执行期间创建的最新 assistant 消息恢复视图。
    if (aiIdx === -1 && usedTools.size && sid != null && !detached && !aborted && !interactionPaused
        && viewGeneration === options.getViewGeneration()) {
      try {
        const recovered = await agentApi.getMessages(String(sid))
        const latest = [...(recovered.messages || [])].reverse().find((item: any) =>
          item.role === 'assistant' &&
          (item.content?.trim() || item.files?.length) &&
          (!item.createdAt || Date.parse(item.createdAt) >= streamStartedAt - 60_000),
        )
        if (latest && live()) {
          const messageId = mkid()
          messages.value.push({
            id: messageId,
            dbId: latest.id,
            role: 'ai',
            text: latest.content || '',
            html: latest.content ? renderMd(latest.content) : null,
            files: latest.files?.length ? latest.files : undefined,
            quotedText: latest.quotedText || undefined,
            time: new Date(latest.createdAt || Date.now()).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
            _createdAt: latest.createdAt,
            _timelineOrder: latest.timelineOrder ?? latest.id,
          })
          sortLiveTimeline()
          aiIdx = messages.value.findIndex(item => item.id === messageId)
          await options.scrollBottom()
        }
      } catch { /* 恢复失败再由调用方决定是否显示兜底提示 */ }
    }
    return { aiIdx, usedTools, detached, sid, aborted, interactionPaused }
  }

  // 续看：打开会话时若它正在生成（messages 接口返回 active），重连看后端跑完。
  async function resumeStream(id: number) {
    if (streaming.value) return            // 本地正在发/看，不重复连
    const viewGeneration = options.getViewGeneration()
    activeSessionId = id
    const token = getToken()
    abortCtrl.value = new AbortController()   // 让下次切会话能 abort 掉这条续看
    streaming.value = true; options.clearStatus(); options.setStatus(options.thinkingItem())
    try {
      const res = await fetch(`${API_BASE}/agent/sessions/${id}/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: abortCtrl.value.signal,
      })
      if (!res.ok) return
      if (viewGeneration !== options.getViewGeneration() || sessionId.value !== id) return   // 期间又切走了，丢弃
      if (!res.body) return
      const replayText = [...messages.value].reverse()
        .find(m => m.role === 'ai' && m.text?.trim())?.text.trim() || ''
      const r = await consumeStream(res.body.getReader(), id, viewGeneration, replayText)
      options.refreshAfterTools(r.usedTools)
    } catch { /* 续看失败/被切走中断都不打扰 */ }
    finally {
      // 仍停在本会话才收尾全局指示，避免切走后清掉新会话续看的状态
      if (viewGeneration === options.getViewGeneration() && sessionId.value === id) {
        options.clearStatus(); streaming.value = false; abortCtrl.value = null
      }
      if (activeSessionId === id) activeSessionId = null
    }
  }

  async function send(forcedText?: string, forcedAttachments?: ChatFile[]) {
    // forcedText 来自"排队接力"（队首消息）：此时用户气泡已在入队时显示过，不重复推
    const fromInput = forcedText === undefined
    const text = (fromInput ? options.inputText.value : (forcedText ?? '')).trim()
    const atts = fromInput ? options.pendingAtt.value.slice() : (forcedAttachments ?? [])   // 本次随消息发的附件
    if (!text && !atts.length) return
    if (fromInput) {
      const isNewCommand = /^\/new\s*$/i.test(text)
      _sessionTurn++
      if (isNewCommand && !streaming.value) {
        // /new 本身是控制命令，不成为新上下文的一部分；后端也会删除它的持久消息。
        messages.value = []
        options.onContentReset?.()
      } else {
        messages.value.push({ id: mkid(), role: 'user', text, time: now(),
          files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined })
      }
      options.inputText.value = ''
      options.pendingAtt.value = []
      options.composerRef.value?.resetHeight()
      trackApi.track('chat_message', { turn: _sessionTurn }).catch(() => {})
      await options.scrollBottom(true)
    }
    // 生成中：把这条排队，等当前流式结束后在 finally 里接着发（气泡已显示）。
    // 带上此刻的会话身份——真正发出去之前会再核对一次，身份对不上就丢弃，不发进别的会话。
    if (streaming.value) {
      pendingQueue.value.push({
        text, attachments: atts,
        sessionId: sessionId.value, viewGeneration: options.getViewGeneration(),
      })
      return
    }

    streaming.value = true; options.clearStatus(); options.setStatus(options.thinkingItem())
    abortCtrl.value = new AbortController()
    await options.scrollBottom()
    const token = getToken()
    const ownerSid = sessionId.value   // 本次发送归属的会话（新对话为 null，流里拿到 id 后回填）
    activeSessionId = ownerSid
    const viewGeneration = options.getViewGeneration()
    let resolvedSid = ownerSid         // 流里 session_id 事件后回填成真实 id
    let aiIdx = -1
    const usedTools = new Set<string>()

    // 新会话且当前显示着默认问候 → 把问候随首条消息带给后端，落为本会话首条 assistant 消息，
    // 这样咕咕回复时能看到「自己已经打过招呼」，不会把用户对问候的回复当成对话刚开始。
    const _g0 = messages.value[0]
    const greetingForSession = (ownerSid == null && _g0?._greeting) ? (_g0._greetFull || _g0.text || '') : ''

    try {
      const res = await fetch(`${API_BASE}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message: text, session_id: ownerSid, attachments: atts.map(a => a.attach_id),
                               ...(greetingForSession ? { greeting: greetingForSession } : {}) }),
        signal: abortCtrl.value.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('empty response body')

      const r = await consumeStream(res.body.getReader(), ownerSid, viewGeneration)
      resolvedSid = r.sid
      // session_id 事件可能在浏览器切换/重连的边界丢失；流本身已经返回真实
      // id，当前视图仍未切换时直接补回，确保 ownsView 成立并解除发送锁。
      if (viewGeneration === options.getViewGeneration() && sessionId.value == null && r.sid != null) {
        sessionId.value = r.sid
      }
      aiIdx = r.aiIdx
      r.usedTools.forEach(t => usedTools.add(t))
      // 用户中途切走了 → 别把兜底气泡塞进当前别的会话视图（回复已在后端，切回会重载）
      if (aiIdx === -1 && !r.detached && !r.aborted && !r.interactionPaused) {
        messages.value.push({ id: mkid(), role: 'ai', text: '收到，但没有收到回复，请稍后再试。', time: now() })
        await options.scrollBottom()
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError' && sessionId.value === resolvedSid) {
        // fetch 抛错=连不上咕咕后端，基本都是网络问题（仅在仍停在本会话时报）
        options.clearStatus()
        messages.value.push({ id: mkid(), role: 'ai', text: '咕咕网络不太好 📡 可以再发一遍吗？', time: now() })
        await options.scrollBottom()
      }
      // 发送失败时清理本次带的草稿附件（best-effort，只是降低草稿孤儿产生速度的优化，
      // 不是主清理机制——后端只在附件仍是草稿态时才真的删，消息其实已经发送成功、
      // 只是这次响应丢失/超时的情况会被后端拒绝，不会误删，见 PRD-STORAGE-1）
      if (e?.name !== 'AbortError' && atts.length) {
        for (const attachment of atts) {
          if (!attachment.attach_id) continue
          agentApi.deleteDraftAttachment(attachment.attach_id).catch(() => {})
        }
      }
    } finally {
      // 仍停在本次发送的会话才收尾全局状态；切走后这些状态归新会话的续看流管，别清掉
      const ownsView = viewGeneration === options.getViewGeneration() && sessionId.value === resolvedSid
      if (ownsView) {
        // 流式结束：把该条 AI 消息标记为非流式，触发 markdown 渲染（流式中按纯文本显示，避免半截表格/代码块闪烁）
        if (aiIdx !== -1 && messages.value[aiIdx]) messages.value[aiIdx].streaming = false
        options.clearStatus(); streaming.value = false; abortCtrl.value = null
        options.loadQuota()   // 回复消耗精力，刷新一次——耗尽时顶部状态即时变「休息中」（不 await，原逻辑就是 fire-and-forget）
        // markdown 重渲染后内容变高，MutationObserver 此时已因 streaming=false 停止跟随，
        // 需在 nextTick 后再滚一次，否则底部时间戳会被截掉
        await options.scrollBottom()
      }
      if (activeSessionId === resolvedSid) activeSessionId = null
      // 咕咕若调用了改数据的工具，刷新对应前端视图（项目/日历/文件），免手动刷新页面
      options.refreshAfterTools(usedTools)
      // 生成期间排队的消息：取队首接着发（其自身 finally 会继续取下一条，逐条处理）。
      // 正常情况下 loadSession/newSession 已经在切换那一刻清空过 pendingQueue，这里的
      // 身份核对是竞态兜底——万一切换和这次消费之间有空子可钻，也不能把排队消息发进
      // 已经不是它所属的那个会话。
      // sessionId == null 是"入队时还没拿到真实 id"（新对话第一轮），只要还在同一个
      // viewGeneration 里就允许消费——真实 id 已在收到 session_id 事件时由
      // resolvePendingSession 回填。
      if (ownsView) {
        while (pendingQueue.value.length) {
          const next = pendingQueue.value[0]
          const sameView = next.viewGeneration === options.getViewGeneration()
          const sameSession = next.sessionId == null || next.sessionId === sessionId.value
          if (sameView && sameSession) {
            pendingQueue.value.shift()
            send(next.text, next.attachments)
            break
          }
          pendingQueue.value.shift()   // 属于已经离开的会话，丢弃不发
        }
      }
    }
  }

  return {
    streaming, abortCtrl, pendingQueue,
    resetSessionTurn, clearPendingQueue, resolvePendingSession,
    send, stopStreaming, resumeStream,
  }
}
