/**
 * 窗口状态、样式与小窗高度跟随的唯一所有权：open / expanded / resizing、窗口坐标、
 * z-index、通知锚点、播放器样式、contentH / _baseScrollH 高度基线。
 *
 * 不拥有：消息/会话/流式（useChatConversation）、附件/录音（useChatAttachments）、
 * 音频播放（useChatAudio）、IM 连接（useChatImConnect）、FAB 行为。
 *
 * 三个钩子（onContentReset / onCaptureBaseScrollH / onSyncSmallH）由本 composable
 * 内部定义并通过返回值暴露，由 GuguChat.vue 传给 useChatConversation，把「内容变化
 * → 窗口尺寸跟随」这条链收在本文件内闭环，不在主组件里写半透半遮的中间层。
 *
 * 依赖：useChatWindow 需要 windowRef（chat-window DOM 引用，由 GuguChatWindow.vue
 * 通过 defineExpose 暴露）、composerRef（调 fitTextarea 做过渡结束后的最终校准）、
 * messagesEl（消息容器 ref，由 useChatConversation 通过 messageListRef.el 提供）。
 */
import { ref, computed, watch, onMounted, onUnmounted, type ComputedRef, type Ref } from 'vue'
import { useAudioStore } from '@/stores/audio'
import { useUiStore } from '@/stores/ui'
import { nextZ } from '@/composables/windowz'
import { playGuguSfx } from '@/services/sfx'
import { SMALL_W, SMALL_H, SIDEBAR_W, SESSION_KEY, LAST_SESSION_KEY, MINI_PINNED_KEY, REOPEN_RESUME_KEY } from '../chatConstants'

const MP_EST_H = 112   // 播放器外高估值（含 padding，用于通知锚点堆叠避让）

export interface UseChatWindowOptions {
  windowRef: Ref<HTMLElement | null>
  composerRef: Ref<{ fitTextarea?: (isExpanded?: boolean) => void } | null>
  messagesEl: ComputedRef<HTMLElement | null>
}

