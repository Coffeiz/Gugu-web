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
            <button
              v-for="note in group.items"
              :key="note.id"
              class="ntp-item"
              :class="[note.color ? `tint-${note.color}` : '', { selected: note.id === selectedId }]"
              @click="selectedId = note.id"
            >
              <div class="ni-head">
                <span class="ni-time">{{ timeHM(note) }}</span>
                <span v-if="titleOf(note)" class="ni-title">{{ titleOf(note) }}</span>
              </div>
              <div class="ni-preview" :class="{ 'no-title': !titleOf(note) }">{{ previewOf(note) }}</div>
              <div v-if="note.color || taskCount(note)" class="ni-foot">
                <span class="ni-dot" :class="note.color ?? 'none'"></span>
                <span v-if="taskCount(note)" class="ni-task">
                  <PhCheckSquare :size="13" weight="bold" />
                  {{ taskCount(note) }}
                </span>
              </div>
            </button>
          </template>
          <div v-if="!store.timeline.length" class="ntp-state">{{ t('mind.noRecords') }}</div>
          <div v-if="store.loadingMore" class="ntp-state">{{ t('common.status.loading') }}</div>
        </template>
      </div>
    </section>

    <!-- 栏 2+3：阅读窗格与信息栏合并为同一块玻璃面板，中间只用内容色细分隔线 -->
    <section class="ntp-detail" :class="{ empty: !selected }">
      <div class="ntp-reading">
        <template v-if="selected">
          <div class="rp-head">
            <span class="rp-datetime">{{ fullTime(selected) }}</span>
            <span class="rp-swatch" :class="selected.color ?? 'none'" :title="t('mindUi.defaultColor')"></span>
            <div class="rp-actions">
              <button v-if="!editing" class="rp-edit-btn" @click="startEdit">
                <PhPencilSimple :size="13" weight="bold" />
                {{ t('mindUi.edit') }}
              </button>
            </div>
          </div>
          <template v-if="!editing">
            <h1 v-if="selectedTitle" class="rp-title">{{ selectedTitle }}</h1>
            <div v-if="nodeRef || selectedTitle" class="rp-meta">
              <button v-if="nodeRef" class="ntp-ref-chip" :title="refTypeLabel(nodeRef.type)" @click="openNodeRef(nodeRef)">
                <component :is="refIcon(nodeRef.type)" :size="14" weight="bold" />
                <span class="label">{{ nodeRef.label }}</span>
              </button>
            </div>
            <!-- 只读正文复用 NoteCard 同一套 mdToPreviewHtml + 全局 .md-preview 样式：
                 待办勾选、引用 chip、代码块、引用块的行为和主题适配免费拿到 -->
            <article class="rp-body md-preview" @click="onBodyClick" v-html="previewHtml"></article>
          </template>
          <!-- 编辑态：整条 contentMd 进 NoteEditor（与卡片编辑同一台 TipTap），首行 # 即标题；
               foot-actions 插槽挂完成/取消，与 NoteCard 的完成按钮同一插槽口径 -->
          <NoteEditor v-else v-model="editMd" :autofocus="true" class="rp-editor" @submit="finishEdit">
            <template #foot-actions>
              <button class="rp-done-btn" @click="finishEdit">
                <PhCheck :size="12" weight="bold" /> {{ t('mindUi.editDone') }}
              </button>
              <button class="rp-cancel-btn" @click="cancelEdit">{{ t('common.actions.cancel') }}</button>
            </template>
          </NoteEditor>
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
          <button v-if="nodeRef" class="ntp-ref-chip wide" :title="refTypeLabel(nodeRef.type)" @click="openNodeRef(nodeRef)">
            <component :is="refIcon(nodeRef.type)" :size="14" weight="bold" />
            <span class="label">{{ nodeRef.label }}</span>
            <PhArrowSquareOut :size="13" weight="bold" class="open-ico" />
          </button>
          <div v-else class="info-empty">{{ t('mindThreePane.noRefs') }}</div>
        </div>
      </aside>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowSquareOut, PhCalendarBlank, PhCheck, PhCheckSquare, PhFile, PhPencilSimple, PhStack } from '@phosphor-icons/vue'
import { showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { MindConflictError, useMindStore } from '@/stores/mind'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useMindRefActions } from '@/composables/mind/useMindRefActions'
import { mdToPreviewHtml, splitMindTitleBody, toggleTaskInMd } from '@/composables/mind/useMindEditor'
import { localDayKey, parseUtc } from '@/utils/dateAttribution'
import type { MindNote } from '@/services/api'
import NoteEditor from './components/NoteEditor.vue'

const store = useMindStore()
const projectStore = useProjectStore()
const filesCache = useFilesCacheStore()
const { t } = useI18n()
const { openMindRef } = useMindRefActions()

const listRef = ref<HTMLElement | null>(null)
const selectedId = ref<number | null>(null)

