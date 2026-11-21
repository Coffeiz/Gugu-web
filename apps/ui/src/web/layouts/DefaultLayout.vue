<template>
  <div class="layout">
    <AppSidebar />
    <main class="layout-main" :class="{ 'full-bleed': fullBleed, 'canvas-workspace': isCanvasWorkspace }">
      <!-- 全幅页面自行管理头部，见路由 meta。 -->
      <header v-if="!fullBleed" class="topbar glass-card" :class="{ 'locale-ja': locale === 'ja-JP' }">
        <div class="topbar-title">
          <h1>{{ currentTitle }}</h1>
          <p>{{ todayStr }}</p>
        </div>
        <GlobalSearch />
        <div class="topbar-actions">
          <ActionButton variant="secondary" class="topbar-upload-button" @click="openUpload"><Icon name="action.upload" :size="13" />{{ t('common.actions.upload') }}</ActionButton>
          <ActionButton class="topbar-create-button" @click="openNewProject"><Icon name="action.add" :size="14" />{{ t('common.actions.createProject') }}</ActionButton>
        </div>
      </header>

      <!-- 页面内容 -->
      <div class="page-content">
        <WorkspaceRouteSkeleton v-if="skeletonRoute" :route-name="String(skeletonRoute.name ?? '')" />
        <div v-show="!skeletonRoute" class="route-page-host"><router-view /></div>
      </div>
    </main>

    <!-- AI 悬浮球 -->
    <GuguChat
      :greeting-access="chatGreetingAccess"
      :http-stream="chatHttpStream"
      :session-access="webChatSessionAccess"
      :cancel-session="cancelWebChatSession"
      :respond-to-interaction="respondToHttpInteraction"
      :read-interaction-session="agentApi.getInteractionSession"
      :read-quota="authApi.getQuota"
      :track-chat-event="trackChatEvent"
      :track-message-sent="trackMessageSent"
      :read-ui-labels="agentApi.getUiLabels"
      :im-access="chatImAccess"
    />

    <!-- 通知气泡 -->
    <NotificationBubble />

    <!-- 新建项目 Modal -->
    <NewProjectModal
      :show="uiStore.openNewProject"
      :initStatus="uiStore.newProjectInitStatus"
      @close="uiStore.openNewProject = false; uiStore.newProjectInitStatus = null"
    />

    <!-- 全局项目编辑 Modal -->
    <ProjectModal
      :project="projectStore.modalProject"
      @close="projectStore.closeModal()"
    />

    <!-- 全局活动编辑 Modal（笔记页的活动引用卡片点开） -->
    <EventEditModal />

    <!-- 上传文件 Modal（顶栏按钮触发） -->
    <UploadModal
      :show="uploadDialogOpen"
      :projects="uploadProjects"
      :workspace-target="uploadWorkspaceTarget"
      @close="uploadDialogOpen = false"
      @uploaded="onGlobalUploaded"
      @workspace-changed="uploadSignal++"
    />

    <!-- 文件预览 Modal（PDF / 文本 / 音频） -->
    <FilePreviewModal :show="!!previewStore.singleFile" :file="previewStore.singleFile" @close="previewStore.close" />

    <!-- 个人资料 Modal -->
    <ProfileModal :show="uiStore.openProfile" :initial-nav="uiStore.profileInitialNav || 'info'" @close="uiStore.openProfile = false; uiStore.profileInitialNav = null" />

    <!-- 首次配置引导：状态由 onboarding composable 管理，布局只负责挂载。 -->
    <OnboardingModal :show="shouldShowOnboarding" />

    <!-- 浮动预览窗口（图片 / 视频，可多开） -->
    <Teleport to="body">
      <FloatPreviewWindow
        v-for="win in previewStore.windows"
        :key="win.id"
        :win="win"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, provide } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { runOnboarding, shouldShowOnboarding } from '@/composables/onboarding/useOnboarding'
