<template>
  <div class="gs-wrap" ref="wrapEl">
    <SearchInput
      ref="inputEl"
      v-model="q"
      :active="open"
      clearable
      :placeholder="t(desktop ? 'common.desktopSearchPlaceholder' : 'common.searchPlaceholder')"
      @focus="onFocus"
      @input="onInput"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
      @keydown.esc="close"
      @clear="clear"
    >
      <template v-if="desktop" #suffix><kbd class="gs-shortcut">{{ shortcut }}</kbd></template>
    </SearchInput>

    <Teleport to="body">
      <transition name="gs-pop">
        <div v-if="open && q.trim()" ref="panelEl" class="gs-panel" :style="panelStyle">
          <div class="gs-scroll scroll-surface scroll-surface--compact">
            <div v-if="loading" class="gs-hint">
              <Icon name="status.loading" class="gs-spin" size="md" tone="inherit" /> {{ t('common.searching') }}
            </div>
            <div v-else-if="failed" class="gs-hint" role="alert">{{ t('common.desktopSearchFailed') }}</div>
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
                  <ReferenceTypeIcon :type="g.type" class="gs-item-icon" :size="14" />
                  <span class="gs-item-title">{{ it.title }}</span>
                  <span v-if="it.subtitle" class="gs-item-sub">{{ it.subtitle }}</span>
                </button>
              </div>
            </template>
            <div v-if="!loading && partial" class="gs-hint">{{ t('common.desktopSearchPartial') }}</div>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import ReferenceTypeIcon from '@/components/common/icons/ReferenceTypeIcon.vue'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { createPressOutsideGuard } from '@/composables/shared/pressOutsideClose'
import { nextZ } from '@/composables/core/windowz'
import { useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import Icon from '@/components/common/icons/Icon.vue'
import SearchInput from '@/components/common/controls/SearchInput.vue'
import { useSearchAccess, type SearchGroup, type SearchItem } from '@/services/searchAccess'
import { useFileOpenAccess } from '@/services/fileOpenAccess'
import { shouldOpenFileInSystem } from '@/utils/filePreviewTypes'
import { useUiStore } from '@/stores/ui'
import { isPreviewable, usePreviewStore } from '@/stores/preview'
import { splitName } from '@/utils/fileParse'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ desktop?: boolean }>()
const shortcut = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
const fileOpenAccess = useFileOpenAccess()
const searchAccess = useSearchAccess()
const router       = useRouter()
const uiStore      = useUiStore()
const previewStore = usePreviewStore()
const { t } = useI18n()

const wrapEl  = ref<HTMLElement | null>(null)
const inputEl = ref<InstanceType<typeof SearchInput> | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const q       = ref('')
const open    = ref(false)
const loading = ref(false)
const groups  = ref<SearchGroup[]>([])
const total   = ref(0)
const failed = ref(false)
const partial = ref(false)

