<template>
  <div v-if="showGroupToggle" class="pm-bot-group-row">
    <div class="pm-field-desc">
      <span class="pm-field-name">{{ t('profileImUi.groupChat') }}</span>
      <span class="pm-field-hint">{{ t(groupChatHint) }}</span>
    </div>
    <span class="pm-switch-wrap">
      <ToggleSwitch :model-value="groupChatEnabled" :aria-label="t('profileImUi.toggleGroupChat')"
        @update:model-value="emit('group-chat', $event)" />
      <span class="pm-switch-label" :class="{ on: groupChatEnabled }">{{ t(groupChatEnabled ? 'profileImUi.enabled' : 'profileImUi.disabled') }}</span>
    </span>
  </div>

  <template v-if="groupSettingsVisible">
    <div class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc pm-help-anchor">
        <span class="pm-field-name">{{ t('profileImUi.responseMode') }}</span>
        <span class="pm-help-row">
          <span class="pm-field-hint">{{ t(responseModeHint) }}</span>
          <button v-if="responseGuide" :ref="setHelpAnchor" type="button" class="pm-help-toggle" @click.stop="helpOpen = !helpOpen">{{ t('profileImUi.guide') }}</button>
          <PopupMenu v-if="responseGuide" :show="helpOpen" :anchor="helpAnchor" popup-class="pm-help-popup-host">
            <div class="pm-help-pop" @click.stop>
              <template v-if="responseGuide === 'qq'">
                <div class="pm-help-pop-title">{{ t('profileImUi.fullMessageTitle') }}</div>
                <div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep1') }}</div>
                <div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep2') }}</div>
                <div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep3') }}</div>
                <div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep4') }}</div>
                <div class="pm-help-pop-note">{{ t('profileImUi.fullMessageNote') }}</div>
              </template>
              <template v-else-if="responseGuide === 'telegram'">
                <div class="pm-help-pop-title">{{ t('profileImUi.telegramGroupGuideTitle') }}</div>
                <div class="pm-help-pop-step">{{ t('profileImUi.telegramGroupGuideStep1') }}</div>
                <div class="pm-help-pop-step">{{ t('profileImUi.telegramGroupGuideStep2') }}</div>
                <div class="pm-help-pop-step">{{ t('profileImUi.telegramGroupGuideStep3') }}</div>
                <div class="pm-help-pop-note">{{ t('profileImUi.telegramGroupGuideNote') }}</div>
              </template>
            </div>
          </PopupMenu>
        </span>
      </div>
      <div class="pm-style-group pm-tool-options" role="group" :aria-label="t('profileImUi.responseMode')">
        <button v-for="option in responseOptions" :key="option.key" type="button" class="pm-style-chip"
          :class="{ active: groupResponseMode === option.key }" :aria-pressed="groupResponseMode === option.key"
          @click="emit('response-mode', option.key)">{{ t(option.label) }}</button>
      </div>
    </div>
    <div v-if="showAttentionMode && groupResponseMode === 'reply_all'" class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupAttentionMode') }}</span><span class="pm-field-hint">{{ t('profileImUi.groupAttentionModeHint') }}</span></div>
      <div class="pm-style-group pm-tool-options" role="group" :aria-label="t('profileImUi.groupAttentionMode')">
        <button v-for="option in attentionOptions" :key="option.key" type="button" class="pm-style-chip"
          :class="{ active: groupAttentionMode === option.key }" :aria-pressed="groupAttentionMode === option.key"
          @click="emit('attention-mode', option.key)">{{ t(option.label) }}</button>
      </div>
    </div>
  </template>

  <MessageFormatSettings v-if="showMessageFormat || showPrivateStreaming" :bot="messageFormatBot" :private-only="!groupChatEnabled"
    :show-formats="showMessageFormat" :show-streaming="showPrivateStreaming || showMessageFormat"
    @change="(scope, mode) => emit('message-format', scope, mode)"
    @streaming="emit('private-streaming', $event)" />

  <template v-if="groupSettingsVisible">
    <GroupOwnerMemorySwitch :enabled="groupOwnerMemoryEnabled" @change="emit('group-owner-memory', $event)" />
    <div class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupMemory') }}</span><span class="pm-field-hint">{{ t('profileImUi.groupMemoryHint') }}</span></div>
      <span class="pm-switch-wrap">
        <ToggleSwitch :model-value="groupMemoryEnabled" :aria-label="t('profileImUi.toggleGroupMemory')" @update:model-value="emit('group-memory', $event)" />
        <span class="pm-switch-label" :class="{ on: groupMemoryEnabled }">{{ t(groupMemoryEnabled ? 'profileImUi.enabled' : 'profileImUi.disabled') }}</span>
      </span>
    </div>
    <div class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.memberMemory') }}</span><span class="pm-field-hint">{{ t('profileImUi.memberMemoryHint') }}</span></div>
      <span class="pm-switch-wrap">
        <ToggleSwitch :model-value="memberMemoryEnabled" :aria-label="t('profileImUi.toggleMemberMemory')" @update:model-value="emit('member-memory', $event)" />
        <span class="pm-switch-label" :class="{ on: memberMemoryEnabled }">{{ t(memberMemoryEnabled ? 'profileImUi.enabled' : 'profileImUi.disabled') }}</span>
      </span>
    </div>
    <div class="pm-bot-group-row pm-bot-tools-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.memberTools') }}</span><span class="pm-field-hint">{{ t('profileImUi.memberToolsHint') }}</span></div>
      <div class="pm-style-group pm-tool-options" role="group" :aria-label="t('profileImUi.memberTools')">
        <button v-for="option in toolOptions" :key="option.key" :data-tool-option="option.key" type="button" class="pm-style-chip"
          :class="{ active: enabledTools.includes(option.key) }" :aria-pressed="enabledTools.includes(option.key)"
          @click="emit('toggle-tool', option.key)">{{ t(`profileImUi.${option.labelKey}`) }}</button>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import GroupOwnerMemorySwitch from '@/components/common/profile/GroupOwnerMemorySwitch.vue'
