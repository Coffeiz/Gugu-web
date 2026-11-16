<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { desktopData, DesktopBridgeError } from '@/desktop/bridge'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { useDesktopCanvases } from '@/desktop/composables/useDesktopCanvases'
import type { CalendarRow, ClientRow, NoteRow, SandboxStatus } from '@/desktop/bridge'
import type { DesktopOnboardingState } from '@gugu/core/desktop'
import { applyServerTheme, useTheme, type ThemeFamily, type ThemePalette, type ThemePreference } from '@/composables/core/useTheme'
import ProjectsPage from '@/views/Projects/index.vue'
import NewProjectModal from '@/views/Projects/components/NewProjectModal.vue'
import ProjectModal from '@/views/Projects/components/ProjectModal.vue'
import AppToast from '@/components/common/feedback/AppToast.vue'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'

const projectStore = useProjectStore()
const uiStore = useUiStore()
provideRuntime(runtime)

const { preference: themePreference, family: themeFamily, palette, setTheme, setFamily, setPalette } = useTheme(patch => desktopData.updateAppearance(patch))
const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' },
]
const familyOptions: { value: ThemeFamily; label: string }[] = [
  { value: 'glass', label: 'Aero' }, { value: 'mono', label: 'Mono' },
]
const paletteOptions: { value: ThemePalette; label: string }[] = [
  { value: 'neutral', label: 'Ink' }, { value: 'cafe', label: 'Cafe' }, { value: 'red', label: 'Terra' },
  { value: 'blue', label: 'Harbor' }, { value: 'green', label: 'Grove' },
]

const clients = ref<ClientRow[]>([])
const calendar = ref<CalendarRow[]>([])
const notes = ref<NoteRow[]>([])
const clientName = ref('')
const eventTitle = ref('')
const eventDate = ref(new Date().toISOString().slice(0, 10))
const noteContent = ref('')
const editingCalendarEvent = ref<CalendarRow | null>(null)
const editedEventTitle = ref('')
const editedEventDate = ref('')
const calendarHistory = ref<{ undo: string | null; redo: string | null }>({ undo: null, redo: null })
const editingNote = ref<NoteRow | null>(null)
const editedNoteContent = ref('')
const noteHistory = ref<{ undo: string | null; redo: string | null }>({ undo: null, redo: null })
const editingClient = ref<ClientRow | null>(null)
const editedClientName = ref('')
const busy = ref(false)
const error = ref('')
const connected = ref(false)
const sandbox = ref<SandboxStatus | null>(null)
const sandboxMessage = ref('')
const onboarding = ref<DesktopOnboardingState | null>(null)
const pendingOperation = ref('')
const contentArea = ref<HTMLElement | null>(null)
const activeSection = ref('home')
const activeTabTitle = computed(() => ({ home: '工作台', projects: '项目', contacts: '联系人', calendar: '日历', notes: '便签', canvases: '思维画布' })[activeSection.value] ?? '工作台')
const sidebarWidth = ref(150)
const SIDEBAR_WIDTH_KEY = 'gugu.desktop.sidebar-width'
const SIDEBAR_COMPACT_WIDTH = 56
const SIDEBAR_CONTROL_MIN_WIDTH = 0
const SIDEBAR_COMPACT_THRESHOLD = 120
const SIDEBAR_MAX_WIDTH = 200
const sidebarCompact = computed(() => sidebarWidth.value < SIDEBAR_COMPACT_THRESHOLD)
let sidebarResizeStart: { pointerX: number; width: number } | null = null
let sidebarControlWidth = sidebarWidth.value
const PENDING_OPERATION_KEY = 'gugu.desktop.pending-operation'
const canvasPanel = useDesktopCanvases({ perform, refresh, refreshHistory: refreshNoteHistory })
const {
  canvases, title: canvasTitle, editingCanvas, editedTitle: editedCanvasTitle,
  startEdit: startCanvasEdit, create: createCanvas, update: updateCanvas, remove: deleteCanvas,
  selectedCanvasId, items: canvasItems, noteContent: canvasNoteContent, editingItem: editingCanvasItem,
  editedNoteContent: editedCanvasNoteContent, select: selectCanvas, createNote: createCanvasNote,
  updateNote: updateCanvasNote, moveItem: moveCanvasItem, removeItem: removeCanvasItem,
} = canvasPanel

function navigateTo(section: string) {
  activeSection.value = section
  if (contentArea.value) contentArea.value.scrollTop = 0
}

