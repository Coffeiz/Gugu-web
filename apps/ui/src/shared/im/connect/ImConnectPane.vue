<template>
  <div class="pm-section">
    <div class="pm-section-label">{{ t('profileImUi.messagePreferences') }}</div>
    <div class="pm-bot-group-row pm-interaction-preference-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.showToolInteractions') }}</span><span class="pm-field-hint">{{ t('profileImUi.showToolInteractionsHint') }}</span></div>
      <div class="pm-style-group pm-tool-display-options" role="group" :aria-label="t('profileImUi.showToolInteractions')">
        <button v-for="option in toolDisplayOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: toolDisplayMode === option.key }" :aria-pressed="toolDisplayMode === option.key" @click="setToolDisplayMode(option.key)">{{ t(option.labelKey) }}</button>
      </div>
    </div>
    <div class="pm-bot-group-row pm-interaction-preference-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.showIntermediateReplies') }}</span><span class="pm-field-hint">{{ t('profileImUi.showIntermediateRepliesHint') }}</span></div>
      <span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="intermediateReplies" :aria-label="t('profileImUi.toggleIntermediateReplies')" @update:model-value="setIntermediateReplies" /><span class="pm-switch-label" :class="{ on: intermediateReplies }">{{ intermediateReplies ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span>
    </div>
  </div>
  <div class="pm-sep"></div>
  <div class="pm-section">
    <div class="pm-section-label">{{ t('profileImUi.messaging') }}</div>
    <template v-for="platform in platforms" :key="platform.key">
      <div class="pm-platform-block" :data-platform="platform.key">
      <div class="pm-field-row">
        <div class="pm-field-desc">
          <span class="pm-field-name">{{ t(platform.labelKey) }}</span>
          <span class="pm-field-hint">{{ t(platform.hintKey) }}</span>
        </div>
        <div class="pm-platform-actions">
          <button v-if="platform.key === 'telegram'" type="button" class="pm-bind-btn"
            :aria-expanded="telegramFormBotId !== null"
            :disabled="Boolean(connecting) || (desktop && !connectTelegram)"
            @click="openTelegramForm(botsOf(platform.key)[0]?.id ?? 0)">
            {{ t((desktop ? desktopTelegramConfigured : botsOf(platform.key).length) ? 'profileImUi.replaceTelegramToken' : 'profileImUi.scanToConnect') }}
          </button>
          <button v-else-if="platform.api && (desktop || !botsOf(platform.key).length)" type="button" class="pm-bind-btn"
            :aria-expanded="connect?.platform === platform.key"
            :disabled="Boolean(connecting) || (desktop && desktopPairingBusy[platform.key])"
            @click="connect?.platform === platform.key ? cancelConnect() : startConnect(platform.key)">
            {{ t(connect?.platform === platform.key ? 'profileImUi.cancel' : connecting === platform.key ? 'profileImUi.generating' : desktop && desktopPairingStatus[platform.key]?.configured ? 'profileImUi.rebindWechat' : 'profileImUi.scanToConnect') }}
          </button>
          <span v-else class="pm-field-hint pm-bound-tag">{{ t(desktop ? 'desktopTelegram.platformUnavailable' : 'profileImUi.connectedRebind') }}</span>
        </div>
      </div>
      <slot v-if="desktop && platform.key === 'telegram'" name="telegram-status" :set-configured="setDesktopTelegramConfigured" />
      <ImBotCard v-if="desktop && desktopPairingStatus[platform.key]?.configured"
        :name="desktopBotName(platform.key)"
        :detail="desktopPairingStatus[platform.key]?.detail"
        :enabled="desktopPairingStatus[platform.key]?.enabled === true"
        :busy="desktopPairingBusy[platform.key] || connecting === platform.key || connect?.platform === platform.key"
        :status="desktopBotStatus(platform.key)"
        @toggle="enabled => setDesktopPairingEnabled(platform.key, enabled)">
        <ImBindingRow v-if="platform.key === 'qq' && desktopPairingStatus.qq?.enabled"
          :bound="desktopPairingStatus.qq?.bound" :binding="bindingCodes[desktopQqBindingId]"
          :busy="bindingBotId === desktopQqBindingId"
          @generate="createDesktopQqBindingCode" @copy-failed="showBindingCopyError">
          <button v-if="desktopPairingStatus.qq?.bound" type="button" class="pm-style-chip pm-unbind-chip"
            @click="unbindQqIdentity()">{{ t('profileImUi.unbindQq') }}</button>
        </ImBindingRow>
        <QqGroupSettings v-if="platform.key === 'qq'" :show-group-toggle="desktopPairingStatus.qq?.bound === true"
          group-chat-hint="profileImUi.desktopQqGroupChatHint" :group-chat-enabled="desktopPairingStatus.qq?.groupChatEnabled === true"
          :group-settings-visible="desktopPairingStatus.qq?.bound === true && desktopPairingStatus.qq.groupChatEnabled === true"
          :group-response-mode="desktopPairingStatus.qq?.groupReplyMode ?? 'reply_mentions'"
          :message-format-bot="{ group_message_format: desktopPairingStatus.qq?.groupMessageFormat, private_message_format: desktopPairingStatus.qq?.privateMessageFormat, private_streaming_enabled: desktopPairingStatus.qq?.privateStreamingEnabled }"
          :group-owner-memory-enabled="desktopPairingStatus.qq?.groupOwnerMemoryEnabled === true"
          :group-memory-enabled="desktopPairingStatus.qq?.groupMemoryEnabled !== false"
          :member-memory-enabled="desktopPairingStatus.qq?.memberMemoryEnabled !== false"
          :enabled-tools="desktopQqEnabledTools"
          @group-chat="enabled => runDesktopQqSetting(api => api.setGroupChat(enabled))"
          @response-mode="mode => runDesktopQqSetting(api => api.setGroupReplyMode(mode))"
          @message-format="setDesktopQqMessageFormat"
          @private-streaming="enabled => runDesktopQqSetting(api => api.setPrivateStreaming(enabled))"
          @group-owner-memory="enabled => runDesktopQqSetting(api => api.setGroupOwnerMemory(enabled))"
          @group-memory="enabled => runDesktopQqSetting(api => api.setGroupMemory(enabled))"
          @member-memory="enabled => runDesktopQqSetting(api => api.setMemberMemory(enabled))"
          @toggle-tool="toggleDesktopQqTool" />
      </ImBotCard>
      <template v-if="!desktop">
      <ImBotCard v-for="bot in botsOf(platform.key)" :key="bot.id"
        :name="displayBotName(bot)" :detail="bot.app_id" :sandbox="bot.sandbox"
        :enabled="bot.enabled === true" @toggle="toggleBot(bot)">
        <template #actions>
          <button type="button" class="pm-bot-del" @click="removeBot(bot)">{{ t('profileImUi.deleteBot') }}</button>
        </template>
        <ImBindingRow v-if="platform.key === 'qq' || platform.key === 'telegram'"
          :telegram="platform.key === 'telegram'" :bound="bot.owner_bound" :binding="bindingCodes[bot.id]"
          :busy="bindingBotId === bot.id" @generate="createBindingCode(bot)" @copy-failed="showBindingCopyError">
          <button v-if="platform.key === 'qq' && bot.owner_bound" type="button" class="pm-style-chip pm-unbind-chip"
            @click="unbindQqIdentity(bot)">{{ t('profileImUi.unbindQq') }}</button>
        </ImBindingRow>
        <QqGroupSettings v-if="platform.key === 'qq'" :show-group-toggle="true" group-chat-hint="profileImUi.groupChatHint"
          :group-chat-enabled="groupChatEnabled(bot)" :group-settings-visible="groupChatEnabled(bot)"
          :group-response-mode="groupResponseMode(bot)" :message-format-bot="bot"
          :group-owner-memory-enabled="bot.group_owner_memory_enabled === true"
          :group-memory-enabled="bot.group_memory_enabled !== false" :member-memory-enabled="bot.member_memory_enabled !== false"
          :enabled-tools="qqEnabledTools(bot)"
          @group-chat="toggleGroupChat(bot)"
          @response-mode="setGroupResponseMode(bot, $event)"
          @message-format="(scope, mode) => setMessageFormat(bot, scope, mode)"
          @private-streaming="updateBotSetting(bot.id, { private_streaming_enabled: $event }, t('profileImUi.connectionSettingsFailed'))"
          @group-owner-memory="updateBotSetting(bot.id, { group_owner_memory_enabled: $event }, t('profileImUi.groupOwnerMemorySettingsFailed'))"
          @group-memory="updateBotSetting(bot.id, { group_memory_enabled: $event }, '群聊记忆设置失败')"
          @member-memory="updateBotSetting(bot.id, { member_memory_enabled: $event }, '群聊记忆设置失败')"
          @toggle-tool="toggleQqTool(bot, $event)" />
        <div v-if="['feishu', 'telegram'].includes(platform.key)" class="pm-bot-group-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupChat') }}</span><span class="pm-field-hint">{{ t(platform.key === 'feishu' ? 'profileImUi.feishuGroupChatHint' : 'profileImUi.telegramGroupChatHint') }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="groupChatEnabled(bot)" :aria-label="t('profileImUi.toggleGroupChat')" @update:model-value="toggleGroupChat(bot)" /><span class="pm-switch-label" :class="{ on: groupChatEnabled(bot) }">{{ groupChatEnabled(bot) ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span></div>
        <div v-if="['feishu', 'telegram'].includes(platform.key) && groupChatEnabled(bot)" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc pm-help-anchor"><span class="pm-field-name">{{ t('profileImUi.responseMode') }}</span><span class="pm-help-row"><span class="pm-field-hint">{{ t(platform.key === 'feishu' ? 'profileImUi.feishuGroupResponseHint' : 'profileImUi.telegramGroupResponseHint') }}</span><button v-if="platform.key === 'telegram'" :ref="el => setHelpAnchorRef(bot.id, el)" type="button" class="pm-help-toggle" @click.stop="toggleHelpPop(bot.id)">{{ t('profileImUi.guide') }}</button></span><PopupMenu v-if="platform.key === 'telegram'" :show="helpPopBotId === bot.id" :anchor="helpAnchorRefs[bot.id]" popup-class="pm-help-popup-host"><div class="pm-help-pop" @click.stop><div class="pm-help-pop-title">{{ t('profileImUi.telegramGroupGuideTitle') }}</div><div class="pm-help-pop-step">{{ t('profileImUi.telegramGroupGuideStep1') }}</div><div class="pm-help-pop-step">{{ t('profileImUi.telegramGroupGuideStep2') }}</div><div class="pm-help-pop-step">{{ t('profileImUi.telegramGroupGuideStep3') }}</div><div class="pm-help-pop-note">{{ t('profileImUi.telegramGroupGuideNote') }}</div></div></PopupMenu></div><div class="pm-style-group pm-tool-options"><button v-for="option in groupResponseOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: groupResponseMode(bot) === option.key }" @click="setGroupResponseMode(bot, option.key)">{{ t(`profileImUi.${option.key === 'reply_all' ? 'replyAll' : option.key === 'reply_mentions' ? 'replyMentions' : 'recordOnly'}`) }}</button></div></div>
        <div v-if="['feishu', 'telegram'].includes(platform.key) && groupChatEnabled(bot) && groupResponseMode(bot) === 'reply_all'" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupAttentionMode') }}</span><span class="pm-field-hint">{{ t('profileImUi.groupAttentionModeHint') }}</span></div><div class="pm-style-group pm-tool-options" role="group" :aria-label="t('profileImUi.groupAttentionMode')"><button v-for="option in groupAttentionOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: groupAttentionMode(bot) === option.key }" @click="setGroupAttentionMode(bot, option.key)">{{ t(option.label) }}</button></div></div>
        <GroupOwnerMemorySwitch v-if="['feishu', 'telegram'].includes(platform.key) && groupChatEnabled(bot)" :enabled="bot.group_owner_memory_enabled === true" @change="value => updateBotSetting(bot.id, { group_owner_memory_enabled: value }, t('profileImUi.groupOwnerMemorySettingsFailed'))" />
        <template v-if="['feishu', 'telegram'].includes(platform.key) && groupChatEnabled(bot)">
          <div class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupMemory') }}</span><span class="pm-field-hint">{{ t('profileImUi.groupMemoryHint') }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="bot.group_memory_enabled !== false" :aria-label="t('profileImUi.toggleGroupMemory')" @update:model-value="toggleMemory(bot, 'group_memory_enabled')" /><span class="pm-switch-label" :class="{ on: bot.group_memory_enabled !== false }">{{ bot.group_memory_enabled !== false ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span></div>
          <div class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.memberMemory') }}</span><span class="pm-field-hint">{{ t('profileImUi.memberMemoryHint') }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="bot.member_memory_enabled !== false" :aria-label="t('profileImUi.toggleMemberMemory')" @update:model-value="toggleMemory(bot, 'member_memory_enabled')" /><span class="pm-switch-label" :class="{ on: bot.member_memory_enabled !== false }">{{ bot.member_memory_enabled !== false ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span></div>
        </template>
        <div v-if="['feishu', 'telegram'].includes(platform.key) && groupChatEnabled(bot)" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.memberTools') }}</span><span class="pm-field-hint">{{ t('profileImUi.memberToolsHint') }}</span></div><div class="pm-style-group pm-tool-options"><button v-for="option in groupToolOptions" :key="option.key" :data-tool-option="option.key" type="button" class="pm-style-chip" :class="{ active: hasGroupTool(bot, option) }" @click="toggleGroupTool(bot, option)">{{ t(`profileImUi.${option.labelKey}`) }}</button></div></div>
      </ImBotCard>
      </template>
      <TelegramConnectionForm v-if="platform.key === 'telegram' && telegramFormBotId !== null"
        v-model="telegramToken" :busy="connecting === 'telegram'" :replacing="desktopTelegramConfigured || !!telegramFormBotId"
        @submit="submitTelegramToken" @cancel="closeTelegramForm" />
      <div v-if="connect?.platform === platform.key" :ref="el => setConnectPanelRef(platform.key, el)" class="pm-qr-box"><canvas :ref="setConnectCanvasRef" class="pm-qr-canvas"></canvas><div class="pm-qr-hint">{{ connectHint }}</div></div>
      </div>
    </template>
    <slot name="connection-notice" />
    <div v-if="connectErr" class="pm-qr-err">{{ connectErr }}</div>
  </div>
</template>

<script setup lang="ts">
import type { DesktopImPairingStatus, DesktopImSettingsAdapter } from './desktopAdapter'
import { useDesktopProfile } from '@/components/common/profile/desktopProfile'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { normalizeUserBotTools } from '@gugu/core/im/user-bots'
import ImBotCard from './ImBotCard.vue'
import ImBindingRow from './ImBindingRow.vue'
import TelegramConnectionForm from './TelegramConnectionForm.vue'
import QRCode from 'qrcode'
import Icon from '@/components/common/icons/Icon.vue'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { feishuConnectApi, qqConnectApi, telegramConnectApi, userBotsApi, wechatConnectApi } from '@/services/api'
import { optimisticMutation } from '@/utils/optimisticMutation'
import { beginOptimisticIntent, isOptimisticIntentCurrent, withOptimisticIntent } from '@/utils/optimisticIntent'
import { usePreferencesStore } from '@/stores/preferences'
import { useLiveStore } from '@/stores/live'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import GroupOwnerMemorySwitch from '@/components/common/profile/GroupOwnerMemorySwitch.vue'
import { useI18n } from 'vue-i18n'
import QqGroupSettings from './QqGroupSettings.vue'

interface Bot { id: number; platform: string; name?: string; sandbox?: boolean; app_id?: string; enabled?: boolean; group_chat_enabled?: boolean; feishu_group_chat_enabled?: boolean | null; group_requires_at?: boolean; group_read_enabled?: boolean; group_memory_enabled?: boolean; group_owner_memory_enabled?: boolean; member_memory_enabled?: boolean; group_response_mode?: string; group_attention_mode?: 'quiet' | 'natural' | 'active' | 'autonomous'; group_allowed_tools?: string[]; group_message_format?: string; private_message_format?: string; private_streaming_enabled?: boolean; owner_bound?: boolean }
type BotSettingPatch = Partial<Pick<Bot,
  'enabled' | 'group_chat_enabled' | 'feishu_group_chat_enabled' | 'group_response_mode' | 'group_attention_mode' | 'group_allowed_tools' |
  'group_message_format' | 'private_message_format' | 'private_streaming_enabled' |
  'group_memory_enabled' | 'member_memory_enabled' | 'group_owner_memory_enabled'
>>

const groupResponseOptions = [
  { key: 'reply_all', label: '自动回复' },
  { key: 'reply_mentions', label: '只响应 @' },
  { key: 'record_only', label: '静默记录' },
] as const
const groupAttentionOptions = [
  { key: 'quiet', label: 'profileImUi.groupAttentionQuiet' },
  { key: 'natural', label: 'profileImUi.groupAttentionNatural' },
  { key: 'active', label: 'profileImUi.groupAttentionActive' },
  { key: 'autonomous', label: 'profileImUi.groupAttentionAutonomous' },
] as const
const groupToolOptions = [
  { key: 'web_tools', labelKey: 'webSearchTools', tools: ['web_search', 'http_get', 'similar_image_search', 'send_file'] },
  { key: 'web_search', labelKey: 'providerWebSearch', tools: ['web_search'] },
  { key: 'group_context_search', labelKey: 'groupContextSearch', tools: ['group_context_search'] },
] as const
type QqToolKey = (typeof groupToolOptions)[number]['key']
const toolDisplayOptions = [
  { key: 'off', labelKey: 'profileImUi.toolDisplayOff' },
  { key: 'all', labelKey: 'profileImUi.toolDisplayAll' },
  { key: 'slow_only', labelKey: 'profileImUi.toolDisplaySlowOnly' },
] as const
const desktop = useDesktopProfile()
const props = defineProps<{ connectTelegram?: (token: string) => Promise<void>; desktopImAdapter?: DesktopImSettingsAdapter }>()
const desktopPairingApis = desktop ? props.desktopImAdapter?.pairings ?? {} : {}
const desktopQqApi = desktop ? props.desktopImAdapter?.qq : undefined
const desktopPairingStatus = ref<Partial<Record<string, DesktopImPairingStatus>>>({})
const desktopQqEnabledTools = computed<QqToolKey[]>(() => {
  const status = desktopPairingStatus.value.qq
  if (!status) return []
  return [
    ...(status.groupWebToolsEnabled ? ['web_tools' as const] : []),
    ...(status.groupProviderSearchEnabled ? ['web_search' as const] : []),
    ...(status.groupHistorySearchEnabled ? ['group_context_search' as const] : []),
  ]
})
const desktopPairingBusy = ref<Record<string, boolean>>({})
const desktopPairingReads = new Set<string>()
let desktopStatusTicks = 0
async function readDesktopPairingStatus(platform: string) {
  const api = desktopPairingApis[platform]
  if (!api || desktopPairingReads.has(platform) || desktopPairingBusy.value[platform]) return
  desktopPairingReads.add(platform)
  try {
    const result = await api.status('status')
    if (!desktopPairingBusy.value[platform]) desktopPairingStatus.value[platform] = result
    if (platform === 'qq' && result.bound) delete bindingCodes.value[desktopQqBindingId]
  } catch { /* 下次刷新重新读取。 */ }
  finally { desktopPairingReads.delete(platform) }
}
function refreshDesktopPairingStatus() {
  for (const platform of Object.keys(desktopPairingApis)) void readDesktopPairingStatus(platform)
}
async function setDesktopPairingEnabled(platform: string, enabled: boolean) {
  const api = desktopPairingApis[platform]
  if (!api || desktopPairingBusy.value[platform]) return
  desktopPairingBusy.value[platform] = true
  try {
    if (!enabled && !await confirmDialog({
      title: t('profileImUi.disableBot'),
      message: t(`profileImUi.${platform}`),
      confirmText: t('profileImUi.disableBot'),
    })) return
    connectErr.value = ''
    desktopPairingStatus.value[platform] = await api.status(enabled ? 'enable' : 'disable')
    liveStore.bump('im_channels')
    if (platform === 'qq' && !enabled) delete bindingCodes.value[desktopQqBindingId]
  } catch { connectErr.value = t('profileImUi.connectionSettingsFailed') }
  finally { desktopPairingBusy.value[platform] = false }
}
const preferences = usePreferencesStore()
const liveStore = useLiveStore()
const { t } = useI18n()
const allPlatforms = [
  { key: 'feishu', labelKey: 'profileImUi.feishu', api: desktop ? props.desktopImAdapter?.pairings.feishu ?? null : feishuConnectApi, hintKey: 'profileImUi.feishuHint' },
  { key: 'qq', labelKey: 'profileImUi.qq', api: desktop ? props.desktopImAdapter?.pairings.qq ?? null : qqConnectApi, hintKey: 'profileImUi.qqHint' },
  { key: 'wechat', labelKey: 'profileImUi.wechat', api: desktop ? props.desktopImAdapter?.pairings.wechat ?? null : wechatConnectApi, hintKey: 'profileImUi.wechatHint' },
  { key: 'telegram', labelKey: 'profileImUi.telegram', api: null, hintKey: 'profileImUi.telegramHint' },
]
const supportedPlatforms = ref(allPlatforms.map(platform => platform.key))
const platforms = computed(() => allPlatforms.filter(platform => supportedPlatforms.value.includes(platform.key)))
type Platform = typeof allPlatforms[number]
const telegramToken = ref('')
const telegramFormBotId = ref<number | null>(null)
const bots = ref<Bot[]>([]); const botsOf = (platform: string) => bots.value.filter(bot => bot.platform === platform)
const helpPopBotId = ref<number | null>(null)
const helpAnchorRefs = ref<Record<number, HTMLElement | null>>({})
function setHelpAnchorRef(botId: number, el: unknown) { helpAnchorRefs.value[botId] = el instanceof HTMLElement ? el : null }
function toggleHelpPop(botId: number) { helpPopBotId.value = helpPopBotId.value === botId ? null : botId }
// 拖选保护：弹层内拖选文字移出后松开，click 落在外面，不能因此误关
let _helpPressInside = false
function onDocPressCloseHelp(e: MouseEvent) {
  _helpPressInside = e.target instanceof HTMLElement && !!e.target.closest('.popup-menu-host')
}
function onDocClickCloseHelp(e: MouseEvent) {
  if (e && _helpPressInside) { _helpPressInside = false; return }
  _helpPressInside = false
  helpPopBotId.value = null
}
const connecting = ref(''); const connect = ref<{ platform: string; id: string } | null>(null); const connectHint = ref(''); const connectErr = ref(''); const connectCanvas = ref<HTMLCanvasElement | null>(null); const bindingBotId = ref<number | null>(null); const bindingCodes = ref<Record<number, { code: string; expiresIn: number }>>({}); let poll: ReturnType<typeof setInterval> | null = null; let bindingCountdown: ReturnType<typeof setInterval> | null = null
const connectPanels = ref<Record<string, HTMLElement | null>>({})
function setConnectPanelRef(platform: string, element: unknown) {
  connectPanels.value[platform] = element instanceof HTMLElement ? element : null
}
function setConnectCanvasRef(element: unknown) {
  // canvas 位于 v-for 的平台区块中，字符串 ref 会被 Vue 收集成数组；QRCode.toCanvas
  // 需要真实 HTMLCanvasElement，否则重绑时会因数组没有 getContext 而失败。
  connectCanvas.value = element instanceof HTMLCanvasElement ? element : null
}

// 「接入咕咕」设置全部走同一套 latest-intent 乐观事务：apply 永远同步发生，
// 同 bot 同字段的 persistence 由 optimisticIntent 串行，旧失败不会回滚更新点击。
// 不在每次成功后整表 loadBots，避免慢 GET 把更晚的本地意图覆盖回旧值。
const pendingSettingWrites = new Set<Promise<void>>()
let settingsRevision = 0
let botsLoadSeq = 0

const localMessagePreferences = ref<{ imToolDisplayMode?: 'off' | 'all' | 'slow_only'; showIntermediateReplies?: boolean }>({})
const toolDisplayMode = computed(() => desktop ? localMessagePreferences.value.imToolDisplayMode ?? 'all' : preferences.imToolDisplayMode)
const intermediateReplies = computed(() => desktop ? localMessagePreferences.value.showIntermediateReplies === true : preferences.showIntermediateReplies)
let localPreferenceWrite = Promise.resolve()
function saveLocalMessagePreferences(patch: typeof localMessagePreferences.value) {
  localPreferenceWrite = localPreferenceWrite.then(async () => {
    try {
      if (!props.desktopImAdapter) throw new Error(t('profileImUi.connectionSettingsFailed'))
      localMessagePreferences.value = await props.desktopImAdapter.updateAppearance(patch)
    }
    catch (error) { connectErr.value = error instanceof Error ? error.message : t('profileImUi.connectionSettingsFailed') }
  })
}

function setIntermediateReplies(value: boolean) {
  if (desktop) saveLocalMessagePreferences({ showIntermediateReplies: value })
  else void preferences.saveShowIntermediateReplies(value)
}

function setToolDisplayMode(value: 'off' | 'all' | 'slow_only') {
  if (desktop) saveLocalMessagePreferences({ imToolDisplayMode: value })
  else void preferences.saveImToolDisplayMode(value)
}

function botById(botId: number): Bot | undefined { return bots.value.find(bot => bot.id === botId) }
function desktopBotName(platform: string): string {
  if (platform === 'wechat') return t('profileImUi.defaultWechatBot')
  if (platform === 'qq') return t('profileImUi.defaultQqBot')
  return t('profileImUi.defaultFeishuBot')
}

function desktopBotStatus(platform: string): string | undefined {
  const state = desktopPairingStatus.value[platform]?.connectionState
  if (!state || state === 'disabled' || state === 'running') return undefined
  return t(`profileImUi.desktopGateway.${state}`)
}

function displayBotName(bot: Bot): string {
  const name = bot.name?.trim() || ''
  const normalized = name.replace(/\s+/g, '')
  const defaultKey = bot.platform === 'feishu' && normalized === '我的飞书机器人'
    ? 'defaultFeishuBot'
    : bot.platform === 'qq' && normalized === '我的QQ机器人'
      ? 'defaultQqBot'
      : bot.platform === 'wechat' && ['我的微信', '我的微信机器人'].includes(normalized)
        ? 'defaultWechatBot'
        : bot.platform === 'telegram' && normalized === '我的telegram机器人'
          ? 'defaultTelegramBot'
        : null
  return defaultKey ? t(`profileImUi.${defaultKey}`) : name
}
function patchLocalBot(botId: number, patch: Partial<Bot>) {
  const index = bots.value.findIndex(bot => bot.id === botId)
  if (index === -1) return
  bots.value[index] = { ...bots.value[index], ...patch }
}
function trackSettingWrite(task: Promise<void>) {
  pendingSettingWrites.add(task)
  void task.finally(() => pendingSettingWrites.delete(task))
}
async function waitForSettingWrites() {
  while (pendingSettingWrites.size) await Promise.allSettled([...pendingSettingWrites])
}
async function loadBots() {
  const seq = ++botsLoadSeq
  await waitForSettingWrites()
  if (seq !== botsLoadSeq) return
  const startRevision = settingsRevision
  try {
    const result = await userBotsApi.list()
    if (seq !== botsLoadSeq) return
    if (Array.isArray(result.supported_platforms)) supportedPlatforms.value = result.supported_platforms
    // GET 发出后若又发生了乐观写，即使该写很快结算，当前响应也可能读到提交前快照。
    // 丢掉这份响应并重取，不能让旧 list 覆盖已经立即呈现给用户的新状态。
    if (startRevision !== settingsRevision || pendingSettingWrites.size) {
      void loadBots()
      return
    }
    bots.value = result.items || []
    const boundIds = new Set(bots.value.filter(bot => bot.owner_bound).map(bot => bot.id))
    if (boundIds.size) {
      bindingCodes.value = Object.fromEntries(Object.entries(bindingCodes.value).filter(([id]) => !boundIds.has(Number(id))))
    }
  } catch {}
}
function updateBotSetting(botId: number, patch: BotSettingPatch, fallbackError: string): Promise<void> {
  const current = botById(botId)
  if (!current) return Promise.resolve()
  const fields = Object.keys(patch) as Array<keyof BotSettingPatch>
  const backup = Object.fromEntries(fields.map(field => [field, current[field]])) as BotSettingPatch
  const intent = beginOptimisticIntent(fields.map(field => `profile-im:${botId}:${String(field)}`))
  connectErr.value = ''
  const task = withOptimisticIntent(intent, () => optimisticMutation({
    apply: () => {
      settingsRevision++
      patchLocalBot(botId, patch)
    },
    work: () => userBotsApi.update(botId, patch),
    rollback: () => {
      settingsRevision++
      patchLocalBot(botId, backup)
    },
    afterMutate: () => {},
    onError: error => {
      // 被更新点击 supersede 的旧失败不再弹错误；只有当前最终意图失败才提示。
      if (!isOptimisticIntentCurrent(intent)) return
      connectErr.value = (error instanceof Error ? error.message : '') || fallbackError
    },
  }))
  trackSettingWrite(task)
  return task
}

async function startConnect(platform: string) { const item = platforms.value.find(value => value.key === platform); if (!item?.api || connecting.value) return; cancelConnect(); connecting.value = platform; connectErr.value = ''; try { const result = await item.api.start(); const id = 'poll_id' in result && result.poll_id ? result.poll_id : 'task_id' in result ? result.task_id : ''; connect.value = { platform, id }; connectHint.value = t(`profileImUi.${platform}ConnectHint`); await nextTick(); const panel = connectPanels.value[platform]; if (typeof panel?.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); await QRCode.toCanvas(connectCanvas.value, result.scan_url, { width: 180, margin: 1 }); startPoll(item) } catch (error) { connectErr.value = (error instanceof Error ? error.message : '') || t('profileImUi.qrGenerateFailed'); connect.value = null } finally { connecting.value = '' } }
let pollInFlight = false
function startPoll(platform: Exclude<Platform, { api: null }>) { stopPoll(); let tries = 0; poll = setInterval(async () => { const current = connect.value; if (!current || pollInFlight || document.hidden) return; tries++; pollInFlight = true; try { const result = await platform.api.poll(current.id); if (connect.value !== current) return; if (result.status === 'success') { cancelConnect(); if (!desktop) await loadBots(); else { liveStore.bump('im_channels'); await readDesktopPairingStatus(platform.key) } } else if (result.status === 'expired') { connectErr.value = t('profileImUi.qrExpired'); cancelConnect() } else if (result.status === 'fail') { connectErr.value = t('profileImUi.connectionFailedWithReason', { reason: result.reason || t('profileImUi.unknownError') }); cancelConnect() } } catch {} finally { pollInFlight = false } if (connect.value === current && tries > 100) cancelConnect() }, 3000) }
function stopPoll() { if (poll) { clearInterval(poll); poll = null } }
function resumePoll() {
  if (!connect.value) return
  const platform = platforms.value.find(value => value.key === connect.value?.platform)
  if (platform?.api) startPoll(platform as Exclude<Platform, { api: null }>)
}
function cancelConnect() { stopPoll(); connect.value = null }
function openTelegramForm(botId: number) { connectErr.value = ''; telegramToken.value = ''; telegramFormBotId.value = botId; void nextTick(() => { const input = document.getElementById('telegram-bot-token'); if (typeof input?.scrollIntoView === 'function') input.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }) }
const desktopTelegramConfigured = ref(false)
function setDesktopTelegramConfigured(configured: boolean) { desktopTelegramConfigured.value = configured }
function closeTelegramForm() { telegramFormBotId.value = null; telegramToken.value = '' }
async function submitTelegramToken() {
  const secret = telegramToken.value.trim()
  const botId = telegramFormBotId.value
  if (!secret || botId === null || connecting.value) return
  connecting.value = 'telegram'
  connectErr.value = ''
  telegramToken.value = ''
  try {
    if (props.connectTelegram) await props.connectTelegram(secret)
    else if (botId) await telegramConnectApi.replace(botId, secret)
    else await telegramConnectApi.connect(secret)
    closeTelegramForm()
    if (!props.connectTelegram) await loadBots()
  } catch (error) {
    connectErr.value = error instanceof Error ? error.message : t('profileImUi.connectionFailed')
  } finally {
    connecting.value = ''
  }
}
function toggleBot(bot: Bot) { const current = botById(bot.id); if (current) void updateBotSetting(bot.id, { enabled: !current.enabled }, t('profileImUi.connectionSettingsFailed')) }
async function createBindingCode(bot: Bot) { bindingBotId.value = bot.id; connectErr.value = ''; try { const result = bot.platform === 'telegram' ? await telegramConnectApi.createBindingCode(bot.id) : await userBotsApi.createQqBindingCode(bot.id); bindingCodes.value = { ...bindingCodes.value, [bot.id]: { code: result.code, expiresIn: result.expires_in } } } catch (error) { connectErr.value = error instanceof Error ? error.message : t('profileImUi.codeGenerateFailed') } finally { bindingBotId.value = null } }
const desktopQqBindingId = -1
async function createDesktopQqBindingCode() {
  if (!desktopQqApi) return
  bindingBotId.value = desktopQqBindingId
  connectErr.value = ''
  try {
    const result = await desktopQqApi.bindingCode()
    bindingCodes.value[desktopQqBindingId] = { code: result.code, expiresIn: result.expires_in }
  } catch { connectErr.value = t('profileImUi.codeGenerateFailed') }
  finally { bindingBotId.value = null }
}
function tickBindingCodes() {
  const next = Object.fromEntries(Object.entries(bindingCodes.value).map(([id, binding]) => [id, { ...binding, expiresIn: Math.max(0, binding.expiresIn - 1) }]))
  bindingCodes.value = next
  if (desktop && !document.hidden && ++desktopStatusTicks % 5 === 0 &&
    Object.values(desktopPairingStatus.value).some(status => status?.enabled)) refreshDesktopPairingStatus()
  const remaining = bindingCodes.value[desktopQqBindingId]?.expiresIn
  if (remaining && remaining % 3 === 0 && !document.hidden) void readDesktopPairingStatus('qq')
}
function showBindingCopyError() { connectErr.value = t('profileImUi.copyFailed') }
async function setDesktopQqMessageFormat(scope: 'group' | 'private', mode: string) {
  if (!desktopQqApi || (mode !== 'compat' && mode !== 'markdown')) return
  await updateDesktopQqReplySettings(() => desktopQqApi.setMessageFormat(scope, mode))
}
function runDesktopQqSetting(update: (api: NonNullable<typeof desktopQqApi>) => Promise<DesktopImPairingStatus>) {
  if (desktopQqApi) void updateDesktopQqReplySettings(() => update(desktopQqApi))
}
async function updateDesktopQqReplySettings(update: () => Promise<DesktopImPairingStatus>) {
  if (!desktopQqApi) return
  if (desktopPairingBusy.value.qq) return
  desktopPairingBusy.value.qq = true
  try { desktopPairingStatus.value.qq = await update() }
  catch { connectErr.value = t('profileImUi.connectionSettingsFailed') }
  finally { desktopPairingBusy.value.qq = false }
}
async function unbindQqIdentity(bot?: Bot) {
  if (!await confirmDialog({ title: t('profileImUi.unbindQqTitle'), message: t('profileImUi.unbindQqMessage'), tone: 'warning', confirmText: t('profileImUi.unbindQq') })) return
  if (!bot) {
    if (!desktopQqApi) return
    if (desktopPairingBusy.value.qq) return
    desktopPairingBusy.value.qq = true
    try {
      desktopPairingStatus.value.qq = await desktopQqApi.unbind()
      delete bindingCodes.value[desktopQqBindingId]
      liveStore.bump('im_channels')
    } catch { connectErr.value = t('profileImUi.unbindQqFailed') }
    finally { desktopPairingBusy.value.qq = false }
    return
  }
  try {
    await userBotsApi.unbindQqIdentity(bot.id)
    patchLocalBot(bot.id, { owner_bound: false })
    const next = { ...bindingCodes.value }
    delete next[bot.id]
    bindingCodes.value = next
  } catch (error) { connectErr.value = (error instanceof Error ? error.message : '') || t('profileImUi.unbindQqFailed') }
}
function groupChatEnabled(bot: Bot): boolean { return bot.platform === 'feishu' ? bot.feishu_group_chat_enabled !== false : bot.group_chat_enabled === true }
function toggleGroupChat(bot: Bot) {
  const current = botById(bot.id)
  if (!current) return
  const field = current.platform === 'feishu' ? 'feishu_group_chat_enabled' : 'group_chat_enabled'
  void updateBotSetting(bot.id, { [field]: !groupChatEnabled(current) }, '群聊设置失败')
}
function toggleMemory(bot: Bot, field: 'group_memory_enabled' | 'member_memory_enabled') {
  const current = botById(bot.id)
  if (current) void updateBotSetting(bot.id, { [field]: current[field] !== false ? false : true }, '群聊记忆设置失败')
}
type QqGroupResponseMode = 'reply_mentions' | 'reply_all' | 'record_only'
function groupResponseMode(bot: Bot): QqGroupResponseMode {
  if (bot.group_response_mode === 'reply_mentions' || bot.group_response_mode === 'reply_all' || bot.group_response_mode === 'record_only') return bot.group_response_mode
  return bot.group_read_enabled ? 'record_only' : (bot.group_requires_at ?? true) ? 'reply_mentions' : 'reply_all'
}
function setGroupResponseMode(bot: Bot, mode: string) { void updateBotSetting(bot.id, { group_response_mode: mode }, '群聊回应方式设置失败') }
function groupAttentionMode(bot: Bot): string { return bot.group_attention_mode ?? 'autonomous' }
function setGroupAttentionMode(bot: Bot, mode: 'quiet' | 'natural' | 'active' | 'autonomous') { void updateBotSetting(bot.id, { group_attention_mode: mode }, '群聊参与度设置失败') }
function groupTools(bot: Bot): string[] { return normalizeUserBotTools(bot.group_allowed_tools) }
function hasGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]): boolean { return option.tools.every(t => groupTools(bot).includes(t)) }
function toggleGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]) {
  const current = botById(bot.id)
  if (!current) return
  const tools = new Set(groupTools(current))
  if (hasGroupTool(current, option)) option.tools.forEach(t => tools.delete(t))
  else option.tools.forEach(t => tools.add(t))
  void updateBotSetting(bot.id, { group_allowed_tools: [...tools] }, '群聊工具设置失败')
}
function qqEnabledTools(bot: Bot): QqToolKey[] {
  return groupToolOptions.filter(option => hasGroupTool(bot, option)).map(option => option.key)
}
function toggleQqTool(bot: Bot, key: QqToolKey) {
  const option = groupToolOptions.find(item => item.key === key)
  if (option) toggleGroupTool(bot, option)
}
function toggleDesktopQqTool(key: QqToolKey) {
  const status = desktopPairingStatus.value.qq
  if (!desktopQqApi) return
  if (!status) return
  const update = key === 'web_tools'
    ? () => desktopQqApi.setGroupWebTools(status.groupWebToolsEnabled !== true)
    : key === 'web_search'
      ? () => desktopQqApi.setGroupProviderSearch(status.groupProviderSearchEnabled !== true)
      : () => desktopQqApi.setGroupHistorySearch(status.groupHistorySearchEnabled !== true)
  void updateDesktopQqReplySettings(update)
}
function setMessageFormat(bot: Bot, scope: 'group' | 'private', mode: string) {
  const patch = scope === 'group' ? { group_message_format: mode } : { private_message_format: mode }
  void updateBotSetting(bot.id, patch, '消息格式设置失败')
}
async function removeBot(bot: Bot) { if (!await confirmDialog({ title: t('profileImUi.deleteBotTitle'), message: t('profileImUi.deleteBotMessage', { name: displayBotName(bot) }), tone: 'danger', confirmText: t('profileImUi.deleteBot') })) return; try { await waitForSettingWrites(); await userBotsApi.remove(bot.id); await loadBots() } catch (error) { connectErr.value = error instanceof Error ? error.message : t('profileImUi.connectionFailed') } }
onMounted(() => { document.addEventListener('mousedown', onDocPressCloseHelp, true); document.addEventListener('click', onDocClickCloseHelp); if (desktop) { localPreferenceWrite = props.desktopImAdapter?.appearance().then(value => { localMessagePreferences.value = value }).catch(() => {} ) ?? Promise.resolve(); refreshDesktopPairingStatus(); bindingCountdown = setInterval(tickBindingCodes, 1000); return } void preferences.fetch(); loadBots(); bindingCountdown = setInterval(tickBindingCodes, 1000) })
onDeactivated(stopPoll)
onDeactivated(onDocClickCloseHelp)
onActivated(() => { resumePoll(); refreshDesktopPairingStatus() })
onActivated(() => { if (!desktop) void loadBots() })
watch(() => liveStore.rev.im_channels, () => { if (!desktop) void loadBots() })
watch(() => liveStore.connected, connected => {
  if (!desktop && connected && Object.values(bindingCodes.value).some(binding => binding.expiresIn > 0)) void loadBots()
})
onBeforeUnmount(() => { cancelConnect(); if (bindingCountdown) clearInterval(bindingCountdown); document.removeEventListener('mousedown', onDocPressCloseHelp, true); document.removeEventListener('click', onDocClickCloseHelp) })
</script>

