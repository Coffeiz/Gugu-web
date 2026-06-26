<template>
  <div class="layout">
    <AppSidebar />
    <main class="layout-main">
      <!-- 顶栏 -->
      <header class="topbar glass-card">
        <div class="topbar-title">
          <h1>{{ currentTitle }}</h1>
          <p>{{ todayStr }}</p>
        </div>
        <GlobalSearch />
        <div class="topbar-actions">
          <a-button class="btn-ghost-custom" @click="openUpload"><PhUploadSimple :size="13" weight="bold" style="vertical-align:-1px;margin-right:5px" />上传文件</a-button>
          <a-button type="primary" class="btn-primary-custom" @click="openNewProject"><PhPlus :size="13" weight="bold" style="vertical-align:-1px;margin-right:5px" />新建项目</a-button>
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

<script setup>
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
import GuguChat from '@/components/common/GuguChat.vue'
import { PhPlus, PhUploadSimple } from '@phosphor-icons/vue'
import GlobalSearch from '@/components/common/GlobalSearch.vue'
import NewProjectModal from '@/views/Projects/components/NewProjectModal.vue'
import ProjectModal    from '@/views/Projects/components/ProjectModal.vue'
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

function openUpload() {
  uploadDialogOpen.value = true
  projectsApi.list().then(ps => { uploadProjects.value = ps }).catch(() => {})
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
  }
  projectStore.fetchProjects()
  projectStore.fetchUpcomingCalEvents()
})

onBeforeUnmount(() => liveStore.disconnect())

const currentTitle = computed(() => route.meta.title || '总览')

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
  z-index: 5; /* 低于顶栏(10)，高于内容 */
}

.topbar {
  position: absolute;
  top: 20px;
  left: 20px;
  right: 24px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  /* 顶栏绝对定位 + backdrop-filter，其 backdrop 取自下方的 .page-content。Chrome/macOS 下，
     页面内容（日历日期格、总览项目卡等）hover 改背景触发重绘时，顶栏的 backdrop-filter 栅格
     会失效，在其下沿渲染出一条白色伪影带（Safari 无此问题）。translateZ(0) 把顶栏提升为独立
     GPU 合成层，稳定 backdrop-filter 的栅格，消除该白带。 */
  transform: translateZ(0);
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

.btn-ghost-custom {
  background: rgba(255, 255, 255, 0.52) !important;
  border: 1px solid rgba(255, 255, 255, 0.78) !important;
  border-radius: var(--radius-sm) !important;
  color: var(--text-secondary) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95) !important;
  font-size: 13px; font-weight: 500;
  transition: transform 0.3s cubic-bezier(0.34, 1.2, 0.64, 1),
              background 0.2s ease-out, box-shadow 0.2s ease-out !important;
}
.btn-ghost-custom:hover {
  transform: translateY(-2px);
  background: rgba(255,255,255,0.72) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 4px 12px rgba(80,90,110,0.1) !important;
}

.btn-primary-custom {
  background: linear-gradient(135deg, #7b7fb2, #9590c4) !important;
  border: none !important;
  border-radius: var(--radius-sm) !important;
  box-shadow: 0 3px 12px rgba(123,127,178,0.3) !important;
  font-size: 13px; font-weight: 500;
  transition: transform 0.3s cubic-bezier(0.34, 1.2, 0.64, 1),
              box-shadow 0.2s ease-out, opacity 0.2s ease-out !important;
}
.btn-primary-custom:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(123,127,178,0.4) !important;
  opacity: 0.92;
}

.page-content {
  height: 100%;
  overflow-y: scroll;
  scrollbar-gutter: stable;
  padding: 128px 34px 24px 30px;
  box-sizing: border-box;
}
</style>
