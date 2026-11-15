<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { desktopData, DesktopBridgeError } from './bridge'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { useDesktopCanvases } from './composables/useDesktopCanvases'
import type { CalendarRow, ClientRow, NoteRow, ProjectRow, SandboxStatus } from './bridge'
import type { DesktopOnboardingState } from '@gugu/core/desktop'
import { applyServerTheme, useTheme, type ThemeFamily, type ThemePalette, type ThemePreference } from '@/composables/core/useTheme'

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

const projects = ref<ProjectRow[]>([])
const clients = ref<ClientRow[]>([])
const calendar = ref<CalendarRow[]>([])
const notes = ref<NoteRow[]>([])
const projectName = ref('')
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
const editingProject = ref<ProjectRow | null>(null)
const editedProjectName = ref('')
const editingClient = ref<ClientRow | null>(null)
const editedClientName = ref('')
const busy = ref(false)
const error = ref('')
const connected = ref(false)
const sandbox = ref<SandboxStatus | null>(null)
const sandboxMessage = ref('')
const onboarding = ref<DesktopOnboardingState | null>(null)
const pendingOperation = ref('')
const PENDING_OPERATION_KEY = 'gugu.desktop.pending-operation'
const canvasPanel = useDesktopCanvases({ perform, refresh, refreshHistory: refreshNoteHistory })
const {
  canvases, title: canvasTitle, editingCanvas, editedTitle: editedCanvasTitle,
  startEdit: startCanvasEdit, create: createCanvas, update: updateCanvas, remove: deleteCanvas,
  selectedCanvasId, items: canvasItems, noteContent: canvasNoteContent, editingItem: editingCanvasItem,
  editedNoteContent: editedCanvasNoteContent, select: selectCanvas, createNote: createCanvasNote,
  updateNote: updateCanvasNote, moveItem: moveCanvasItem, removeItem: removeCanvasItem,
} = canvasPanel

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
  const [projectRows, clientRows, events, canvasRows, noteRows] = await Promise.all([desktopData.projects(), desktopData.clients(), desktopData.calendar(), desktopData.canvases(), desktopData.notes()])
  projects.value = projectRows
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

function createProject() {
  return perform(async () => {
    await desktopData.createProject(projectName.value)
    projectName.value = ''
    await refresh()
  })
}

function createClient() {
  return perform(async () => {
    await desktopData.createClient(clientName.value)
    clientName.value = ''
    await refresh()
  })
}

function renameProject() {
  return perform(async () => {
    const project = editingProject.value
    if (!project) return
    await desktopData.renameProject(project.id, project.version, editedProjectName.value)
    editingProject.value = null
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
  pendingOperation.value = localStorage.getItem(PENDING_OPERATION_KEY) ?? ''
  if (pendingOperation.value) await recoverPendingOperation()
  const appearance = await desktopData.appearance()
  applyServerTheme(appearance.theme, appearance.themeFamily, appearance.palette)
  onboarding.value = await desktopData.onboarding()
  await refresh()
  sandbox.value = await desktopData.sandboxStatus()
}))
</script>

