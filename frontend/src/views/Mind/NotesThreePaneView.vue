<template>
  <div class="ntp-layout">
    <!-- 栏 1：按日期分组的便签列表（竖列）。数据走 useMindStore 的 timeline（filterQ 已在
         store 内生效），与现行 NotesView 共享同一份数据源与筛选状态。 -->
    <section class="ntp-list">
      <div ref="listRef" class="ntp-list-scroll" @scroll="onListScroll">
        <div v-if="store.loading && !store.loaded" class="ntp-state">{{ t('common.status.loading') }}</div>
        <template v-else>
          <template v-for="group in store.timeline" :key="group.date">
            <div class="ntp-day-label" :data-date="group.date">
              <span>{{ dayLabel(group.date) }}</span>
              <span class="n">{{ t('mindThreePane.count', { count: group.items.length }) }}</span>
            </div>
            <div
              v-for="note in group.items"
              :key="note.id"
              class="ntp-item"
              :class="[note.color ? `tint-${note.color}` : '', { selected: note.id === selectedId }]"
              role="button"
              tabindex="0"
              @click="selectedId = note.id"
              @keydown.enter.prevent="selectedId = note.id"
            >
              <div class="ni-head">
                <span class="ni-time">{{ timeHM(note) }}</span>
                <span v-if="titleOf(note)" class="ni-title">{{ titleOf(note) }}</span>
              </div>
              <div class="ni-preview" :class="{ 'no-title': !titleOf(note) }">{{ previewOf(note) }}</div>
              <div class="ni-foot">
                <!-- 颜色球：显示当前颜色，点击向右展开抽屉选择（含默认纸色）；选完球即新色 -->
                <span class="color-dot-wrap">
                  <button
                    class="ni-dot-btn"
                    :class="[note.color || 'none', { open: openColorFor === note.id }]"
                    :title="note.color ? t(`mindUi.colors.${note.color}`) : t('mindUi.defaultColor')"
                    @click.stop="toggleColorPicker(note.id)"
                  ></button>
                  <span class="color-drawer" :class="{ open: openColorFor === note.id }" @click.stop>
                    <!-- 抽屉只列「可选的其他颜色」：当前色就在球上不重复出现；无色时球即默认，默认项也不进抽屉 -->
                    <button
                      v-if="note.color"
                      class="pop-dot none"
                      :title="t('mindUi.defaultColor')"
                      @click="pickColor(note, null)"
                    ></button>
                    <button
                      v-for="c in NOTE_COLORS.filter(c => c !== note.color)" :key="c"
                      class="pop-dot" :class="c"
                      :title="t(`mindUi.colors.${c}`)"
                      @click="pickColor(note, c)"
                    ></button>
                  </span>
                </span>
                <span v-if="taskCount(note)" class="ni-task">
                  <PhCheckSquare :size="13" weight="bold" />
                  {{ taskCount(note) }}
                </span>
              </div>
            </div>
          </template>
          <div v-if="!store.timeline.length" class="ntp-state">{{ t('mind.noRecords') }}</div>
          <div v-if="store.loadingMore" class="ntp-state">{{ t('common.status.loading') }}</div>
        </template>
      </div>
      <!-- 新建：进编辑态的空草稿。本地样例模式造负 id 草稿不落库；真实模式走 createNote，
           取消（未写内容）则把刚建的空便签删掉，不留垃圾行 -->
      <ActionButton variant="secondary" fit class="ntp-new" @click="createNew">
        <PhPlus :size="14" weight="bold" />
        {{ t('mindThreePane.new') }}
      </ActionButton>
    </section>

    <!-- 栏 2+3：阅读窗格与信息栏合并为同一块玻璃面板，中间只用内容色细分隔线 -->
    <section class="ntp-detail" :class="{ empty: !selected }">
      <div ref="readingRef" class="ntp-reading" :class="{ editing }">
        <template v-if="selected">
          <template v-if="!editing">
            <!-- 标题行（引用 chip 并排）+ 固定分割线：间距与编辑态标题 h1 的
                 padding/margin 完全同值，两种模式标题→分割线→正文的节奏一致 -->
            <div v-if="selectedTitle || nodeRef" class="rp-title-row">
              <h1 v-if="selectedTitle" class="rp-title">{{ selectedTitle }}</h1>
              <button v-if="nodeRef" class="ntp-ref-chip" :title="refTypeLabel(nodeRef.type)" @click="openNodeRef(nodeRef)">
                <component :is="refIcon(nodeRef.type)" :size="14" weight="bold" />
                <span class="label">{{ nodeRef.label }}</span>
              </button>
            </div>
            <div v-if="selectedTitle || nodeRef" class="rp-divider"></div>
            <!-- 只读正文复用 NoteCard 同一套 mdToPreviewHtml + 全局 .md-preview 样式：
                 待办勾选、引用 chip、代码块、引用块的行为和主题适配免费拿到 -->
            <div class="rp-body-wrap">
              <article class="rp-body md-preview" @click="onBodyClick" v-html="previewHtml"></article>
            </div>
            <!-- 底部操作区：与编辑态 Done/Cancel 同一位置；删除带文字，四个按钮统一形态 -->
            <div class="rp-foot">
              <ActionButton variant="secondary" fit @click="startEdit">
                <PhPencilSimple :size="14" weight="bold" />
                {{ t('mindUi.edit') }}
              </ActionButton>
              <ActionButton variant="danger" fit @click="onDelete">
                <PhTrash :size="14" weight="bold" />
                {{ t('mindUi.delete') }}
              </ActionButton>
            </div>
          </template>
          <!-- 编辑态：标题独占输入位（无标题便签也有地方写标题，且永久保留标题位），
               正文进 NoteEditor；完成时 combineTitleBody 拼回 contentMd，与卡片编辑同一约定 -->
          <template v-else>
            <input
              ref="titleInputRef"
              v-model="editTitle"
              class="rp-title-input"
              type="text"
              :placeholder="t('mind.titleOptional')"
              @keydown.enter.prevent
            >
            <NoteEditor v-model="editMd" :autofocus="true" :expand-drawers="true" class="rp-editor" @submit="finishEdit">
              <template #foot-actions>
                <ActionButton variant="primary" fit @click="finishEdit">
                  <PhCheck :size="14" weight="bold" /> {{ t('mindUi.editDone') }}
                </ActionButton>
                <ActionButton variant="secondary" fit @click="cancelEdit">
                  <PhX :size="14" weight="bold" /> {{ t('common.actions.cancel') }}
                </ActionButton>
              </template>
            </NoteEditor>
          </template>
        </template>
        <div v-else class="ntp-state">{{ t('mind.noRecords') }}</div>
      </div>
      <aside v-if="selected" class="ntp-info">
        <div class="info-sec">
          <div class="info-title">{{ t('mindThreePane.info') }}</div>
          <div class="kv"><span class="k">{{ t('mindThreePane.created') }}</span><span class="v">{{ fullTime(selected, 'createdAt') }}</span></div>
          <div class="kv"><span class="k">{{ t('mindThreePane.updated') }}</span><span class="v">{{ fullTime(selected, 'updatedAt') }}</span></div>
          <div class="kv"><span class="k">{{ t('mindThreePane.words') }}</span><span class="v">{{ wordCount }}</span></div>
        </div>
        <div class="info-sec">
          <div class="info-title">{{ t('mindThreePane.refs') }}</div>
          <!-- 本体单引用 + 正文行内 [[type:id|label]] 引用一起去重列出 -->
          <div v-if="allRefs.length" class="ref-list">
            <button
              v-for="r in allRefs" :key="`${r.type}:${r.id}`"
              class="ntp-ref-chip wide" :title="refTypeLabel(r.type)"
              @click="openNodeRef(r)"
            >
              <component :is="refIcon(r.type)" :size="14" weight="bold" />
              <span class="label">{{ r.label }}</span>
            </button>
          </div>
          <div v-else class="info-empty">{{ t('mindThreePane.noRefs') }}</div>
        </div>
      </aside>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowSquareOut, PhCalendarBlank, PhCheck, PhCheckSquare, PhFile, PhPencilSimple, PhPlus, PhStack, PhTrash, PhX } from '@phosphor-icons/vue'
import { showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { MindConflictError, useMindStore } from '@/stores/mind'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useMindRefActions } from '@/composables/mind/useMindRefActions'
import { mdToPreviewHtml, splitMindTitleBody, toggleTaskInMd, combineTitleBody } from '@/composables/mind/useMindEditor'
import { localDayKey, parseUtc } from '@/utils/dateAttribution'
import type { MindNote } from '@/services/api'
import NoteEditor from './components/NoteEditor.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'

const store = useMindStore()
const projectStore = useProjectStore()
const filesCache = useFilesCacheStore()
const { t } = useI18n()
const { openMindRef } = useMindRefActions()

const listRef = ref<HTMLElement | null>(null)
const selectedId = ref<number | null>(null)

onMounted(() => {
  if (!store.loaded) void store.fetchNotes().catch(() => { /* 网络/后端不可用：全局拦截器已报错，列表落空态即可 */ })
  document.addEventListener('click', closeColorPicker)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeColorPicker)
})

// 当前选中的便签。数据刷新（勾待办 / 其他端改动）后 store.notes 是同引用替换，
// 这里按 id 重新 find，保证读到的是最新字段。
const selected = computed(() => store.notes.find(n => n.id === selectedId.value) ?? null)

// 列表变化（筛选 / 删除 / 首载）后选中项不在了 → 顺位选最新的第一条，避免右侧开天窗
watch(() => store.timeline, (groups) => {
  if (groups.length && !groups.some(g => g.items.some(n => n.id === selectedId.value))) {
    selectedId.value = groups[0].items[0]?.id ?? null
  }
  if (!groups.length) selectedId.value = null
}, { immediate: true })

