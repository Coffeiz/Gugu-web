<script setup lang="ts">
import OnboardingModal from '@/components/onboarding/OnboardingModal.vue'
import { configureOnboardingGuideSave, onboardingGuideState, setOnboardingGuideState, shouldShowOnboarding } from '@/composables/onboarding/useOnboardingGuide'
import DesktopAgentModel from '../account/DesktopAgentModel.vue'
import ImConnectPane from '@/im/connect/ImConnectPane.vue'
import { desktopImSettingsAdapter } from '../im/connect/adapter'
import { provideMailInboxStatus } from '@/views/Mail/useMailInboxStatus'
import DesktopBackdropDefinitions from '../shared/components/DesktopBackdropDefinitions.vue'
import { syncDesktopFileOpenPreference } from '../files/fileOpen'
import DesktopFiles from '../files/index.vue'
import FilePreviewModal from '@/components/common/file-browser/FilePreviewModal.vue'
import MailPage from '@/views/Mail/index.vue'
import FloatPreviewWindow from '@/components/common/layout/FloatPreviewWindow.vue'
import { usePreviewStore } from '@/stores/preview'
import type { ApplicationMenuBridge, ApplicationMenuCommand } from '@gugu/desktop-contracts'
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isNavigationFailure, NavigationFailureType, RouterView, useRoute, useRouter } from 'vue-router'
import { desktopData, DesktopBridgeError, hasDesktopTelegramGateway, requestDesktopTelegram } from '@desktop/bridge/bridge'
import { useDesktopMindHistory } from '../mind/useDesktopMindHistory'
import { undoShortcutMode } from '@/interaction/undo/UndoManager'
import { desktopSkillsApi } from '../resources/transport'
import { notifyResourceChanged } from '@/services/resourceRefreshEvents'
import { setUserTimezone } from '@/utils/userTimezone'
import { usePreferencesStore } from '@/stores/preferences'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import ProjectsPage from '../projects/index.vue'
import ContactsPage from '../contacts/index.vue'
import DesktopPersonalSettings from '../account/DesktopPersonalSettings.vue'
import WorkspaceRouteSkeleton from '@/components/common/feedback/skeleton/WorkspaceRouteSkeleton.vue'
import { useRouteSkeleton } from '@/composables/core/useRouteSkeleton'
import ComingSoon from '../shared/components/ComingSoon.vue'
import { useDesktopContacts } from '../contacts/composables/useDesktopContacts'
import { calendarSignal } from '@/services/cache'
import { useDesktopCalendar } from '../calendar/composables/useDesktopCalendar'
import DesktopSidebar from './components/DesktopSidebar.vue'
import DesktopGuguChat from './components/DesktopGuguChat.vue'
import { useDesktopSidebar } from './composables/useDesktopSidebar'
import NewProjectModal from '@/views/Projects/components/NewProjectModal.vue'
import { projectWindowBridge, projectWindowResult } from '../projects/projectWindowBridge'
import ProjectModal from '@/views/Projects/components/ProjectModal.vue'
import GlobalSearch from '@/components/common/layout/GlobalSearch.vue'
import DesktopCalendar from '../calendar/index.vue'
import DesktopSchedules from '@/views/Schedules/index.vue'
import DesktopSkills from '@/views/Skills/index.vue'
import DesktopMcp from '@/views/Mcp/index.vue'
import DesktopResources from '../resources/index.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import AppToast from '@/components/common/feedback/AppToast.vue'
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'

const DevWorkbench = import.meta.env.DEV ? defineAsyncComponent(() => import('../workbench/index.vue')) : null
const DevWorkbenchButton = import.meta.env.DEV ? defineAsyncComponent(() => import('../workbench/DevWorkbenchButton.vue')) : null

const projectStore = useProjectStore()
provideMailInboxStatus()
const preferences = usePreferencesStore()
const route = useRoute()
configureOnboardingGuideSave(patch => desktopData.onboarding(patch))
function closeOnboarding() {
  if (onboardingGuideState.value) setOnboardingGuideState({ ...onboardingGuideState.value, should_show: false })
}
const connectOnboardingTelegram = hasDesktopTelegramGateway() ? async (token: string) => {
  await requestDesktopTelegram({ action: 'save', input: { token } })
} : undefined

