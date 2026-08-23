<template>
  <div class="layout">
    <AppSidebar />
    <main class="layout-main" :class="{ 'full-bleed': fullBleed, 'canvas-workspace': isCanvasWorkspace }">
      <!-- 顶栏（fullBleed 页隐藏：思维面板等「工作台」视图自己管头部，见 router meta） -->
      <header v-if="!fullBleed" class="topbar glass-card">
        <GlassBg />
        <div class="topbar-title">
          <h1>{{ currentTitle }}</h1>
          <p>{{ todayStr }}</p>
        </div>
        <GlobalSearch />
        <div class="topbar-actions">
          <a-button class="btn-ghost-custom press-fx" @click="openUpload"><Icon name="action.upload" :size="13" style="vertical-align:-1px;margin-right:5px" />上传文件</a-button>
          <a-button type="primary" class="btn-primary-custom press-fx" @click="openNewProject"><Icon name="action.add" :size="13" style="vertical-align:-1px;margin-right:5px" />新建项目</a-button>
        </div>
      </header>

      <!-- 页面内容 -->
      <div class="page-content">
        <router-view />
      </div>
    </main>

    <!-- AI 悬浮球 -->
    <GuguChat />

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
      @close="uploadDialogOpen = false"
      @uploaded="onGlobalUploaded"
    />

    <!-- 文件预览 Modal（PDF / 文本 / 音频） -->
    <FilePreviewModal :show="!!previewStore.singleFile" :file="previewStore.singleFile" @close="previewStore.close" />

    <!-- 个人资料 Modal -->
    <ProfileModal :show="uiStore.openProfile" @close="uiStore.openProfile = false" />

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
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { runOnboarding } from '@/composables/useOnboarding'
import { useUiStore } from '@/stores/ui'
import { useProjectStore } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { useLiveStore } from '@/stores/live'
import { projectsApi } from '@/services/api'
import { uploadSignal } from '@/services/cache'
import AppSidebar from '@/components/common/AppSidebar.vue'
import Icon from '@/components/common/Icon.vue'
import GuguChat from '@/components/common/GuguChat.vue'
import GlobalSearch from '@/components/common/GlobalSearch.vue'
import GlassBg from '@/components/common/GlassBg.vue'
import NewProjectModal from '@/views/Projects/components/NewProjectModal.vue'
import ProjectModal    from '@/views/Projects/components/ProjectModal.vue'
import EventEditModal  from '@/components/events/EventEditModal.vue'
import UploadModal from '@/views/Files/UploadModal.vue'
import FilePreviewModal    from '@/components/common/FilePreviewModal.vue'
import ProfileModal        from '@/components/common/ProfileModal.vue'
import FloatPreviewWindow    from '@/components/common/FloatPreviewWindow.vue'
import NotificationBubble   from '@/components/common/NotificationBubble.vue'
import { usePreviewStore, isAudioExt } from '@/stores/preview'
import { useAudioStore } from '@/stores/audio'
import { usePreferencesStore } from '@/stores/preferences'

const previewStore = usePreviewStore()
const audioStore   = useAudioStore()

// 音频文件不走预览框，直接交给迷你播放器
watch(() => previewStore.file, (f) => {
  if (f && isAudioExt(f.ext)) {
    audioStore.play(f)
    previewStore.close()
  }
})

const route          = useRoute()
const router         = useRouter()
const uiStore        = useUiStore()
const projectStore   = useProjectStore()
const authStore      = useAuthStore()
const liveStore      = useLiveStore()
const prefsStore     = usePreferencesStore()

const uploadDialogOpen = ref(false)
const uploadProjects   = ref([])

function openNewProject() {
  uiStore.newProjectRange = uiStore.calendarActiveRange ?? null
  uiStore.openNewProject = true
}

async function openUpload() {
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
  await authStore.fetchMe()
  if (authStore.isLoggedIn) {
    audioStore.restore()
    prefsStore.fetch()
    uiStore.fetchNotifications()   // 拉持久通知（含离线漏掉的）：关浏览器重开还在
    uiStore.checkLoginBubble()     // 上线补弹最近一条有效气泡（只一次、过期不弹）
    liveStore.connect()   // 开实时事件订阅：咕咕/IM 改了数据网页自动刷新
    runOnboarding(router)          // 新手引导：延迟弹欢迎/引导气泡 + 高亮引导项目（fire-and-forget）
    // 对话框默认问候的生成不在这儿无条件触发——只有「全新对话（无可恢复会话）」才需要，
    // 由 GuguChat onMounted 据 SESSION_KEY 决定（刷新停在老会话时不空跑生成）。
  }
  projectStore.fetchProjects()
  projectStore.fetchUpcomingCalEvents()
})

onBeforeUnmount(() => liveStore.disconnect())

const currentTitle = computed(() => route.meta.title || '总览')
const fullBleed    = computed(() => !!route.meta.fullBleed)
const isCanvasWorkspace = computed(() => route.path.startsWith('/mind/canvases'))