// ── 列表条目的展示拆分 ──
function partsOf(note: MindNote) { return splitMindTitleBody(note.contentMd) }
function titleOf(note: MindNote) { return partsOf(note).titleRaw.trim() }
function taskCount(note: MindNote) { return (note.contentMd.match(/^\s*-\s\[[ xX]\]/gm) ?? []).length }

/** 列表预览：纯文本口径，剥掉 md 标记与 [[type:id|label]] 的锚点语法只留 label */
function previewOf(note: MindNote) {
  const body = partsOf(note).body || note.contentMd
  return plainText(body).slice(0, 120)
}
function plainText(md: string) {
  return md
    .replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^-\s\[[ xX]\]\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── 阅读窗格 ──
const selectedTitle = computed(() => (selected.value ? titleOf(selected.value) : ''))
const previewHtml = computed(() => mdToPreviewHtml(selected.value ? partsOf(selected.value).body : ''))

/** 正文字数：剥掉 md 语法与引用锚点后按非空白字符计（中文口径） */
const wordCount = computed(() => {
  if (!selected.value) return 0
  return plainText(selected.value.contentMd).length
})

// 便签引用聚合：本体单引用（refType/refId）+ 正文行内 [[type:id|label]]，按 type:id 去重。
// 行内引用的 label 直接取自正文锚点；本体引用的 label 尽力从项目/文件缓存解析。
interface NtpNodeRef { type: string; id: number; label: string }
const nodeRef = computed<NtpNodeRef | null>(() => {
  const n = selected.value
  if (!n?.refType || n.refId == null) return null
  return { type: n.refType, id: n.refId, label: refLabel(n.refType, n.refId) }
})
const allRefs = computed<NtpNodeRef[]>(() => {
  const n = selected.value
  if (!n) return []
  const seen = new Set<string>()
  const out: NtpNodeRef[] = []
  const push = (type: string, id: number, label: string | null) => {
    if (!type || !Number.isFinite(id)) return
    const key = `${type}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ type, id, label: label || `${refTypeLabel(type)} #${id}` })
  }
  if (n.refType && n.refId != null) push(n.refType, n.refId, refLabel(n.refType, n.refId))
  for (const m of n.contentMd.matchAll(/\[\[([a-z_]+):(\d+)\|([^\]]*)\]\]/g)) {
    push(m[1], Number(m[2]), m[3] || null)
  }
  return out
})
function refLabel(type: string, id: number): string | null {
  if (type === 'project') return projectStore.projects.find(p => p.id === id)?.name ?? null
  if (type === 'file') return filesCache.getFile(id)?.displayName ?? null
  return null
}
function refTypeLabel(type: string) { return t(`mindEditorUi.referenceTypes.${type}`, t('mindUi.object')) }
const REF_ICONS: Record<string, typeof PhStack> = { project: PhStack, file: PhFile, event: PhCalendarBlank }
function refIcon(type: string) { return REF_ICONS[type] ?? PhCalendarBlank }
function openNodeRef(ref: NtpNodeRef) { void openMindRef(ref.type, ref.id) }