const skeletonRoute = useRouteSkeleton({ desktop: true })
const router = useRouter()
const uiStore = useUiStore()
provideRuntime(runtime)

const personalSettingsOpen = ref(false)
const personalSettingsMounted = ref(false)
const personalSettingsTab = ref<'info' | 'prefs'>('info')
function openPersonalSettings(tab: 'info' | 'prefs' = 'info') {
  personalSettingsTab.value = tab
  personalSettingsMounted.value = true
  personalSettingsOpen.value = true
}
const busy = ref(false)
const error = ref('')
const connected = ref(false)
const pendingOperation = ref('')
const contentArea = ref<HTMLElement | null>(null)
const previewStore = usePreviewStore()
const activeSection = computed(() => String(route.name ?? 'home'))
const pendingSkeleton = computed(() => skeletonRoute.value?.name === 'notes' ? 'MindNotes' : skeletonRoute.value?.name === 'canvases' ? 'MindCanvas' : undefined)
const visibleSection = computed(() => String(skeletonRoute.value?.name ?? activeSection.value))
const { width: sidebarWidth, compact: sidebarCompact, restore: restoreSidebar, startResize: startSidebarResize, resize: resizeSidebar, finishResize: finishSidebarResize, handleResizeKeydown, minWidth: sidebarMinWidth, maxWidth: sidebarMaxWidth } = useDesktopSidebar()
const PENDING_OPERATION_KEY = 'gugu.desktop.pending-operation'
const contactsPanel = useDesktopContacts(perform, refresh)
const calendarPanel = useDesktopCalendar(perform)
const { clients } = contactsPanel
const { calendar, calendarHistory, initialLoading: calendarInitialLoading } = calendarPanel

const applyMindHistory = useDesktopMindHistory()

function onHistoryShortcut(event: KeyboardEvent) {
  if (personalSettingsOpen.value || uiStore.openNewProject || projectStore.modalProject) return
  const mode = undoShortcutMode(event)
  if (!mode) return
  const section = activeSection.value
  if (section === 'calendar' && calendarHistory.value[mode]) {
    event.preventDefault()
    void calendarPanel.applyHistoryAction(mode)
  } else if (section === 'notes' || section === 'canvases') {
    event.preventDefault()
    void perform(() => applyMindHistory(mode))
  } else if (section === 'skills') {
    event.preventDefault()
    void desktopSkillsApi.applyFileHistory(mode).then(result => {
      if (result.changed) notifyResourceChanged('skills')
    }).catch(error => showAppError(errorMessage(error)))
  }
}

onMounted(() => window.addEventListener('keydown', onHistoryShortcut))
onUnmounted(() => window.removeEventListener('keydown', onHistoryShortcut))

async function navigateTo(section: string, query?: { object_id: string }) {
  try {
    const failure = await router.push({ name: section, query })
    if (isNavigationFailure(failure, NavigationFailureType.duplicated) && section === 'calendar' && connected.value) {
      void perform(calendarPanel.refresh)
    }
  } catch {
    showAppError('页面加载失败，请重试')
  }
}

const globalSearch = ref<InstanceType<typeof GlobalSearch> | null>(null)
const routedPage = ref<{ openNewDraft?: () => Promise<void> } | null>(null)
let menuNavigationRequested = false

async function runMenuCommand(command: ApplicationMenuCommand) {
  if (command === 'settings') {
    openPersonalSettings('prefs')
    return
  }
  if (command === 'search') {
    globalSearch.value?.focus()
    return
  }
  if (command === 'new-project') {
    uiStore.openNewProject = true
    return
  }
  const section = command === 'new-note' ? 'notes' : command
  menuNavigationRequested = true
  await navigateTo(section)
  if (command === 'new-note' && activeSection.value === 'notes') {
    await nextTick()
    await routedPage.value?.openNewDraft?.()
  }
}

