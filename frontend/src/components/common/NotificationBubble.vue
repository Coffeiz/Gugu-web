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
        <button class="nb-close" @click="dismiss(item.id)" :title="t('common.actions.close')">
          <Icon name="action.close" :size="13" />
        </button>
        <div v-if="item.title" class="nb-head">
          <span class="nb-dot" :class="{ typing: item.typing }" />
          <div class="nb-title">{{ item.tTitle }}</div>
        </div>
        <div v-if="item.content" class="nb-content scroll-surface scroll-surface--compact">
          <MarkdownView :text="item.tContent" />
        </div>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import { useUiStore } from '@/stores/ui'
import MarkdownView from '@/components/common/MarkdownView.vue'
import { useI18n } from 'vue-i18n'

interface BubbleItem {
  id: number; notifId: number | null; title: string; content: string
  tTitle: string; tContent: string; phase: string; typing: boolean
}

const uiStore = useUiStore()
const { t } = useI18n()
const visible = ref<BubbleItem[]>([])
let _vk = 0                 // 气泡本地 key（与后端 id 解耦）

// 状态气泡那套「类 SSE 逐字流式」搬到通知上：新通知不直接出全文，而是标题先逐字冒出、
// 再正文逐字流式（正文渲染「已打出的子串」，与咕咕回复的流式 markdown 同源）。
let _typeTimer: ReturnType<typeof setTimeout> | null = null      // 全局单计时器：同一时刻只让最新那条打字
let _typingId: number | null = null      // 正在打字的 item id（手动关掉它时要停表）
const TITLE_MS = 30        // 标题每字间隔
const BODY_MS  = 15        // 正文每字间隔（比标题快，长文不拖沓）
const PAUSE_TOKEN = '[[p]]'  // 文案里的停顿标记（不显示）
const PAUSE_MS = 1000        // 打到停顿标记时暂停时长
const SLOW_MS  = 400         // [[slow]]…[[/slow]] 段内逐字慢速冒出的每字间隔

// 气泡 = 纯「实时到达」的瞬态弹层，**只监听 uiStore.liveNotification**（SSE 实时置位）——
// 关浏览器重开拉回来的历史通知**不弹气泡**（那是导航栏通知中心的事）。气泡与导航栏彻底分开：
// 气泡关闭只动本组件 visible，不影响 uiStore.notifications，也不改已读态（气泡不算已读）。
// 普通通知不自动消失，只能靠用户点 ✕ 关（是否显示过只弹一次由 uiStore._markBubbleSeen 独立
// 保证，与关闭方式无关）——新气泡到来时旧气泡照常堆叠在上方，都留着等用户处理。
watch(() => uiStore.liveNotification, (n) => {
  if (!n) return
  // 新气泡插到队首（视觉上在底部、贴近球），把旧的顶上去；reactive 让打字机改属性能驱动视图
  const item = reactive({
    id: ++_vk, notifId: n.id ?? null, title: n.title || '', content: n.content || '',
    tTitle: '', tContent: '', phase: 'title', typing: true,
  })
  visible.value = [item, ...visible.value]
  startTyping(item)
})

// 标题逐字 → 正文逐字。正文较长时一拍多推几字，避免长通知打太久。
// 文案标记（不显示）：[[p]]=停顿 PAUSE_MS；[[slow]]…[[/slow]]=段内每字 SLOW_MS 慢速冒出。
function startTyping(item: BubbleItem) {
  if (_typeTimer) { clearInterval(_typeTimer); _typeTimer = null }
  const raw = item.content || ''
  const hasMarkers = raw.includes('[[')
  const STRIP_RE = /\[\[\/?(?:p(?::\d+)?|slow)\]\]/g   // 去 [[p]] / [[p:1500]] / [[slow]] / [[/slow]]
  const fullTitle = (item.title || '').replace(STRIP_RE, '')
  const fullBody = raw.replace(STRIP_RE, '')   // 去所有标记，用于空判断
  if (!fullTitle && !fullBody) { item.typing = false; return }
  _typingId = item.id
  item.phase = fullTitle ? 'title' : 'body'
  let ti = 0
  const run = (ms: number, tick: () => void) => { if (_typeTimer) clearInterval(_typeTimer); _typeTimer = setInterval(tick, ms) }
  // 打完字后停在原地，只能点 ✕ 关闭。
  const stop = () => {
    if (_typeTimer) { clearInterval(_typeTimer); _typeTimer = null }
    item.typing = false
    if (_typingId === item.id) _typingId = null
  }

  let typeBody: () => void
  if (!hasMarkers) {
    // 快路径：无标记，按 slice 推进（长文一拍多推几字）
    const bodyStep = fullBody.length > 150 ? 3 : 1
    let bi = 0
    typeBody = () => run(BODY_MS, () => {
      bi = Math.min(fullBody.length, bi + bodyStep)
      item.tContent = fullBody.slice(0, bi)
      if (bi >= fullBody.length) stop()
    })
  } else {
    // 标记路径：解析成 ops（普通字 / 慢字 / 纯停顿），逐 op 用 setTimeout 推进，速度可变
    const ops: { ch: string; ms: number }[] = []
    let i = 0, slow = false
    while (i < raw.length) {
      // [[p]] 或 [[p:1500]]：纯停顿，时长可指定（缺省 PAUSE_MS）
      if (raw.startsWith('[[p', i)) {
        const m = raw.slice(i).match(/^\[\[p(?::(\d+))?\]\]/)
        if (m) { ops.push({ ch: '', ms: m[1] ? +m[1] : PAUSE_MS }); i += m[0].length; continue }
      }
      if (raw.startsWith('[[slow]]', i))   { slow = true;  i += 8; continue }
      if (raw.startsWith('[[/slow]]', i))  { slow = false; i += 9; continue }
      ops.push({ ch: raw[i], ms: slow ? SLOW_MS : BODY_MS }); i++
    }
    let acc = '', oi = 0
    typeBody = () => {
      if (oi >= ops.length) { stop(); return }
      const op = ops[oi++]
      if (op.ch) { acc += op.ch; item.tContent = acc }
      _typeTimer = setTimeout(() => { if (_typingId === item.id) typeBody() }, op.ms)
    }
  }
  if (item.phase === 'title') {
    run(TITLE_MS, () => {
      item.tTitle = fullTitle.slice(0, ++ti)
      if (ti >= fullTitle.length) {
        item.phase = 'body'
        if (_typeTimer) { clearInterval(_typeTimer); _typeTimer = null }  // 清掉标题 interval 再进正文（两路都安全）
        fullBody ? typeBody() : stop()
      }
    })
  } else { typeBody() }
}