// 面板 Teleport 到 body，脱离页面布局的层叠上下文后再绘制浮层 blur；用 fixed 跟随搜索框定位
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
  reqSeq++
  failed.value = false
  partial.value = false
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
    if (!searchAccess) throw new Error('搜索接口未装配')
    const r = await searchAccess.query(queries, searchAbort.signal)
    if (seq !== reqSeq) return   // 有更新的请求了，丢弃这次
    groups.value = r.groups || []
    total.value  = r.total || 0
    partial.value = r.partial === true
  } catch (error: any) {
    if (seq !== reqSeq) return
    if (error?.name === 'AbortError') return
    failed.value = props.desktop === true
    groups.value = []; total.value = 0
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

function go(type: string, it: SearchItem) {
  close()
  // 历史类型（project/file/...）的 id 都是 number；mcp/scheduled_task 是字符串，
  // 各自走专属分支，数字型消费方一律 Number() 收紧。
  const numericId = Number(it.id)
  if (type === 'project') {
    uiStore.pendingProjectHighlight = numericId
    void router.push('/projects')
  } else if (type === 'file' || type === 'folder') {
    if (!it.path_file) return
    uiStore.pendingFileTarget = { kind: type, id: 0, pathFile: it.path_file }
    void router.push('/files')
    if (type === 'file') {
      const { base, ext } = splitName(it.title)
      if (props.desktop && fileOpenAccess?.canOpenInSystem(it.path_file)
        && shouldOpenFileInSystem(fileOpenAccess.getOpenPreference(), base ? ext : '')) {
        void fileOpenAccess.openInSystem(it.path_file)
      } else if (isPreviewable(base ? ext : '')) {
        const { directoryId, relativePath } = it.path_file
        previewStore.open({ displayName: base || it.title, ext: base ? ext : '', workspaceFile: { directoryId, relativePath } })
      }
    }
  } else if (type === 'event') {
    uiStore.pendingCalendarEvent = { id: numericId, date: it.date }
    router.push('/calendar')
  } else if (type === 'conversation') {
    uiStore.requestChatNavigation(numericId, it.message_id || null)
  } else if (type === 'client') {
    Message.info('联系人页面还在开发中，先在项目里看吧～')
  } else if (type === 'note') {
    router.push({ path: '/notes', query: { object_id: String(numericId) } })
  } else if (type === 'canvas_note') {
    const canvasId = Number(it.canvas_id)
    if (Number.isSafeInteger(canvasId) && canvasId > 0 && Number.isSafeInteger(numericId) && numericId > 0) {
      uiStore.pendingCanvasTarget = { canvasId, nodeId: numericId }
      router.push('/canvases')
    }
  } else if (type === 'skill') {
    router.push({ path: '/skills', query: { skill: String(it.id) } })
  } else if (type === 'mcp') {
    router.push({ path: '/mcp', query: { server: String(it.id) } })
  } else if (type === 'scheduled_task') {
    router.push({ path: '/schedules', query: { object_id: String(it.id) } })
  }
}

function clear() {
  reqSeq++
  clearTimeout(timer ?? undefined)
  failed.value = false
  partial.value = false
  loading.value = false
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

// 拖选保护：面板内拖选文字移出后松开，click 落在外面，不能因此误关
const pressGuard = createPressOutsideGuard((t: Node) =>
  !!(wrapEl.value?.contains(t) || panelEl.value?.contains(t)))
function onDocPress(e: MouseEvent) { pressGuard.notePress(e) }

function onDocClick(e: MouseEvent) {
  // 面板已 Teleport 到 body，点击命中输入框或面板都不关
  if (!pressGuard.shouldCloseOn(e)) return
  close()
}

function onReposition() {
  if (open.value) updatePanelPos()
}

function onSearchShortcut(event: KeyboardEvent) {
  if (!props.desktop || event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
  event.preventDefault()
  inputEl.value?.focus()
}
onMounted(() => {
  window.addEventListener('keydown', onSearchShortcut)
  document.addEventListener('mousedown', onDocPress, true)
  document.addEventListener('click', onDocClick)
  window.addEventListener('resize', onReposition)
  window.addEventListener('scroll', onReposition, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onSearchShortcut)
  searchAbort?.abort()
  document.removeEventListener('mousedown', onDocPress, true)
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

.gs-shortcut { flex-shrink: 0; font: inherit; font-size: var(--font-size-sm); color: var(--content-tertiary); }

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
  border-radius: var(--card-radius);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.98), 0 8px 32px rgba(60, 70, 100, 0.12);
  backdrop-filter: var(--popup-blur);
  -webkit-backdrop-filter: var(--popup-blur);
  /* z-index 由 :style 动态 */
}
/* 滚动面套浮层滚动条契约；滑块右移进面板内侧，避免压到玻璃面板的圆角边框。 */
.gs-scroll { max-height: calc(62vh - 12px); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; --scrollbar-overlay-right-offset: 4px; }

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
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background 0.18s ease;
}
.gs-item:hover { background: color-mix(in srgb, var(--action-primary) 8%, transparent); }

.gs-item-icon {
  color: var(--topbar-search-result-icon);
  flex-shrink: 0;
}
.gs-item-title {
  font-size: 13px;
  line-height: 1.5;
  color: var(--topbar-search-result-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  max-width: 56%;
}
.gs-item-sub {
  font-size: 12px;
  line-height: 1.5;
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
