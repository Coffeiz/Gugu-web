<template>
  <div class="composer glass-card">
    <NoteEditor
      ref="editorRef"
      v-model="md"
      placeholder="记点什么…（Cmd/Ctrl + Enter 保存）"
      compact
      @submit="save"
    />
    <div class="composer-foot">
      <!-- 补录：日期可以往回选，落进它「发生」的那天，而不是今天 -->
      <label class="backfill" :class="{ on: backfill }">
        <input type="checkbox" v-model="backfill" />
        补录到
      </label>
      <DatePicker v-if="backfill" class="backfill-date" v-model="date" placeholder="选择日期" />
      <button class="composer-save press-fx" :disabled="!canSave || saving" @click="save">
        {{ saving ? '记录中…' : '记录' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import DatePicker from '@/components/common/DatePicker.vue'
import NoteEditor from './NoteEditor.vue'

const emit = defineEmits<{ (e: 'created', md: string, capturedAt?: string): void }>()

const md       = ref('')
const backfill = ref(false)
const date     = ref(new Date().toISOString().slice(0, 10))
const saving   = ref(false)
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)

const canSave = computed(() => md.value.trim().length > 0)

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    // 补录时给一个当天正午的时间戳：只关心落在哪一天，不用纠结时分
    const capturedAt = backfill.value ? `${date.value}T12:00:00` : undefined
    emit('created', md.value, capturedAt)
    md.value = ''
    editorRef.value?.clear()
    backfill.value = false
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.composer { padding: 10px 14px 10px; }

.composer-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; padding-top: 8px;
  border-top: 1px solid rgba(0,0,0,0.05);
}
.backfill {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: 12px; color: var(--text-secondary);
  cursor: pointer; user-select: none; white-space: nowrap;
}
.backfill.on { color: var(--color-primary); }
.backfill-date { width: 150px; }

.composer-save {
  margin-left: auto; flex-shrink: 0;
  padding: 6px 16px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: rgba(255,255,255,0.95);
  font-size: 12.5px; font-weight: 600; cursor: pointer;
  font-family: var(--font-sans);
}
.composer-save:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
