<template>
  <div class="pm-message-format-settings">
    <div v-for="scope in scopes" :key="scope.key" class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t(scope.labelKey) }}</span><span class="pm-field-hint">{{ t(scope.hintKey) }}</span></div>
      <div class="pm-style-group pm-tool-options"><button v-for="option in options" :key="option.key" type="button" class="pm-style-chip" :class="{ active: format(scope.key) === option.key }" @click="setFormat(scope.key, option.key)">{{ t(option.labelKey) }}</button></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

interface MessageFormatBot { id: number; group_message_format?: string; private_message_format?: string }
const props = defineProps<{ bot: MessageFormatBot }>()
const emit = defineEmits<{ change: [scope: 'group' | 'private', mode: string] }>()
const { t } = useI18n()
const scopes = [
  { key: 'group', labelKey: 'profileImUi.groupMessageFormat', hintKey: 'profileImUi.groupMessageFormatHint' },
  { key: 'private', labelKey: 'profileImUi.privateMessageFormat', hintKey: 'profileImUi.privateMessageFormatHint' },
] as const
const options = [
  { key: 'compat', labelKey: 'profileImUi.compatFormat' },
  { key: 'smart', labelKey: 'profileImUi.smartFormat' },
  { key: 'markdown', labelKey: 'profileImUi.forceMarkdown' },
] as const
function format(scope: 'group' | 'private'): string { return scope === 'group' ? (props.bot.group_message_format ?? 'compat') : (props.bot.private_message_format ?? 'smart') }
function setFormat(scope: 'group' | 'private', mode: string) { emit('change', scope, mode) }
</script>
