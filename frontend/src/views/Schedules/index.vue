<template>
  <div class="sched-page">
    <div class="panel glass-card">
      <div class="section-header">
        <ActionButton fit @click="openCreate">
          <Icon name="admin.alarm" :size="14" />{{ t('schedules.create') }}
        </ActionButton>
      </div>
      <div v-if="!loading && !tasks.length" class="empty-state">
        <Icon name="admin.alarm" :size="32" />
        <strong>{{ t('schedules.emptyTitle') }}</strong>
        <span>{{ t('schedules.emptyHint') }}</span>
        <ActionButton fit @click="openCreate">{{ t('schedules.createFirst') }}</ActionButton>
      </div>
      <div v-else-if="tasks.length" class="task-grid scroll-surface scroll-surface--compact">
        <ScheduleCard v-for="task in tasks" :key="task.id" :task="task" :busy="busy"
          @toggle="toggle" @run="runNow" @edit="openEdit" @remove="remove" />
      </div>
    </div>

    <ScheduleFormModal :show="showModal" :task="editing" :im-channels="imChannels" :busy="busy"
      :workspaces="workspaces" :filesystem-authorization-enabled="filesystemAuthorizationEnabled"
      :external-error="formErr" @close="showModal = false" @save="submit" />
    <FilesystemAuthorizationDialog :show="authorizationOpen" :busy="authorizationBusy"
      :subject-name="authorizationSubjectName" @close="closeAuthorization" @confirm="confirmAuthorization" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { workspacesApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import ScheduleCard from './components/ScheduleCard.vue'
import ScheduleFormModal from './components/ScheduleFormModal.vue'
import FilesystemAuthorizationDialog from '@/components/common/filesystem/FilesystemAuthorizationDialog.vue'
import { useScheduledTasks } from '@/composables/schedules/useScheduledTasks'
import { useFilesystemAuthorization } from '@/composables/useFilesystemAuthorization'

const authStore = useAuthStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const imChannels = computed(() => authStore.user?.imChannels ?? [])
const { tasks, loading, busy, load, save, toggle, runNow, remove } = useScheduledTasks()
const workspaces = ref<Array<{ id: number; name: string }>>([])
const filesystemAuthorizationEnabled = ref(false)
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
  await load()
  const requestedId = Number(route.query.object_id)
  const task = tasks.value.find(item => Number(item.id) === requestedId)
  if (!task) return
  openEdit(task)
  // 用完即清：object_id 留在地址栏的话，关掉弹窗后一刷新又会弹出来。
  // replace 不产生历史记录；清空会触发上面的 watch，但 NaN 匹配不到任务，是安全的空操作。
  await router.replace({ query: { ...route.query, object_id: undefined } })
}
async function loadWorkspaces() {
  try {
    const result = await workspacesApi.status()
    workspaces.value = (result.items || [])
      .filter((item: any) => item?.enabled)
      .map((item: any) => ({ id: Number(item.id), name: String(item.name || '') }))
      .filter(item => Number.isFinite(item.id) && item.name)
    filesystemAuthorizationEnabled.value = result.filesystemAuthorizationEnabled === true
  } catch {
    workspaces.value = []
    filesystemAuthorizationEnabled.value = false
  }
}
onMounted(() => { void loadWorkspaces(); void openRequestedTask() })
watch(() => route.query.object_id, openRequestedTask)
window.addEventListener('gugu:open-object', openRequestedTask as EventListener)
onBeforeUnmount(() => window.removeEventListener('gugu:open-object', openRequestedTask as EventListener))

function openCreate() {
  editing.value = null
  formErr.value = ''
  showModal.value = true
}

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
.sched-page { height: 100%; font-family: var(--font-sans); }
.btn-primary {
  padding: 8px 16px; border: none; border-radius: var(--radius-sm);
  background: var(--action-primary-bg); color: var(--content-on-accent);
  font-size: 13px; font-weight: 500; cursor: pointer; font-family: var(--font-sans);
  display: inline-flex; align-items: center;
  box-shadow: var(--elevation-card);
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.2s ease-out, opacity 0.2s ease-out;
}
.btn-primary:hover { background: var(--action-primary-bg-hover); opacity: 0.92; }
.btn-primary:disabled { opacity: 0.5; cursor: default; transform: none; }
.panel {
  --glass-card-background: var(--column-bg);
  --glass-card-background-hover: var(--column-bg);
  height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column;
  padding: 22px 24px;
}
.section-header { display: flex; align-items: center; justify-content: flex-start; margin-bottom: 16px; flex-shrink: 0; }
.empty-state { min-height: 300px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--content-secondary); }
.empty-state strong { color:var(--content-primary); }
.empty-state span { font-size:12px; }
.task-grid {
  flex: 1; min-height: 0; overflow-y: auto; align-content: start;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(264px, 1fr)); gap: 12px; align-items: stretch;
  margin: 0 -8px; padding: 10px 8px 16px;
}
</style>
