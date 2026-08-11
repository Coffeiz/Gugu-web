<template>
  <div class="sched-page">
    <div class="panel glass-card">
      <div class="section-header">
        <button class="btn-primary press-fx" @click="openCreate">
          <PhAlarm :size="14" weight="bold" style="vertical-align:-1px;margin-right:5px" />新建任务
        </button>
      </div>
      <div v-if="!loading && !tasks.length" class="empty">还没有自定义任务，点上方「新建任务」试试～</div>
      <div v-else-if="tasks.length" class="task-grid">
        <ScheduleCard v-for="task in tasks" :key="task.id" :task="task" :busy="busy"
          @toggle="toggle" @run="runNow" @edit="openEdit" @remove="remove" />
      </div>
    </div>

    <ScheduleFormModal :show="showModal" :task="editing" :im-channels="imChannels" :busy="busy"
      :external-error="formErr" @close="showModal = false" @save="submit" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PhAlarm } from '@phosphor-icons/vue'
import { errorMessage } from '@/composables/useAppToast'
import { fireHint } from '@/composables/useOnboarding'
import { useAuthStore } from '@/stores/auth'
import ScheduleCard from './components/ScheduleCard.vue'
import ScheduleFormModal from './components/ScheduleFormModal.vue'
import { useScheduledTasks } from './composables/useScheduledTasks'

const authStore = useAuthStore()
const imChannels = computed(() => authStore.user?.imChannels ?? [])
const { tasks, loading, busy, load, save, toggle, runNow, remove } = useScheduledTasks()
const showModal = ref(false)
const editing = ref<any | null>(null)
const formErr = ref('')

onMounted(() => { fireHint('schedules'); void load() })

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
    formErr.value = error instanceof Error ? error.message : `保存失败：${errorMessage(error)}`
  }
}
</script>

<style scoped>
.sched-page { height: 100%; font-family: var(--font-sans); }
.btn-primary {
  padding: 8px 16px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: rgba(255,255,255,0.95);
  font-size: 13px; font-weight: 500; cursor: pointer; font-family: var(--font-sans);
  display: inline-flex; align-items: center;
  box-shadow: 0 3px 12px rgba(123,127,178,0.3);
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.2s ease-out, opacity 0.2s ease-out;
}
.btn-primary:hover { opacity: 0.92; }
.btn-primary:disabled { opacity: 0.5; cursor: default; transform: none; }
.panel {
  --glass-bg: rgba(255,255,255,0.25);
  --glass-bg-hover: rgba(255,255,255,0.25);
  height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column;
  padding: 22px 24px;
}
.section-header { display: flex; align-items: center; justify-content: flex-start; margin-bottom: 16px; flex-shrink: 0; }
.empty { font-size: 13px; color: var(--text-secondary); padding: 8px 2px; }
.task-grid {
  flex: 1; min-height: 0; overflow-y: auto; align-content: start;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(264px, 1fr)); gap: 12px;
  margin: 0 -8px; padding: 10px 8px 16px;
}
</style>
