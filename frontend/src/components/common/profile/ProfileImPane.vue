<template>
  <div class="pm-section">
    <div class="pm-section-label">{{ t('profileImUi.messagePreferences') }}</div>
    <div class="pm-bot-group-row pm-interaction-preference-row">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.showToolInteractions') }}</span><span class="pm-field-hint">{{ t('profileImUi.showToolInteractionsHint') }}</span></div>
      <span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="preferences.showToolInteractions" :aria-label="t('profileImUi.toggleToolInteractions')" @update:model-value="toggleToolInteractions" /><span class="pm-switch-label" :class="{ on: preferences.showToolInteractions }">{{ preferences.showToolInteractions ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span>
    </div>
  </div>
  <div class="pm-sep"></div>
  <div class="pm-section">
    <div class="pm-section-label">{{ t('profileImUi.messaging') }}</div>
    <template v-for="platform in platforms" :key="platform.key">
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t(platform.labelKey) }}</span><span class="pm-field-hint">{{ t(platform.hintKey) }}</span></div><button v-if="!botsOf(platform.key).length" class="pm-bind-btn" :disabled="connecting === platform.key" @click="startConnect(platform.key)">{{ connecting === platform.key ? t('profileImUi.generating') : t('profileImUi.scanToConnect') }}</button><span v-else class="pm-field-hint pm-bound-tag">{{ t('profileImUi.connectedRebind') }}</span></div>
      <div v-for="bot in botsOf(platform.key)" :key="bot.id" class="pm-bot-item">
        <div class="pm-bot-item-top"><div class="pm-bot-info"><span class="pm-bot-name">{{ displayBotName(bot) }}<span v-if="bot.sandbox" class="pm-bot-tag">{{ t('profileImUi.sandbox') }}</span></span><span class="pm-bot-appid">{{ bot.app_id }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="bot.enabled === true" :aria-label="bot.enabled === true ? t('profileImUi.disableBot') : t('profileImUi.enableBot')" @update:model-value="toggleBot(bot)" /><span class="pm-switch-label" :class="{ on: bot.enabled === true }">{{ bot.enabled === true ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span><button class="pm-bot-del" @click="removeBot(bot)">{{ t('profileImUi.deleteBot') }}</button></div>
        <div v-if="platform.key === 'qq'" class="pm-bot-group-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.qqBinding') }}</span><span class="pm-field-hint">{{ t('profileImUi.qqBindingHint') }}</span></div><div class="pm-binding-code"><button v-if="!bot.owner_bound && (!bindingCodes[bot.id] || bindingCodes[bot.id].expiresIn <= 0)" type="button" class="pm-style-chip" :disabled="bindingBotId === bot.id" @click="createBindingCode(bot)">{{ bindingBotId === bot.id ? t('profileImUi.generating') : t('profileImUi.generateCode') }}</button><div v-if="bindingCodes[bot.id] && bindingCodes[bot.id].expiresIn > 0" class="pm-binding-code-result"><span class="pm-binding-code-command" :title="t('profileImUi.sendToBot')"><code class="pm-binding-code-value">{{ bindingCodes[bot.id].code }}</code></span><span class="pm-binding-code-expiry">{{ t('profileImUi.codeExpiry', { seconds: bindingCodes[bot.id].expiresIn }) }}</span><button type="button" class="pm-binding-copy-btn" :class="{ copied: copiedBindingBotId === bot.id }" :title="copiedBindingBotId === bot.id ? t('profileImUi.bindingCopied') : t('profileImUi.copyBinding')" @click="copyBindingCode(bot.id)"><Icon name="status.success" v-if="copiedBindingBotId === bot.id" :size="12" /><Icon name="action.copy" v-else :size="12" /><span>{{ copiedBindingBotId === bot.id ? t('profileImUi.copied') : t('profileImUi.copy') }}</span></button></div><span v-else-if="bot.owner_bound" class="pm-field-hint">{{ t('profileImUi.bound') }}</span><span v-else-if="bindingCodes[bot.id]" class="pm-field-hint">{{ t('profileImUi.codeExpired') }}</span><button v-if="bot.owner_bound" type="button" class="pm-style-chip pm-unbind-chip" @click="unbindQqIdentity(bot)">{{ t('profileImUi.unbindQq') }}</button></div></div>
        <div v-if="platform.key === 'qq'" class="pm-bot-group-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupChat') }}</span><span class="pm-field-hint">{{ t('profileImUi.groupChatHint') }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="bot.group_chat_enabled === true" :aria-label="t('profileImUi.toggleGroupChat')" @update:model-value="toggleGroupChat(bot)" /><span class="pm-switch-label" :class="{ on: bot.group_chat_enabled === true }">{{ bot.group_chat_enabled === true ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span></div>
        <div v-if="platform.key === 'qq' && bot.group_chat_enabled" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc pm-help-anchor"><span class="pm-field-name">{{ t('profileImUi.responseMode') }}</span><span class="pm-help-row"><span class="pm-field-hint">{{ t('profileImUi.responseModeHint') }}</span><button :ref="el => setHelpAnchorRef(bot.id, el)" type="button" class="pm-help-toggle" @click.stop="toggleHelpPop(bot.id)">{{ t('profileImUi.guide') }}</button></span><PopupMenu :show="helpPopBotId === bot.id" :anchor="helpAnchorRefs[bot.id]" popup-class="pm-help-popup-host"><div class="pm-help-pop" @click.stop><div class="pm-help-pop-title">{{ t('profileImUi.fullMessageTitle') }}</div><div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep1') }}</div><div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep2') }}</div><div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep3') }}</div><div class="pm-help-pop-step">{{ t('profileImUi.fullMessageStep4') }}</div><div class="pm-help-pop-note">{{ t('profileImUi.fullMessageNote') }}</div></div></PopupMenu></div><div class="pm-style-group pm-tool-options"><button v-for="option in groupResponseOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: groupResponseMode(bot) === option.key }" @click="setGroupResponseMode(bot, option.key)">{{ t(`profileImUi.${option.key === 'reply_all' ? 'replyAll' : option.key === 'reply_mentions' ? 'replyMentions' : 'recordOnly'}`) }}</button></div></div>
        <template v-if="platform.key === 'qq'">
          <MessageFormatSettings :bot="bot" @change="(scope, mode) => setMessageFormat(bot, scope, mode)" />
          <div class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.privateStreaming') }}</span><span class="pm-field-hint">{{ t('profileImUi.privateStreamingHint') }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="bot.private_streaming_enabled === true" :aria-label="t('profileImUi.togglePrivateStreaming')" @update:model-value="togglePrivateStreaming(bot)" /><span class="pm-switch-label" :class="{ on: bot.private_streaming_enabled === true }">{{ bot.private_streaming_enabled === true ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span></div>
        </template>
        <template v-if="platform.key === 'qq' && bot.group_chat_enabled">
          <div class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupMemory') }}</span><span class="pm-field-hint">{{ t('profileImUi.groupMemoryHint') }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="bot.group_memory_enabled !== false" :aria-label="t('profileImUi.toggleGroupMemory')" @update:model-value="toggleMemory(bot, 'group_memory_enabled')" /><span class="pm-switch-label" :class="{ on: bot.group_memory_enabled !== false }">{{ bot.group_memory_enabled !== false ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span></div>
          <div class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.memberMemory') }}</span><span class="pm-field-hint">{{ t('profileImUi.memberMemoryHint') }}</span></div><span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="bot.member_memory_enabled !== false" :aria-label="t('profileImUi.toggleMemberMemory')" @update:model-value="toggleMemory(bot, 'member_memory_enabled')" /><span class="pm-switch-label" :class="{ on: bot.member_memory_enabled !== false }">{{ bot.member_memory_enabled !== false ? t('profileImUi.enabled') : t('profileImUi.disabled') }}</span></span></div>
        </template>
        <div v-if="platform.key === 'qq' && bot.group_chat_enabled" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.memberTools') }}</span><span class="pm-field-hint">{{ t('profileImUi.memberToolsHint') }}</span></div><div class="pm-style-group pm-tool-options"><button v-for="option in groupToolOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: hasGroupTool(bot, option) }" @click="toggleGroupTool(bot, option)">{{ t(`profileImUi.${option.key === 'web_search' ? 'webSearchTools' : 'groupContextSearch'}`) }}</button></div></div>
      </div>
    </template>
    <div v-if="connect" class="pm-qr-box"><canvas ref="connectCanvas" class="pm-qr-canvas"></canvas><div class="pm-qr-hint">{{ connectHint }}</div><button class="pm-qr-cancel" @click="cancelConnect">{{ t('profileImUi.cancel') }}</button></div>
    <div v-if="connectErr" class="pm-qr-err">{{ connectErr }}</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import QRCode from 'qrcode'
import Icon from '@/components/common/icons/Icon.vue'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { feishuConnectApi, qqConnectApi, userBotsApi, wechatConnectApi } from '@/services/api'
import { optimisticMutation } from '@/utils/optimisticMutation'
import { beginOptimisticIntent, isOptimisticIntentCurrent, withOptimisticIntent } from '@/utils/optimisticIntent'
import MessageFormatSettings from './MessageFormatSettings.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { useI18n } from 'vue-i18n'

interface Bot { id: number; platform: string; name?: string; sandbox?: boolean; app_id?: string; enabled?: boolean; group_chat_enabled?: boolean; group_requires_at?: boolean; group_read_enabled?: boolean; group_memory_enabled?: boolean; member_memory_enabled?: boolean; group_response_mode?: string; group_allowed_tools?: string[]; group_message_format?: string; private_message_format?: string; private_streaming_enabled?: boolean; owner_bound?: boolean }
type BotSettingPatch = Partial<Pick<Bot,
  'enabled' | 'group_chat_enabled' | 'group_response_mode' | 'group_allowed_tools' |
  'group_message_format' | 'private_message_format' | 'private_streaming_enabled' |
  'group_memory_enabled' | 'member_memory_enabled'
>>

const groupResponseOptions = [
  { key: 'reply_all', label: '自动回复' },
  { key: 'reply_mentions', label: '只响应 @' },
  { key: 'record_only', label: '静默记录' },
] as const
const groupToolOptions = [
  { key: 'web_search', label: '联网搜索 + 网页阅读 + 搜图/读图/发图', tools: ['web_search', 'http_get', 'image_search', 'inspect_images', 'send_file'] },
  { key: 'group_context_search', label: '群上下文搜索', tools: ['group_context_search'] },
] as const
const preferences = usePreferencesStore()
const { t } = useI18n()
const platforms = [
  { key: 'feishu', labelKey: 'profileImUi.feishu', api: feishuConnectApi, hintKey: 'profileImUi.feishuHint' },
  { key: 'qq', labelKey: 'profileImUi.qq', api: qqConnectApi, hintKey: 'profileImUi.qqHint' },
  { key: 'wechat', labelKey: 'profileImUi.wechat', api: wechatConnectApi, hintKey: 'profileImUi.wechatHint' },
]
const bots = ref<Bot[]>([]); const botsOf = (platform: string) => bots.value.filter(bot => bot.platform === platform)
const helpPopBotId = ref<number | null>(null)
const helpAnchorRefs = ref<Record<number, HTMLElement | null>>({})
function setHelpAnchorRef(botId: number, el: unknown) { helpAnchorRefs.value[botId] = el instanceof HTMLElement ? el : null }
function toggleHelpPop(botId: number) { helpPopBotId.value = helpPopBotId.value === botId ? null : botId }
function onDocClickCloseHelp() { helpPopBotId.value = null }
const connecting = ref(''); const connect = ref<{ platform: string; id: string } | null>(null); const connectHint = ref(''); const connectErr = ref(''); const connectCanvas = ref<HTMLCanvasElement | null>(null); const bindingBotId = ref<number | null>(null); const bindingCodes = ref<Record<number, { code: string; expiresIn: number }>>({}); const copiedBindingBotId = ref<number | null>(null); let poll: ReturnType<typeof setInterval> | null = null; let bindingCountdown: ReturnType<typeof setInterval> | null = null; let bindingStatusPoll: ReturnType<typeof setInterval> | null = null; let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null

// 「接入咕咕」设置全部走同一套 latest-intent 乐观事务：apply 永远同步发生，
// 同 bot 同字段的 persistence 由 optimisticIntent 串行，旧失败不会回滚更新点击。
// 不在每次成功后整表 loadBots，避免慢 GET 把更晚的本地意图覆盖回旧值。
const pendingSettingWrites = new Set<Promise<void>>()
let settingsRevision = 0
let botsLoadSeq = 0

function toggleToolInteractions() {
  void preferences.saveShowToolInteractions(!preferences.showToolInteractions)
}

function botById(botId: number): Bot | undefined { return bots.value.find(bot => bot.id === botId) }
function displayBotName(bot: Bot): string {
  const name = bot.name?.trim() || ''
  const normalized = name.replace(/\s+/g, '')
  const defaultKey = bot.platform === 'feishu' && normalized === '我的飞书机器人'
    ? 'defaultFeishuBot'
    : bot.platform === 'qq' && normalized === '我的QQ机器人'
      ? 'defaultQqBot'
      : bot.platform === 'wechat' && ['我的微信', '我的微信机器人'].includes(normalized)
        ? 'defaultWechatBot'
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
    if (!Object.values(bindingCodes.value).some(binding => binding.expiresIn > 0)) stopBindingStatusPoll()
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

async function startConnect(platform: string) { const item = platforms.find(value => value.key === platform); if (!item) return; connecting.value = platform; connectErr.value = ''; try { const result = await item.api.start(); const id = result.poll_id || result.task_id; connect.value = { platform, id }; connectHint.value = t(`profileImUi.${platform}ConnectHint`); await nextTick(); await QRCode.toCanvas(connectCanvas.value, result.scan_url, { width: 180, margin: 1 }); startPoll(item) } catch (error) { connectErr.value = (error instanceof Error ? error.message : '') || t('profileImUi.qrGenerateFailed'); connect.value = null } finally { connecting.value = '' } }
function startPoll(platform: (typeof platforms)[number]) { stopPoll(); let tries = 0; poll = setInterval(async () => { tries++; try { if (!connect.value) return; const result = await platform.api.poll(connect.value.id); if (result.status === 'success') { cancelConnect(); await loadBots() } else if (result.status === 'expired') { connectErr.value = t('profileImUi.qrExpired'); cancelConnect() } else if (result.status === 'fail') { connectErr.value = t('profileImUi.connectionFailedWithReason', { reason: result.reason || t('profileImUi.unknownError') }); cancelConnect() } } catch {} if (tries > 100) cancelConnect() }, 3000) }
function stopPoll() { if (poll) { clearInterval(poll); poll = null } }
function resumePoll() {
  if (!connect.value) return
  const platform = platforms.find(value => value.key === connect.value?.platform)
  if (platform) startPoll(platform)
}
function cancelConnect() { stopPoll(); connect.value = null }
function toggleBot(bot: Bot) { const current = botById(bot.id); if (current) void updateBotSetting(bot.id, { enabled: !current.enabled }, t('profileImUi.connectionSettingsFailed')) }
async function createBindingCode(bot: Bot) { bindingBotId.value = bot.id; connectErr.value = ''; try { const result = await userBotsApi.createQqBindingCode(bot.id); bindingCodes.value = { ...bindingCodes.value, [bot.id]: { code: result.code, expiresIn: result.expires_in } }; startBindingStatusPoll() } catch (error) { connectErr.value = error instanceof Error ? error.message : t('profileImUi.codeGenerateFailed') } finally { bindingBotId.value = null } }
function tickBindingCodes() {
  const next = Object.fromEntries(Object.entries(bindingCodes.value).map(([id, binding]) => [id, { ...binding, expiresIn: Math.max(0, binding.expiresIn - 1) }]))
  bindingCodes.value = next
  if (!Object.values(next).some(binding => binding.expiresIn > 0)) stopBindingStatusPoll()
}
function startBindingStatusPoll() { stopBindingStatusPoll(); bindingStatusPoll = setInterval(() => { void loadBots() }, 3000) }
function stopBindingStatusPoll() { if (bindingStatusPoll) { clearInterval(bindingStatusPoll); bindingStatusPoll = null } }
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(el)
    return copied
  }
}
async function copyBindingCode(botId: number) {
  const binding = bindingCodes.value[botId]
  if (!binding) return
  const copied = await copyText(binding.code)
  if (!copied) { connectErr.value = t('profileImUi.copyFailed'); return }
  copiedBindingBotId.value = botId
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = setTimeout(() => { copiedBindingBotId.value = null; copyFeedbackTimer = null }, 1600)
}
async function unbindQqIdentity(bot: Bot) {
  if (!await confirmDialog({ title: t('profileImUi.unbindQqTitle'), message: t('profileImUi.unbindQqMessage'), tone: 'warning', confirmText: t('profileImUi.unbindQq') })) return
  try {
    await userBotsApi.unbindQqIdentity(bot.id)
    patchLocalBot(bot.id, { owner_bound: false })
    const next = { ...bindingCodes.value }
    delete next[bot.id]
    bindingCodes.value = next
  } catch (error) { connectErr.value = (error instanceof Error ? error.message : '') || t('profileImUi.unbindQqFailed') }
}
function clearCopyFeedback() { if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer); copyFeedbackTimer = null; copiedBindingBotId.value = null }
function toggleGroupChat(bot: Bot) { const current = botById(bot.id); if (current) void updateBotSetting(bot.id, { group_chat_enabled: !current.group_chat_enabled }, '群聊设置失败') }
function toggleMemory(bot: Bot, field: 'group_memory_enabled' | 'member_memory_enabled') {
  const current = botById(bot.id)
  if (current) void updateBotSetting(bot.id, { [field]: current[field] !== false ? false : true }, '群聊记忆设置失败')
}
function groupResponseMode(bot: Bot): string { return bot.group_response_mode ?? (bot.group_read_enabled ? 'record_only' : bot.group_requires_at ? 'reply_mentions' : 'reply_all') }
function setGroupResponseMode(bot: Bot, mode: string) { void updateBotSetting(bot.id, { group_response_mode: mode }, '群聊回应方式设置失败') }
function groupTools(bot: Bot): string[] { return bot.group_allowed_tools ?? ['web_search', 'http_get', 'image_search', 'inspect_images', 'send_file'] }
function hasGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]): boolean { return option.tools.every(t => groupTools(bot).includes(t)) }
function toggleGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]) {
  const current = botById(bot.id)
  if (!current) return
  const tools = new Set(groupTools(current))
  if (hasGroupTool(current, option)) option.tools.forEach(t => tools.delete(t))
  else option.tools.forEach(t => tools.add(t))
  void updateBotSetting(bot.id, { group_allowed_tools: [...tools] }, '群聊工具设置失败')
}
function setMessageFormat(bot: Bot, scope: 'group' | 'private', mode: string) {
  const patch = scope === 'group' ? { group_message_format: mode } : { private_message_format: mode }
  void updateBotSetting(bot.id, patch, '消息格式设置失败')
}
function togglePrivateStreaming(bot: Bot) {
  const current = botById(bot.id)
  if (current) void updateBotSetting(bot.id, { private_streaming_enabled: current.private_streaming_enabled !== true }, t('profileImUi.privateStreamingFailed'))
}
async function removeBot(bot: Bot) { if (!await confirmDialog({ title: t('profileImUi.deleteBotTitle'), message: t('profileImUi.deleteBotMessage', { name: displayBotName(bot) }), tone: 'danger', confirmText: t('profileImUi.deleteBot') })) return; try { await waitForSettingWrites(); await userBotsApi.remove(bot.id); await loadBots() } catch (error) { connectErr.value = error instanceof Error ? error.message : t('profileImUi.connectionFailed') } }
onMounted(() => { void preferences.fetch(); loadBots(); bindingCountdown = setInterval(tickBindingCodes, 1000); document.addEventListener('click', onDocClickCloseHelp) })
onDeactivated(stopPoll)
onDeactivated(stopBindingStatusPoll)
onDeactivated(clearCopyFeedback)
onDeactivated(onDocClickCloseHelp)
onActivated(resumePoll)
onActivated(() => { if (Object.values(bindingCodes.value).some(binding => binding.expiresIn > 0)) startBindingStatusPoll() })
onBeforeUnmount(() => { stopBindingStatusPoll(); if (bindingCountdown) clearInterval(bindingCountdown); if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer); document.removeEventListener('click', onDocClickCloseHelp) })
</script>

<style scoped>
.pm-interaction-preference-row {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}

.pm-binding-code {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.pm-binding-code-result {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px 3px 10px;
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
}

.pm-binding-code-command {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}

.pm-binding-code-prefix {
  font-size: 11px;
  font-weight: 600;
  color: var(--content-secondary);
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
  border-radius: var(--radius-xs);
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
