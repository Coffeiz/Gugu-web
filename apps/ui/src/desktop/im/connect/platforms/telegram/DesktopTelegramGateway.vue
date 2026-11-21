<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { i18n } from '@/i18n'
import { hasDesktopTelegramGateway, requestDesktopTelegram, type DesktopTelegramSnapshot } from '@desktop/bridge/bridge'
import ImBotCard from '@/im/connect/ImBotCard.vue'
import ImBindingRow from '@/im/connect/ImBindingRow.vue'
import GroupChatSettings from '@/im/connect/GroupChatSettings.vue'
import type { DesktopImGroupSettingsPatch } from '@/im/connect/desktopAdapter'

const props = defineProps<{ savedSnapshot?: DesktopTelegramSnapshot }>()
const emit = defineEmits<{ configured: [value: boolean] }>()

const { t, locale } = i18n.global
const available = hasDesktopTelegramGateway()
const snapshot = ref<DesktopTelegramSnapshot | null>(null)
const busy = ref(false)
const error = ref('')
const now = ref(Date.now())
const binding = computed(() => snapshot.value?.binding)
const enabledTools = computed(() => [
  ...(snapshot.value?.groupWebToolsEnabled ? ['web_tools' as const] : []),
  ...(snapshot.value?.groupProviderSearchEnabled ? ['web_search' as const] : []),
  ...(snapshot.value?.groupHistorySearchEnabled ? ['group_context_search' as const] : []),
])
const remaining = computed(() => Math.max(0, Math.ceil(((binding.value?.expiresAt ?? 0) - now.value) / 1000)))
let timer: ReturnType<typeof setInterval> | undefined

watch(() => binding.value?.expiresAt, expiresAt => {
  clearInterval(timer)
  if (!expiresAt) return
  now.value = Date.now()
  let ticks = 0
  timer = setInterval(() => {
    now.value = Date.now()
    if (!remaining.value) clearInterval(timer)
    else if (++ticks % 3 === 0 && !document.hidden) void run({ action: 'status' })
  }, 1000)
})
onBeforeUnmount(() => clearInterval(timer))
watch(() => props.savedSnapshot, value => {
  if (value) snapshot.value = value
})
watch(() => snapshot.value?.configured === true, value => emit('configured', value), { immediate: true })

async function run(command: Parameters<typeof requestDesktopTelegram>[0]) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const previousSave = props.savedSnapshot
  try {
    const result = await requestDesktopTelegram(command)
    if (props.savedSnapshot === previousSave) snapshot.value = result
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('desktopTelegram.failed')
  } finally {
    busy.value = false
  }
}

function saveGroupSettings(patch: DesktopImGroupSettingsPatch) {
  void run({ action: 'updateGroupSettings', patch })
}
function toggleTool(key: 'web_tools' | 'web_search' | 'group_context_search') {
  if (!snapshot.value) return
  const patch = key === 'web_tools' ? { groupWebToolsEnabled: snapshot.value.groupWebToolsEnabled !== true }
    : key === 'web_search' ? { groupProviderSearchEnabled: snapshot.value.groupProviderSearchEnabled !== true }
      : { groupHistorySearchEnabled: snapshot.value.groupHistorySearchEnabled !== true }
  saveGroupSettings(patch)
}

async function toggleConnection() {
  if (busy.value || !snapshot.value?.configured) return
  if (snapshot.value.enabled) {
    if (!await confirmDialog({
      title: t('desktopTelegram.stop'),
      message: t('chatUi.telegram'),
      confirmText: t('desktopTelegram.stop'),
    })) return
    if (snapshot.value.enabled) await run({ action: 'disable' })
  } else {
    await run({ action: 'enable' })
  }
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(locale.value)
}

onMounted(() => { if (available) void run({ action: 'status' }) })
</script>

<template>
  <ImBotCard v-if="snapshot?.configured" :name="t('profileImUi.defaultTelegramBot')"
    :enabled="snapshot.enabled" :busy="busy"
    :status="snapshot.status === 'disabled' ? undefined : t(`desktopTelegram.${snapshot.status}`)"
    @toggle="toggleConnection">
    <template #actions>
      <button class="pm-style-chip" type="button" :disabled="busy"
        @click="run({ action: 'status' })">{{ t('desktopTelegram.refresh') }}</button>
    </template>
    <ImBindingRow v-if="snapshot.enabled" telegram :bound="snapshot.bound" :busy="busy"
      :binding="binding && { code: binding.code, expiresIn: remaining }"
      @generate="run({ action: 'bindingCode' })" @copy-failed="error = t('profileImUi.copyFailed')" />
    <GroupChatSettings v-if="snapshot.bound" :show-group-toggle="true"
      group-chat-hint="profileImUi.telegramGroupChatHint"
      :group-chat-enabled="snapshot.groupChatEnabled === true"
      :group-settings-visible="snapshot.groupChatEnabled === true"
      :group-response-mode="snapshot.groupReplyMode ?? 'reply_mentions'"
      :group-attention-mode="snapshot.groupAttentionMode ?? 'autonomous'" show-attention-mode
      response-mode-hint="profileImUi.telegramGroupResponseHint" response-guide="telegram" show-private-streaming
      :show-message-format="false" :message-format-bot="{ private_streaming_enabled: snapshot.privateStreamingEnabled }"
      :group-owner-memory-enabled="snapshot.groupOwnerMemoryEnabled === true"
      :group-memory-enabled="snapshot.groupMemoryEnabled !== false"
      :member-memory-enabled="snapshot.memberMemoryEnabled !== false" :enabled-tools="enabledTools"
      @group-chat="saveGroupSettings({ groupChatEnabled: $event })"
      @response-mode="saveGroupSettings({ groupReplyMode: $event })"
      @attention-mode="saveGroupSettings({ groupAttentionMode: $event })"
      @private-streaming="run({ action: 'setPrivateStreaming', enabled: $event })"
      @group-owner-memory="saveGroupSettings({ groupOwnerMemoryEnabled: $event })"
      @group-memory="saveGroupSettings({ groupMemoryEnabled: $event })"
      @member-memory="saveGroupSettings({ memberMemoryEnabled: $event })"
      @toggle-tool="toggleTool" />
    <template v-if="snapshot?.bound">
      <h4 class="pm-section-label">{{ t('desktopTelegram.inbox') }}</h4>
      <p v-if="!snapshot.messages.length" class="pm-field-hint">{{ t('desktopTelegram.empty') }}</p>
      <div v-for="message in snapshot.messages.slice().reverse()" :key="message.id" class="pm-bot-item">
        <time class="pm-field-hint" :datetime="message.receivedAt">{{ formatTime(message.receivedAt) }}</time>
        <div>{{ message.text }}</div>
      </div>
    </template>
  </ImBotCard>
  <p v-if="error" class="pm-msg err" role="alert">{{ error }}</p>
</template>
