<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import FilePreviewModal from '@/components/common/file-browser/FilePreviewModal.vue'
import FloatPreviewWindow from '@/components/common/layout/FloatPreviewWindow.vue'
import { usePreviewStore } from '@/stores/preview'
import DesktopProjectFiles from '@/views/Projects/components/DesktopProjectFiles.vue'
import ProjectModal from '@/views/Projects/components/ProjectModal.vue'
import AppToast from '@/components/common/feedback/AppToast.vue'
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
import { useProjectStore } from '@/stores/projects'
import { desktopData } from '@desktop/bridge/bridge'
import { showAppError } from '@/composables/core/useAppToast'
import { applyThemePalette } from '@/composables/core/useTheme'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'
import { projectWindowBridge, projectWindowResult } from './projectWindowBridge'

const props = defineProps({ projectId: { type: Number, required: true } })
const previewStore = usePreviewStore()
const projectStore = useProjectStore()
provideRuntime(runtime)
const loading = ref(true)
const closing = ref(false)
const error = ref('')
let stopPrepareClose: (() => void) | undefined
let stopUpdates: (() => void) | undefined

async function close() {
  if (closing.value || !projectWindowBridge) return
  closing.value = true
  try {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    await projectStore.flushProjectUpdates(props.projectId)
    if (projectStore.modalProject && projectStore.error) {
      showAppError(projectStore.error)
      projectStore.error = null
      return
    }
    await projectWindowResult(projectWindowBridge.close())
  } catch (cause) {
    showAppError(cause instanceof Error ? cause.message : '关闭项目窗口失败')
  } finally {
    closing.value = false
  }
}

onMounted(async () => {
  stopPrepareClose = projectWindowBridge?.onPrepareClose(() => { void close() })
  stopUpdates = projectWindowBridge?.onUpdated?.(project => {
    if (project.id !== props.projectId) return
    projectStore.acceptDesktopProject(project, true)
    if (!loading.value && project.archived && !projectStore.modalProject) error.value = '项目已归档'
  })
  try {
    const [opened] = await Promise.all([
      projectStore.loadModalProject(props.projectId),
      desktopData.appearance().then(appearance => applyThemePalette(appearance.palette)),
    ])
    if (!opened) error.value = '项目不存在或已归档'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '项目加载失败'
  } finally {
    loading.value = false
  }
})
onUnmounted(() => {
  stopPrepareClose?.()
  stopUpdates?.()
})
</script>

<template>
  <main class="desktop-project-window">
    <DesktopProjectFiles v-if="loading || error" shell native-window @close="close">
      <p v-if="loading" role="status">正在加载项目…</p>
      <p v-else role="alert">{{ error }}</p>
    </DesktopProjectFiles>
    <ProjectModal v-else :project="projectStore.modalProject" native-window @close="close" />
    <FilePreviewModal :show="!!previewStore.singleFile" :file="previewStore.singleFile" @close="previewStore.close" />
    <FloatPreviewWindow v-for="win in previewStore.windows" :key="win.id" :win="win" />
    <AppToast />
    <ConfirmDialog />
  </main>
</template>

<style scoped>
.desktop-project-window {
  position: relative;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-primary);
}
</style>
