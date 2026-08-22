import { nextTick, computed, type Ref } from 'vue'
import { agentApi, getToken } from '@/services/api'
import { API_BASE } from '../chatConstants'
import type { ChatMessage, ChatFile, ChatSession } from '../chatTypes'
import { displayQQFaces } from '../messageDisplay'
import type GuguChatComposer from '../GuguChatComposer.vue'

interface RawSessionMessage {
  id: number
  role: string
  content: string
  files?: ChatFile[]
  quotedText?: string
  platformUserId?: string | null
  platformUserName?: string | null
  createdAt: string
}

interface RawToolEvent {
  id: string
  toolCallId: string
  toolName: string
  toolInput?: unknown
  toolResult?: unknown
  toolStatus?: ChatMessage['toolStatus']
  toolDurationMs?: number
  createdAt: string
}

/**
 * 会话切换操作的唯一所有权：loadSession/newSession/deleteSession，以及从
 * sessions 派生的 webSessions/imSessions/currentSessionTitle。
 *
 * sessionId/sessions/ownerPlatformUserId/isGroupSession 这几个"当前会话
 * 身份"状态由 useChatConversation 创建并传入——它们同时也被 useChatStream
 * 读写（流里收到 session_id/session_title 事件时），真正双向共享的状态
 * 放在编排层创建一次、两边传引用，比硬塞进某一侧、再靠回调互相通知要简单。
 *
 * 不拥有流式收发本身——切会话/新建会话需要打断正在进行的流，靠注入的
 * abortCtrl/streaming/resumeStream/resetSessionTurn（来自 useChatStream）
 * 完成，这里只负责在正确的时机调用它们。
 */
