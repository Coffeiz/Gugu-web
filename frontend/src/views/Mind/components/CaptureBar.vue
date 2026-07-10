<template>
  <!-- 底部停靠捕捉条：收起=单行占位；聚焦展开=编辑器+工具栏从条内长出来（不弹浮层）。
       浮在滚动的便签流之上：玻璃可以用，但内部交互元素克制（hover 只做 opacity/淡背景，
       不做 box-shadow 过渡——白带红线）；本组件自身/祖先不挂 opacity 动画（隔离组红线）。 -->
  <div class="capture-bar" :class="{ expanded }">
    <template v-if="!expanded">
      <button class="cb-collapsed" @click="expand">
        <PhPencilSimple :size="13" weight="bold" class="cb-pencil" />
        <span class="cb-placeholder">{{ md.trim() ? plainPreview : '记点什么…' }}</span>
        <span class="cb-kbd">随手记</span>
      </button>
    </template>

    <template v-else>
      <NoteEditor
        ref="editorRef"
        v-model="md"
        placeholder="记点什么…（Cmd/Ctrl + Enter 记录）"
        compact
        autofocus
        @submit="save"
      />
      <div class="cb-foot">
        <!-- 补录：日期可以往回选，落进它「发生」的那天，而不是今天 -->
        <label class="cb-backfill" :class="{ on: backfill }">
          <input type="checkbox" v-model="backfill" />
          补录到
        </label>
        <DatePicker v-if="backfill" class="cb-date" v-model="date" placeholder="选择日期" />
        <button class="cb-min" title="收起（内容保留）" @click="collapse">
          <PhCaretDown :size="13" weight="bold" />
        </button>
        <button class="cb-save press-fx" :disabled="!canSave || saving" @click="save">
          {{ saving ? '记录中…' : '记录' }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { PhCaretDown, PhPencilSimple } from '@phosphor-icons/vue'
import DatePicker from '@/components/common/DatePicker.vue'
import NoteEditor from './NoteEditor.vue'

const emit = defineEmits<{ (e: 'created', md: string, capturedAt?: string): void }>()

const expanded = ref(false)
const md       = ref('')
const backfill = ref(false)
const date     = ref(new Date().toISOString().slice(0, 10))
const saving   = ref(false)
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)

const canSave = computed(() => md.value.trim().length > 0)
/** 收起时草稿没丢：单行里露一眼开头，提醒"这里还有没记完的" */
const plainPreview = computed(() =>
  md.value.replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1').replace(/^#+\s*|-\s\[[ xX]\]\s?|-\s+/gm, '').split('\n')[0].slice(0, 40))

function expand() { expanded.value = true }
function collapse() { expanded.value = false }   // 草稿保留在 md 里，下次展开接着写

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    // 补录给当天正午的时间戳：只关心落在哪一天，不用纠结时分
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
.capture-bar {
  border-radius: 14px;
  background: rgba(255,255,255,0.66);
  backdrop-filter: var(--popup-blur); -webkit-backdrop-filter: var(--popup-blur);
  border: 1px solid rgba(255,255,255,0.78);
  box-shadow: 0 8px 28px rgba(30,40,80,0.14), inset 0 1px 0 rgba(255,255,255,0.9);
}
.capture-bar.expanded { padding: 8px 14px 10px; }

.cb-collapsed {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 12px 16px; border: none; border-radius: inherit;
  background: none; cursor: text; text-align: left;
  font-family: var(--font-sans);
}
.cb-pencil { flex-shrink: 0; color: var(--color-primary); opacity: 0.75; }
.cb-placeholder {
  flex: 1; min-width: 0; font-size: 13px; color: var(--text-secondary); opacity: 0.75;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cb-kbd {
  flex-shrink: 0; font-size: 10px; color: var(--text-secondary); opacity: 0.55;
  padding: 2px 7px; border-radius: 5px; border: 1px solid rgba(0,0,0,0.08);
}

.cb-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; padding-top: 8px;
  border-top: 1px solid rgba(0,0,0,0.05);
}
.cb-backfill {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: 12px; color: var(--text-secondary);
  cursor: pointer; user-select: none; white-space: nowrap;
}
.cb-backfill.on { color: var(--color-primary); }
.cb-date { width: 150px; }

.cb-min {
  margin-left: auto; flex-shrink: 0; display: inline-flex; padding: 5px;
  border: none; border-radius: 6px; background: none;
  color: var(--text-secondary); cursor: pointer;
}
.cb-min:hover { background: rgba(0,0,0,0.05); }

.cb-save {
  flex-shrink: 0;
  padding: 6px 16px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: rgba(255,255,255,0.95);
  font-size: 12.5px; font-weight: 600; cursor: pointer;
  font-family: var(--font-sans);
}
.cb-save:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