function startSidebarResize(event: PointerEvent) {
  if (event.button !== 0) return
  sidebarControlWidth = sidebarWidth.value
  sidebarResizeStart = { pointerX: event.clientX, width: sidebarControlWidth }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function resizeSidebar(event: PointerEvent) {
  if (!sidebarResizeStart) return
  sidebarControlWidth = Math.max(SIDEBAR_CONTROL_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, sidebarResizeStart.width + event.clientX - sidebarResizeStart.pointerX))
  sidebarWidth.value = sidebarControlWidth < SIDEBAR_COMPACT_THRESHOLD
    ? SIDEBAR_COMPACT_WIDTH
    : sidebarControlWidth
}

function finishSidebarResize() {
  if (!sidebarResizeStart) return
  sidebarWidth.value = sidebarControlWidth < SIDEBAR_COMPACT_THRESHOLD
    ? SIDEBAR_COMPACT_WIDTH
    : Math.max(SIDEBAR_COMPACT_THRESHOLD, sidebarControlWidth)
  sidebarControlWidth = sidebarWidth.value
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
  sidebarResizeStart = null
}

function handleSidebarResizeKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') sidebarWidth.value = sidebarCompact.value || sidebarWidth.value <= SIDEBAR_COMPACT_THRESHOLD + 16
    ? SIDEBAR_COMPACT_WIDTH
    : sidebarWidth.value - 16
  else if (event.key === 'ArrowRight') sidebarWidth.value = sidebarCompact.value
    ? SIDEBAR_COMPACT_THRESHOLD
    : Math.min(SIDEBAR_MAX_WIDTH, sidebarWidth.value + 16)
  else if (event.key === 'Home') sidebarWidth.value = SIDEBAR_COMPACT_WIDTH
  else if (event.key === 'End') sidebarWidth.value = SIDEBAR_MAX_WIDTH
  else return
  event.preventDefault()
  sidebarControlWidth = sidebarWidth.value
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
}

async function perform(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    if (reason instanceof DesktopBridgeError && reason.code === 'unknown_result' && reason.operationId) {
      pendingOperation.value = reason.operationId
      localStorage.setItem(PENDING_OPERATION_KEY, reason.operationId)
      error.value = `${error.value}。操作标识 ${reason.operationId}，请先查询操作结果`
    }
  }
  finally { busy.value = false }
}

async function refresh() {
  const [clientRows, events, canvasRows, noteRows] = await Promise.all([desktopData.clients(), desktopData.calendar(), desktopData.canvases(), desktopData.notes()])
  clients.value = clientRows
  calendar.value = events
  await canvasPanel.setRows(canvasRows)
  notes.value = noteRows
  connected.value = true
}

async function refreshNoteHistory() {
  try {
    const history = await desktopData.undoPreview('desktop-mind') as {
      undo?: { operation_id?: unknown; can_undo?: boolean } | null
      redo?: { operation_id?: unknown; can_redo?: boolean } | null
    }
    noteHistory.value = {
      undo: history.undo?.can_undo && typeof history.undo.operation_id === 'string' ? history.undo.operation_id : null,
      redo: history.redo?.can_redo && typeof history.redo.operation_id === 'string' ? history.redo.operation_id : null,
    }
  } catch {
    noteHistory.value = { undo: null, redo: null }
  }
}

async function refreshCalendarHistory() {
  try {
    const history = await desktopData.undoPreview('desktop-calendar') as {
      undo?: { operation_id?: unknown; can_undo?: boolean } | null
      redo?: { operation_id?: unknown; can_redo?: boolean } | null
    }
    calendarHistory.value = {
      undo: history.undo?.can_undo && typeof history.undo.operation_id === 'string' ? history.undo.operation_id : null,
      redo: history.redo?.can_redo && typeof history.redo.operation_id === 'string' ? history.redo.operation_id : null,
    }
  } catch {
    calendarHistory.value = { undo: null, redo: null }
  }
}

function applyCalendarHistoryAction(mode: 'undo' | 'redo') {
  return perform(async () => {
    const undoId = calendarHistory.value[mode]
    if (!undoId) return
    const operationId = crypto.randomUUID()
    if (mode === 'undo') await desktopData.undoApply('desktop-calendar', undoId, operationId)
    else await desktopData.undoRedo('desktop-calendar', undoId, operationId)
    await refresh()
    await refreshCalendarHistory()
  })
}

function applyNoteHistoryAction(mode: 'undo' | 'redo') {
  return perform(async () => {
    const undoId = noteHistory.value[mode]
    if (!undoId) return
    const operationId = crypto.randomUUID()
    if (mode === 'undo') await desktopData.undoApply('desktop-mind', undoId, operationId)
    else await desktopData.undoRedo('desktop-mind', undoId, operationId)
    await refresh()
    await refreshNoteHistory()
  })
}

