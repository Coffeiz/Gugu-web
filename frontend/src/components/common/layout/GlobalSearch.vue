<template>
  <div class="gs-wrap" ref="wrapEl">
    <SearchInput
      ref="inputEl"
      v-model="q"
      :active="open"
      clearable
      :placeholder="t('common.searchPlaceholder')"
      @focus="onFocus"
      @input="onInput"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
      @keydown.esc="close"
      @clear="clear"
    />

    <Teleport to="body">
      <transition name="gs-pop">
        <div v-if="open && q.trim()" ref="panelEl" class="gs-panel" :style="panelStyle">
          <div class="gs-scroll">
            <div v-if="loading" class="gs-hint">
              <Icon name="status.loading" class="gs-spin" size="md" tone="inherit" /> {{ t('common.searching') }}
            </div>
            <div v-else-if="total === 0" class="gs-hint">{{ t('common.searchNoResults', { query: q.trim() }) }}</div>
            <template v-else>
              <div v-for="g in groups" :key="g.type" class="gs-group">
                <div class="gs-group-label">{{ g.label }}</div>
                <button
                  v-for="it in g.items"
                  :key="g.type + '-' + it.id"
                  class="gs-item"
                  @click="go(g.type, it)"
                >
                  <Icon :name="TYPE_ICON[g.type]" class="gs-item-icon" size="md" tone="inherit" />
                  <span class="gs-item-title">{{ it.title }}</span>
                  <span v-if="it.subtitle" class="gs-item-sub">{{ it.subtitle }}</span>
                </button>
              </div>
            </template>
          </div>
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
import Icon from '@/components/common/icons/Icon.vue'
import SearchInput from '@/components/common/controls/SearchInput.vue'
import { searchApi } from '@/services/api'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useI18n } from 'vue-i18n'

// 类型图标与侧边栏导航保持一致，具体图标由语义注册表统一解析。
const TYPE_ICON = {
  project: 'navigation.projects',
  file: 'file.document',
  folder: 'file.folder',
  event: 'navigation.calendar',
  client: 'communication.customer',
  conversation: 'communication.chat',
  note: 'canvas.graph',
}

const router       = useRouter()
const projectStore = useProjectStore()
const uiStore      = useUiStore()
const { t } = useI18n()

interface SearchItem { id: number; title: string; subtitle?: string; date?: string; message_id?: number }
interface SearchGroup { type: 'project' | 'file' | 'folder' | 'event' | 'client' | 'conversation' | 'note'; label: string; items: SearchItem[] }

const wrapEl  = ref<HTMLElement | null>(null)
const inputEl = ref<InstanceType<typeof SearchInput> | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const q       = ref('')
const open    = ref(false)
const loading = ref(false)
const groups  = ref<SearchGroup[]>([])
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

let timer: ReturnType<typeof setTimeout> | null = null
let reqSeq = 0   // 防抖 + 防乱序：只认最后一次请求的结果
let searchAbort: AbortController | null = null
let composing = false
const SEARCH_DEBOUNCE_MS = 120

function onInput() {
  // 中文输入法组合拼音时，input 也会连续触发；等候选字确认后再搜，避免无意义请求。
  if (composing) return
  open.value = true
  updatePanelPos()
  clearTimeout(timer ?? undefined)
  searchAbort?.abort()
  searchAbort = null
  const text = q.value.trim()
  if (!text) { groups.value = []; total.value = 0; loading.value = false; return }
  loading.value = true
  timer = setTimeout(() => runSearch(text), SEARCH_DEBOUNCE_MS)
}

function onCompositionEnd() {
  composing = false
  onInput()
}

async function runSearch(text: string) {
  const seq = ++reqSeq
  searchAbort?.abort()
  searchAbort = new AbortController()
  const queries = [...new Set(text.split(/\s+/).map(item => item.trim()).filter(Boolean))]
  try {
    const r = await searchApi.query(queries, searchAbort.signal)
    if (seq !== reqSeq) return   // 有更新的请求了，丢弃这次
    groups.value = r.groups || []
    total.value  = r.total || 0
  } catch (error: any) {
    if (seq !== reqSeq) return
    if (error?.name === 'AbortError') return
    groups.value = []; total.value = 0
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

function go(type: string, it: SearchItem) {
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
  } else if (type === 'note') {
    uiStore.pendingNoteId = it.id   // NotesView 监听后定位到对应日期并打开编辑态
    router.push('/mind/notes')
  }
}

function clear() {
  reqSeq++
  searchAbort?.abort()
  searchAbort = null
  q.value = ''; groups.value = []; total.value = 0
  inputEl.value?.focus()
}

function onFocus() {
  open.value = true
  updatePanelPos()
}

function close() { open.value = false }

function onDocClick(e: MouseEvent) {
  // 面板已 Teleport 到 body，点击命中输入框或面板都不关
  const inWrap  = wrapEl.value?.contains(e.target as Node)
  const inPanel = panelEl.value?.contains(e.target as Node)
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
  clearTimeout(timer ?? undefined)
})
</script>

<style scoped>
.gs-wrap {
  flex: 1;
  max-width: 340px;
  margin-left: auto;
  position: relative;
}

/* ── 结果面板：与「添加/编辑活动」弹窗(.add-event-popup)、右键菜单(.popup-menu)同款白底毛玻璃；
   Teleport 到 body 后用 fixed 定位(position/top/left/width 由内联样式给) ── */
.gs-panel {
  box-sizing: border-box;
  max-height: 62vh;
  overflow: hidden;
  overscroll-behavior: contain;
  padding: 6px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.98), 0 8px 32px rgba(60, 70, 100, 0.12);
  backdrop-filter: var(--popup-blur);
  -webkit-backdrop-filter: var(--popup-blur);
  /* z-index 由 :style 动态 */
}
.gs-scroll { max-height: calc(62vh - 12px); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }

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
  color: var(--topbar-search-result-icon);
  flex-shrink: 0;
}
.gs-item-title {
  font-size: 13px;
  color: var(--topbar-search-result-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  max-width: 56%;
}
.gs-item-sub {
  font-size: 12px;
  color: var(--topbar-search-result-muted);
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