import { useUiStore } from '@/stores/ui'
import { useProjectStore } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { useLiveStore } from '@/stores/live'
import { useProjectAccess } from '@/api/projects'
import { uploadSignal } from '@/services/cache'
import WorkspaceRouteSkeleton from '@/components/common/feedback/skeleton/WorkspaceRouteSkeleton.vue'
import { useRouteSkeleton } from '@/composables/core/useRouteSkeleton'
import AppSidebar from '@/components/common/layout/AppSidebar.vue'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { chatModelCatalogKey } from '@/components/common/gugu-chat/chatPresentationAccess'
import { cancelWebChatSession, webChatSessionAccess } from '@web/chat/sessionAccess'
import { createWebChatModelCatalog } from '@web/chat/modelCatalog'
import { respondToHttpInteraction } from '@/components/common/gugu-chat/chatInteractionAccess'
import { chatHttpStream } from '@/components/common/gugu-chat/chatHttpStream'
import GuguChat from '@/components/common/gugu-chat/GuguChat.vue'
import { getGreeting, prefetchGreeting } from '@/composables/shared/useGreeting'
import { authApi } from '@/api/auth'
import { agentApi, trackApi, userBotsApi, telegramConnectApi, feishuConnectApi, qqConnectApi, wechatConnectApi } from '@/services/api'
import type { ChatImAccess } from '@/components/common/gugu-chat/composables/useChatImConnect'
import GlobalSearch from '@/components/common/layout/GlobalSearch.vue'
import NewProjectModal from '@/views/Projects/components/NewProjectModal.vue'
import ProjectModal    from '@/views/Projects/components/ProjectModal.vue'
import EventEditModal  from '@/components/events/EventEditModal.vue'
import UploadModal from '@/views/Files/UploadModal.vue'
import FilePreviewModal    from '@/components/common/file-browser/FilePreviewModal.vue'
import ProfileModal        from '@/components/common/profile/ProfileModal.vue'
import OnboardingModal     from '@/components/onboarding/OnboardingModal.vue'
import FloatPreviewWindow    from '@/components/common/layout/FloatPreviewWindow.vue'
import NotificationBubble   from '@/components/common/feedback/NotificationBubble.vue'
import { usePreviewStore, isAudioExt } from '@/stores/preview'
import { useAudioStore } from '@/stores/audio'
import { usePreferencesStore } from '@/stores/preferences'
import { useI18n } from 'vue-i18n'
import { formatDate } from '@/utils/formatters'

const chatGreetingAccess = { prefetch: prefetchGreeting, read: getGreeting }

const chatImAccess: ChatImAccess = {
  listBots: userBotsApi.list,
  connectTelegram: telegramConnectApi.connect,
  qr: { feishu: feishuConnectApi, qq: qqConnectApi, wechat: wechatConnectApi },
}

function trackMessageSent(turn: number) {
  void trackApi.track('chat_message', { turn }).catch(() => {})
}

function trackChatEvent(event: 'chat_open' | 'chat_expanded') {
  void trackApi.track(event).catch(() => {})
}

const previewStore = usePreviewStore()
const audioStore   = useAudioStore()

// 音频文件不走预览框，直接交给迷你播放器
watch(() => previewStore.file, (f) => {
  if (f && isAudioExt(f.ext)) {
    audioStore.play(f, previewStore.singleSiblings)
    previewStore.close()
  }
})

const skeletonRoute = useRouteSkeleton()
const route          = useRoute()
const router         = useRouter()
const uiStore        = useUiStore()
const projectStore   = useProjectStore()
const authStore      = useAuthStore()
provide(chatModelCatalogKey, createWebChatModelCatalog(() => authStore.user?.id))
const liveStore      = useLiveStore()
const prefsStore     = usePreferencesStore()
const { t, locale }  = useI18n()

const uploadDialogOpen = ref(false)
const projectsApi = useProjectAccess()
const uploadProjects   = ref([])
const uploadWorkspaceTarget = ref<typeof uiStore.workspaceUploadTarget>(null)

function openNewProject() {
  uiStore.newProjectRange = uiStore.calendarActiveRange ?? null
  uiStore.openNewProject = true
}

async function openUpload() {
  uploadWorkspaceTarget.value = route.path === '/files' ? uiStore.workspaceUploadTarget : null
  if (uploadWorkspaceTarget.value) {
    uploadDialogOpen.value = true
    return
  }
  // 弹窗内的项目分组会直接影响内容高度。先准备好数据再挂载，避免先按空列表打开、
  // 请求回包后再把整个窗口撑到最终尺寸。
  if (projectStore.projectsLoaded) {
    uploadProjects.value = projectStore.projects
  } else {
    try {
      uploadProjects.value = await projectsApi.list()
    } catch {
      uploadProjects.value = []
    }
  }
  uploadDialogOpen.value = true
}

function onGlobalUploaded() {
  uploadDialogOpen.value = false
  uploadSignal.value++
}

