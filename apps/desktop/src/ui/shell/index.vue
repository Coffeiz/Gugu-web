<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { desktopData, DesktopBridgeError } from '@/desktop/bridge'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import type { SandboxStatus } from '@/desktop/bridge'
import type { DesktopOnboardingState } from '@gugu/core/desktop'
import { applyServerTheme, useTheme, type ThemeFamily, type ThemePalette, type ThemePreference } from '@/composables/core/useTheme'
import ProjectsPage from '../projects/index.vue'
import WorkbenchPage from '../workbench/index.vue'
import ContactsPage from '../contacts/index.vue'
import ComingSoon from '../shared/components/ComingSoon.vue'
import { useDesktopContacts } from '../contacts/composables/useDesktopContacts'
import { useDesktopCalendar } from '../calendar/composables/useDesktopCalendar'
import DesktopSidebar from './components/DesktopSidebar.vue'
import { useDesktopSidebar } from './composables/useDesktopSidebar'
import NewProjectModal from '@/views/Projects/components/NewProjectModal.vue'
import ProjectModal from '@/views/Projects/components/ProjectModal.vue'
import DesktopCalendar from '../calendar/index.vue'
import DesktopSchedules from '../schedules/index.vue'
import DesktopResources from '../resources/index.vue'
import AppToast from '@/components/common/feedback/AppToast.vue'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'

const projectStore = useProjectStore()
const route = useRoute()
const router = useRouter()
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

const busy = ref(false)
const error = ref('')
const connected = ref(false)
const sandbox = ref<SandboxStatus | null>(null)
const sandboxMessage = ref('')
const onboarding = ref<DesktopOnboardingState | null>(null)
const pendingOperation = ref('')
const contentArea = ref<HTMLElement | null>(null)
const activeSection = ref('home')
const { width: sidebarWidth, compact: sidebarCompact, restore: restoreSidebar, startResize: startSidebarResize, resize: resizeSidebar, finishResize: finishSidebarResize, handleResizeKeydown, minWidth: sidebarMinWidth, maxWidth: sidebarMaxWidth } = useDesktopSidebar()
const PENDING_OPERATION_KEY = 'gugu.desktop.pending-operation'
const contactsPanel = useDesktopContacts(perform, refresh)
const calendarPanel = useDesktopCalendar(perform, refresh)
const { clients, clientName, editingClient, editedClientName } = contactsPanel
const { calendar, calendarHistory } = calendarPanel

function navigateTo(section: string) {
  if (section === 'notes' || section === 'canvases') {
    void router.push(`/${section}`)
  }
  activeSection.value = section
  if (contentArea.value) contentArea.value.scrollTop = 0
}

function openCalendarProjectDialog(range: { start: string; end: string }) {
  uiStore.newProjectRange = range
  uiStore.openNewProject = true
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
  const [clientRows, events] = await Promise.all([desktopData.clients(), desktopData.calendar()])
  await contactsPanel.setRows(clientRows)
  await calendarPanel.setRows(events)
  connected.value = true
}

watch(() => route.path, path => {
  if (path === '/notes') activeSection.value = 'notes'
  else if (path === '/canvases') activeSection.value = 'canvases'
}, { immediate: true })

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

function checkSandbox() {
  return perform(async () => {
    sandboxMessage.value = '正在检测…'
    sandbox.value = await desktopData.sandboxStatus()
    sandboxMessage.value = sandbox.value.reason ?? (sandbox.value.supported ? '已检测到原生隔离能力' : '当前环境未提供原生隔离能力')
  })
}


