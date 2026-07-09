<template>
  <div class="gs-wrap" ref="wrapEl">
    <div class="gs-box" :class="{ active: open }">
      <PhMagnifyingGlass class="gs-mag" :size="15" weight="bold" />
      <input
        ref="inputEl"
        v-model="q"
        class="gs-input"
        type="text"
        placeholder="搜索项目、文件、日程、客户…"
        @focus="onFocus"
        @input="onInput"
        @keydown.esc="close"
      />
      <button v-if="q" class="gs-clear" @click="clear" title="清除">
        <PhX :size="13" weight="bold" />
      </button>
    </div>

    <Teleport to="body">
      <transition name="gs-pop">
        <div v-if="open && q.trim()" ref="panelEl" class="gs-panel" :style="panelStyle">
          <div v-if="loading" class="gs-hint">
            <PhCircleNotch class="gs-spin" :size="15" weight="bold" /> 搜索中…
          </div>
          <div v-else-if="total === 0" class="gs-hint">没找到「{{ q.trim() }}」相关内容</div>
          <template v-else>
            <div v-for="g in groups" :key="g.type" class="gs-group">
              <div class="gs-group-label">{{ g.label }}</div>
              <button
                v-for="it in g.items"
                :key="g.type + '-' + it.id"
                class="gs-item"
                @click="go(g.type, it)"
              >
                <component :is="TYPE_ICON[g.type]" class="gs-item-icon" :size="16" weight="bold" />
                <span class="gs-item-title">{{ it.title }}</span>
                <span v-if="it.subtitle" class="gs-item-sub">{{ it.subtitle }}</span>
              </button>
            </div>
          </template>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { nextZ } from '@/composables/windowz'
import { useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import {
  PhMagnifyingGlass, PhX, PhCircleNotch,
  PhStack, PhFile, PhFolder, PhCalendarBlank, PhAddressBook, PhChatCircle,
} from '@phosphor-icons/vue'
import { searchApi } from '@/services/api'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

// 类型图标与侧边栏导航保持一致（项目=PhStack、日历=PhCalendarBlank、文件库=PhFolder、客户=PhAddressBook）
const TYPE_ICON = {
  project: PhStack,
  file: PhFile,
  folder: PhFolder,
  event: PhCalendarBlank,
  client: PhAddressBook,
  conversation: PhChatCircle,
}

const router       = useRouter()
const projectStore = useProjectStore()
const uiStore      = useUiStore()

const wrapEl  = ref(null)
const inputEl = ref(null)
const panelEl = ref(null)
const q       = ref('')
const open    = ref(false)
const loading = ref(false)
const groups  = ref([])
const total   = ref(0)

// 面板 Teleport 到 body（脱离顶栏的 backdrop-filter，blur 才生效），用 fixed 跟随搜索框定位
const panelStyle = ref({})
function updatePanelPos() {
  const r = wrapEl.value?.getBoundingClientRect()
  if (!r) return
  panelStyle.value = {
    position: 'fixed',
    top: `${r.bottom + 8}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    zIndex: nextZ(),   // 盖当前最顶窗口
  }
}

let timer = null
let reqSeq = 0   // 防抖 + 防乱序：只认最后一次请求的结果

function onInput() {
  open.value = true
  updatePanelPos()
  clearTimeout(timer)
  const text = q.value.trim()
  if (!text) { groups.value = []; total.value = 0; loading.value = false; return }
  loading.value = true
  timer = setTimeout(() => runSearch(text), 250)
}

async function runSearch(text) {
  const seq = ++reqSeq
  try {
    const r = await searchApi.query(text)
    if (seq !== reqSeq) return   // 有更新的请求了，丢弃这次
    groups.value = r.groups || []
    total.value  = r.total || 0
  } catch {
    if (seq !== reqSeq) return
    groups.value = []; total.value = 0
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

function go(type, it) {
  close()
  if (type === 'project') {
    uiStore.pendingProjectHighlight = it.id   // 跳转后高亮项目卡，不打开编辑弹窗
    router.push('/projects')
  } else if (type === 'file' || type === 'folder') {
    uiStore.pendingFileTarget = { kind: type, id: it.id }   // 文件库监听后定位到对应目录
    router.push('/files')
  } else if (type === 'event') {
    uiStore.pendingCalendarEvent = { id: it.id, date: it.date }
    router.push('/calendar')
  } else if (type === 'conversation') {
    uiStore.pendingChatMessageId = it.message_id || null
    uiStore.pendingChatSession = it.id   // GuguChat 监听后打开、切到会话、滚到匹配消息
  } else if (type === 'client') {
    Message.info('客户页面还在开发中，先在项目里看吧～')
  }
}

function clear() {
  q.value = ''; groups.value = []; total.value = 0
  inputEl.value?.focus()
}

function onFocus() {
  open.value = true
  updatePanelPos()
}

function close() { open.value = false }

function onDocClick(e) {
  // 面板已 Teleport 到 body，点击命中输入框或面板都不关
  const inWrap  = wrapEl.value?.contains(e.target)
  const inPanel = panelEl.value?.contains(e.target)
  if (!inWrap && !inPanel) close()
}

function onReposition() {
  if (open.value) updatePanelPos()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  window.addEventListener('resize', onReposition)
  window.addEventListener('scroll', onReposition, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('resize', onReposition)
  window.removeEventListener('scroll', onReposition, true)
  clearTimeout(timer)
})
</script>

<style scoped>
.gs-wrap {
  flex: 1;
  max-width: 340px;
  margin-left: auto;
  position: relative;
}

/* ── 输入框：玻璃小元素 ── */
.gs-box {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  color: var(--text-secondary);
  transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
}
.gs-box.active {
  background: var(--glass-bg-hover);
  border-color: rgba(123, 127, 178, 0.45);
  box-shadow: 0 4px 16px rgba(80, 90, 110, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.95);
}
.gs-mag { color: var(--text-secondary); flex-shrink: 0; }
.gs-box.active .gs-mag { color: var(--color-primary); }

.gs-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--text-primary);
}
.gs-input::placeholder { color: var(--text-secondary); }

.gs-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px;
  border-radius: 6px;
  flex-shrink: 0;
  transition: background 0.2s ease, color 0.2s ease;
}
.gs-clear:hover { background: rgba(123, 127, 178, 0.12); color: var(--text-primary); }

/* ── 结果面板：与「添加/编辑活动」弹窗(.add-event-popup)、右键菜单(.popup-menu)同款白底毛玻璃；
   Teleport 到 body 后用 fixed 定位(position/top/left/width 由内联样式给) ── */
.gs-panel {
  max-height: 62vh;
  overflow-y: auto;
  padding: 6px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.98), 0 8px 32px rgba(60, 70, 100, 0.12);
  backdrop-filter: var(--popup-blur);
  -webkit-backdrop-filter: var(--popup-blur);
  /* z-index 由 :style 动态 */
}

.gs-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 12px;
  font-size: 13px;
  color: var(--text-secondary);
}
.gs-spin { animation: gs-rotate 0.8s linear infinite; }
@keyframes gs-rotate { to { transform: rotate(360deg); } }

.gs-group { margin-bottom: 4px; }
.gs-group:last-child { margin-bottom: 0; }
.gs-group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  padding: 7px 10px 4px;
}

.gs-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.18s ease;
}
.gs-item:hover { background: rgba(123, 127, 178, 0.08); }

.gs-item-icon {
  color: var(--color-primary);
  flex-shrink: 0;
}
.gs-item-title {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  max-width: 56%;
}
.gs-item-sub {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: auto;
  padding-left: 8px;
}

/* ── 下拉出现动画 ── */
.gs-pop-enter-active, .gs-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.gs-pop-enter-from, .gs-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