<template>
  <div class="desktop-shell">
    <aside class="desktop-sidebar" aria-label="主导航">
      <div class="brand"><span class="brand-mark">咕</span><strong>咕咕</strong><small>桌面工作台</small></div>
      <nav>
        <a href="#desktop-home" class="nav-item active"><span>⌂</span>工作台</a>
        <a href="#desktop-projects" class="nav-item"><span>▧</span>项目</a>
        <a href="#desktop-calendar" class="nav-item"><span>▦</span>日历</a>
        <a href="#desktop-notes" class="nav-item"><span>▤</span>便签</a>
        <a href="#desktop-canvases" class="nav-item"><span>⌘</span>思维画布</a>
      </nav>
      <div class="sidebar-footer"><span class="connection-dot" :class="{ connected }"></span>{{ connected ? 'Core 已连接' : '连接中' }}</div>
    </aside>
    <header class="desktop-topbar">
      <div class="window-spacer" aria-hidden="true"></div>
      <div class="topbar-search"><span>⌕</span><span>搜索项目、日程与便签</span><kbd>⌘ K</kbd></div>
      <button class="profile-chip" type="button" aria-label="本地工作区">本地工作区 <span>⌄</span></button>
    </header>
    <main id="desktop-home" class="desktop-workbench">
    <header class="desktop-header">
      <div><span class="desktop-eyebrow">咕咕 · 桌面验证版</span><h1>本地工作台</h1><p>项目和联系人保存在当前设备。</p></div>
      <span class="desktop-state">{{ connected ? 'Core 已连接' : '正在连接 Core' }}</span>
    </header>
    <p v-if="error" class="desktop-error" role="alert">{{ error }}</p>
    <section class="desktop-panel desktop-appearance" aria-labelledby="desktop-appearance">
      <h2 id="desktop-appearance">外观</h2>
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
    <section v-if="onboarding" class="desktop-panel desktop-onboarding" aria-labelledby="desktop-onboarding">
      <h2 id="desktop-onboarding">新手引导状态</h2>
      <p v-if="!onboarding.guide.enabled">当前未启用引导。</p>
      <p v-else-if="onboarding.guide.completed_at">引导已完成。</p>
      <p v-else-if="onboarding.guide.dismissed">引导已暂时关闭。</p>
      <p v-else>引导进行中：{{ onboarding.guide.current_step }} · 已完成 {{ onboarding.guide.completed_steps.length }} 步。</p>
    </section>
    <ActionButton v-if="pendingOperation" fit variant="secondary" :disabled="busy" @click="perform(recoverPendingOperation)">查询待确认操作</ActionButton>
    <div class="desktop-columns">
      <section id="desktop-projects" class="desktop-panel" aria-labelledby="desktop-projects-title">
        <h2 id="desktop-projects-title">项目 <span>{{ projects.length }}</span></h2>
        <form @submit.prevent="createProject">
          <span id="project-name-title" class="sr-only">项目名称</span>
          <input id="project-name" v-model="projectName" class="form-input" aria-labelledby="project-name-title" maxlength="200" placeholder="准备开展的新项目" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">创建项目</ActionButton>
        </form>
        <ul v-if="projects.length"><li v-for="project in projects" :key="project.id"><form v-if="editingProject?.id === project.id" @submit.prevent="renameProject"><input v-model="editedProjectName" class="form-input" aria-label="项目名称" maxlength="200" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingProject = null">取消</ActionButton></form><template v-else><span>{{ project.name }}</span><small>v{{ project.version }}</small><ActionButton fit variant="secondary" :disabled="busy" @click="editingProject = project; editedProjectName = project.name">重命名</ActionButton></template></li></ul>
        <p v-else class="desktop-empty">从第一个项目开始。</p>
      </section>
      <section id="desktop-clients" class="desktop-panel" aria-labelledby="desktop-clients-title">
        <h2 id="desktop-clients-title">联系人 <span>{{ clients.length }}</span></h2>
        <form @submit.prevent="createClient">
          <span id="client-name-title" class="sr-only">联系人名称</span>
          <input id="client-name" v-model="clientName" class="form-input" aria-labelledby="client-name-title" maxlength="200" placeholder="添加一位联系人" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">添加联系人</ActionButton>
        </form>
        <ul v-if="clients.length"><li v-for="client in clients" :key="client.id"><form v-if="editingClient?.id === client.id" @submit.prevent="renameClient"><input v-model="editedClientName" class="form-input" aria-label="联系人名称" maxlength="200" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingClient = null">取消</ActionButton></form><template v-else><span>{{ client.name }}</span><ActionButton fit variant="secondary" :disabled="busy" @click="editingClient = client; editedClientName = client.name">重命名</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteClient(client)">删除</ActionButton></template></li></ul>
        <p v-else class="desktop-empty">这里会保存你的联系人。</p>
      </section>
    </div>
    <section id="desktop-calendar" class="desktop-panel desktop-calendar" aria-labelledby="desktop-calendar-title">
      <h2 id="desktop-calendar-title">日历 <span>{{ calendar.length }}</span></h2>
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
    <section id="desktop-notes" class="desktop-panel desktop-calendar" aria-labelledby="desktop-notes-title">
      <h2 id="desktop-notes-title">便签 <span>{{ notes.length }}</span></h2>
      <form @submit.prevent="createNote">
        <span id="note-content-label" class="sr-only">便签 Markdown 正文</span>
        <textarea v-model="noteContent" class="form-input" aria-labelledby="note-content-label" maxlength="20000" placeholder="# 便签标题&#10;&#10;记录内容" required :disabled="busy" />
        <ActionButton fit type="submit" :disabled="busy">保存便签</ActionButton>
      </form>
      <ul v-if="notes.length"><li v-for="note in notes" :key="note.id"><form v-if="editingNote?.id === note.id" @submit.prevent="updateNote"><span id="note-edit-label" class="sr-only">便签 Markdown 正文</span><textarea v-model="editedNoteContent" class="form-input" aria-labelledby="note-edit-label" maxlength="20000" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingNote = null">取消</ActionButton></form><template v-else><span>{{ note.contentMd }}</span><small>v{{ note.version }}</small><ActionButton fit variant="secondary" :disabled="busy" @click="editingNote = note; editedNoteContent = note.contentMd">编辑</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteNote(note)">删除</ActionButton></template></li></ul>
      <p v-else class="desktop-empty">这里会保存你的便签。</p>
    </section>
    <section id="desktop-canvases" class="desktop-panel" aria-labelledby="desktop-canvases-title">
      <h2 id="desktop-canvases-title">画布 <span>{{ canvases.length }}</span></h2>
      <form @submit.prevent="createCanvas">
        <span id="canvas-title-label" class="sr-only">画布标题</span>
        <input v-model="canvasTitle" class="form-input" aria-labelledby="canvas-title-label" maxlength="300" placeholder="创建画布" required :disabled="busy" />
        <ActionButton fit type="submit" :disabled="busy">新建画布</ActionButton>
      </form>
      <ul v-if="canvases.length"><li v-for="canvas in canvases" :key="canvas.id"><form v-if="editingCanvas?.id === canvas.id" @submit.prevent="updateCanvas"><input v-model="editedCanvasTitle" class="form-input" aria-label="画布标题" maxlength="300" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingCanvas = null">取消</ActionButton></form><template v-else><span>{{ canvas.title }}</span><ActionButton fit variant="secondary" :disabled="busy" @click="selectCanvas(canvas)">{{ selectedCanvasId === canvas.id ? '已打开' : '打开画布' }}</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="startCanvasEdit(canvas)">重命名</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteCanvas(canvas)">删除</ActionButton></template></li></ul>
      <p v-else class="desktop-empty">创建第一个画布。</p>
      <div v-if="selectedCanvasId !== null" class="desktop-canvas-content" aria-label="画布内容">
        <h3>{{ canvases.find(canvas => canvas.id === selectedCanvasId)?.title }} · 画布便签</h3>
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
    <section class="desktop-panel desktop-sandbox">
      <div><h2>执行隔离</h2><p>{{ sandbox?.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力' }}</p><p v-if="sandboxMessage" role="status">{{ sandboxMessage }}</p></div>
      <ActionButton fit variant="secondary" :disabled="busy" @click="checkSandbox">重新检测</ActionButton>
    </section>
    <ActionButton fit variant="secondary" class="desktop-refresh" :disabled="busy" @click="perform(refresh)">{{ busy ? '处理中…' : '刷新本地数据' }}</ActionButton>
    </main>
  </div>
</template>

<style scoped>
.desktop-shell { height: 100vh; width: 100vw; overflow: hidden; display: grid; grid-template-columns: 204px minmax(0, 1fr); grid-template-rows: 64px minmax(0, 1fr); color: var(--text-primary); background: radial-gradient(ellipse at 18% 0%, color-mix(in srgb, var(--primary) 14%, transparent), transparent 42%), var(--surface-app, #eef0f5); }
.desktop-sidebar { grid-column: 1; grid-row: 1 / 3; z-index: 2; display: flex; flex-direction: column; padding: 66px 14px 18px; border-right: 1px solid color-mix(in srgb, var(--glass-card-border) 85%, transparent); background: color-mix(in srgb, var(--glass-card-background) 72%, transparent); backdrop-filter: blur(30px) saturate(145%); -webkit-backdrop-filter: blur(30px) saturate(145%); }
.brand { display: flex; align-items: center; gap: 9px; padding: 2px 10px 34px; font-size: 17px; }.brand small { margin-left: auto; font-size: 10px; font-weight: 500; }.brand-mark { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 10px; color: white; background: var(--primary, #686b75); font-weight: 700; }
.desktop-sidebar nav { display: grid; gap: 7px; }.nav-item { display: flex; align-items: center; gap: 13px; height: 42px; padding: 0 12px; border-radius: 11px; color: var(--content-secondary, var(--text-secondary)); font-size: 13px; text-decoration: none; transition: background .16s ease, color .16s ease; }.nav-item span { width: 18px; font-size: 18px; text-align: center; }.nav-item:hover,.nav-item.active { color: var(--content-primary, var(--text-primary)); background: color-mix(in srgb, var(--primary) 12%, transparent); }.nav-item.active { font-weight: 650; }
.sidebar-footer { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--text-secondary); font-size: 11px; }.connection-dot { width: 8px; height: 8px; border-radius: 50%; background: #d9a441; }.connection-dot.connected { background: #54ad72; }
.desktop-topbar { grid-column: 1 / 3; grid-row: 1; z-index: 1; display: flex; align-items: center; gap: 24px; padding: 8px 28px 8px 118px; background: color-mix(in srgb, var(--glass-card-background) 66%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--glass-card-border) 76%, transparent); backdrop-filter: blur(28px) saturate(145%); -webkit-backdrop-filter: blur(28px) saturate(145%); -webkit-app-region: drag; }.window-spacer { display: none; }.topbar-search { -webkit-app-region: no-drag; display: flex; align-items: center; gap: 10px; width: min(520px, 58%); margin: auto; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--content-divider) 70%, transparent); border-radius: 12px; color: var(--text-secondary); background: color-mix(in srgb, var(--surface-card-solid) 55%, transparent); font-size: 12px; }.topbar-search > span:first-child { font-size: 19px; }.topbar-search kbd { margin-left: auto; font: inherit; opacity: .7; }.profile-chip { -webkit-app-region: no-drag; border: 0; border-radius: 20px; padding: 9px 12px; color: var(--text-primary); background: color-mix(in srgb, var(--surface-card-solid) 65%, transparent); font: inherit; font-size: 12px; }
.desktop-workbench { grid-column: 2; grid-row: 2; min-width: 0; min-height: 0; overflow: auto; margin: 14px 16px 16px 12px; padding: 32px clamp(22px, 3vw, 48px) 48px; border: 1px solid color-mix(in srgb, var(--content-divider) 75%, transparent); border-radius: 18px; background: var(--surface-card-solid, #fff); box-shadow: 0 12px 34px rgba(34, 39, 52, .08); }
.desktop-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 36px; }
.desktop-header > div { min-width: 0; }
.desktop-eyebrow, .desktop-state { color: var(--text-secondary); font-size: 13px; }
h1 { margin: 10px 0; font-size: 30px; font-weight: 600; }
h2 { margin: 0 0 20px; font-size: 18px; font-weight: 600; }
h2 span { margin-left: 8px; color: var(--text-secondary); font-size: 13px; }
p { color: var(--text-secondary); line-height: 1.6; }
.desktop-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.desktop-panel { padding: 24px; border: 1px solid var(--content-divider); border-radius: 16px; background: var(--surface-card-solid); min-width: 0; }
.desktop-appearance { margin-bottom: 24px; }
.desktop-onboarding { margin-bottom: 24px; }
.appearance-group { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.appearance-group > span { min-width: 56px; color: var(--text-secondary); }
form { display: flex; gap: 10px; }
input { min-width: 0; width: 100%; }
textarea { min-width: 0; width: 100%; min-height: 100px; resize: vertical; }
button { flex-shrink: 0; }
ul { margin: 20px 0 0; padding: 0; list-style: none; }
li { display: flex; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--content-divider); }
li span { min-width: 0; overflow-wrap: anywhere; }
small, .desktop-empty { color: var(--text-secondary); }
.desktop-sandbox { margin-top: 24px; display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.desktop-calendar { margin-top: 24px; }
.desktop-sandbox h2 { margin-bottom: 8px; }
.desktop-refresh { margin-top: 20px; }
.desktop-error { padding: 12px 16px; background: var(--control-bg); border: 1px solid var(--status-danger); border-radius: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 760px) { .desktop-shell { grid-template-columns: 64px minmax(0,1fr); grid-template-rows: 64px minmax(0,1fr); }.desktop-sidebar { padding: 66px 7px 16px; }.brand { display:none; }.nav-item:not(.active) { font-size: 0; }.nav-item { justify-content: center; padding: 0; }.nav-item span { font-size: 18px; }.sidebar-footer { justify-content: center; padding: 8px 0; font-size: 0; }.desktop-topbar { padding: 8px 12px 8px 104px; gap: 8px; }.topbar-search { width: auto; flex: 1; margin: 0; }.profile-chip { font-size: 0; }.profile-chip span { font-size: 12px; }.desktop-workbench { margin: 8px; padding: 24px 20px; }.desktop-columns { grid-template-columns: 1fr; } }
</style>
