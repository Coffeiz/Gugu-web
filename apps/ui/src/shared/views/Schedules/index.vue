<template>
  <div class="sched-page">
    <ScrollableCardLayout :action-label="t('schedules.create')" @action="openCreate">
      <template v-if="(loaded || !loading) && !tasks.length" #empty>
        <FirstUseEmptyState :title="t('schedules.emptyTitle')" :description="t('schedules.emptyHint')">
          <template #icon><Icon name="admin.alarm" :size="24" /></template>
          <ActionButton fit @click="desktop ? openCreate() : openChatSetup()">{{ t('schedules.createFirst') }}</ActionButton>
        </FirstUseEmptyState>
      </template>
      <SkeletonGate v-if="loading && !loaded && !tasks.length">
        <section v-for="group in taskGroups" :key="group.mode" class="task-group">
          <SkeletonBlock class="task-group-title" style="--skeleton-width: 76px" />
          <PageSkeleton collection="schedules" :count="1" />
        </section>
      </SkeletonGate>
      <template v-else-if="tasks.length">
        <section v-for="group in taskGroups" :key="group.mode" class="task-group"
          :aria-labelledby="`task-group-${group.mode}`">
          <h2 :id="`task-group-${group.mode}`" class="task-group-title">{{ t(group.label) }}</h2>
          <div v-if="group.tasks.length" class="task-grid card-collection--schedules">
            <ScheduleCard v-for="task in group.tasks" :key="task.id" :task="task" :busy="busy"
              @toggle="toggle" @run="runNow" @edit="openEdit" @remove="remove" />
          </div>
          <p v-else class="task-group-empty">{{ t('scheduleUi.emptyMode') }}</p>
        </section>
      </template>
    </ScrollableCardLayout>

    <ScheduleFormModal :desktop="desktop" :show="showModal" :task="editing" :im-channels="imChannels" :busy="busy"
      :workspaces="workspaces" :filesystem-authorization-enabled="filesystemAuthorizationEnabled"
      :workspace-supported="workspaceSupported"
      :external-error="formErr" @close="showModal = false" @save="submit" />
    <FilesystemAuthorizationDialog :show="authorizationOpen" :busy="authorizationBusy"
      :subject-name="authorizationSubjectName" @close="closeAuthorization" @confirm="confirmAuthorization" />
  </div>
</template>