function dismiss(id: number) {
  // 关掉的正是当前在打字的那条 → 停表，别让计时器空转
  if (_typingId === id && _typeTimer) { clearInterval(_typeTimer); _typeTimer = null; _typingId = null }
  const item = visible.value.find(n => n.id === id)
  if (item?.notifId != null) uiStore.markRead(item.notifId)
  visible.value = visible.value.filter(n => n.id !== id)
}
</script>

<style scoped>
/* 锚定在咕咕球（或其上方的小窗/播放器）正上方，bottom 由 uiStore.chatNotifyAnchor 实时驱动 */
.nb-stack {
  position: fixed;
  right: 28px;
  z-index: 100000;   /* 压顶带:通知永远可见(见 composables/windowz.ts) */
  display: flex;
  flex-direction: column-reverse;  /* 新条目在底部，贴近球 */
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
  transition: bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);   /* 小窗开合时平滑避让 */
  transform: translateZ(0);   /* 提升为稳定合成层：固定容器背后页面滚动时，子项 backdrop-filter 不再反复重绘闪烁 */
}

/* 气泡风与 GuguChat 小窗/播放器一致：玻璃面板 + blur(28) + 20 圆角 */
.nb-item {
  --nb-border: rgba(255,255,255,0.65);
  --nb-highlight-top: rgba(255,255,255,0.9);
  --nb-highlight-side: rgba(255,255,255,0.5);
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  width: 360px;          /* 固定宽度，与 GuguChat 小窗/播放器同宽、右对齐成一列 */
  padding: 13px 15px 15px;   /* 左右对称，内容区占满整宽 */
  background: var(--panel-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--nb-border);
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
  box-shadow: inset 0 1px 0 var(--nb-highlight-top), inset 1px 0 0 var(--nb-highlight-side);
  pointer-events: none;
}

/* 暗色只重映射边缘 token，避免沿用亮色主题的纯白高光；亮色基线保持不变。 */
:global(html[data-theme='dark'][data-family] .nb-item) {
  --nb-border: var(--border-default);
  --nb-highlight-top: var(--highlight-soft);
  --nb-highlight-side: var(--highlight-muted);
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
/* 逐字流式进行中：圆点脉冲，像「正在接收」 */
.nb-dot.typing { animation: nb-pulse 0.9s ease-in-out infinite; }
@keyframes nb-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.66); }
}
.nb-title {
  flex: 1; min-width: 0;
  font-size: 12.5px; font-weight: 700; color: var(--text-primary);
  line-height: 1.3;
}
.nb-content {
  /* 文字与 GuguChat 小窗正文一致（全局变量，所有通知气泡共用）*/
  font-size: var(--gugu-body-size); color: var(--text-primary);
  line-height: var(--gugu-body-line);
  max-height: 200px; overflow-y: auto;   /* 完整 md 可能较长：限高，超出可滚动 */
  word-break: break-word; overflow-wrap: break-word;
  /* 占满整个内容宽度，左右与气泡 padding 对称 */
}
/* 无标题（仅内容）时，内容是顶部元素：在右上角浮一个占位块给关闭 ✕ 让位，
   首行文字绕开它，避免被 ✕ 压住，其余行仍占满整宽 */
.nb-bare .nb-content::before {
  content: ''; float: right; width: 30px; height: 22px;
}
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
