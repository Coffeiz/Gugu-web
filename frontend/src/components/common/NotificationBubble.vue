<template>
  <Teleport to="body">
    <TransitionGroup name="nb" tag="div" class="nb-stack" :style="{ bottom: uiStore.chatNotifyAnchor + 'px' }">
      <div
        v-for="item in visible"
        :key="item.id"
        class="nb-item"
        :class="{ 'nb-bare': !item.title }"
        :style="{ transformOrigin: uiStore.chatNotifyOrigin }"
      >
        <button class="nb-close" @click="dismiss(item.id)" title="关闭">
          <PhX weight="bold" :size="13" />
        </button>
        <div v-if="item.title" class="nb-head">
          <span class="nb-dot" />
          <div class="nb-title">{{ item.title }}</div>
        </div>
        <div v-if="item.content" class="nb-content">
          <MarkdownView :text="item.content" />
        </div>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'
import { PhX } from '@phosphor-icons/vue'
import { useUiStore } from '@/stores/ui'
import MarkdownView from '@/components/common/MarkdownView.vue'

const uiStore = useUiStore()
const visible = ref([])
let lastSeenId = 0
const timers = new Map()   // id -> setTimeout 句柄

// 新通知到来：把现有的旧通知顶上去（column-reverse 下新条插到底部，旧条上移），
// 旧条停留 0.5 秒后自动消失。当前最新这条不自动超时，由用户点关闭或被下一条顶替。
//
// 气泡只是一个「转瞬即逝的弹层」，与侧边栏通知中心是两个独立组件：
// 这里存的是 uiStore 通知的「独立快照」（而非同一对象引用），关闭气泡只动本组件自己的
// visible 列表，绝不影响 uiStore.notifications，侧边栏通知不会被一起关掉。
watch(() => uiStore.notifications, (notifs) => {
  if (!notifs.length) return
  const latest = notifs[0]
  if (latest.id <= lastSeenId) return
  lastSeenId = latest.id

  // 现有可见的旧通知：被顶上去后 0.5 秒消失
  visible.value.forEach(item => scheduleDismiss(item.id, 500))
  // 新通知插到队首（视觉上在底部、贴近球），把旧的顶上去；存快照不共享引用
  visible.value = [{ id: latest.id, title: latest.title, content: latest.content }, ...visible.value]
}, { deep: true })

function scheduleDismiss(id, delay) {
  if (timers.has(id)) return   // 已排程，避免重复计时
  timers.set(id, setTimeout(() => dismiss(id), delay))
}

function dismiss(id) {
  const t = timers.get(id)
  if (t) { clearTimeout(t); timers.delete(id) }
  visible.value = visible.value.filter(n => n.id !== id)
}
</script>

<style scoped>
/* 锚定在咕咕球（或其上方的小窗/播放器）正上方，bottom 由 uiStore.chatNotifyAnchor 实时驱动 */
.nb-stack {
  position: fixed;
  right: 28px;
  z-index: 9999;
  display: flex;
  flex-direction: column-reverse;  /* 新条目在底部，贴近球 */
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
  transition: bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);   /* 小窗开合时平滑避让 */
}

/* 气泡风与 GuguChat 小窗/播放器一致：玻璃面板 + blur(28) + 20 圆角 */
.nb-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  width: 360px;          /* 固定宽度，与 GuguChat 小窗/播放器同宽、右对齐成一列 */
  padding: 13px 15px 15px;   /* 左右对称，内容区占满整宽 */
  background: var(--panel-bg);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(255,255,255,0.65);
  border-radius: 20px;
  box-shadow: var(--glass-shadow-lg);
  pointer-events: auto;
  position: relative;
  overflow: hidden;
  /* transform-origin 由内联 style 绑定 uiStore.chatNotifyOrigin（以咕咕球圆心 / 自身中心缩放） */
}
.nb-item::after {   /* 内高光描边，复刻小窗玻璃质感 */
  content: '';
  position: absolute; inset: 0;
  border-radius: 20px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), inset 1px 0 0 rgba(255,255,255,0.5);
  pointer-events: none;
}

/* 标题行：圆点 + 标题，预留右上角关闭按钮的位置 */
.nb-head {
  display: flex; align-items: center; gap: 8px;
  padding-right: 28px;   /* 给右上角绝对定位的关闭按钮（26px）让位，标题不被压住 */
}
.nb-dot {
  width: 8px; height: 8px; border-radius: 50%;
  flex-shrink: 0;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);   /* 固定咕咕主题色，不再随通知配色 */
}
.nb-title {
  flex: 1; min-width: 0;
  font-size: 12.5px; font-weight: 700; color: var(--text-primary);
  line-height: 1.3;
}
.nb-content {
  font-size: 12px; color: var(--text-secondary);
  line-height: 1.5;
  max-height: 200px; overflow-y: auto;   /* 完整 md 可能较长：限高，超出可滚动 */
  word-break: break-word; overflow-wrap: break-word;
  /* 占满整个内容宽度，左右与气泡 padding 对称 */
}
/* 无标题（仅内容）时，内容是顶部元素：在右上角浮一个占位块给关闭 ✕ 让位，
   首行文字绕开它，避免被 ✕ 压住，其余行仍占满整宽 */
.nb-bare .nb-content::before {
  content: ''; float: right; width: 30px; height: 22px;
}
.nb-content::-webkit-scrollbar { width: 3px; }
.nb-content::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.14); border-radius: 99px; }
/* markdown 排版由通用组件 MarkdownView 统一提供 */

/* 关闭按钮与音乐播放器 / GuguChat 一致：26px 圆角方块、透明底、hover 变红 */
.nb-close {
  position: absolute; top: 9px; right: 9px; z-index: 1;
  width: 26px; height: 26px; border-radius: 7px;
  border: none; background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; padding: 0;
}
.nb-close :deep(svg) { display: block; }
.nb-close:hover { background: rgba(200,80,80,0.1); color: rgba(200,80,80,0.8); }

/* 开/关动画：以咕咕球圆心缩放（transform-origin 由内联 style 给出），与音乐播放器一致 */
.nb-enter-active {
  transition: opacity 0.26s, transform 0.32s cubic-bezier(.22, 1.12, .36, 1);
}
.nb-leave-active {
  transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(.55, 0, 1, .7);
  pointer-events: none;
}
.nb-enter-from, .nb-leave-to {
  opacity: 0;
  transform: scale(0.05);
}
/* 已存在的气泡在新条目插入/某条关闭时平滑上移/下移 */
.nb-move {
  transition: transform 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
}
</style>