// 正文点击：待办勾选走与卡片同一条乐观锁保存路径；引用 chip 打开对应对象。
// （编辑态入口暂缺：三栏板式的编辑模型是后续要定的独立问题，先只读验证布局。）
function onBodyClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const note = selected.value
  if (!note) return
  if (target instanceof HTMLInputElement && target.dataset.taskIdx !== undefined) {
    e.preventDefault()   // 视觉状态由 PATCH 成功后的数据回流驱动，别让浏览器先勾上
    if (note.id < 0) return   // 样例数据不写后端
    const idx = Number(target.dataset.taskIdx)
    void onSave(note, toggleTaskInMd(note.contentMd, idx))
    return
  }
  const refEl = target.closest<HTMLElement>('.mind-ref')
  if (refEl) {
    const refType = refEl.dataset.refType
    const refId = Number(refEl.dataset.refId)
    if (refType && Number.isFinite(refId)) void openMindRef(refType, refId)
  }
}

async function onSave(note: MindNote, md: string) {
  try {
    await store.updateNote(note.id, { contentMd: md, version: note.version })
  } catch (e) {
    if (e instanceof MindConflictError) {
      await store.fetchNotes()
      showAppNotice(t('mind.updatedElsewhere'))
    } else {
      showAppError(t('mind.saveFailed'))
    }
  }
}

// ── 阅读窗格编辑态：标题独占输入位 + 正文进 NoteEditor（与卡片编辑同一台 TipTap）──
const editing = ref(false)
const editTitle = ref('')
const editMd = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
const readingRef = ref<HTMLElement | null>(null)

/** 进编辑态后把窗格和页面级滚动都归零：TipTap autofocus 的 scrollIntoView 会把
 *  overflow:hidden 窗格的滚动意图转嫁给 .page-content 祖先，表现为整页上跳、顶部区域变窄 */
function settleReadingScroll() {
  const el = readingRef.value
  if (!el) return
  el.scrollTop = 0
  el.closest<HTMLElement>('.page-content')?.scrollTo({ top: 0 })
}

async function startEdit() {
  if (!selected.value) return
  const parts = splitMindTitleBody(selected.value.contentMd)
  editTitle.value = parts.titleRaw
  editMd.value = parts.body
  editing.value = true
  await nextTick()
  await new Promise(resolve => requestAnimationFrame(resolve))
  settleReadingScroll()
  // 无标题便签：光标直接落标题位，引导先写标题
  if (!editTitle.value) titleInputRef.value?.focus()
}
function cancelEdit() {
  const note = selected.value
  const hadContent = !!combineTitleBody(editTitle.value.trim(), editMd.value).trim()
  editing.value = false
  // 新建后取消且没写任何内容：把空草稿删掉，不留垃圾行（负 id 只删内存，真实 id 走软删）
  if (note && pendingNewId.value === note.id && !hadContent) {
    pendingNewId.value = null
    if (note.id < 0) {
      store.notes = store.notes.filter(n => n.id !== note.id)
    } else {
      void store.deleteNote(note.id).catch(() => showAppError(t('mind.deleteFailed')))
    }
  }
}
// ── 新建：建一条空草稿并直接进编辑态 ──
// pendingNewId 记录"本次会话刚建、还没写内容"的草稿，取消时删掉
const pendingNewId = ref<number | null>(null)

