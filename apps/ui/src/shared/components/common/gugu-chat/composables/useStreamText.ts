import { onScopeDispose, shallowRef, watch } from 'vue'
import { markdownStreamMotionDuration } from '../../content/markdownStreamMotion'
import { scanChatMarkdownFences } from '../markdown'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const revealInterval = 25
const graphemesPerReveal = 5
const maxCatchUpBatches = 12

function prefixEnd(text: string, start: number, count: number): number {
  let end = start
  for (const { segment } of graphemes.segment(text.slice(start))) {
    end += segment.length
    if (--count === 0) break
  }
  return end
}

/** 只调节展示文本，消息及 SSE 历史仍保留完整内容。 */
export function useStreamText(source: () => {
  key: string
  text: string
  streaming: boolean
  hasFollowingMessage: boolean
}) {
  const displayed = shallowRef('')
  const presenting = shallowRef(false)
  let key: string | undefined
  let target = ''
  let batchSize = graphemesPerReveal
  let smartRanges: ReturnType<typeof scanChatMarkdownFences>['smartRanges'] = []
  let streaming = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let finishTimer: ReturnType<typeof setTimeout> | undefined

  function stopTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function stopFinishTimer() {
    clearTimeout(finishTimer)
    finishTimer = undefined
  }

  function settle() {
    stopTimer()
    stopFinishTimer()
    batchSize = graphemesPerReveal
    displayed.value = target
    presenting.value = streaming
  }

  function schedule() {
    if (displayed.value === target) {
      batchSize = graphemesPerReveal
      if (!streaming && finishTimer === undefined) {
        // 正文全部显示后，给末批文字留出完整的淡入时间。
        finishTimer = setTimeout(settle, markdownStreamMotionDuration)
      }
      return
    }
    stopFinishTimer()
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      const start = displayed.value.length
      const next = prefixEnd(target, start, batchSize)
      const smartRange = smartRanges.find(range => range.start < next && range.end > start)
      displayed.value = target.slice(0, Math.max(next, smartRange?.end ?? 0))
      schedule()
    }, revealInterval)
  }

  watch(source, current => {
    const replaced = key !== undefined && key !== current.key
    const append = current.text.startsWith(target)
    const wasStreaming = streaming
    key = current.key
    target = current.text
    smartRanges = target.includes('gugu-ui') ? scanChatMarkdownFences(target.split('\n')).smartRanges : []
    streaming = current.streaming
    if (replaced || !append || current.hasFollowingMessage
      || ((streaming || wasStreaming) && typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)) {
      settle()
      return
    }
    if (!streaming && !wasStreaming && !presenting.value) {
      settle()
      return
    }
    if (streaming) {
      stopFinishTimer()
      presenting.value = true
      if (!displayed.value && target) displayed.value = target.slice(0, prefixEnd(target, 0, 1))
    }
    // 保持追赶速度直到积压排空，避免每批减速拖长最后一段。
    batchSize = Math.max(batchSize, Math.ceil((target.length - displayed.value.length) / maxCatchUpBatches))
    schedule()
  }, { immediate: true })

  onScopeDispose(() => {
    stopTimer()
    stopFinishTimer()
  })
  return { displayed, presenting }
}
