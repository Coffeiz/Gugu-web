import { selectionDraftEvent, type SelectionDraft } from '@/components/common/selection/selectionDraft'
import { installMailLinks, openMailComposer, openMailDraftKey } from '@/api/mailLinks'
import { installOverlayScrollbars } from '@/utils/overlayScrollbars'
import { pathFileAccessKey } from '@/services/pathFileAccess'
import { desktopPathFileAccess } from '@desktop/files/pathFileAccess'
import { scheduleAccessKey } from '@/services/scheduleAccess'
import { chatCalendarEventsKey, chatCitationSiteKey } from '@/components/common/gugu-chat/chatPresentationAccess'
import { desktopScheduleAccess } from './schedules/access'
import { projectAccessKey } from '@/api/projects'
import { desktopProjectAccess } from './projects/access'
import { mindAccessKey } from '@/services/mindAccess'
import { desktopMindAccess } from './mind/access'
import { desktopData, hasDesktopFileDrag, nativeDesktopBridge, requestDesktopFile, startDesktopFileDrag } from './bridge/bridge'
import { searchAccessKey } from '@/services/searchAccess'
import { desktopSearchAccess } from './search/access'
import { localPreferencesAccessKey } from '@/services/localPreferencesAccess'
import { desktopPreferencesAccess } from './account/preferencesAccess'
import { localPtyAccessKey } from '@/views/Terminals/localPtyAccess'
import { createDesktopPtyTransport } from './terminals/ptyTransport'
import { mailAccessKey } from '@/api/mail'
import { desktopMailAccess } from './mail/access'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ArcoVue from '@arco-design/web-vue'
import '@arco-design/web-vue/dist/arco.css'
import '@/assets/styles/global.css'
import { projectWindowBridge, projectWindowResult } from './projects/projectWindowBridge'
import { openPlatformPreview, previewWindowBridge } from './files/previewWindowBridge'
import { desktopMcpApi, desktopSkillsApi, readDesktopCitationSite } from './resources/transport'
import { mcpAccessKey, skillAccessKey } from '@/services/resourceAccess'
import { canOpenDesktopFile, getDesktopFileOpenPreference, openDesktopFile } from './files/fileOpen'
import { useProjectStore } from '@/stores/projects'
import { locateConversationMessageKey, openProjectReferenceKey } from '@/composables/mind/useMindRefActions'
import { requestDesktopAgentSessions } from './shell/agent-session-transport'
import { fileOpenAccessKey } from '@/services/fileOpenAccess'
import { openPlatformPreviewKey } from '@/stores/preview'
import { i18n } from '@/i18n'
import { setupInteractionRuntime } from '@/interaction/runtime/setup'
import { initializeDesktopTheme } from '@/composables/core/useTheme'
import { chatFabHost } from './chat-fab/bridge'
import { installEnterDirective } from '@/directives/enter'

initializeDesktopTheme()
setupInteractionRuntime()
const query = new URLSearchParams(location.search)
const nativeChatPanel = chatFabHost && query.get('chatFabPanel') === '1'
const nativePreview = previewWindowBridge && query.get('filePreview') === '1'
const projectId = Number(query.get('projectWindow'))
const nativeProject = projectWindowBridge && Number.isSafeInteger(projectId) && projectId > 0

