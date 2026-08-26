<template>
  <div class="interaction-bubble">
    <div class="interaction-title">{{ msg.interaction?.title || '需要确认' }}</div>
    <div class="interaction-body">{{ msg.interaction?.body }}</div>
    <div class="interaction-actions">
      <button v-for="option in (msg.interaction?.options || [])" :key="option.id" type="button"
              :disabled="resolved" @click="selectOption(option)">
        {{ option.label }}
      </button>
    </div>
    <div v-if="resolved" class="interaction-resolved">已提交</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ChatMessage } from './chatTypes'

const props = defineProps<{ msg: ChatMessage }>()
const resolved = ref(Boolean(props.msg.interaction?.resolved))
const emit = defineEmits<{
  select: [msg: ChatMessage, option: { id: string; label: string; token: string }]
}>()
function selectOption(option: { id: string; label: string; token: string }) {
  if (resolved.value) return
  emit('select', props.msg, option)
}
watch(() => props.msg.interaction?.resolved, (value) => {
  resolved.value = Boolean(value)
})
</script>

<style scoped>
.interaction-bubble { width: min(360px, 88%); box-sizing: border-box; margin: 0; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-card-solid); color: var(--content-primary); box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card); }
.interaction-title { color: var(--content-primary); font-size: var(--font-size-md); font-weight: 650; line-height: var(--line-height-ui); }
.interaction-body { margin-top: 5px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); white-space: pre-wrap; }
.interaction-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--border-subtle); }
.interaction-actions button { min-height: var(--control-height-sm); border: 1px solid var(--action-primary); border-radius: var(--control-radius); padding: 5px 12px; background: var(--action-primary-bg); color: var(--content-on-accent); font-size: var(--font-size-sm); cursor: pointer; transform: translateY(0); transition: var(--card-motion), background var(--motion-hover-card) var(--motion-ease-standard); }
.interaction-actions button:hover:not(:disabled) { background: var(--action-primary-bg-hover); border-color: var(--action-primary-hover); box-shadow: none; transform: none; }
.interaction-actions button:focus-visible { outline: none; box-shadow: var(--control-focus-shadow); }
.interaction-actions button:disabled { opacity: .55; cursor: default; }
.interaction-resolved { margin-top: 8px; color: var(--content-tertiary); font-size: var(--font-size-xs); }
</style>
