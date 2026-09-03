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
      :external-error="formErr" @close="showModal = false" @save="submit" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { errorMessage } from '@/composables/core/useAppToast'
import { useAuthStore } from '@/stores/auth'
import ScheduleCard from './components/ScheduleCard.vue'
import ScheduleFormModal from './components/ScheduleFormModal.vue'
import { useScheduledTasks } from '@/composables/schedules/useScheduledTasks'

const authStore = useAuthStore()
const route = useRoute()
const { t } = useI18n()
const imChannels = computed(() => authStore.user?.imChannels ?? [])
const { tasks, loading, busy, load, save, toggle, runNow, remove } = useScheduledTasks()
const showModal = ref(false)
const editing = ref<any | null>(null)
const formErr = ref('')

// 从路由 query / 同页重复点击事件里取目标任务并打开编辑弹窗。
// 聊天卡片点击是 router.push：已在 /schedules 时组件不会重新挂载，query 相同时
// push 也是 no-op（此时 GuguChat 派发 gugu:open-object 事件），所以三种入口都要接。
async function openRequestedTask() {
  await load()
  const requestedId = Number(route.query.object_id)
  const task = tasks.value.find(item => Number(item.id) === requestedId)
  if (task) openEdit(task)
}
onMounted(openRequestedTask)
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
    await save(editing.value?.id ?? null, data)
    showModal.value = false
  } catch (error) {
    formErr.value = error instanceof Error ? error.message : t('schedules.saveFailed', { message: errorMessage(error) })
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
  display: grid; grid-template-columns: repeat(auto-fill, minmax(264px, 1fr)); gap: 12px;
  margin: 0 -8px; padding: 10px 8px 16px;
}
</style>