let stopApplicationMenu: (() => void) | undefined
let menuWork = Promise.resolve()
onMounted(() => {
  const bridge = (window as Window & { guguApplicationMenu?: ApplicationMenuBridge }).guguApplicationMenu
  stopApplicationMenu = bridge?.onCommand(command => {
    menuWork = menuWork.then(() => runMenuCommand(command)).catch(() => showAppError('无法完成菜单操作，请重试'))
  })
})
onUnmounted(() => stopApplicationMenu?.())

function openCalendarProjectDialog(range: { start: string; end: string }) {
  uiStore.newProjectRange = range
  uiStore.openNewProject = true
}

function moveCalendarProject(id: number, range: { start: string; end: string }) {
  return perform(() => projectStore.updateProject(id, { startDate: range.start, deadline: range.end }))
}

function openCalendarNote(id: number) {
  void navigateTo('notes', { object_id: String(id) })
}

function recordPendingOperation(reason: unknown) {
  if (!(reason instanceof DesktopBridgeError) || reason.code !== 'unknown_result' || !reason.operationId) return
  pendingOperation.value = reason.operationId
  localStorage.setItem(PENDING_OPERATION_KEY, reason.operationId)
  error.value = `${reason.message}。操作标识 ${reason.operationId}，请先查询操作结果`
}

async function perform(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    recordPendingOperation(reason)
  }
  finally { busy.value = false }
}

async function refresh() {
  const [clientRows] = await Promise.all([desktopData.clients(), calendarPanel.refresh(), projectStore.fetchProjects()])
  await contactsPanel.setRows(clientRows)
  connected.value = true
}

watch(activeSection, section => {
  if (contentArea.value) contentArea.value.scrollTop = 0
  if (section === 'calendar' && connected.value) void perform(calendarPanel.refresh)
})

watch(calendarSignal, () => {
  if (!connected.value || activeSection.value !== 'calendar') return
  void calendarPanel.refresh().catch(() => showAppError('日历刷新失败，请重试'))
})

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

watch(() => projectStore.modalProject?.id, async id => {
  if (!id || !projectWindowBridge) return
  try {
    await projectWindowResult(projectWindowBridge.open(id))
  } catch (cause) {
    showAppError(cause instanceof Error ? cause.message : '无法打开独立项目窗口')
  } finally {
    if (projectStore.modalProject?.id === id) projectStore.closeModal()
  }
})
const stopProjectWindowRefresh = projectWindowBridge?.onClosed(() => { void projectStore.fetchProjects() })
const stopProjectUpdates = projectWindowBridge?.onUpdated?.(project => projectStore.acceptDesktopProject(project))
onUnmounted(() => {
  stopProjectWindowRefresh?.()
  stopProjectUpdates?.()
})

onMounted(() => perform(async () => {
  restoreSidebar()
  pendingOperation.value = localStorage.getItem(PENDING_OPERATION_KEY) ?? ''
  if (pendingOperation.value) await recoverPendingOperation()
  const appearance = await desktopData.appearance()
  await syncDesktopFileOpenPreference(appearance.fileOpenPreference).catch(error => showAppError(errorMessage(error)))
  await preferences.fetch(appearance)
  void desktopData.onboarding().then(state => setOnboardingGuideState(state.guide)).catch(error => showAppError(errorMessage(error)))
  setUserTimezone(appearance.timezone)
  if (route.name === 'home' && !menuNavigationRequested) {
    const defaultView = preferences.defaultView
    const section = defaultView === 'mind' ? 'notes' : defaultView
    await router.replace({ name: section !== 'home' && section !== 'dev-workbench' && router.hasRoute(section) ? section : 'projects' })
  }
  await refresh()
}))
</script>