async function createNew() {
  if (editing.value) return
  if (store.notes.some(n => n.id < 0)) {
    // 本地样例模式：造负 id 草稿，只进内存
    const now = new Date().toISOString()
    const draft: MindNote = {
      id: -Date.now(), kind: 'note', title: null, color: null, contentMd: '',
      capturedAt: now, createdAt: now, updatedAt: now, version: 1,
    }
    store.notes = [draft, ...store.notes]
    pendingNewId.value = draft.id
    await selectAndEdit(draft.id)
    return
  }
  try {
    const created = await store.createNote({ contentMd: '' })
    pendingNewId.value = created.id
    await selectAndEdit(created.id)
  } catch {
    showAppError(t('mind.recordFailed'))
  }
}

/** 选中刚建的草稿再进编辑：watch(selectedId) 是 pre-flush，同步紧跟的 editing=true 会被它
 *  顶掉，必须等选中切换渲染完一帧后再开编辑态 */
async function selectAndEdit(id: number) {
  selectedId.value = id
  await nextTick()
  await startEdit()
}

async function finishEdit() {
  const note = selected.value
  editing.value = false
  pendingNewId.value = null
  if (!note) return
  // 标题输入位 + 正文拼回单串 contentMd（无标题时只存正文，不产生假 `#` 行）
  const md = combineTitleBody(editTitle.value.trim(), editMd.value)
  if (md === note.contentMd) return
  if (note.id < 0) {
    // 样例数据（负 id）只改内存态，绝不落库
    store.notes = store.notes.map(n => n.id === note.id
      ? { ...n, title: editTitle.value.trim() || null, contentMd: md, version: n.version + 1, updatedAt: new Date().toISOString() }
      : n)
    return
  }
  await onSave(note, md)
}

// 切换选中便签即退出编辑——三栏式里左侧列表始终可见，点别的条目语义明确是"看那条"
watch(selectedId, () => { editing.value = false })

// ── 颜色：卡片上的颜色球，点击弹出选择（含默认纸色），选完球即新色 ──
// 颜色只改 color 字段，不牵动 contentMd/version 冲突判定（与 NotesView.onColor 同口径）
const NOTE_COLORS = ['amber', 'coral', 'blue', 'teal'] as const
const openColorFor = ref<number | null>(null)

function toggleColorPicker(id: number) {
  openColorFor.value = openColorFor.value === id ? null : id
}
function pickColor(note: MindNote, color: string | null) {
  openColorFor.value = null
  void onColor(note, color)
}
// 点卡片外任意处收起弹层（卡片本体/色球都有 stop，不会误收）
function closeColorPicker() { openColorFor.value = null }

async function onColor(note: MindNote, color: string | null) {
  if (note.id < 0) {
    store.notes = store.notes.map(n => n.id === note.id ? { ...n, color } : n)
    return
  }
  try {
    await store.updateNote(note.id, { color, version: note.version })
  } catch {
    showAppError(t('mind.colorSaveFailed'))
  }
}

// ── 删除：confirmDialog 危险确认（前端规范禁原生 confirm），负 id 样例只删内存 ──
async function onDelete() {
  const note = selected.value
  if (!note) return
  if (!await confirmDialog({
    title: t('mindThreePane.delTitle'),
    message: t('mindThreePane.delMessage'),
    tone: 'danger',
    confirmText: t('mindUi.delete'),
  })) return
  if (note.id < 0) {
    store.notes = store.notes.filter(n => n.id !== note.id)
    return
  }
  try {
    await store.deleteNote(note.id)
  } catch {
    showAppError(t('mind.deleteFailed'))
  }
}

