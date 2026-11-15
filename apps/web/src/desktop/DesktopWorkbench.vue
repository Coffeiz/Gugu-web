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
  <main class="desktop-workbench">
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
      <section class="desktop-panel" aria-labelledby="desktop-projects">
        <h2 id="desktop-projects">项目 <span>{{ projects.length }}</span></h2>
        <form @submit.prevent="createProject">
          <span id="project-name-title" class="sr-only">项目名称</span>
          <input id="project-name" v-model="projectName" class="form-input" aria-labelledby="project-name-title" maxlength="200" placeholder="准备开展的新项目" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">创建项目</ActionButton>
        </form>
        <ul v-if="projects.length"><li v-for="project in projects" :key="project.id"><form v-if="editingProject?.id === project.id" @submit.prevent="renameProject"><input v-model="editedProjectName" class="form-input" aria-label="项目名称" maxlength="200" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingProject = null">取消</ActionButton></form><template v-else><span>{{ project.name }}</span><small>v{{ project.version }}</small><ActionButton fit variant="secondary" :disabled="busy" @click="editingProject = project; editedProjectName = project.name">重命名</ActionButton></template></li></ul>
        <p v-else class="desktop-empty">从第一个项目开始。</p>
      </section>
      <section class="desktop-panel" aria-labelledby="desktop-clients">
        <h2 id="desktop-clients">联系人 <span>{{ clients.length }}</span></h2>
        <form @submit.prevent="createClient">
          <span id="client-name-title" class="sr-only">联系人名称</span>
          <input id="client-name" v-model="clientName" class="form-input" aria-labelledby="client-name-title" maxlength="200" placeholder="添加一位联系人" required :disabled="busy" />
          <ActionButton fit type="submit" :disabled="busy">添加联系人</ActionButton>
        </form>
        <ul v-if="clients.length"><li v-for="client in clients" :key="client.id"><form v-if="editingClient?.id === client.id" @submit.prevent="renameClient"><input v-model="editedClientName" class="form-input" aria-label="联系人名称" maxlength="200" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingClient = null">取消</ActionButton></form><template v-else><span>{{ client.name }}</span><ActionButton fit variant="secondary" :disabled="busy" @click="editingClient = client; editedClientName = client.name">重命名</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteClient(client)">删除</ActionButton></template></li></ul>
        <p v-else class="desktop-empty">这里会保存你的联系人。</p>
      </section>
    </div>
    <section class="desktop-panel desktop-calendar" aria-labelledby="desktop-calendar">
      <h2 id="desktop-calendar">日历 <span>{{ calendar.length }}</span></h2>
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
    <section class="desktop-panel desktop-calendar" aria-labelledby="desktop-notes">
      <h2 id="desktop-notes">便签 <span>{{ notes.length }}</span></h2>
      <form @submit.prevent="createNote">
        <span id="note-content-label" class="sr-only">便签 Markdown 正文</span>
        <textarea v-model="noteContent" class="form-input" aria-labelledby="note-content-label" maxlength="20000" placeholder="# 便签标题&#10;&#10;记录内容" required :disabled="busy" />
        <ActionButton fit type="submit" :disabled="busy">保存便签</ActionButton>
      </form>
      <ul v-if="notes.length"><li v-for="note in notes" :key="note.id"><form v-if="editingNote?.id === note.id" @submit.prevent="updateNote"><span id="note-edit-label" class="sr-only">便签 Markdown 正文</span><textarea v-model="editedNoteContent" class="form-input" aria-labelledby="note-edit-label" maxlength="20000" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingNote = null">取消</ActionButton></form><template v-else><span>{{ note.contentMd }}</span><small>v{{ note.version }}</small><ActionButton fit variant="secondary" :disabled="busy" @click="editingNote = note; editedNoteContent = note.contentMd">编辑</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="deleteNote(note)">删除</ActionButton></template></li></ul>
      <p v-else class="desktop-empty">这里会保存你的便签。</p>
    </section>
    <section class="desktop-panel" aria-labelledby="desktop-canvases">
      <h2 id="desktop-canvases">画布 <span>{{ canvases.length }}</span></h2>
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
</template>

<style scoped>
.desktop-workbench { max-width: 1120px; margin: 0 auto; padding: 48px 40px; color: var(--text-primary); }
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
@media (max-width: 760px) { .desktop-workbench { padding: 24px 20px; } .desktop-columns { grid-template-columns: 1fr; } }
</style>
