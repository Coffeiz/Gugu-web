<template>
  <BaseModal :show="show" width="480px" @close="$emit('close')">
    <div class="ap-modal">
      <div class="ap-header">
        <span class="ap-title">已归档项目</span>
        <button class="ap-close" @click="$emit('close')">
          <PhX :size="14" weight="bold" />
        </button>
      </div>

      <div class="ap-body">
        <div v-if="projectStore.archivedLoading" class="ap-empty">加载中…</div>
        <div v-else-if="!projectStore.archivedProjects.length" class="ap-empty">暂无已归档项目</div>
        <div v-else class="ap-list">
          <div v-for="p in projectStore.archivedProjects" :key="p.id" class="ap-row">
            <span class="ap-dot" :style="{ background: p.color }"></span>
            <div class="ap-info">
              <div class="ap-name">{{ p.name }}</div>
              <div class="ap-sub">{{ p.client || '无客户' }} · {{ statusLabel(p.status) }}</div>
            </div>
            <button class="ap-restore" :disabled="restoringId === p.id" @click="restore(p.id)">
              {{ restoringId === p.id ? '恢复中…' : '取消归档' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { PhX } from '@phosphor-icons/vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useProjectStore } from '@/stores/projects'

defineProps({ show: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const projectStore = useProjectStore()
const restoringId = ref<number | null>(null)

const STATUS_LABELS: Record<string, string> = { pending: '待开始', active: '进行中', done: '已完成' }
function statusLabel(status: string) { return STATUS_LABELS[status] ?? status }

async function restore(id: number) {
  restoringId.value = id
  try {
    await projectStore.unarchiveProject(id)
  } finally {
    restoringId.value = null
  }
}
</script>

<style scoped>
.ap-modal { display: flex; flex-direction: column; max-height: 70vh; }
.ap-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px; border-bottom: 1px solid rgba(0,0,0,0.06); flex-shrink: 0;
}
.ap-title { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.ap-close {
  width: 26px; height: 26px; border-radius: 8px; border: none; background: none;
  color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s;
}
.ap-close:hover { background: rgba(0,0,0,0.08); }

.ap-body { padding: 10px 12px 16px; overflow-y: auto; }
.ap-empty {
  padding: 32px 0; text-align: center; color: var(--text-secondary); font-size: 13px;
}
.ap-list { display: flex; flex-direction: column; gap: 4px; }
.ap-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 10px; transition: background 0.12s;
}
.ap-row:hover { background: rgba(255,255,255,0.55); }
.ap-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.ap-info { flex: 1; min-width: 0; }
.ap-name {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ap-sub { font-size: 11px; color: var(--text-secondary); margin-top: 1px; }
.ap-restore {
  flex-shrink: 0; font-size: 12px; font-weight: 600; padding: 5px 10px;
  border-radius: 8px; border: 1px solid rgba(123,127,178,0.35);
  background: rgba(123,127,178,0.08); color: var(--color-primary, #7b7fb2);
  cursor: pointer; transition: background 0.15s;
}
.ap-restore:hover:not(:disabled) { background: rgba(123,127,178,0.18); }
.ap-restore:disabled { opacity: 0.6; cursor: default; }
</style>