<style scoped>
.pm-interaction-preference-row {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.pm-tool-display-options {
  justify-content: flex-end;
  flex-wrap: wrap;
  max-width: 58%;
}

.pm-platform-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.pm-platform-block > .pm-field-row > .pm-field-desc {
  flex: 1;
  min-width: 0;
}

/* 回应方式的「如何开启消息接收」浮层：表面颜色消费 --popup-* 契约
   （与右键菜单 popup-menu 同一套），组件里只定义几何。 */
.pm-help-anchor { position: relative; }
/* 「选择群消息的处理方式」文字 + 「设置方法」按钮同行水平排：
   pm-field-desc 是 flex-direction:column（默认所有 desc 都这么排），
   这里要把 hint + button 绑成一行，所以单独再套一个 inline 容器。 */
.pm-help-row { display: inline-flex; align-items: baseline; gap: 4px; }
.pm-help-toggle {
  white-space: nowrap;
  /* 「设置方法」是行内小链接按钮：跟「选择群消息的处理方式」文字同行末尾
     居中显示，跟 hint 同字号 12px（不再小一号看着突兀），用 action-primary
     颜色 + 600 字重区别于普通灰色说明文字，让用户一眼识别为可点击；
     无下虚线、无下沉反馈——4 个字在按钮内水平居中。 */
  background: none;
  border: none;
  padding: 0 2px;
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
:global(.popup-menu-host.pm-help-popup-host) { padding: 0; }
.pm-help-pop { width: max-content; max-width: 300px; padding: 10px 12px; color: var(--popup-item-fg); }
.pm-help-pop-title { font-size: 12px; font-weight: 700; color: var(--content-primary); margin-bottom: 6px; }
.pm-help-pop-step { font-size: 12px; color: var(--content-secondary); line-height: 1.7; }
.pm-help-pop-note { margin-top: 6px; font-size: 11px; color: var(--popup-item-fg-muted); border-top: 1px solid var(--popup-divider); padding-top: 6px; line-height: 1.6; }
</style>
