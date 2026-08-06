import { nextTick, computed, type Ref } from 'vue'
import { agentApi } from '@/services/api'
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
      messages.value = data.messages.map((m: RawSessionMessage) => {
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
        }
      })
      options.onContentReset(); options.resetSessionTurn()
      await nextTick()
      options.onCaptureBaseScrollH()   // 基线 = 切入会话的历史高度
      options.scrollBottom(true)
      if (data.active) options.resumeStream(id)   // 该会话后端正在生成 → 重连续看
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

  return {
    webSessions, imSessions, currentSessionTitle,
    loadSession, newSession, deleteSession,
  }
}