onMounted(async () => {
  // 受保护页面的路由守卫已经读取过当前用户；避免布局重复请求阻塞首页数据加载。
  if (!authStore.user) await authStore.fetchMe()
  if (authStore.isLoggedIn) {
    audioStore.restore()
    prefsStore.fetch()
    uiStore.fetchNotifications()   // 拉持久通知（含离线漏掉的）：关浏览器重开还在
    uiStore.checkLoginBubble()     // 上线补弹最近一条有效气泡（只一次、过期不弹）
    liveStore.connect()   // 开实时事件订阅：咕咕/IM 改了数据网页自动刷新
    runOnboarding(router)          // 读取播种项目 ID，供新建项目表单排除
    // 对话框默认问候的生成不在这儿无条件触发——只有「全新对话（无可恢复会话）」才需要，
    // 由 GuguChat onMounted 据 SESSION_KEY 决定（刷新停在老会话时不空跑生成）。
  }
  projectStore.fetchProjects()
  projectStore.fetchUpcomingCalEvents()
})

onBeforeUnmount(() => liveStore.disconnect())

const visibleRoute = computed(() => skeletonRoute.value ?? route)
const currentTitle = computed(() => visibleRoute.value.meta.title ? t(String(visibleRoute.value.meta.title)) : t('navigation.defaultTitle'))
const fullBleed = computed(() => !!visibleRoute.value.meta.fullBleed)
const isCanvasWorkspace = computed(() => visibleRoute.value.path.startsWith('/canvases'))

const todayStr = computed(() => {
  // 中文日期格式默认会把日期和星期连在一起，增加一个可见间隔。
  return formatDate(new Date(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    .replace(/日(?=星期)/, '日 ')
})
</script>

<style scoped>
.layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.layout-main {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.topbar {
  position: absolute;
  top: var(--web-workspace-top-inset);
  left: 20px;
  right: 24px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  background: var(--glass-card-background);
  overflow: visible;  /* 按钮外发阴影不能被顶栏裁掉 */
}
/* 顶栏玻璃宿主保持静态，内部按钮自行提供 hover 反馈。 */

.topbar-title h1 {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}
.topbar-title p {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.search-box {
  flex: 1;
  max-width: 320px;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.52);
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: var(--radius-xs);
  padding: 8px 12px;
  cursor: text;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 顶栏搜索框和操作按钮共享同一个中号控件高度，避免 Arco 默认尺寸让按钮比搜索框短。 */
.topbar-actions .arco-btn {
  box-sizing: border-box;
  height: var(--control-height-md);
  min-height: var(--control-height-md);
  padding-top: 0;
  padding-bottom: 0;
  line-height: var(--control-height-md);
}
.topbar-actions .btn-content {
  display: inline-flex;
  align-items: center;
  height: 100%;
  line-height: var(--line-height-ui);
}
.topbar-actions .topbar-create-button {
  width: 100px;
  min-width: 100px;
  flex-basis: 100px;
  height: var(--control-height-md);
  min-height: var(--control-height-md);
}
.topbar-actions .topbar-upload-button {
  --action-secondary-bg: var(--surface-raised);
  --action-secondary-bg-hover: var(--surface-raised);
  width: 100px;
  min-width: 100px;
  flex-basis: 100px;
  height: var(--control-height-md);
  min-height: var(--control-height-md);
}
html[data-theme='dark'] .topbar-actions .topbar-upload-button {
  --action-secondary-border: color-mix(in srgb, var(--action-outline) 70%, transparent);
  --action-secondary-border-hover: color-mix(in srgb, var(--input-border-hover) 82%, transparent);
}
.topbar.locale-ja .topbar-upload-button {
  width: 120px;
  min-width: 120px;
  flex-basis: 120px;
}
.topbar.locale-ja .topbar-create-button {
  width: 120px;
  min-width: 120px;
  flex-basis: 120px;
}

.route-page-host { display: contents; }

.page-content {
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: auto;
  padding: 128px 34px 24px 30px;
  box-sizing: border-box;
}

/* 全幅页面自行管理顶部间距与滚动，隐藏顶栏时也去掉其渐变遮罩。 */
.layout-main.full-bleed::after { display: none; }
/* 全幅画布可以延伸到侧栏后方，外层布局仍限制在视口内。 */
.layout-main.full-bleed { overflow: visible; }
/* 工作台内容盒从导航栏右缘和视口顶端开始，由各工作台设置自己的内边距。 */
.layout-main.full-bleed .page-content {
  overflow: visible;
  padding: 0;
}

/* 画布视图自己是 position:fixed;inset:0（见 CanvasView.vue），不受 page-content padding
   约束、天然铺满整个浏览器（含侧栏背后那一段——无限画布的点阵/世界坐标不该在那儿截断，
   只是被侧栏更高的 z-index 盖住看不见）；画布自己浮层的 UI（切换面板/底部工具条）z-index
   与侧栏同属 UI 层，高于拖拽克隆，各自在定位里加了侧栏宽度的偏移量避免落进侧栏底下，不靠收窄画布整体范围解决，
   见 CanvasSidebar.vue / CanvasToolbar.vue。 */
</style>
