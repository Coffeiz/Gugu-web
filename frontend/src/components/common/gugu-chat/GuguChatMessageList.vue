<template>
  <!-- 单一消息列表：真虚拟列表（@tanstack/vue-virtual），任何时刻只挂载视口 ± overscan
       内的消息 DOM，其余用下面这段按测量/估算高度撑出来的占位空间代替，滚动条始终代表
       整个会话的真实长度。messagesEl 是真实可滚动容器，虚拟列表只管它内部挂多少 DOM。 -->
  <div class="chat-messages" :class="{ 'is-session-settling': sessionSettling }" ref="messagesEl">
    <div class="msg-virtual-spacer" :style="{ height: virtualTotalSize + 'px' }">
      <!-- v-memo：同一帧内其它消息在变（比如正在流式输出的那条）时，跳过这一行没变的
           子树重新生成——虚拟列表已经把同时挂载的行数摁在个位数附近，这里收益比之前小，
           但仍能省掉一趟不必要的 vnode diff。 -->
      <div v-for="{ row, msg } in rowsWithMsg" :key="String(row.key)" :data-index="row.index" :ref="measureRow"
           :class="['msg-virtual-row', { 'is-tool-row': msg.role === 'tool', 'is-interaction-row': msg.role === 'interaction' }]"
           :style="{ transform: `translateY(${row.start + msgsPadTop}px)` }">
        <div :class="['msg', msg.role]" :data-db-id="msg.dbId || ''"
             v-memo="[msg.role, msg.speakerLabel, msg.text, msg.html, msg.streaming, msg.roundId, msg.toolCallId, msg.toolStatus, msg.toolDurationMs, msg.toolInput, msg.toolResult, msg.files?.length, msg.files?.map(f => `${f.file_id ?? ''}:${f.attach_id ?? ''}:${f.ext ?? ''}`).join(','), msg.quotedText, copiedId === msg.id, voicePlayingId && msg.files?.some(f => f.attach_id === voicePlayingId)]">
          <GuguChatMessageRow
            :msg="msg" :is-group-session="isGroupSession"
            :copied-id="copiedId" :voice-playing-id="voicePlayingId"
            @copy="$emit('copy', $event)" @toggle-voice="$emit('toggleVoice', $event)"
            @open-file="$emit('openFile', $event)" @download="$emit('download', $event)" @action-click="$emit('actionClick', $event)"
            @interaction-select="(selectedMsg, option) => $emit('interactionSelect', selectedMsg, option)"
          />
        </div>
      </div>
    </div>
    <!-- 整个生成期只维持一枚状态气泡：状态切换时替换内容，不让气泡闪退重建。 -->
    <div v-if="statusKind" class="msg ai">
      <div class="msg-bubble status-pop"
           :class="statusKind === 'dots' ? 'thinking' : 'tool-bubble'">
        <template v-if="statusKind === 'dots'"><span /><span /><span /></template>
        <template v-else>
          <span class="tool-spinner" />
          <span class="tool-label">{{ statusTyped }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 虚拟列表、滚动容器和消息行排列的唯一所有权：真实可滚动 DOM（messagesEl）、
 * @tanstack/vue-virtual 实例和逐行测量都收在这里。不拥有发送请求或消息数据本身——
 * messages 由 GuguChat.vue 持有并作为 prop 传入，这里只读取展示、不重新赋值整个数组
 * （html 懒渲染回填除外：那是纯展示缓存，不是业务字段）。
 *
 * 父组件仍需要拿到真实滚动容器（scrollTop/scrollHeight/addEventListener）和
 * virtualizer 的 scrollToIndex（流式跟随滚动、切会话定位、搜索跳转高亮），
 * 通过 defineExpose 暴露 el 和 scrollToIndex，不把这些操作重新实现一遍。
 */
import { ref, computed, watch, nextTick, type ComponentPublicInstance } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import GuguChatMessageRow from './GuguChatMessageRow.vue'
import type { ChatMessage, ChatFile } from './chatTypes'
import { renderMd } from './markdown'

const props = defineProps<{
  messages: ChatMessage[]
  sessionId: number | null
  isGroupSession: boolean
  copiedId: number | null
  voicePlayingId: string | null
  expanded: boolean
  statusKind: string
  statusTyped: string
  sessionSettling: boolean
}>()

defineEmits<{
  copy: [msg: ChatMessage]
  toggleVoice: [file: ChatFile]
  openFile: [file: ChatFile]
  download: [file: ChatFile]
  actionClick: [e: MouseEvent]
  interactionSelect: [msg: ChatMessage, option: { id: string; label: string; token: string }]
}>()

const messagesEl = ref<HTMLElement | null>(null)

// 消息高度不定长（纯文本/代码块/文件卡片/语音条差异很大），measureElement 首次挂载
// 后用真实高度回填、并自带 ResizeObserver 持续纠偏（图片/缩略图迟一拍加载导致变高也能跟上）。
const virtualizer = useVirtualizer({
  get count() { return props.messages.length },
  getScrollElement: () => messagesEl.value,
  estimateSize: () => 96,
  overscan: 6,
  // 高度缓存必须跟随真实消息身份，而不是跟随数组索引；不同会话的第 N 条消息
  // 内容高度通常完全不同，按 index 复用会先套用旧会话高度，再在下一帧跳动。
  getItemKey: (index) => {
    const message = props.messages[index]
    return message?.dbId ?? message?.id ?? `${props.sessionId ?? 'new'}:${index}`
  },
})
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
// 绝对定位的子元素不会跟着祖先的 padding 走（top:0/left:0 是相对祖先的边框盒，不是内容盒），
// 所以顶部留白只能自己在 translateY 里加、不能指望 .msg-virtual-spacer 的 padding-top 生效；
// 水平方向的留白则放在每一行自己的左右 padding 上（CSS，见下）。
const msgsPadTop = computed(() => props.expanded ? 20 : 12)
// 占位容器总高度 = 虚拟列表算出的内容高度 + 顶部留白（底部留白由最后一行自带的 padding-bottom 覆盖）
const virtualTotalSize = computed(() => virtualizer.value.getTotalSize() + msgsPadTop.value)
// v-for 需要同时拿到虚拟行的定位信息（row）和它对应的消息（msg），zip 成一个数组，
// 这样消息行内部的模板完全不用改，照样按 msg.xxx 取值。
const rowsWithMsg = computed(() => virtualRows.value.map(row => ({ row, msg: props.messages[row.index] })))
watch(() => props.sessionId, async () => {
  // 切换会话时清掉旧行的测量结果，等新会话行重新挂载后再测量。
  await nextTick()
  virtualizer.value.measure()
}, { flush: 'post' })
function measureRow(el: Element | ComponentPublicInstance | null) { if (el) virtualizer.value.measureElement(el as Element) }

// 只有真正挂进视口 ± overscan 的消息才需要解析 markdown——不在 loadSession 时就把
// 整个历史一次性跑一遍 marked.parse，等消息第一次进虚拟窗口再补，减轻长会话打开时的
// 一次性 CPU 尖峰；已经解析过的（html 非空）不重复解析。
watch(virtualRows, (rows) => {
  for (const row of rows) {
    const m = props.messages[row.index]
    if (m && m.role === 'ai' && !m.streaming && m.html == null) m.html = renderMd(m.text)
  }
})

defineExpose({
  el: computed(() => messagesEl.value),
  scrollToIndex: (idx: number, opts: Parameters<ReturnType<typeof useVirtualizer>['value']['scrollToIndex']>[1]) =>
    virtualizer.value.scrollToIndex(idx, opts),
})
</script>
