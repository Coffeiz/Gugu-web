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
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="6" cy="6" r="4"/><path d="M10 10l2.5 2.5"/>
          </svg>
          搜索项目、文件或客户…
        </div>
        <div class="topbar-actions">
          <a-button class="btn-ghost-custom" @click="openUpload">上传文件</a-button>
          <a-button type="primary" class="btn-primary-custom" @click="uiStore.openNewProject = true">
            ＋ 新建项目
          </a-button>
        </div>
      </header>

      <!-- 页面内容 -->
      <div class="page-content">
        <router-view />
      </div>
    </main>

    <!-- AI 悬浮球 -->
    <AiFloatBall />

    <!-- 新建项目 Modal -->
    <NewProjectModal
      :show="uiStore.openNewProject"
      @close="uiStore.openNewProject = false"
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { useProjectStore } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { projectsApi } from '@/services/api'
import { uploadSignal } from '@/services/cache'
import AppSidebar from '@/components/common/AppSidebar.vue'
import AiFloatBall from '@/components/common/AiFloatBall.vue'
import NewProjectModal from '@/views/Projects/components/NewProjectModal.vue'
import ProjectModal    from '@/views/Projects/components/ProjectModal.vue'
import UploadModal from '@/views/Files/UploadModal.vue'

const route        = useRoute()
const uiStore      = useUiStore()
const projectStore = useProjectStore()
const authStore    = useAuthStore()

const uploadDialogOpen = ref(false)
const uploadProjects   = ref([])

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
  projectStore.fetchProjects()
  projectStore.fetchUpcomingCalEvents()
})

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
  font-size: 13px;
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
  font-size: 13px;
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