<template>
  <div class="desktop-shell" :style="{ '--desktop-sidebar-width': `${sidebarWidth}px` }">
    <DesktopBackdropDefinitions />
    <div class="desktop-window-drag-region" aria-hidden="true"></div>
    <DesktopSidebar
      :active-section="visibleSection"
      :compact="sidebarCompact"
      :width="sidebarWidth"
      :min-width="sidebarMinWidth"
      :max-width="sidebarMaxWidth"
      @navigate="navigateTo"
      @open-settings="openPersonalSettings"
      @resize-start="startSidebarResize"
      @resize="resizeSidebar"
      @resize-finish="finishSidebarResize"
      @resize-keydown="handleResizeKeydown"
    />
    <header class="desktop-topbar">
      <DevWorkbenchButton
        v-if="DevWorkbenchButton"
        :active="activeSection === 'dev-workbench'"
        @open="navigateTo('dev-workbench')"
      />
      <GlobalSearch ref="globalSearch" desktop class="topbar-search" />
    </header>
    <main id="desktop-home" ref="contentArea" class="desktop-workbench" :class="{ 'is-canvas-workspace': visibleSection === 'canvases' }">
    <p v-if="error" class="desktop-error" role="alert">{{ error }}</p>
    <ActionButton v-if="pendingOperation" fit variant="secondary"
      :disabled="busy" @click="perform(recoverPendingOperation)">{{ $t('pageUi.checkPending') }}</ActionButton>
    <WorkspaceRouteSkeleton v-if="pendingSkeleton" desktop :route-name="pendingSkeleton" />
    <div v-show="!pendingSkeleton" class="desktop-route-host">
    <DevWorkbench
      v-if="DevWorkbench && activeSection === 'dev-workbench'"
      :connected="connected"
      :busy="busy"
      @open-appearance="openPersonalSettings('prefs')"
      @refresh="perform(refresh)"
    />
    <ProjectsPage v-if="activeSection === 'projects'" />
    <ContactsPage
      v-if="activeSection === 'contacts'"
      :clients="clients"
      :busy="busy"
      :save-contact="contactsPanel.save"
      @remove="contactsPanel.remove"
    />
    <section v-if="activeSection === 'calendar'" id="desktop-calendar" class="desktop-calendar-page" :aria-label="$t('pageUi.calendar')">
      <DesktopCalendar :events="calendar" :initial-loading="calendarInitialLoading" :busy="busy" :save-event="calendarPanel.save" :remove-event="calendarPanel.remove" @add-project="openCalendarProjectDialog" @open-note="openCalendarNote" @move-project="moveCalendarProject" />
    </section>
    <section v-if="activeSection === 'notes' || activeSection === 'canvases'" class="desktop-mind-page">
      <RouterView v-slot="{ Component }">
        <component :is="Component" ref="routedPage" />
      </RouterView>
    </section>
    <DesktopSchedules v-if="activeSection === 'schedules'" />
    <DesktopSkills v-if="activeSection === 'skills'" />
    <DesktopMcp v-if="activeSection === 'mcp'" />
    <MailPage v-if="activeSection === 'mail'" />
    <DesktopResources v-if="activeSection === 'terminals'" />
    <DesktopFiles v-if="activeSection === 'files'" />
    <ComingSoon v-if="['customers','team'].includes(activeSection)" :section="activeSection" />
    </div>
    </main>
    <DesktopPersonalSettings v-if="personalSettingsMounted" :show="personalSettingsOpen"
      :connected="connected" :initial-nav="personalSettingsTab" @close="personalSettingsOpen = false" :refresh-imported-data="() => perform(refresh)" />
    <NewProjectModal :show="uiStore.openNewProject" :init-status="uiStore.newProjectInitStatus" @close="uiStore.openNewProject = false; uiStore.newProjectInitStatus = null" @create-error="recordPendingOperation" />
    <ProjectModal v-if="!projectWindowBridge" :project="projectStore.modalProject" @close="projectStore.closeModal()" />
    <FilePreviewModal :show="!!previewStore.singleFile" :file="previewStore.singleFile" @close="previewStore.close" />
    <Teleport to="body">
      <FloatPreviewWindow v-for="win in previewStore.windows" :key="win.id" :win="win" />
    </Teleport>
    <DesktopGuguChat />
    <OnboardingModal v-if="shouldShowOnboarding" :show="true" @close="closeOnboarding">
      <template #model><DesktopAgentModel onboarding /></template>
      <template #im><ImConnectPane :desktop-im-adapter="desktopImSettingsAdapter" :connect-telegram="connectOnboardingTelegram" /></template>
    </OnboardingModal>
    <ConfirmDialog teleport-to="body" />
    <AppToast />
  </div>