// ── 时间 / 日期标签 ──
function timeHM(note: MindNote) {
  const d = parseUtc(note.capturedAt)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function fullTime(note: MindNote, field: 'capturedAt' | 'createdAt' | 'updatedAt' = 'capturedAt') {
  const d = parseUtc(note[field])
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${day} ${timeHM(note)}`
}
const todayKey = localDayKey(new Date())
const yesterdayKey = localDayKey(new Date(Date.now() - 86400e3))
function dayLabel(date: string) {
  if (date === todayKey) return t('calendar.today')
  if (date === yesterdayKey) return t('mindThreePane.yesterday')
  const [, m, d] = date.split('-')
  return t('mindThreePane.dayLabel', { month: +m, day: +d })
}

// ── 滚动联动 ──
// 日历选择日期 → 列表滚到对应日期分组（DatePicker 的 allowed-dates 已限定只选有记录的日期）
watch(() => store.jumpTarget, (date) => {
  if (!date || !listRef.value) return
  listRef.value.querySelector<HTMLElement>(`.ntp-day-label[data-date="${date}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
})

// 列表滚近底部 → 追加更早的日期（与时间流的 load-more 同一份数据通道）
function onListScroll() {
  const el = listRef.value
  if (!el) return
  if (el.scrollTop + el.clientHeight < el.scrollHeight - 240) return
  if (store.hasMore && !store.loadingMore) void store.loadMoreNotes()
}
</script>

<style scoped>
.ntp-layout {
  display: flex; gap: 16px;
  height: 100%; min-height: 0;
  padding: 0 24px 22px;
}

/* ── 栏 1：日期分组列表 ── */
.ntp-list { flex: 0 0 316px; min-height: 0; display: flex; flex-direction: column; }
.ntp-list-scroll {
  flex: 1; min-height: 0; overflow-y: auto; padding: 2px 2px 16px;
  /* 底部渐变淡出：卡片滚出可视区前先溶解进背景（新建按钮下方接住），不再生硬截断 */
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 64px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 64px), transparent);
}
.ntp-state { padding: 28px 12px; font-size: 12.5px; color: var(--text-secondary); }
.ntp-day-label {
  display: flex; align-items: baseline; gap: 8px;
  padding: 14px 6px 8px; font-size: 12px; font-weight: 600; color: var(--text-secondary);
}
.ntp-day-label:first-child { padding-top: 4px; }
.ntp-day-label .n { font-weight: 400; opacity: 0.7; }
.ntp-item {
  position: relative; display: block; width: 100%; text-align: left;
  padding: 11px 13px 10px; margin-bottom: 8px;
  /* 不能加 overflow:hidden——颜色弹层要从卡片向上弹出，裁剪会把弹层吃掉 */
  background: var(--surface-card-solid); border: 1px solid transparent; border-radius: var(--radius-md);
  box-shadow: var(--elevation-card); cursor: pointer; color: inherit; font-family: inherit;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
}
.ntp-item:hover { transform: translateY(-1px); box-shadow: var(--elevation-card-hover); }
.ntp-item:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.ntp-item.selected { border-color: color-mix(in srgb, var(--color-primary) 45%, transparent); }
/* 便签四色 tint 消费主题 token（tokens/components/mind.css 定义亮暗两套值）——
   不能像 NoteCard 旧底稿那样硬编码浅色 rgb，暗色下会变成浅底配浅字不可读 */