function createEvent() {
  return perform(async () => {
    await desktopData.createCalendarEvent(eventTitle.value, eventDate.value)
    eventTitle.value = ''
    await refresh()
    await refreshCalendarHistory()
  })
}

function updateCalendarEvent() {
  return perform(async () => {
    const event = editingCalendarEvent.value
    if (!event) return
    await desktopData.updateCalendarEvent(event.id, { version: event.version, title: editedEventTitle.value, date: editedEventDate.value })
    editingCalendarEvent.value = null
    await refresh()
    await refreshCalendarHistory()
  })
}

function deleteCalendarEvent(event: CalendarRow) {
  return perform(async () => {
    const confirmed = await confirmDialog({
      title: '删除日程',
      message: `确定删除“${event.title}”吗？删除后可通过撤销恢复。`,
      tone: 'danger',
      confirmText: '删除日程',
    })
    if (!confirmed) return
    await desktopData.deleteCalendarEvent(event.id, event.version)
    await refresh()
    await refreshCalendarHistory()
  })
}

function createNote() {
  return perform(async () => {
    await desktopData.createNote(noteContent.value)
    noteContent.value = ''
    await refresh()
    await refreshNoteHistory()
  })
}

function updateNote() {
  return perform(async () => {
    const note = editingNote.value
    if (!note) return
    await desktopData.updateNote(note.id, { version: note.version, contentMd: editedNoteContent.value })
    editingNote.value = null
    await refresh()
    await refreshNoteHistory()
  })
}

function deleteNote(note: NoteRow) {
  return perform(async () => {
    const confirmed = await confirmDialog({
      title: '删除便签',
      message: '删除后便签将进入已删除状态，可通过撤销恢复。',
      tone: 'danger',
      confirmText: '删除便签',
    })
    if (!confirmed) return
    await desktopData.deleteNote(note.id)
    await refresh()
    await refreshNoteHistory()
  })
}

async function recoverPendingOperation() {
  if (!pendingOperation.value) return
  const receipt = await desktopData.receipt(pendingOperation.value)
  if (receipt === null) {
    error.value = '暂未找到操作收据，操作状态仍需确认；请刷新数据后再决定下一步'
    return
  }
  pendingOperation.value = ''
  localStorage.removeItem(PENDING_OPERATION_KEY)
  await refresh()
  error.value = '已查询到操作收据，本地数据已刷新'
}

function createClient() {
  return perform(async () => {
    await desktopData.createClient(clientName.value)
    clientName.value = ''
    await refresh()
  })
}

function renameClient() {
  return perform(async () => {
    const client = editingClient.value
    if (!client) return
    await desktopData.renameClient(client.id, editedClientName.value)
    editingClient.value = null
    await refresh()
  })
}

function deleteClient(client: ClientRow) {
  return perform(async () => {
    const confirmed = await confirmDialog({
      title: '删除联系人',
      message: `确定删除联系人“${client.name}”吗？此操作无法撤销。`,
      tone: 'danger',
      confirmText: '删除联系人',
    })
    if (!confirmed) return
    await desktopData.deleteClient(client.id)
    await refresh()
  })
}

function checkSandbox() {
  return perform(async () => {
    sandboxMessage.value = '正在检测…'
    sandbox.value = await desktopData.sandboxStatus()
    sandboxMessage.value = sandbox.value.reason ?? (sandbox.value.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力')
  })
}

onMounted(() => perform(async () => {
  const savedSidebarWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0 && savedSidebarWidth <= SIDEBAR_MAX_WIDTH) {
    sidebarWidth.value = savedSidebarWidth < SIDEBAR_COMPACT_THRESHOLD ? SIDEBAR_COMPACT_WIDTH : savedSidebarWidth
    sidebarControlWidth = sidebarWidth.value
  }
  pendingOperation.value = localStorage.getItem(PENDING_OPERATION_KEY) ?? ''
  if (pendingOperation.value) await recoverPendingOperation()
  const appearance = await desktopData.appearance()
  applyServerTheme(appearance.theme, appearance.themeFamily, appearance.palette)
  onboarding.value = await desktopData.onboarding()
  await refresh()
  void projectStore.fetchProjects()
  sandbox.value = await desktopData.sandboxStatus()
}))
</script>