import MessageFormatSettings from '@/components/common/profile/MessageFormatSettings.vue'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import type { ImGroupAttentionMode, ImGroupReplyMode } from '@gugu/core/im/group-settings'

type MessageScope = 'group' | 'private'
type ToolOption = 'web_tools' | 'web_search' | 'group_context_search'
type GroupResponseMode = ImGroupReplyMode
type GroupAttentionMode = ImGroupAttentionMode
interface MessageFormatBot { group_message_format?: string; private_message_format?: string; private_streaming_enabled?: boolean }

const emit = defineEmits<{
  'group-chat': [enabled: boolean]
  'response-mode': [mode: GroupResponseMode]
  'attention-mode': [mode: GroupAttentionMode]
  'message-format': [scope: MessageScope, mode: string]
  'private-streaming': [enabled: boolean]
  'group-owner-memory': [enabled: boolean]
  'group-memory': [enabled: boolean]
  'member-memory': [enabled: boolean]
  'toggle-tool': [tool: ToolOption]
}>()
const { t } = useI18n()
const helpOpen = ref(false)
const helpAnchor = ref<HTMLElement | null>(null)
let helpPressInside = false
function setHelpAnchor(value: unknown) {
  helpAnchor.value = value instanceof HTMLElement ? value : null
}
function onDocumentMouseDown(event: MouseEvent) {
  helpPressInside = event.target instanceof HTMLElement && !!event.target.closest('.popup-menu-host')
}
function onDocumentClick() {
  if (helpPressInside) { helpPressInside = false; return }
  helpOpen.value = false
}
onMounted(() => {
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  document.addEventListener('click', onDocumentClick)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  document.removeEventListener('click', onDocumentClick)
})
const responseOptions = [
  { key: 'reply_all', label: 'profileImUi.replyAll' },
  { key: 'reply_mentions', label: 'profileImUi.replyMentions' },
  { key: 'record_only', label: 'profileImUi.recordOnly' },
] as const
const attentionOptions = [
  { key: 'quiet', label: 'profileImUi.groupAttentionQuiet' },
  { key: 'natural', label: 'profileImUi.groupAttentionNatural' },
  { key: 'active', label: 'profileImUi.groupAttentionActive' },
  { key: 'autonomous', label: 'profileImUi.groupAttentionAutonomous' },
] as const
withDefaults(defineProps<{
  showGroupToggle: boolean
  groupChatHint: string
  groupChatEnabled: boolean
  groupSettingsVisible: boolean
  groupResponseMode: GroupResponseMode
  groupAttentionMode?: GroupAttentionMode
  showAttentionMode?: boolean
  responseModeHint?: string
  responseGuide?: 'qq' | 'telegram'
  showMessageFormat?: boolean
  showPrivateStreaming?: boolean
  messageFormatBot: MessageFormatBot
  groupOwnerMemoryEnabled: boolean
  groupMemoryEnabled: boolean
  memberMemoryEnabled: boolean
  enabledTools: readonly ToolOption[]
}>(), {
  groupAttentionMode: 'autonomous',
  showAttentionMode: false,
  responseModeHint: 'profileImUi.responseModeHint',
  showMessageFormat: true,
  showPrivateStreaming: false,
})
const toolOptions = [
  { key: 'web_tools', labelKey: 'webSearchTools' },
  { key: 'web_search', labelKey: 'providerWebSearch' },
  { key: 'group_context_search', labelKey: 'groupContextSearch' },
] as const
</script>

<style scoped>
.pm-help-anchor { position: relative; }
.pm-help-row { display: inline-flex; align-items: baseline; gap: var(--space-xs); }
.pm-help-toggle {
  white-space: nowrap;
  background: none;
  border: none;
  padding: 0 var(--space-xs);
  margin: 0;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--action-primary);
  text-align: center;
  text-decoration: none;
  font-family: var(--font-sans);
  line-height: inherit;
  vertical-align: baseline;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: none;
  opacity: 1;
}
.pm-help-toggle:hover { color: var(--action-primary-hover, var(--action-primary)); text-decoration: none; }
.pm-help-toggle:focus { outline: none; }
.pm-help-toggle:focus-visible { outline: 2px solid var(--action-outline); outline-offset: 2px; border-radius: 2px; }
.pm-help-toggle:active { transform: none; opacity: 1; }
.pm-help-pop { width: max-content; max-width: 300px; padding: var(--space-sm) var(--space-md); color: var(--popup-item-fg); }
.pm-help-pop-title { font-size: 12px; font-weight: 700; color: var(--content-primary); margin-bottom: var(--space-xs); }
.pm-help-pop-step { font-size: 12px; color: var(--content-secondary); line-height: 1.7; }
.pm-help-pop-note { margin-top: var(--space-xs); font-size: 11px; color: var(--popup-item-fg-muted); border-top: 1px solid var(--popup-divider); padding-top: var(--space-xs); line-height: 1.6; }
</style>
