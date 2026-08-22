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
import { ref } from 'vue'
import type { ChatMessage } from './chatTypes'

const props = defineProps<{ msg: ChatMessage }>()
const resolved = ref(Boolean(props.msg.interaction?.resolved))
const emit = defineEmits<{
  select: [msg: ChatMessage, option: { id: string; label: string; token: string }]
}>()
function selectOption(option: { id: string; label: string; token: string }) {
  if (resolved.value) return
  resolved.value = true
  emit('select', props.msg, option)
}
</script>

<style scoped>
.interaction-bubble { max-width: min(560px, 88%); margin: 7px 0 11px; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-card-solid); color: var(--content-primary); box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card); }
.interaction-title { color: var(--content-primary); font-size: var(--font-size-md); font-weight: 650; line-height: var(--line-height-ui); }
.interaction-body { margin-top: 5px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); white-space: pre-wrap; }
.interaction-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--border-subtle); }
.interaction-actions button { min-height: var(--control-height-sm); border: 1px solid var(--action-primary); border-radius: var(--control-radius); padding: 5px 12px; background: var(--action-primary-bg); color: var(--content-on-accent); font-size: var(--font-size-sm); cursor: pointer; transition: background var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), transform var(--motion-hover-control) var(--motion-ease-emphasis); }
.interaction-actions button:hover:not(:disabled) { background: var(--action-primary-bg-hover); border-color: var(--action-primary-hover); transform: translateY(-1px); }
.interaction-actions button:focus-visible { outline: none; box-shadow: var(--control-focus-shadow); }
.interaction-actions button:disabled { opacity: .55; cursor: default; }
.interaction-resolved { margin-top: 8px; color: var(--content-tertiary); font-size: var(--font-size-xs); }
</style>