onMounted(() => {
  if (!store.loaded) void store.fetchNotes().catch(() => { /* 网络/后端不可用：全局拦截器已报错，列表落空态即可 */ })
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

// 便签本体单引用（refType/refId）：label 尽力从项目 / 文件缓存解析，解析不到退回类型名 + id
interface NtpNodeRef { type: string; id: number; label: string }
const nodeRef = computed<NtpNodeRef | null>(() => {
  const n = selected.value
  if (!n?.refType || n.refId == null) return null
  let label: string | null = null
  if (n.refType === 'project') label = projectStore.projects.find(p => p.id === n.refId)?.name ?? null
  else if (n.refType === 'file') label = filesCache.getFile(n.refId)?.displayName ?? null
  return { type: n.refType, id: n.refId, label: label || `${refTypeLabel(n.refType)} #${n.refId}` }
})
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

// ── 阅读窗格编辑态：整条 contentMd 进 NoteEditor（与卡片编辑同一台 TipTap）──
const editing = ref(false)
const editMd = ref('')

function startEdit() {
  if (!selected.value) return
  editMd.value = selected.value.contentMd
  editing.value = true
}
function cancelEdit() { editing.value = false }

async function finishEdit() {
  const note = selected.value
  editing.value = false
  if (!note) return
  const md = editMd.value
  if (md === note.contentMd) return
  if (note.id < 0) {
    // 样例数据（负 id）只改内存态，绝不落库
    store.notes = store.notes.map(n => n.id === note.id
      ? { ...n, contentMd: md, version: n.version + 1, updatedAt: new Date().toISOString() }
      : n)
    return
  }
  await onSave(note, md)
}

// 切换选中便签即退出编辑——三栏式里左侧列表始终可见，点别的条目语义明确是"看那条"
watch(selectedId, () => { editing.value = false })

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
.ntp-list-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 2px 16px; }
.ntp-state { padding: 28px 12px; font-size: 12.5px; color: var(--text-secondary); }
.ntp-day-label {
  display: flex; align-items: baseline; gap: 8px;
  padding: 14px 6px 8px; font-size: 12px; font-weight: 600; color: var(--text-secondary);
}
.ntp-day-label:first-child { padding-top: 4px; }
.ntp-day-label .n { font-weight: 400; opacity: 0.7; }
.ntp-item {
  position: relative; display: block; width: 100%; text-align: left;
  padding: 11px 13px 10px; margin-bottom: 8px; overflow: hidden;
  background: var(--surface-card-solid); border: 1px solid transparent; border-radius: var(--radius-md);
  box-shadow: var(--elevation-card); cursor: pointer; color: inherit; font-family: inherit;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
}
.ntp-item:hover { transform: translateY(-1px); box-shadow: var(--elevation-card-hover); }
.ntp-item.selected { border-color: color-mix(in srgb, var(--color-primary) 45%, transparent); }
.ntp-item.selected::before {
  content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--color-primary);
}
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
.ni-foot { display: flex; align-items: center; gap: 8px; min-height: 14px; }
.ni-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ni-dot.none { background: var(--text-secondary); opacity: 0.3; }
.ni-dot.amber { background: #ffc05f; }
.ni-dot.coral { background: #ff826c; }
.ni-dot.blue  { background: #3196e2; }
.ni-dot.teal  { background: #53d2dc; }
.ni-task { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary); }

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
.ntp-reading { min-height: 0; overflow-y: auto; padding: 20px 28px 32px; }
.ntp-detail.empty .ntp-reading { display: grid; place-items: center; }
.rp-head { display: flex; align-items: center; gap: 10px; }
.rp-datetime { font-size: 12.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.rp-swatch { width: 11px; height: 11px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(30, 32, 40, 0.12); }
.rp-swatch.none { background: repeating-conic-gradient(#dcdce2 0% 25%, #fff 0% 50%) 0 0 / 6px 6px; }
.rp-swatch.amber { background: #ffc05f; }
.rp-swatch.coral { background: #ff826c; }
.rp-swatch.blue  { background: #3196e2; }
.rp-swatch.teal  { background: #53d2dc; }
.rp-title { font-size: 23px; font-weight: 700; line-height: 1.35; margin: 10px 0 0; color: var(--text-primary); }
.rp-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  padding-bottom: 14px; margin: 12px 0 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 8%, transparent);
}
.rp-title + .rp-meta { margin-top: 10px; }
.rp-body { font-size: 14px; }

/* 编辑态：编辑器撑满阅读栏剩余高度（NoteEditor 自带 .note-editor 排版），按钮沿用卡片完成按钮的口径 */
.rp-edit-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-radius: 999px; font-size: 12.5px;
  color: var(--color-primary); border: 1px solid color-mix(in srgb, var(--color-primary) 35%, transparent);
  background: transparent; cursor: pointer; font-family: inherit; transition: background 0.15s;
}
.rp-edit-btn:hover { background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
.rp-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; margin-top: 14px; }
.rp-done-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
  color: #fff; background: var(--color-primary); border: none; cursor: pointer; font-family: inherit;
}
.rp-done-btn:hover { background: var(--action-primary-hover); }
.rp-cancel-btn {
  display: inline-flex; align-items: center;
  padding: 4px 10px; border-radius: 999px; font-size: 12px;
  color: var(--text-secondary); border: 1px solid color-mix(in srgb, var(--text-primary) 14%, transparent);
  background: transparent; cursor: pointer; font-family: inherit;
}
.rp-cancel-btn:hover { color: var(--text-primary); }

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
.ntp-ref-chip .open-ico { margin-left: auto; color: var(--text-secondary); opacity: 0.6; }

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