export async function mountDesktop() {
  if (import.meta.env.DEV && /^\/design\/?$/.test(location.pathname)) {
    const [{ default: DesignPage }, { default: ConfirmDialog }, { default: AppToast }] = await Promise.all([
      import('@/views/Design/index.vue'),
      import('@/components/common/overlays/ConfirmDialog.vue'),
      import('@/components/common/feedback/AppToast.vue'),
    ])
    const app = createApp({ render: () => [h(DesignPage), h(ConfirmDialog, { teleportTo: 'body' }), h(AppToast)] })
    installEnterDirective(app)
    app.use(createPinia()).use(i18n).use(ArcoVue).mount('#app')
    installOverlayScrollbars()
    return
  }
  if (nativeChatPanel) document.documentElement.dataset.desktopChatPanel = 'true'
  const app = nativeChatPanel
    ? createApp((await import('./shell/components/DesktopGuguChat.vue')).default, { standalone: true })
    : nativePreview
    ? createApp((await import('./files/DesktopPreviewWindow.vue')).default)
    : nativeProject
    ? createApp((await import('./projects/ProjectWindow.vue')).default, { projectId })
    : createApp((await import('./shell/index.vue')).default)

  const pinia = createPinia()
  app.provide(openProjectReferenceKey, async id => {
    if (projectWindowBridge) {
      await projectWindowResult(projectWindowBridge.open(id))
      return true
    }
    return useProjectStore(pinia).loadModalProject(id)
  })
  app.provide(locateConversationMessageKey, messageId => requestDesktopAgentSessions({ action: 'messageLocation', messageId }))
  app.provide(pathFileAccessKey, desktopPathFileAccess)
  app.provide(scheduleAccessKey, desktopScheduleAccess)
  app.provide(chatCalendarEventsKey, desktopData.calendar)
  app.provide(chatCitationSiteKey, readDesktopCitationSite)
  app.provide(projectAccessKey, desktopProjectAccess)
  app.provide(mindAccessKey, desktopMindAccess)
  app.provide(searchAccessKey, desktopSearchAccess)
  app.provide(mailAccessKey, desktopMailAccess)
  if (nativeChatPanel) app.provide(openMailDraftKey, draft => {
    void chatFabHost.openMainReference('mail-draft', JSON.stringify(draft))
  })
  app.provide(localPreferencesAccessKey, desktopPreferencesAccess)
  if ('guguDesktop' in window) app.provide(localPtyAccessKey, createDesktopPtyTransport)
  app.provide(openPlatformPreviewKey, openPlatformPreview)
  app.provide(fileOpenAccessKey, {
    canOpenInSystem: canOpenDesktopFile, openInSystem: openDesktopFile, getOpenPreference: getDesktopFileOpenPreference,
    canBatchDownload: false,
    revealLocalEntry: nativeDesktopBridge() ? (directoryId, path) => requestDesktopFile({ action: 'reveal', directoryId, path }) : undefined,
    startNativeDrag: hasDesktopFileDrag() ? startDesktopFileDrag : undefined,
    createDroppedReference: nativeDesktopBridge()?.createDroppedFileReference ? desktopData.createDroppedFileReference : undefined,
    openDroppedReference: desktopData.openDroppedFileReference,
  })
  app.provide(skillAccessKey, { api: desktopSkillsApi, configureWithChat: false })
  app.provide(mcpAccessKey, {
    api: desktopMcpApi, httpOnly: true, configureWithChat: false, refreshMissingStatuses: false,
  })
  installEnterDirective(app)
  if (chatFabHost && !nativeChatPanel) window.addEventListener(selectionDraftEvent, event => {
    event.stopImmediatePropagation()
    const { reference, ...selection } = (event as CustomEvent<SelectionDraft>).detail
    chatFabHost.dropReferences([reference], selection)
  }, true)
  const router = createDesktopRouter()
  app.use(pinia).use(i18n).use(ArcoVue).use(router).mount('#app')
  if (nativeChatPanel) installMailLinks(to => chatFabHost.openMainReference('mail', to))
  else if (!nativePreview && !nativeProject) installMailLinks(to => openMailComposer(router, to))
  installOverlayScrollbars()
}

function createDesktopRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      // 普通页面由桌面壳层渲染；笔记和画布在路由提交前解析异步组件。
      { path: '/', name: 'home', components: {} },
      ...(import.meta.env.DEV ? [{ path: '/dev', name: 'dev-workbench', components: {} }] : []),
      ...['projects', 'calendar', 'schedules', 'files', 'terminals', 'skills', 'mcp', 'mail', 'contacts', 'team']
        .map(section => ({ path: `/${section}`, name: section, components: {} })),
      { path: '/notes', name: 'notes', component: () => import('@/views/Mind/NotesThreePaneView.vue') },
      { path: '/canvases', name: 'canvases', component: () => import('@/views/Mind/CanvasView.vue') },
      { path: '/mind/notes', redirect: to => ({ path: '/notes', query: to.query, hash: to.hash }) },
      { path: '/mind/canvases', redirect: to => ({ path: '/canvases', query: to.query, hash: to.hash }) },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
  })
}
