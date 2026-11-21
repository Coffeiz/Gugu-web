<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import { copyTextToClipboard } from '@/components/common/gugu-chat/composables/copyTextToClipboard'

const props = defineProps({
  binding: { type: Object as PropType<{ code: string; expiresIn: number }>, required: true },
  telegram: Boolean,
})
const emit = defineEmits<{ copyFailed: [] }>()
const { t } = useI18n()
const command = computed(() => props.telegram ? `/bind ${props.binding.code}` : props.binding.code)
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function reset() {
  clearTimeout(timer)
  copied.value = false
}
watch(command, reset)
onBeforeUnmount(reset)

async function copy() {
  const text = command.value
  if (!await copyTextToClipboard(text)) { emit('copyFailed'); return }
  if (command.value !== text) return
  reset()
  copied.value = true
  timer = setTimeout(reset, 1600)
}
</script>

<template>
  <div class="pm-binding-code-result">
    <span class="pm-binding-code-command" :title="t(telegram ? 'profileImUi.sendTelegramToBot' : 'profileImUi.sendToBot')">
      <code class="pm-binding-code-value">{{ command }}</code>
    </span>
    <span class="pm-binding-code-expiry">{{ t('profileImUi.codeExpiry', { seconds: binding.expiresIn }) }}</span>
    <button type="button" class="pm-binding-copy-btn" :class="{ copied }"
      :title="t(copied ? 'profileImUi.bindingCopied' : 'profileImUi.copyBinding')" @click="copy">
      <Icon :name="copied ? 'status.success' : 'action.copy'" :size="12" />
      <span>{{ t(copied ? 'profileImUi.copied' : 'profileImUi.copy') }}</span>
    </button>
  </div>
</template>

<style scoped>
.pm-binding-code-result {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px 3px 10px;
  border: 1px solid var(--input-border);
  border-radius: var(--radius-xs);
  background: var(--surface-raised);
}

.pm-binding-code-command {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}

.pm-binding-code-value {
  font-family: var(--font-family-mono);
  font-size: 15px;
  font-weight: 750;
  line-height: 1;
  letter-spacing: .12em;
  font-variant-numeric: tabular-nums;
  color: var(--content-primary);
}

.pm-binding-code-expiry {
  font-size: 11px;
  color: var(--content-tertiary);
  white-space: nowrap;
}

.pm-binding-copy-btn {
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid var(--control-border);
  border-radius: var(--radius-compact);
  background: var(--control-bg);
  color: var(--control-fg);
  font: 600 11px var(--font-sans);
  cursor: pointer;
  white-space: nowrap;
  transition:
    color var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard);
}

.pm-binding-copy-btn:hover {
  color: var(--control-fg-strong);
  background: var(--control-bg-hover);
  border-color: var(--control-border-hover);
}

.pm-binding-copy-btn.copied {
  color: var(--status-success);
  background: var(--status-success-bg);
  border-color: color-mix(in srgb,var(--status-success) 32%,transparent);
}
</style>