export function useChatSessions(options: {
  messages: Ref<ChatMessage[]>
  mkid: () => number
  sessionId: Ref<number | null>
  sessions: Ref<ChatSession[]>
  ownerPlatformUserId: Ref<string | null>
  isGroupSession: Ref<boolean>
  resolveSpeaker: (
    role: string,
    platformUserId: string | null | undefined,
    platformUserName: string | null | undefined,
  ) => { role: string; speakerLabel?: string }
  bumpViewGeneration: () => number
  getViewGeneration: () => number
  composerRef: Ref<InstanceType<typeof GuguChatComposer> | null>
  abortCtrl: Ref<AbortController | null>
  streaming: Ref<boolean>
  resumeStream: (id: number) => Promise<void>
  resetSessionTurn: () => void
  clearPendingQueue: () => void
  clearStatus: () => void
  onContentReset: () => void
  onCaptureBaseScrollH: () => void
  scrollBottom: (force?: boolean) => Promise<void>
}) {
  const { messages, mkid, sessionId, sessions } = options

  const webSessions = computed(() => sessions.value.filter(s => !s.source || s.source === 'web'))
  const imSessions = computed(() => sessions.value.filter(s => s.source && s.source !== 'web'))
  const currentSessionTitle = computed(() =>
    !sessionId.value ? '新对话' : (sessions.value.find(s => s.id === sessionId.value)?.title ?? '对话')
  )

  async function loadSession(id: number) {
    if (id === sessionId.value) return
    const viewGeneration = options.bumpViewGeneration()
    options.abortCtrl.value?.abort()        // 停掉当前会话的流式消费（后端生成不受影响、继续跑）
    options.streaming.value = false
    // 旧会话排队等着接力发送的消息不属于要切进去的这个会话，清掉——不清的话，等新会话
    // 这边某次 send() 结束时会把它们当成"这个会话排队的消息"接着发出去（真实复现过的
    // bug：A 会话生成中发消息进队列，切到 C 会话，C 的回复一结束，A 排队的那条被发进 C）。
    options.clearPendingQueue()
    try {
      const data = await agentApi.getMessages(String(id))
      if (viewGeneration !== options.getViewGeneration()) return   // 等待期间又切换/新建了会话，丢弃这次结果
      sessionId.value = id
      options.ownerPlatformUserId.value = data.session?.ownerPlatformUserId ?? null
      options.isGroupSession.value = data.session?.chatType === 'group'
      options.clearStatus()   // 切会话先清掉上个会话残留的状态指示（active 会话下面 resumeStream 会重置）
      // html 先留空、不在这一步就把整个历史都跑一遍 marked.parse——只有真正挂进虚拟列表
      // 视口的那些消息才会被 watch(virtualRows, ...) 补上，减轻长会话打开时的一次性 CPU 尖峰。
      const loadedMessages = data.messages.map((m: RawSessionMessage) => {
        const speaker = options.resolveSpeaker(m.role, m.platformUserId, m.platformUserName)
        return {
          id: mkid(),
          dbId: m.id,
          role: speaker.role,
          speakerLabel: speaker.speakerLabel,
          platformUserId: m.platformUserId || null,
          text: displayQQFaces(m.content),
          html: null,
          files: m.files && m.files.length ? m.files : undefined,
          quotedText: m.quotedText || undefined,
          time: new Date(m.createdAt).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
          _createdAt: m.createdAt,
        }
      })
      const loadedTools = ((data.toolEvents || []) as RawToolEvent[]).map((event) => ({
        id: mkid(), role: 'tool', text: '', time: new Date(event.createdAt).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
        toolCallId: event.toolCallId, toolName: event.toolName,
        toolStatus: event.toolStatus || (event.toolResult !== undefined ? 'success' : 'running'),
        toolInput: event.toolInput, toolResult: event.toolResult, toolDurationMs: event.toolDurationMs, _createdAt: event.createdAt,
      }))
      messages.value = [...loadedMessages, ...loadedTools].sort((a, b) =>
        String((a as ChatMessage & { _createdAt?: string })._createdAt || '').localeCompare(String((b as ChatMessage & { _createdAt?: string })._createdAt || ''))
      )
      // 刷新/切回会话时恢复尚未过期的交互按钮；服务端会轮换 pending action token，
      // 因而前端不需要、也不会持久化旧 token。
      try {
        const interactionRes = await fetch(`${API_BASE}/agent/sessions/${id}/interactions`, {
          headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
        })
        if (interactionRes.ok) {
          const interactionData = await interactionRes.json()
          for (const item of (interactionData.items || [])) {
            messages.value.push({
              id: mkid(), role: 'interaction', text: '', _createdAt: item.created_at,
              time: new Date(item.created_at || Date.now()).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
              interaction: {
                promptId: Number(item.id), kind: String(item.kind || 'confirm'),
                title: String(item.title || '需要确认'), body: String(item.body || ''),
                options: Array.isArray(item.options) ? item.options : [],
                resolved: Boolean(item.resolved), selectedOptionId: item.selected_option_id || null,
              },
            })
          }
          messages.value.sort((a, b) => String(a._createdAt || '').localeCompare(String(b._createdAt || '')))
        }
      } catch { /* 交互恢复失败不阻断历史会话加载 */ }
      options.onContentReset(); options.resetSessionTurn()
      await nextTick()
      options.onCaptureBaseScrollH()   // 基线 = 切入会话的历史高度
      options.scrollBottom(true)
      // DB 持久化和 genstream.end() 不是同一个事务：生成刚完成时，接口可能短暂同时返回
      // 「最后一条是完整 assistant」和 active=true。此时不能把已完成回复再次 resume，
      // 否则 Redis 快照会被渲染成第二个生成气泡。只有最后一条可见消息不是完整 assistant
      // 时，active 才代表真正尚未落库的中断生成。
      const lastVisible = data.messages[data.messages.length - 1]
      const staleActive = Boolean(
        data.active && lastVisible?.role === 'assistant' && Boolean(lastVisible.content?.trim()),
      )
      if (staleActive) {
      } else if (data.active) {
        options.resumeStream(id)   // 该会话后端正在生成 → 重连续看
      }
    } catch {}
  }

  async function newSession() {
    options.bumpViewGeneration()
    options.abortCtrl.value?.abort()
    options.streaming.value = false
    options.clearPendingQueue()   // 同 loadSession：旧会话排队的消息不属于新对话，清掉
    sessionId.value = null
    messages.value = []        // 大窗「新对话」是干净起手——不放默认问候（问候只在打开小窗时出现）
    options.clearStatus()      // 旧会话残留的思考/工具状态气泡不属于这个空会话，清掉（loadSession 早就有这步，这里之前漏了）
    options.resetSessionTurn()
    await nextTick()
    options.composerRef.value?.focus()
  }

  async function deleteSession(id: number) {
    try {
      await agentApi.deleteSession(String(id))
      sessions.value = sessions.value.filter(s => s.id !== id)
      if (sessionId.value === id) await newSession()
    } catch {}
  }

  async function renameSession(id: number, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    const target = sessions.value.find(s => s.id === id)
    if (!target) return
    const prev = target.title
    target.title = trimmed   // 乐观更新：先改本地，输入框/列表立刻显示新标题，不用等接口返回
    try {
      await agentApi.renameSession(String(id), trimmed)
    } catch {
      target.title = prev   // 失败回滚
    }
  }

  return {
    webSessions, imSessions, currentSessionTitle,
    loadSession, newSession, deleteSession, renameSession,
  }
}
