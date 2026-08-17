<template>
  <div class="pm-message-format-settings">
    <div v-for="scope in scopes" :key="scope.key" class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ scope.label }}</span><span class="pm-field-hint">{{ scope.hint }}</span></div>
      <div class="pm-style-group pm-tool-options"><button v-for="option in options" :key="option.key" type="button" class="pm-style-chip" :class="{ active: format(scope.key) === option.key }" @click="setFormat(scope.key, option.key)">{{ option.label }}</button></div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface MessageFormatBot { id: number; group_message_format?: string; private_message_format?: string }
const props = defineProps<{ bot: MessageFormatBot }>()
const emit = defineEmits<{ change: [scope: 'group' | 'private', mode: string] }>()
const scopes = [
  { key: 'group', label: '群聊消息格式', hint: '兼容旧版 QQ；智能模式仅在需要时使用 Markdown' },
  { key: 'private', label: '私聊消息格式', hint: '私聊可保留 Markdown 排版' },
] as const
const options = [
  { key: 'compat', label: '兼容格式' },
  { key: 'smart', label: '智能格式' },
  { key: 'markdown', label: '强制 Markdown' },
] as const
function format(scope: 'group' | 'private'): string { return scope === 'group' ? (props.bot.group_message_format ?? 'compat') : (props.bot.private_message_format ?? 'smart') }
function setFormat(scope: 'group' | 'private', mode: string) { emit('change', scope, mode) }
</script>