<template>
  <div class="desktop-shell" :class="{ 'sidebar-compact': sidebarCompact }" :style="{ '--desktop-sidebar-width': `${sidebarWidth}px` }">
    <aside class="desktop-sidebar" aria-label="主导航">
      <nav>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'home' }" aria-label="工作台" @click="navigateTo('home')"><Icon name="navigation.projects" size="sm" /><span class="nav-label">工作台</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'projects' }" aria-label="项目" @click="navigateTo('projects')"><Icon name="navigation.projects" size="sm" /><span class="nav-label">项目</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'contacts' }" aria-label="联系人" @click="navigateTo('contacts')"><Icon name="communication.customer" size="sm" /><span class="nav-label">联系人</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'calendar' }" aria-label="日历" @click="navigateTo('calendar')"><Icon name="navigation.calendar" size="sm" /><span class="nav-label">日历</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'notes' }" aria-label="便签" @click="navigateTo('notes')"><Icon name="canvas.note" size="sm" /><span class="nav-label">便签</span></button>
        <button type="button" class="nav-item" :class="{ active: activeSection === 'canvases' }" aria-label="思维画布" @click="navigateTo('canvases')"><Icon name="admin.brain" size="sm" /><span class="nav-label">思维画布</span></button>
      </nav>
      <div class="sidebar-footer"><span class="connection-dot" :class="{ connected }"></span><span class="connection-label">{{ connected ? 'Core 已连接' : '连接中' }}</span></div>
      <button class="sidebar-resize" type="button" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" title="拖动调整导航宽度，方向键微调" :aria-valuemin="SIDEBAR_COMPACT_WIDTH" :aria-valuemax="SIDEBAR_MAX_WIDTH" :aria-valuenow="Math.round(sidebarWidth)" :aria-valuetext="sidebarCompact ? '缩略导航' : `导航宽度 ${Math.round(sidebarWidth)} 像素`" @pointerdown="startSidebarResize" @pointermove="resizeSidebar" @pointerup="finishSidebarResize" @pointercancel="finishSidebarResize" @keydown="handleSidebarResizeKeydown"></button>
    </aside>
    <header class="desktop-topbar">
      <span class="desktop-tab-title">{{ activeTabTitle }}</span>
      <div class="topbar-search"><span>⌕</span><span>搜索项目、日程与便签</span><kbd>⌘ K</kbd></div>
      <ActionButton fit class="topbar-create-button" @click="uiStore.openNewProject = true"><Icon name="action.add" :size="14" />新建项目</ActionButton>
    </header>
    <main id="desktop-home" ref="contentArea" class="desktop-workbench">
    <header v-if="activeSection === 'home'" class="desktop-header">
      <div><span class="desktop-eyebrow">咕咕 · 桌面验证版</span><h1>本地工作台</h1><p>项目和联系人保存在当前设备。</p></div>
      <span class="desktop-state">{{ connected ? 'Core 已连接' : '正在连接 Core' }}</span>
    </header>
    <p v-if="error" class="desktop-error" role="alert">{{ error }}</p>
    <section v-if="activeSection === 'home'" class="desktop-panel glass-card desktop-appearance" aria-labelledby="desktop-appearance">
      <h2 id="desktop-appearance" class="section-title">外观</h2>
      <div class="appearance-group" role="group" aria-label="主题模式">
        <span>主题</span>
        <ActionButton v-for="option in themeOptions" :key="option.value" fit variant="secondary" :aria-pressed="themePreference === option.value" :disabled="busy" @click="perform(async () => { await setTheme(option.value) })">{{ option.label }}</ActionButton>
      </div>
      <div class="appearance-group" role="group" aria-label="主题样式">
        <span>样式</span>
        <ActionButton v-for="option in familyOptions" :key="option.value" fit variant="secondary" :aria-pressed="themeFamily === option.value" :disabled="busy" @click="perform(async () => { await setFamily(option.value) })">{{ option.label }}</ActionButton>
      </div>
      <div class="appearance-group" role="group" aria-label="强调配色">
        <span>配色</span>
        <ActionButton v-for="option in paletteOptions" :key="option.value" fit variant="secondary" :aria-pressed="palette === option.value" :disabled="busy" @click="perform(async () => { await setPalette(option.value) })">{{ option.label }}</ActionButton>
      </div>
    </section>
    <section v-if="activeSection === 'home' && onboarding" class="desktop-panel glass-card desktop-onboarding" aria-labelledby="desktop-onboarding">
      <h2 id="desktop-onboarding" class="section-title">新手引导状态</h2>
      <p v-if="!onboarding.guide.enabled">当前未启用引导。</p>
      <p v-else-if="onboarding.guide.completed_at">引导已完成。</p>
      <p v-else-if="onboarding.guide.dismissed">引导已暂时关闭。</p>
      <p v-else>引导进行中：{{ onboarding.guide.current_step }} · 已完成 {{ onboarding.guide.completed_steps.length }} 步。</p>
    </section>
    <ActionButton v-if="pendingOperation" fit variant="secondary" :disabled="busy" @click="perform(recoverPendingOperation)">查询待确认操作</ActionButton>
    <section v-if="activeSection === 'projects'" class="desktop-projects-page" aria-label="项目看板"><ProjectsPage /></section>
    <section v-if="activeSection === 'contacts'" id="desktop-clients" class="desktop-panel glass-card desktop-clients-panel" aria-labelledby="desktop-clients-title">
        <h2 id="desktop-clients-title" class="section-title">联系人 <span>{{ clients.length }}</span></h2>
        <form @submit.prevent="createClient">
          <span id="client-name-title" class="sr-only">联系人名称</span>
          <input id="client-name" v-model="clientName" class="form-input" aria-labelledby="client-name-title" maxlength="200" placeholder="添加一位联系人" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">添加联系人</ActionButton>
        </form>
        <ul v-if="clients.length"><li v-for="client in clients" :key="client.id"><form v-if="editingClient?.id === client.id" @submit.prevent="renameClient"><input v-model="editedClientName" class="form-input" aria-label="联系人名称" maxlength="200" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingClient = null">取消</ActionButton></form><template v-else><span>{{ client.name }}</span><ActionButton fit variant="secondary" :disabled="busy" @click="editingClient = client; editedClientName = client.name">重命名</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteClient(client)">删除</ActionButton></template></li></ul>
        <p v-else class="desktop-empty">这里会保存你的联系人。</p>
    </section>
    <section v-if="activeSection === 'calendar'" id="desktop-calendar" class="desktop-panel glass-card desktop-calendar" aria-labelledby="desktop-calendar-title">
      <h2 id="desktop-calendar-title" class="section-title">日历 <span>{{ calendar.length }}</span></h2>
      <form @submit.prevent="createEvent">
        <span id="calendar-title-label" class="sr-only">日程标题</span>
        <input v-model="eventTitle" class="form-input" aria-labelledby="calendar-title-label" maxlength="200" placeholder="添加日程" required :disabled="busy" />
        <span id="calendar-date-label" class="sr-only">日程日期</span>
        <input v-model="eventDate" class="form-input" aria-labelledby="calendar-date-label" type="date" required :disabled="busy" />
        <ActionButton fit type="submit" :disabled="busy">添加日程</ActionButton>
      </form>
      <ActionButton v-if="calendarHistory.undo" fit variant="secondary" :disabled="busy" @click="applyCalendarHistoryAction('undo')">撤销最近日历操作</ActionButton><ActionButton v-if="calendarHistory.redo" fit variant="secondary" :disabled="busy" @click="applyCalendarHistoryAction('redo')">重做最近日历操作</ActionButton>
      <ul v-if="calendar.length"><li v-for="event in calendar" :key="event.id"><form v-if="editingCalendarEvent?.id === event.id" @submit.prevent="updateCalendarEvent"><span id="calendar-edit-title-label" class="sr-only">日程标题</span><input v-model="editedEventTitle" class="form-input" aria-labelledby="calendar-edit-title-label" maxlength="200" required :disabled="busy" /><span id="calendar-edit-date-label" class="sr-only">日程日期</span><input v-model="editedEventDate" class="form-input" aria-labelledby="calendar-edit-date-label" type="date" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingCalendarEvent = null">取消</ActionButton></form><template v-else><span>{{ event.title }}</span><time>{{ event.date }}</time><small>v{{ event.version }}</small><ActionButton fit variant="secondary" :disabled="busy" @click="editingCalendarEvent = event; editedEventTitle = event.title; editedEventDate = event.date">编辑</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteCalendarEvent(event)">删除</ActionButton></template></li></ul>
      <p v-else class="desktop-empty">这里会显示你的日程。</p>
    </section>
    <section v-if="activeSection === 'notes'" id="desktop-notes" class="desktop-panel glass-card desktop-calendar" aria-labelledby="desktop-notes-title">
      <h2 id="desktop-notes-title" class="section-title">便签 <span>{{ notes.length }}</span></h2>
      <form @submit.prevent="createNote">
        <span id="note-content-label" class="sr-only">便签 Markdown 正文</span>
        <textarea v-model="noteContent" class="form-input" aria-labelledby="note-content-label" maxlength="20000" placeholder="# 便签标题&#10;&#10;记录内容" required :disabled="busy" />
        <ActionButton fit type="submit" :disabled="busy">保存便签</ActionButton>
      </form>
      <ul v-if="notes.length"><li v-for="note in notes" :key="note.id"><form v-if="editingNote?.id === note.id" @submit.prevent="updateNote"><span id="note-edit-label" class="sr-only">便签 Markdown 正文</span><textarea v-model="editedNoteContent" class="form-input" aria-labelledby="note-edit-label" maxlength="20000" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingNote = null">取消</ActionButton></form><template v-else><span>{{ note.contentMd }}</span><small>v{{ note.version }}</small><ActionButton fit variant="secondary" :disabled="busy" @click="editingNote = note; editedNoteContent = note.contentMd">编辑</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteNote(note)">删除</ActionButton></template></li></ul>
      <p v-else class="desktop-empty">这里会保存你的便签。</p>
    </section>
    <section v-if="activeSection === 'canvases'" id="desktop-canvases" class="desktop-panel glass-card" aria-labelledby="desktop-canvases-title">
      <h2 id="desktop-canvases-title" class="section-title">画布 <span>{{ canvases.length }}</span></h2>
      <form @submit.prevent="createCanvas">
        <span id="canvas-title-label" class="sr-only">画布标题</span>
        <input v-model="canvasTitle" class="form-input" aria-labelledby="canvas-title-label" maxlength="300" placeholder="创建画布" required :disabled="busy" />
        <ActionButton fit type="submit" :disabled="busy">新建画布</ActionButton>
      </form>
      <ul v-if="canvases.length"><li v-for="canvas in canvases" :key="canvas.id"><form v-if="editingCanvas?.id === canvas.id" @submit.prevent="updateCanvas"><input v-model="editedCanvasTitle" class="form-input" aria-label="画布标题" maxlength="300" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingCanvas = null">取消</ActionButton></form><template v-else><span>{{ canvas.title }}</span><ActionButton fit variant="secondary" :disabled="busy" @click="selectCanvas(canvas)">{{ selectedCanvasId === canvas.id ? '已打开' : '打开画布' }}</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="startCanvasEdit(canvas)">重命名</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteCanvas(canvas)">删除</ActionButton></template></li></ul>
      <p v-else class="desktop-empty">创建第一个画布。</p>
      <div v-if="selectedCanvasId !== null" class="desktop-canvas-content glass-card" aria-label="画布内容">
        <h3 class="section-title">{{ canvases.find(canvas => canvas.id === selectedCanvasId)?.title }} · 画布便签</h3>
        <form @submit.prevent="createCanvasNote">
          <span id="canvas-note-content-label" class="sr-only">画布便签 Markdown 正文</span>
          <textarea v-model="canvasNoteContent" class="form-input" aria-labelledby="canvas-note-content-label" maxlength="20000" placeholder="# 便签标题&#10;&#10;记录内容" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">添加到画布</ActionButton>
        </form>
        <ul v-if="canvasItems.length"><li v-for="item in canvasItems" :key="item.id">
          <form v-if="item.node.kind === 'canvas_note' && editingCanvasItem?.id === item.id" @submit.prevent="updateCanvasNote">
            <span :id="`canvas-note-edit-${item.id}`" class="sr-only">画布便签 Markdown 正文</span>
            <textarea v-model="editedCanvasNoteContent" class="form-input" :aria-labelledby="`canvas-note-edit-${item.id}`" maxlength="20000" required :disabled="busy" />
            <ActionButton fit type="submit" :disabled="busy">保存</ActionButton>
            <ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingCanvasItem = null">取消</ActionButton>
          </form>
          <template v-else>
            <pre>{{ item.node.kind === 'canvas_note' ? item.node.contentMd : item.node.title }}</pre>
            <small>{{ item.node.kind === 'canvas_note' ? `便签 v${item.node.version} · 位置 ${item.x}, ${item.y}` : '关联内容（只读）' }}</small>
            <template v-if="item.node.kind === 'canvas_note'"><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向左移动，当前 ${item.x}, ${item.y}`" @click="moveCanvasItem(item, 'left')">←</ActionButton><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向右移动，当前 ${item.x}, ${item.y}`" @click="moveCanvasItem(item, 'right')">→</ActionButton><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向上移动，当前 ${item.x}, ${item.y}`" @click="moveCanvasItem(item, 'up')">↑</ActionButton><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向下移动，当前 ${item.x}, ${item.y}`" @click="moveCanvasItem(item, 'down')">↓</ActionButton></template>
            <ActionButton v-if="item.node.kind === 'canvas_note'" fit variant="secondary" :disabled="busy" @click="editingCanvasItem = item; editedCanvasNoteContent = item.node.contentMd">编辑便签</ActionButton>
            <ActionButton v-if="item.node.kind === 'canvas_note'" fit variant="secondary" :disabled="busy" @click="removeCanvasItem(item)">从画布移除</ActionButton>
          </template>
        </li></ul>
        <p v-else class="desktop-empty">画布中还没有内容。</p>
      </div>
      <ActionButton v-if="noteHistory.undo" fit variant="secondary" :disabled="busy" @click="applyNoteHistoryAction('undo')">撤销最近便签或画布操作</ActionButton><ActionButton v-if="noteHistory.redo" fit variant="secondary" :disabled="busy" @click="applyNoteHistoryAction('redo')">重做最近便签或画布操作</ActionButton>
    </section>
    <section v-if="activeSection === 'home'" class="desktop-panel glass-card desktop-sandbox">
      <div><h2 class="section-title">执行隔离</h2><p>{{ sandbox?.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力' }}</p><p v-if="sandboxMessage" role="status">{{ sandboxMessage }}</p></div>
      <ActionButton fit variant="secondary" :disabled="busy" @click="checkSandbox">重新检测</ActionButton>
    </section>
    <ActionButton v-if="activeSection === 'home'" fit variant="secondary" class="desktop-refresh" :disabled="busy" @click="perform(refresh)">{{ busy ? '处理中…' : '刷新本地数据' }}</ActionButton>
    </main>
    <NewProjectModal :show="uiStore.openNewProject" :init-status="uiStore.newProjectInitStatus" @close="uiStore.openNewProject = false; uiStore.newProjectInitStatus = null" />
    <ProjectModal :project="projectStore.modalProject" @close="projectStore.closeModal()" />
    <AppToast />
  </div>
</template>

<style scoped>
.desktop-shell { --desktop-topbar-height: 52px; position: relative; isolation: isolate; height: 100vh; width: 100vw; overflow: hidden; display: grid; grid-template-columns: var(--desktop-sidebar-width, 204px) minmax(0, 1fr); grid-template-rows: var(--desktop-topbar-height) minmax(0, 1fr); color: var(--text-primary); background: color-mix(in srgb, var(--glass-card-background) 12%, transparent); }
.desktop-sidebar { position: relative; grid-column: 1; grid-row: 1 / 3; z-index: 2; display: flex; flex-direction: column; min-width: 0; padding: calc(var(--desktop-topbar-height) + 2px) 14px 18px; background: transparent; }
.desktop-sidebar nav { display: grid; gap: 7px; }.nav-item { display: flex; align-items: center; gap: 13px; width: 100%; min-width: 0; height: 42px; padding: 0 12px; border: 0; border-radius: 11px; color: var(--content-secondary, var(--text-secondary)); background: transparent; font: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: background .16s ease, color .16s ease; }.nav-item :deep(svg) { width: 18px; height: 18px; flex: 0 0 18px; }.nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.nav-item:hover,.nav-item.active { color: var(--content-primary, var(--text-primary)); background: color-mix(in srgb, var(--primary) 12%, transparent); }.nav-item.active { font-weight: 650; }
.sidebar-footer { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--text-secondary); font-size: 11px; }.connection-dot { width: 8px; height: 8px; border-radius: 50%; background: #d9a441; }.connection-dot.connected { background: #54ad72; }
.desktop-shell.sidebar-compact .desktop-sidebar { padding-right: 7px; padding-left: 7px; }.sidebar-compact .nav-label,.sidebar-compact .connection-label { display: none; }.sidebar-compact .nav-item { justify-content: center; padding-right: 0; padding-left: 0; }.sidebar-compact .sidebar-footer { justify-content: center; padding-right: 0; padding-left: 0; }
.sidebar-resize { position: absolute; z-index: 5; top: var(--desktop-topbar-height); right: -5px; bottom: 0; width: 10px; padding: 0; border: 0; background: transparent; cursor: col-resize; touch-action: none; }.sidebar-resize::after { position: absolute; top: 50%; left: 4px; width: 2px; height: 36px; border-radius: 2px; background: transparent; content: ''; transform: translateY(-50%); transition: background .15s ease; }.sidebar-resize:hover::after,.sidebar-resize:focus-visible::after { background: var(--primary); }.sidebar-resize:focus-visible { outline: none; }
.desktop-topbar { position: relative; grid-column: 2; grid-row: 1; z-index: 1; display: flex; align-items: center; justify-content: space-between; min-width: 0; margin-right: 16px; padding: 0 clamp(22px, 3vw, 48px); background: transparent; -webkit-app-region: drag; }.desktop-tab-title { min-width: 0; overflow: hidden; color: var(--text-primary); font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.topbar-search { position: absolute; left: 50%; box-sizing: border-box; -webkit-app-region: no-drag; display: flex; align-items: center; gap: 10px; width: min(400px, 48%); height: 36px; padding: 7px 12px; border: 1px solid color-mix(in srgb, var(--content-divider) 70%, transparent); border-radius: 11px; color: var(--text-secondary); background: color-mix(in srgb, var(--surface-card-solid) 55%, transparent); font-size: 12px; transform: translateX(-50%); }.topbar-search > span:first-child { font-size: 17px; }.topbar-search kbd { margin-left: auto; font: inherit; opacity: .7; }.desktop-topbar :deep(.topbar-create-button) { -webkit-app-region: no-drag; flex: 0 0 auto; width: max-content; min-width: max-content; }
.desktop-workbench { grid-column: 2; grid-row: 2; min-width: 0; min-height: 0; overflow: auto; margin: 0 16px 16px 0; padding: 32px clamp(22px, 3vw, 48px) 48px; border: 1px solid color-mix(in srgb, var(--content-divider) 75%, transparent); border-radius: 18px; background: var(--surface-card-solid, #fff); box-shadow: 0 12px 34px rgba(34, 39, 52, .08); scroll-behavior: smooth; }
.desktop-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 36px; }
.desktop-header > div { min-width: 0; }
.desktop-eyebrow, .desktop-state { color: var(--text-secondary); font-size: 13px; }
h1 { margin: 10px 0; font-size: 30px; font-weight: 600; }
.desktop-panel > h2 { margin: 0 0 18px; }
.desktop-panel h2 span { margin-left: 8px; color: var(--text-secondary); font-size: 12px; font-weight: 500; }
.desktop-panel p { color: var(--text-secondary); line-height: 1.6; }
.desktop-projects-page { min-width: 0; min-height: 0; height: 100%; }
.desktop-projects-page :deep(.projects-page) { height: 100%; }
.desktop-projects-page :deep(.kanban) { height: 100%; }
.desktop-clients-panel { margin-top: 20px; }
.desktop-panel { min-width: 0; padding: 22px 24px; --glass-card-background-hover: var(--glass-card-background); --glass-card-border-hover: var(--glass-card-border); --glass-card-shadow-hover: var(--glass-card-shadow); }
.desktop-appearance { margin-bottom: 24px; }
.desktop-onboarding { margin-bottom: 24px; }
.appearance-group { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.appearance-group > span { min-width: 56px; color: var(--text-secondary); }
.desktop-panel form { display: flex; gap: 10px; }
.desktop-panel form > .form-input { min-width: 0; width: 100%; }
.desktop-panel textarea.form-input { min-height: 100px; resize: vertical; }
.desktop-panel form > :deep(.app-action-button) { flex-shrink: 0; }
.desktop-panel ul { margin: 20px 0 0; padding: 0; list-style: none; }
.desktop-panel li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--content-divider); }
.desktop-panel li > span { min-width: 0; overflow-wrap: anywhere; }
.desktop-panel small, .desktop-empty { color: var(--text-secondary); }
.desktop-canvas-content { margin-top: 24px; padding: 20px; --glass-card-background-hover: var(--glass-card-background); --glass-card-border-hover: var(--glass-card-border); --glass-card-shadow-hover: var(--glass-card-shadow); }
.desktop-canvas-content h3 { margin: 0 0 16px; }
.desktop-sandbox { margin-top: 24px; display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.desktop-calendar { margin-top: 24px; }
.desktop-sandbox h2 { margin-bottom: 8px; }
.desktop-refresh { margin-top: 20px; }
.desktop-error { padding: 12px 16px; background: var(--control-bg); border: 1px solid var(--status-danger); border-radius: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 760px) { .desktop-shell { grid-template-columns: 64px minmax(0,1fr); }.desktop-sidebar { padding: calc(var(--desktop-topbar-height) + 2px) 7px 16px; }.nav-label { display:none; }.nav-item { justify-content: center; padding: 0; }.sidebar-footer { justify-content: center; padding: 8px 0; font-size: 0; }.sidebar-resize { display: none; }.desktop-topbar { gap: 8px; margin-right: 8px; padding: 0 12px; }.desktop-tab-title { max-width: 80px; font-size: 12px; }.topbar-search { position: static; width: auto; height: 34px; flex: 1; min-width: 0; transform: none; padding: 6px 8px; }.desktop-topbar :deep(.topbar-create-button) { padding-right: 9px; padding-left: 9px; }.desktop-workbench { margin: 0 8px 8px 0; padding: 24px 20px; }.desktop-projects-page { height: auto; min-height: 0; }.desktop-projects-page :deep(.kanban) { height: auto; grid-template-columns: 1fr; }.desktop-projects-page :deep(.column),.desktop-projects-page :deep(.done-col) { min-height: 240px; } }
</style>