</template>

<style scoped>
.desktop-shell { --desktop-topbar-height: 52px; --desktop-workspace-edge: var(--space-xs); --desktop-workspace-inset: var(--space-sm); position: relative; isolation: isolate; height: 100vh; width: 100vw; overflow: hidden; display: grid; grid-template-columns: var(--desktop-sidebar-width, 204px) minmax(0, 1fr); grid-template-rows: var(--desktop-topbar-height) minmax(0, 1fr); color: var(--text-primary); background: var(--desktop-l0-surface); }
.desktop-window-drag-region {
  position: absolute;
  inset: 0 0 auto;
  height: var(--desktop-topbar-height);
  app-region: drag;
  -webkit-app-region: drag;
}
.desktop-topbar {
  position: relative;
  grid-column: 2;
  grid-row: 1;
  z-index: 3;
  min-width: 0;
  margin-inline-end: var(--space-sm);
  pointer-events: none;
}
.topbar-search {
  position: absolute; top: 50%; left: calc(50% + (var(--space-sm) - var(--desktop-workspace-edge)) / 2);
  z-index: 2; width: min(400px, 48%); max-width: none; margin: 0;
  pointer-events: auto; app-region: no-drag; -webkit-app-region: no-drag; transform: translate(-50%, -50%);
}
.topbar-search :deep(.search-input) { height: 36px; min-height: 36px; }

.desktop-workbench {
  /* L2 的底色和边界独立于 Mono 材质和品牌配色，保留系统底层透出的空间。 */
  --desktop-workspace-surface: light-dark(#fafafa, var(--palette-page-mid));
  --desktop-workspace-border: light-dark(rgb(0 0 0 / 7%), rgb(255 255 255 / 7%));
  position: relative;
  grid-column: 2;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  margin: 0 var(--desktop-workspace-edge) var(--desktop-workspace-edge) 0;
  padding: var(--desktop-workspace-inset);
  border: 1px solid var(--desktop-workspace-border);
  border-radius: var(--radius-md);
  background: rgb(from var(--desktop-workspace-surface) r g b / 75%);
  box-shadow: 0 12px 34px rgb(0 0 0 / 8%);
  scroll-behavior: smooth;
}
.desktop-workbench:has(.desktop-calendar-page) { display: flex; flex-direction: column; }
.desktop-workbench:has(.desktop-mind-page) { display: flex; overflow: hidden; }
.desktop-workbench.is-canvas-workspace { padding: 0; }
.desktop-route-host { display: contents; }
.desktop-workbench :deep(.page-toolbar :is(button, .seg-control)) {
  box-sizing: border-box;
  height: var(--toolbar-compact-control-height);
}
.desktop-workbench :deep(.page-toolbar button) {
  min-height: var(--toolbar-compact-control-height);
  padding-block: 0;
}
.desktop-workbench :deep(.page-toolbar .app-action-button) {
  font-size: var(--font-size-sm);
}
.desktop-workbench :deep(.page-toolbar .nav-btn) {
  width: var(--toolbar-compact-control-height);
}
.desktop-workbench :deep(.page-toolbar .seg-control > button) {
  align-self: stretch;
  height: auto;
  min-height: 0;
}
.desktop-mind-page { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; box-sizing: border-box; }
.desktop-mind-page :deep(.ntp-layout) { box-sizing: border-box; width: 100%; padding: 0; }
.desktop-calendar-page { position: relative; display: flex; flex: 1; flex-direction: column; gap: var(--space-md); min-width: 0; min-height: 0; }
.desktop-error { padding: var(--space-md) var(--space-lg); background: var(--control-bg); border: 1px solid var(--status-danger); border-radius: 8px; }
@media (max-width: 760px) {
  .desktop-shell { grid-template-columns: 64px minmax(0,1fr); }
  .desktop-topbar { display: flex; align-items: center; gap: var(--space-sm); margin-right: var(--space-sm); padding: 0; }
  .topbar-search { position: static; width: auto; flex: 1; min-width: 0; transform: none; }
}
</style>