onMounted(() => perform(async () => {
  restoreSidebar()
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
  <div class="desktop-shell" :style="{ '--desktop-sidebar-width': `${sidebarWidth}px` }">
    <DesktopSidebar
      :active-section="activeSection"
      :connected="connected"
      :compact="sidebarCompact"
      :width="sidebarWidth"
      :min-width="sidebarMinWidth"
      :max-width="sidebarMaxWidth"
      @navigate="navigateTo"
      @resize-start="startSidebarResize"
      @resize="resizeSidebar"
      @resize-finish="finishSidebarResize"
      @resize-keydown="handleResizeKeydown"
    />
    <header class="desktop-topbar">
      <div class="topbar-search"><span>⌕</span><span>搜索项目、日程与便签</span><kbd>⌘ K</kbd></div>
      <ActionButton v-if="activeSection === 'projects'" fit class="topbar-create-button" @click="uiStore.openNewProject = true"><Icon name="action.add" :size="14" />新建项目</ActionButton>
    </header>
    <main id="desktop-home" ref="contentArea" class="desktop-workbench">
    <p v-if="error" class="desktop-error" role="alert">{{ error }}</p>
    <WorkbenchPage
      v-if="activeSection === 'home'"
      :connected="connected"
      :busy="busy"
      :preference="themePreference"
      :family="themeFamily"
      :palette="palette"
      :theme-options="themeOptions"
      :family-options="familyOptions"
      :palette-options="paletteOptions"
      :onboarding="onboarding"
      :sandbox="sandbox"
      :sandbox-message="sandboxMessage"
      :pending-operation="pendingOperation"
      @theme="value => perform(async () => { await setTheme(value) })"
      @family="value => perform(async () => { await setFamily(value) })"
      @palette="value => perform(async () => { await setPalette(value) })"
      @refresh="perform(refresh)"
      @recover="perform(recoverPendingOperation)"
      @check-sandbox="checkSandbox"
    />
    <ProjectsPage v-if="activeSection === 'projects'" />
    <ContactsPage
      v-if="activeSection === 'contacts'"
      v-model:client-name="clientName"
      v-model:editing-client="editingClient"
      v-model:edited-client-name="editedClientName"
      :clients="clients"
      :busy="busy"
      @create="contactsPanel.create"
      @rename="contactsPanel.rename"
      @remove="contactsPanel.remove"
    />
    <section v-if="activeSection === 'calendar'" id="desktop-calendar" class="desktop-calendar-page" aria-label="日历">
      <DesktopCalendar :events="calendar" :busy="busy" @create="calendarPanel.create" @update="calendarPanel.update" @delete="calendarPanel.remove" @add-project="openCalendarProjectDialog" />
      <div class="calendar-history-actions"><ActionButton v-if="calendarHistory.undo" fit variant="secondary" :disabled="busy" @click="calendarPanel.applyHistoryAction('undo')">撤销</ActionButton><ActionButton v-if="calendarHistory.redo" fit variant="secondary" :disabled="busy" @click="calendarPanel.applyHistoryAction('redo')">重做</ActionButton></div>
    </section>
    <section v-if="activeSection === 'notes' || activeSection === 'canvases'" class="desktop-mind-page">
      <RouterView />
    </section>
    <DesktopSchedules v-if="activeSection === 'schedules'" />
    <DesktopResources v-if="activeSection === 'terminals' || activeSection === 'skills' || activeSection === 'mcp'" :section="activeSection" />
    <ComingSoon v-if="['files','customers','team','notifications'].includes(activeSection)" :section="activeSection" />
    </main>
    <NewProjectModal :show="uiStore.openNewProject" :init-status="uiStore.newProjectInitStatus" @close="uiStore.openNewProject = false; uiStore.newProjectInitStatus = null" />
    <ProjectModal :project="projectStore.modalProject" @close="projectStore.closeModal()" />
    <AppToast />
  </div>
</template>

<style scoped>
.desktop-shell { --desktop-topbar-height: 52px; position: relative; isolation: isolate; height: 100vh; width: 100vw; overflow: hidden; display: grid; grid-template-columns: var(--desktop-sidebar-width, 204px) minmax(0, 1fr); grid-template-rows: var(--desktop-topbar-height) minmax(0, 1fr); color: var(--text-primary); background: rgb(from var(--surface-card-solid) r g b / 50%); }
.desktop-topbar { position: relative; grid-column: 2; grid-row: 1; z-index: 3; display: flex; align-items: center; justify-content: flex-end; min-width: 0; margin: 0 var(--space-sm) 0 0; padding: 0; background: transparent; -webkit-app-region: drag; }.desktop-topbar::before { position: absolute; top: 0; right: 100%; bottom: 0; width: var(--desktop-sidebar-width, 204px); content: ''; -webkit-app-region: drag; pointer-events: none; }.topbar-search { position: absolute; z-index: 2; left: 50%; box-sizing: border-box; -webkit-app-region: no-drag; display: flex; align-items: center; gap: 10px; width: min(400px, 48%); height: 36px; padding: 7px 12px; border: 1px solid color-mix(in srgb, var(--content-divider) 70%, transparent); border-radius: 11px; color: var(--text-secondary); background: color-mix(in srgb, var(--surface-card-solid) 55%, transparent); font-size: 12px; transform: translateX(-50%); }.topbar-search > span:first-child { font-size: 17px; }.topbar-search kbd { margin-left: auto; font: inherit; opacity: .7; }.desktop-topbar :deep(.topbar-create-button) { -webkit-app-region: no-drag; flex: 0 0 auto; width: max-content; min-width: max-content; }
.desktop-workbench { position: relative; grid-column: 2; grid-row: 2; min-width: 0; min-height: 0; overflow: auto; margin: 0 var(--space-sm) var(--space-sm) 0; padding: var(--space-lg); border: 1px solid color-mix(in srgb, var(--content-divider) 75%, transparent); border-radius: 18px; background: rgb(from var(--surface-card-solid) r g b / 75%); box-shadow: 0 12px 34px rgba(34, 39, 52, .08); scroll-behavior: smooth; }
.desktop-workbench:has(.desktop-calendar-page) { display: flex; flex-direction: column; }
.desktop-workbench:has(.desktop-mind-page) { display: flex; overflow: hidden; padding: 0; }
.desktop-mind-page { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; padding: var(--space-lg); box-sizing: border-box; }
.desktop-mind-page :deep(.ntp-layout) { box-sizing: border-box; width: 100%; padding: 0; }
.desktop-calendar-page { position: relative; display: flex; flex: 1; flex-direction: column; gap: var(--space-md); min-width: 0; min-height: 0; }
.calendar-history-actions { position: absolute; right: var(--space-md); bottom: var(--space-md); z-index: 3; display: flex; gap: var(--space-xs); }
.desktop-error { padding: 12px 16px; background: var(--control-bg); border: 1px solid var(--status-danger); border-radius: 8px; }
@media (max-width: 760px) {
  .desktop-shell { grid-template-columns: 64px minmax(0,1fr); }
  .desktop-topbar { gap: 8px; margin-right: 8px; padding: 0; }
  .topbar-search { position: static; width: auto; height: 34px; flex: 1; min-width: 0; transform: none; padding: 6px 8px; }
  .desktop-topbar :deep(.topbar-create-button) { padding-right: 9px; padding-left: 9px; }
}
</style>