<script setup lang="ts">
import SkeletonBlock from '@/components/common/feedback/skeleton/SkeletonBlock.vue'
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import { useScheduleAccess } from '@/services/scheduleAccess'
import PageSkeleton from '@/components/common/feedback/skeleton/PageSkeleton.vue'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FirstUseEmptyState from '@/components/common/layout/FirstUseEmptyState.vue'
import ScrollableCardLayout from '@/components/common/layout/ScrollableCardLayout.vue'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { workspacesApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import ScheduleCard from './components/ScheduleCard.vue'
import ScheduleFormModal from './components/ScheduleFormModal.vue'
import FilesystemAuthorizationDialog from '@/components/common/filesystem/FilesystemAuthorizationDialog.vue'
import { useScheduledTasks } from '@/composables/schedules/useScheduledTasks'
import { useFilesystemAuthorization } from '@/composables/useFilesystemAuthorization'

const desktop = useScheduleAccess()?.storesSchedulesLocally === true
const authStore = useAuthStore()
const uiStore = useUiStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const imChannels = computed(() => authStore.user?.imChannels ?? [])
const { tasks, loaded, loading, busy, load, save, toggle, runNow, remove } = useScheduledTasks()
const taskGroups = computed(() => [
  { mode: 'instruction', label: 'scheduleUi.instructionMode', tasks: tasks.value.filter(task => task.execution_mode !== 'reminder') },
  { mode: 'reminder', label: 'scheduleUi.reminderMode', tasks: tasks.value.filter(task => task.execution_mode === 'reminder') },
])
const workspaces = ref<Array<{ id: number; name: string }>>([])
const filesystemAuthorizationEnabled = ref(false)
const workspaceSupported = ref(false)
const showModal = ref(false)
const editing = ref<any | null>(null)
const formErr = ref('')
const {
  open: authorizationOpen,
  busy: authorizationBusy,
  subjectId: authorizationSubjectId,
  subjectName: authorizationSubjectName,
  request: requestFilesystemAuthorization,
  confirm: confirmFilesystemAuthorization,
  revoke: revokeFilesystemAuthorization,
  close: closeAuthorization,
} = useFilesystemAuthorization()

// 从路由 query / 同页重复点击事件里取目标任务并打开编辑弹窗。
// 聊天卡片点击是 router.push：已在 /schedules 时组件不会重新挂载，query 相同时
// push 也是 no-op（此时 GuguChat 派发 gugu:open-object 事件），所以三种入口都要接。
async function openRequestedTask() {
  const requestedValue = route.query.object_id
  if (typeof requestedValue !== 'string') return
  const requestedId = Number(requestedValue)
  try {
    if (!Number.isSafeInteger(requestedId) || requestedId <= 0) {
      showAppError(t('schedules.targetMissing'))
      return
    }
    await load()
    const task = tasks.value.find(item => Number(item.id) === requestedId)
    if (!task) showAppError(t('schedules.targetMissing'))
    else openEdit(task)
  } catch (error) {
    showAppError(errorMessage(error))
  } finally {
    // 用完即清：object_id 留在地址栏的话，关掉弹窗后一刷新又会弹出来。
    // replace 不产生历史记录；目标缺失或加载失败时也要清理，避免旧目标再次误开。
    if (route.query.object_id === requestedValue) {
      await router.replace({ query: { ...route.query, object_id: undefined } })
    }
  }
}
async function loadWorkspaces() {
  try {
    const result = await workspacesApi.status()
    workspaces.value = (result.items || [])
      .filter((item: any) => item?.enabled)
      .map((item: any) => ({ id: Number(item.id), name: String(item.name || '') }))
      .filter(item => Number.isFinite(item.id) && item.name)
    filesystemAuthorizationEnabled.value = result.filesystemAuthorizationEnabled === true
    workspaceSupported.value = result.workspaceSupported === true
  } catch {
    workspaces.value = []
    filesystemAuthorizationEnabled.value = false
    workspaceSupported.value = false
  }
}
onMounted(() => {
  if (!desktop) void loadWorkspaces()
  if (typeof route.query.object_id === 'string') void openRequestedTask()
  else void load().catch(error => showAppError(errorMessage(error)))
})
watch(() => route.query.object_id, value => { if (typeof value === 'string') void openRequestedTask() })
window.addEventListener('gugu:open-object', openRequestedTask as EventListener)
onBeforeUnmount(() => window.removeEventListener('gugu:open-object', openRequestedTask as EventListener))

function openCreate() {
  editing.value = null
  formErr.value = ''
  showModal.value = true
}

function openChatSetup() { uiStore.pendingChatPrefill = t('schedules.configureWithChat') }

function openEdit(task: Record<string, any>) {
  editing.value = task
  formErr.value = ''
  showModal.value = true
}

async function submit(data: Record<string, any>) {
  formErr.value = ''
  try {
    const requestedAuthorization = data.filesystem_authorized === true
    const wasAuthorized = editing.value?.filesystem_authorized === true
    const taskId = editing.value?.id ?? null
    const saveData = { ...data }
    delete saveData.filesystem_authorized
    const saved = await save(taskId, saveData)
    showModal.value = false
    if (requestedAuthorization && !wasAuthorized) {
      const savedTaskId = Number(saved?.id ?? taskId)
      if (!Number.isFinite(savedTaskId)) throw new Error('任务保存结果缺少任务 ID')
      await requestFilesystemAuthorization({ id: savedTaskId, name: String(saved?.name ?? data.name ?? '') })
    } else if (!requestedAuthorization && wasAuthorized && taskId != null) {
      await revokeFilesystemAuthorization(taskId)
      await load()
    }
  } catch (error) {
    formErr.value = error instanceof Error ? error.message : t('schedules.saveFailed', { message: errorMessage(error) })
    showAppError(formErr.value)
  }
}

async function confirmAuthorization() {
  if (authorizationSubjectId.value == null) return
  try {
    await confirmFilesystemAuthorization()
    await load()
    closeAuthorization()
  } catch (error) {
    formErr.value = t('schedules.filesystemAuthFailed', { message: errorMessage(error) })
    showAppError(formErr.value)
  }
}
</script>

<style scoped>
.sched-page { height: 100%; display: flex; flex-direction: column; font-family: var(--font-sans); }
.task-group + .task-group { margin-top:20px; padding-top:16px; border-top:1px solid var(--content-divider); }
.task-group-title { margin:0 0 12px; color:var(--text-primary); font-size:14px; font-weight:600; }
.task-group-empty { margin:0; padding:14px; border:1px dashed var(--content-outline); border-radius:var(--radius-sm); color:var(--text-secondary); font-size:12px; text-align:center; }
.task-grid {
  align-content: start;
  align-items: stretch;
}
</style>