export function useChatWindow(options: UseChatWindowOptions) {
  const audioStore = useAudioStore()
  const uiStore = useUiStore()

  // ── 状态 ────────────────────────────────────────────
  const open       = ref(false)
  const expanded   = ref(false)
  const resizing   = ref(false)   // 只表示用户主动的大/小窗位形过渡，不代表浏览器 viewport resize
  const chatClosing = ref(false)
  const chatZ      = ref(nextZ())
  const miniPinned = ref(localStorage.getItem(MINI_PINNED_KEY) !== 'false')
  const reopenResume = ref(localStorage.getItem(REOPEN_RESUME_KEY) === '1')

  // ── 大/小窗位形过渡生命周期 ────────────────────────────
  // viewport resize 与模式切换是两种不同事务：前者必须当帧跟随窗口，后者才允许 0.42s 缓动。
  // 如果用户恰好在模式动画期间拖浏览器边缘，真实 window.resize 会直接结束模式动画，
  // 让 is-layout-resizing class 在同一 Vue patch 中撤掉，避免新的 viewport 几何继续吃旧 transition。
  let _resizeTimer: ReturnType<typeof setTimeout> | null = null
  let _onResizeTransitionEnd: ((e: TransitionEvent) => void) | null = null
  function finishResizing(fitTextarea = true) {
    resizing.value = false
    if (_resizeTimer) { clearTimeout(_resizeTimer); _resizeTimer = null }
    const w = options.windowRef.value
    if (w && _onResizeTransitionEnd) w.removeEventListener('transitionend', _onResizeTransitionEnd)
    _onResizeTransitionEnd = null
    if (fitTextarea) options.composerRef.value?.fitTextarea?.()
  }

  // 视口尺寸
  const vw = ref(window.innerWidth)
  const vh = ref(window.innerHeight)
  function onResize() {
    vw.value = window.innerWidth
    vh.value = window.innerHeight
    if (resizing.value) finishResizing()
  }

  // 小窗高度跟随内容：直接用 messages 真实高度算窗口该多高，到 maxH 封顶后内部滚动。
  const contentH = ref(SMALL_H)
  let _baseScrollH = 0   // 打开/切会话时的内容高度基线

  function resetContentH() { contentH.value = SMALL_H }
  function captureBaseScrollH() {
    _baseScrollH = options.messagesEl.value?.scrollHeight || 0
  }
  function setBaseScrollH(v: number) { _baseScrollH = v }

  const smallH = computed(() => {
    const maxH = Math.min(vh.value * 0.75, vh.value - 88 - 16)
    return Math.min(maxH, Math.max(SMALL_H, contentH.value))
  })

  function syncSmallH() {
    const el = options.messagesEl.value
    if (!el || expanded.value || resizing.value) return
    contentH.value = SMALL_H + Math.max(0, el.scrollHeight - _baseScrollH)
  }

  // ── 标记 resizing：监听 chat-window 自己的 transitionend，结束后清掉。
  // 用真实 transitionend 结束 resizing，而不是硬编码 420ms——CSS 过渡在性能不足时
  // 会被拖慢，定时器却按固定墙钟时间准点触发，导致 backdrop-filter/跟随在过渡还没
  // 走完时就被重新打开，看起来「闪一下」。定时器保留作兜底（万一属性没变、不会触发
  // transitionend），加了缓冲、不再和过渡时长完全对齐。
  function markResizing() {
    if (_resizeTimer) clearTimeout(_resizeTimer)
    const w = options.windowRef.value
    if (w && _onResizeTransitionEnd) w.removeEventListener('transitionend', _onResizeTransitionEnd)
    resizing.value = true
    _onResizeTransitionEnd = (e: TransitionEvent) => {
      if (e.target !== w) return
      if (!['top', 'left', 'right', 'bottom'].includes(e.propertyName)) return
      finishResizing()
    }
    w?.addEventListener('transitionend', _onResizeTransitionEnd)
    _resizeTimer = setTimeout(() => finishResizing(), 600)
  }

  // ── 窗口层级 ────────────────────────────────────────────
  function raiseChat() { chatZ.value = nextZ() }
  watch(open, v => { if (v) raiseChat() })

  // FAB 层级：离场动画尚未结束时窗口仍缩回悬浮球，不能提前把球提到窗口前面。
  // after-leave 后才恢复常驻最高层，避免关闭瞬间球盖住窗口。
  const fabZ = computed(() => (open.value || chatClosing.value) ? chatZ.value - 1 : 99999)

  // ── 位置样式 ────────────────────────────────────────────
  // 几何值只负责给出当前真实位置；是否做 0.42s 缓动由 GuguChatWindow 的
  // is-layout-resizing class 单独决定。这样 viewport resize 永远直接跟随，而动画参数
  // 仍只有组件 CSS 一个 owner，不在 JS 再复制 transition。
  const windowStyle = computed(() => {
    if (expanded.value) {
      const left = Math.max(SIDEBAR_W + 12, vw.value * 0.4 - 12)
      return { top: '12px', right: '12px', bottom: '12px', left: `${left}px`, zIndex: chatZ.value }
    }
    return {
      top:    `${vh.value - 88 - smallH.value}px`,
      left:   `${vw.value - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--floating-edge')) - SMALL_W}px`,
      right:  'var(--floating-edge)',
      bottom: '88px',
      zIndex: chatZ.value,
    }
  })

  // 播放器联动：小窗打开时顶到窗口上方，其余情况悬在 fab 上方
  const miniPlayerStyle = computed(() => {
    const bottom = (open.value && !expanded.value) ? 88 + smallH.value + 8 : 88
    const origin = (open.value && !expanded.value)
      ? '50% 50%'
      : `calc(100% - 25px) calc(100% + ${bottom - 53}px)`
    const zIndex = expanded.value ? chatZ.value - 1 : chatZ.value + 1
    return { bottom: `${bottom}px`, transformOrigin: origin, zIndex }
  })

  // 通知锚点：始终浮在「小窗 / 音乐播放器」上方，不与之重叠。
  const notifyAnchor = computed(() => {
    const hasPlayer = !!audioStore.file && (miniPinned.value || open.value)
    if (open.value && !expanded.value) {
      const winTop = 88 + smallH.value
      return (hasPlayer ? winTop + 8 + MP_EST_H : winTop) + 12
    }
    return hasPlayer ? 88 + MP_EST_H + 12 : 90
  })
  watch(notifyAnchor, v => { uiStore.chatNotifyAnchor = v }, { immediate: true })

  // 通知开合的缩放原点（与音乐播放器同逻辑）
  const notifyOrigin = computed(() => {
    const hasPlayer = !!audioStore.file && (miniPinned.value || open.value)
    if (!open.value && !hasPlayer) {
      return `calc(100% - 25px) calc(100% + ${notifyAnchor.value - 53}px)`
    }
    return '50% 50%'
  })
  watch(notifyOrigin, v => { uiStore.chatNotifyOrigin = v }, { immediate: true })

  // ── 关闭（纯窗口：开/关 + 清 expanded） ─────────────────────
  function closeChat() {
    chatClosing.value = true
    open.value = false
    expanded.value = false
  }

  // ── 声音提示：聊天窗被用户看着时不打断；切到别的标签页或收起才提示 ──────
  function playIncomingMessageSfx() {
    if (!open.value || document.hidden) playGuguSfx('message')
  }

  // ── 持久化 ────────────────────────────────────────────
  watch(miniPinned, v => localStorage.setItem(MINI_PINNED_KEY, String(v)))

  // ── 视口监听 ────────────────────────────────────────────
  onMounted(() => {
    window.addEventListener('resize', onResize)
  })
  onUnmounted(() => {
    window.removeEventListener('resize', onResize)
    finishResizing(false)
  })

  return {
    // 状态
    open, expanded, resizing, chatClosing, chatZ, fabZ,
    vw, vh, contentH, smallH,
    miniPinned, reopenResume,
    // 样式
    windowStyle, miniPlayerStyle, notifyAnchor, notifyOrigin,
    // 方法
    setOpen: (v: boolean) => { open.value = v },
    setExpanded: (v: boolean) => { expanded.value = v },
    markResizing, raiseChat, closeChat,
    resetContentH, captureBaseScrollH, setBaseScrollH, syncSmallH,
    playIncomingMessageSfx,
    // 三个钩子（传给 useChatConversation）
    onContentReset: resetContentH,
    onCaptureBaseScrollH: captureBaseScrollH,
    onSyncSmallH: syncSmallH,
    // 常量
    SESSION_KEY, LAST_SESSION_KEY,
  }
}