const todayStr = computed(() => {
  const d = new Date()
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 星期${weekdays[d.getDay()]}`
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

/* 顶部背景色渐变遮罩：让卡片顶部"溶"进背景，降低视觉重心 */
.layout-main::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100px;
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.08) 0%,
    rgba(0, 0, 0, 0.0) 100%
  );
  pointer-events: none;
  z-index: 5; /* 低于顶栏(40)，高于内容 */
}

.topbar {
  --gb-tint: var(--glass-bg);
  position: absolute;
  top: 20px;
  left: 20px;
  right: 24px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  /* 顶栏浮在会动的 page-content 之上，用 backdrop-filter 会闪白带（Chrome 边缘重栅格伪影，
     合成隔离无法根治，见排查记录）。改用 <GlassBg>：background-attachment:fixed 的页面背景副本 +
     普通 filter:blur 预模糊（静态、可缓存、跨引擎一致、无白带）。宿主自身透明、建层叠上下文让
     GlassBg(z-index:-1) 压在内容下；backdrop-filter 显式关掉。*/
  isolation: isolate;
  background: transparent;
  overflow: visible;  /* GlassBg 自己继承圆角裁切；宿主放开，按钮外发阴影才能露出来 */
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.topbar:hover {
  --gb-tint: var(--glass-bg-hover);
  background: transparent;
  box-shadow: var(--glass-shadow-lg);
}

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
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  cursor: text;
}

.topbar-actions {
  display: flex;
  gap: 8px;
}

/* 顶栏按钮不做悬停上浮；上传文件走次要按钮 token，新建项目走全局 press-fx 阴影。 */
.btn-ghost-custom {
  --topbar-btn-shadow: inset 0 1px 0 rgba(255,255,255,0.95);
  background: var(--action-secondary-bg) !important;
  border: 1px solid var(--action-secondary-border) !important;
  border-radius: var(--radius-sm) !important;
  color: var(--action-secondary-fg) !important;
  box-shadow: var(--topbar-btn-shadow) !important;
  font-size: 13px; font-weight: 500;
  transition: background 0.2s ease-out, box-shadow 0.2s ease-out,
              transform 0.15s ease, opacity 0.15s ease !important;
}
.topbar .btn-ghost-custom:hover {
  background: var(--action-secondary-bg-hover) !important;
  border-color: var(--action-secondary-border-hover) !important;
  color: var(--action-secondary-fg-hover) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 3px 10px rgba(80,90,110,0.12) !important;
}
.btn-ghost-custom:active { transform: translateY(1px) !important; opacity: 0.93; }

.btn-primary-custom {
  --topbar-btn-shadow: 0 3px 12px rgba(123,127,178,0.3);
  background: var(--action-primary-bg) !important;
  border: none !important;
  border-radius: var(--radius-sm) !important;
  box-shadow: var(--topbar-btn-shadow) !important;
  font-size: 13px; font-weight: 500;
  transition: box-shadow 0.2s ease-out, opacity 0.2s ease-out,
              transform 0.15s ease !important;
}
.btn-primary-custom:hover {
  background: var(--action-primary-bg-hover) !important;
  opacity: 0.92;
}
.btn-primary-custom:active { transform: translateY(1px) !important; opacity: 0.93; }

.page-content {
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: auto;
  padding: 128px 34px 24px 30px;
  box-sizing: border-box;
}

/* ── fullBleed（思维面板等工作台视图）──
   没有 topbar：顶部渐变遮罩（为"内容溶进 topbar"设计）一并去掉；padding-top 从 128px
   收到 18px；滚动交给页面自己管（笔记页要在内部做便签流滚动 + 底部停靠捕捉条）。 */
.layout-main.full-bleed::after { display: none; }
/* fullBleed 放开左裁：默认 layout-main overflow:hidden 会在侧栏右缘(x=侧栏宽)截断，
   笔记页横向列滚动区要钻到侧栏底下就不能被这里截。外层 .layout overflow:hidden 仍兜住
   视口边界，不会真溢出浏览器。 */
.layout-main.full-bleed { overflow: visible; }
/* 工作台的内容盒必须从导航栏右缘、视口顶端开始，不能再残留普通页面的内边距；否则笔记流
   要靠负 margin 抵左、右侧却没有对称补偿，最终各区域会落进不同坐标系。顶部胶囊等视觉
   留白由 Mind/index.vue 自己承担，画布固定层也不再受此处影响。 */
.layout-main.full-bleed .page-content {
  overflow: visible;
  padding: 0;
}

/* 画布视图自己是 position:fixed;inset:0（见 CanvasView.vue），不受 page-content padding
   约束、天然铺满整个浏览器（含侧栏背后那一段——无限画布的点阵/世界坐标不该在那儿截断，
   只是被侧栏更高的 z-index 盖住看不见）；画布自己浮层的 UI（切换面板/底部工具条）z-index
   与侧栏同属 UI 层，高于拖拽克隆，各自在定位里加了侧栏宽度的偏移量避免落进侧栏底下，不靠收窄画布整体范围解决，
   见 CanvasSidebar.vue / CanvasToolbar.vue。顶部"笔记/画布"胶囊的边距由 Mind/index.vue
   自己维护，和笔记页使用同一坐标系。 */
</style>
