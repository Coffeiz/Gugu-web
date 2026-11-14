<template>
  <div class="pm-message-format-settings">
    <div v-for="scope in scopes" :key="scope.key" class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t(scope.labelKey) }}</span><span class="pm-field-hint">{{ t(scope.hintKey) }}</span></div>
      <div class="pm-style-group pm-tool-options"><button v-for="option in options" :key="option.key" type="button" class="pm-style-chip" :class="{ active: format(scope.key) === option.key }" @click="setFormat(scope.key, option.key)">{{ t(option.labelKey) }}</button></div>
    </div>
    <div class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.qqPrivateStreaming') }}</span><span class="pm-field-hint">{{ t(markdownPrivateFormat ? 'profileImUi.qqPrivateStreamingHint' : 'profileImUi.qqPrivateStreamingMarkdownRequiredHint') }}</span></div>
      <span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="streamingEnabled" :disabled="!markdownPrivateFormat" :aria-label="t('profileImUi.qqPrivateStreaming')" @update:model-value="emit('streaming', $event)" /><span class="pm-switch-label" :class="{ on: streamingEnabled }">{{ streamingEnabled ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'

interface MessageFormatBot { id: number; group_message_format?: string; private_message_format?: string; private_streaming_enabled?: boolean }
const props = defineProps<{ bot: MessageFormatBot }>()
const emit = defineEmits<{ change: [scope: 'group' | 'private', mode: string]; streaming: [enabled: boolean] }>()
const { t } = useI18n()
const markdownPrivateFormat = computed(() => format('private') === 'markdown')
const streamingEnabled = computed(() => markdownPrivateFormat.value && props.bot.private_streaming_enabled === true)
const scopes = [
  { key: 'group', labelKey: 'profileImUi.groupMessageFormat', hintKey: 'profileImUi.groupMessageFormatHint' },
  { key: 'private', labelKey: 'profileImUi.privateMessageFormat', hintKey: 'profileImUi.privateMessageFormatHint' },
] as const
const options = [
  { key: 'compat', labelKey: 'profileImUi.compatFormat' },
  { key: 'markdown', labelKey: 'profileImUi.markdownFormat' },
] as const
function format(scope: 'group' | 'private'): string {
  const value = scope === 'group' ? props.bot.group_message_format : props.bot.private_message_format
  if (scope === 'group') return value === 'markdown' ? 'markdown' : 'compat'
  return value === 'compat' ? 'compat' : 'markdown'
}
function setFormat(scope: 'group' | 'private', mode: string) {
  emit('change', scope, mode)
}
</script>