.ntp-item.tint-amber { background: var(--note-paper-amber); }
.ntp-item.tint-coral { background: var(--note-paper-coral); }
.ntp-item.tint-blue  { background: var(--note-paper-blue); }
.ntp-item.tint-teal  { background: var(--note-paper-teal); }
.ni-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.ni-time { font-size: 11px; color: var(--text-secondary); opacity: 0.85; font-variant-numeric: tabular-nums; flex: none; }
.ni-title {
  flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ni-preview {
  font-size: 12.5px; color: var(--text-secondary); line-height: 1.55;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  margin-bottom: 7px;
}
.ni-preview.no-title { -webkit-line-clamp: 3; color: var(--text-primary); font-weight: 500; }
.ni-foot { display: flex; align-items: center; gap: 8px; min-height: 18px; }
/* 颜色球：即当前颜色指示；点击向右展开抽屉选择（默认纸色 = 棋盘格），选完球即新色。
   抽屉沿用 NoteEditor 样式/插入抽屉的「max-width 从 0 长开」模式，不用浮层 */
.color-dot-wrap { position: relative; display: inline-flex; align-items: center; }
.ni-dot-btn {
  flex: none; width: 14px; height: 14px; border-radius: 50%; padding: 0; cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.85); box-shadow: 0 1px 2px rgba(80, 90, 110, 0.18);
  transition: transform 0.12s, box-shadow 0.12s;
}
.ni-dot-btn:hover { transform: scale(1.12); }
.ni-dot-btn.open { box-shadow: 0 0 0 2px var(--color-primary), 0 1px 2px rgba(80, 90, 110, 0.18); }
.ni-dot-btn.none { background: repeating-conic-gradient(#dcdce2 0% 25%, #fff 0% 50%) 0 0 / 6px 6px; }
.ni-dot-btn.amber { background: #ffc05f; }
.ni-dot-btn.coral { background: #ff826c; }
.ni-dot-btn.blue  { background: #3196e2; }
.ni-dot-btn.teal  { background: #53d2dc; }
.color-drawer {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 0; opacity: 0; overflow: hidden;
  transition: max-width 0.18s cubic-bezier(0.65, 0, 0.35, 1), opacity 0.14s ease;
}
.color-drawer.open { max-width: 140px; opacity: 1; }
/* 与本体球的间隔放抽屉内部：闭合时被 overflow 裁掉不占位，展开时才出现 */
.color-drawer .pop-dot:first-child { margin-left: 6px; }
.pop-dot {
  flex: none; width: 16px; height: 16px; border-radius: 50%; padding: 0; cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.85); box-shadow: 0 1px 2px rgba(80, 90, 110, 0.18);
}
.pop-dot.none { background: repeating-conic-gradient(#dcdce2 0% 25%, #fff 0% 50%) 0 0 / 6px 6px; }
.pop-dot.amber { background: #ffc05f; }
.pop-dot.coral { background: #ff826c; }
.pop-dot.blue  { background: #3196e2; }
.pop-dot.teal  { background: #53d2dc; }
.ni-task { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary); }

/* 新建笔记：列表底部整宽胶囊，标准 ActionButton 只接管几何宽度 */
.ntp-new { width: 100%; flex: none; margin-top: 10px; }

/* ── 栏 2+3：阅读 + 信息同一块玻璃 ── */
.ntp-detail {
  flex: 1; min-width: 0; min-height: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) 264px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border); border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  overflow: hidden;
}
.ntp-detail.empty { grid-template-columns: minmax(0, 1fr); }
/* 只读态底部 16px = 编辑态 12px 窗格边距 + ne-toolbar 自带 4px 底 padding，
   两种模式的按钮底缘才在同一水平线上 */
.ntp-reading { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; padding: 20px 28px 16px; }
/* 编辑态：窗格底部只留 12px，别让钉底的工具栏下面空一截 */
.ntp-reading.editing { overflow: hidden; padding-bottom: 12px; }
.ntp-detail.empty .ntp-reading { display: grid; place-items: center; }
.rp-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 0; }
.rp-title { font-size: 23px; font-weight: 700; line-height: 1.35; margin: 0; color: var(--text-primary); }
/* 标题→分割线→正文的节奏（12/14）与编辑态标题 h1 的 padding/margin 严格同值，
   两种模式切换时标题、分割线、正文的相对位置不动 */
.rp-divider { border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 8%, transparent); margin: 12px 0 14px; }
/* 编辑态常驻标题输入位：字级/下分割线与阅读态 rp-title + rp-divider 严格同值，
   「标题文字→线→正文」的节奏两种模式一致；输入框本体透明无描边，只保留底线 */
.rp-title-input {
  flex: none; width: 100%; box-sizing: border-box; padding: 0 0 12px;
  border: 0; border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 8%, transparent);
  border-radius: 0; outline: none; background: transparent;
  margin: 0 0 14px;
  font: 700 23px/1.35 var(--font-sans); color: var(--text-primary);
  caret-color: var(--color-primary);
}
.rp-title-input::placeholder { color: var(--text-secondary); opacity: 0.55; font-weight: 500; }
.rp-title-input:focus { border-bottom-color: color-mix(in srgb, var(--color-primary) 40%, transparent); }
/* 正文区自占剩余高度滚动，底部操作区（编辑/删除）钉在窗格底部，与编辑态 Done/Cancel 同位 */
.rp-body-wrap { flex: 1; min-height: 0; overflow-y: auto; }
.rp-body { font-size: 14px; margin-top: 14px; }
.rp-divider ~ .rp-body-wrap .rp-body { margin-top: 0; }
.rp-foot { flex: none; display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding-top: 12px; }
/* 勾选框：mind-content 的 14px 是窄卡片口径，宽窗格预览侧浏览器默认渲染已是 16px，
   编辑态按同值锁死，消除「编辑时 checkbox 变小」的观感差 */
.rp-body-wrap :deep(.md-preview .np-tasks input[type="checkbox"]) { width: 16px; height: 16px; margin-top: 3px; }
.rp-editor :deep(.ne-body ul[data-type="taskList"] input[type="checkbox"]) { width: 16px; height: 16px; margin-top: 3px; }

/* 编辑态：排版与只读预览完全同口径——mind-content 基础 13px 是窄卡片口径，宽窗格
   两边一起抬到 14px；标题行与只读大标题同字号（ne-body h1 默认 15px 是卡片口径）；
   小节标题对齐只读视图的 15px；工具栏图标比卡片编辑态大一档（阅读窗格宽、密度低）；
   工具栏/完成取消钉底，底部只留 12px 呼吸空间 */
.rp-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; }
/* 取消按钮与只读态删除按钮右缘对齐：抵消工具栏自身的 2px 右内边距 */
.rp-editor :deep(.ne-toolbar) { padding-right: 0; }
.rp-editor :deep(.ne-body) { flex: 1; min-height: 0; overflow-y: auto; }
.rp-editor :deep(.ProseMirror) { font-size: 14px; }
/* 编辑器把所有 md 标题级别折叠成 h1（markdownToDoc level:1）：其余 h1 一律 15px
   对齐 .md-preview h1（笔记标题改由独立的标题输入位承担，不再依赖首块 h1 字号） */
.rp-editor :deep(.ProseMirror h1) { font-size: 15px; font-weight: 700; margin: 0; }
.rp-editor :deep(.ProseMirror h2),
.rp-editor :deep(.ProseMirror h3) { font-size: 15px; font-weight: 700; }
.rp-editor :deep(.ne-tool svg),
.rp-editor :deep(.ne-style-item svg) { width: 16px; height: 16px; }
.rp-editor :deep(.ne-tool),
.rp-editor :deep(.ne-style-item) { width: 30px; height: 30px; }
.rp-editor :deep(.ne-toolbar-actions) { display: inline-flex; align-items: center; gap: 8px; }

/* 引用 chip（便签本体单引用）：对齐气泡 @ chip 契约——图标不压扁 + label 不换行 */
.ntp-ref-chip {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 280px; padding: 4px 10px;
  background: var(--surface-soft, color-mix(in srgb, var(--color-primary) 7%, transparent));
  border: 1px solid color-mix(in srgb, var(--text-primary) 9%, transparent);
  border-radius: 8px; font-size: 12.5px; color: var(--text-secondary); cursor: pointer;
  font-family: inherit; transition: background 0.15s;
}
.ntp-ref-chip:hover { background: color-mix(in srgb, var(--color-primary) 12%, transparent); }
.ntp-ref-chip svg { flex: none; color: var(--color-primary); }
.ntp-ref-chip .label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ntp-ref-chip.wide { max-width: 100%; width: 100%; box-sizing: border-box; justify-content: flex-start; }
.ref-list { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }

/* ── 信息栏：与阅读窗格同一块玻璃，用内容色细分隔线分区 ── */
.ntp-info {
  min-height: 0; overflow-y: auto;
  padding: 20px 18px;
  border-left: 1px solid color-mix(in srgb, var(--text-primary) 8%, transparent);
}
.info-sec + .info-sec {
  margin-top: 14px; padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--text-primary) 8%, transparent);
}
.info-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 10px; }
.kv { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 4px 0; }
.kv .k { font-size: 12px; color: var(--text-secondary); opacity: 0.8; flex: none; }
.kv .v { font-size: 12.5px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.info-empty { font-size: 12px; color: var(--text-secondary); opacity: 0.75; line-height: 1.6; }
</style>
<!-- 只读正文的排版结构（np-tasks / np-quote / 代码块…）是全局样式，NoteCard.vue 用同一份；
     本页独立于 Mind 路由挂载时也要加载它，否则任务/引用块退化为裸列表 -->
<style src="./components/mind-content.css"></style>
