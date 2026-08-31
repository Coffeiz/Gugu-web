<template>
  <div class="onboarding-im-setup" v-bind="$attrs">
    <article v-for="platform in platforms" :key="platform.key" class="onboarding-im-card" :class="{ 'is-connected': botsOf(platform.key).length, 'is-open': connect?.platform === platform.key }">
      <div class="onboarding-im-card-head">
        <span class="onboarding-im-icon">
          <RiChat1Fill v-if="platform.key === 'feishu'" />
          <RiQqFill v-else-if="platform.key === 'qq'" />
          <RiWechatFill v-else />
        </span>
        <div class="onboarding-im-copy"><strong>{{ t(platform.labelKey) }}</strong><small>{{ botsOf(platform.key).length ? t('profileImUi.connectedRebind') : t(platform.hintKey) }}</small></div>
        <span v-if="botsOf(platform.key).length" class="onboarding-im-status">{{ t('profileImUi.enabled') }}</span>
        <button type="button" class="onboarding-im-connect" :disabled="connecting === platform.key" @click="startConnect(platform)">{{ connecting === platform.key ? t('profileImUi.generating') : botsOf(platform.key).length ? t('profileImUi.connectedRebind') : t('profileImUi.scanToConnect') }}</button>
      </div>
    </article>
  </div>
  <BaseModal :show="modalVisible" width="420px" background="var(--surface-card-solid)" teleport-to="body" @close="cancelConnect">
    <div v-if="modalPlatform" class="onboarding-im-modal">
      <div class="onboarding-im-modal-head">
        <span class="onboarding-im-icon">
          <RiChat1Fill v-if="modalPlatform.key === 'feishu'" />
          <RiQqFill v-else-if="modalPlatform.key === 'qq'" />
          <RiWechatFill v-else />
        </span>
        <div class="onboarding-im-copy"><strong>{{ t(modalPlatform.labelKey) }}</strong><small>{{ t('profileImUi.scanToConnect') }}</small></div>
      </div>
      <div class="onboarding-im-modal-body" role="status">
        <canvas ref="connectCanvas" class="onboarding-im-qr-canvas"></canvas>
        <div class="onboarding-im-qr-copy">{{ connectErr || connectHint }}</div>
      </div>
      <div class="onboarding-im-modal-actions"><button type="button" class="onboarding-im-cancel" @click="cancelConnect">{{ t('profileImUi.cancel') }}</button></div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import QRCode from 'qrcode'
import { RiChat1Fill, RiQqFill, RiWechatFill } from '@remixicon/vue'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import { feishuConnectApi, qqConnectApi, userBotsApi, wechatConnectApi } from '@/services/api'
import { useI18n } from 'vue-i18n'

defineOptions({ inheritAttrs: false })

interface Bot { id: number; platform: string }
type Platform = { key: string; labelKey: string; hintKey: string; api: typeof feishuConnectApi }

const { t } = useI18n()
const platforms: Platform[] = [
  { key: 'feishu', labelKey: 'profileImUi.feishu', hintKey: 'profileImUi.feishuHint', api: feishuConnectApi },
  { key: 'qq', labelKey: 'profileImUi.qq', hintKey: 'profileImUi.qqHint', api: qqConnectApi },
  { key: 'wechat', labelKey: 'profileImUi.wechat', hintKey: 'profileImUi.wechatHint', api: wechatConnectApi },
]
const bots = ref<Bot[]>([])
const connecting = ref('')
const connect = ref<{ platform: string; id: string } | null>(null)
const modalPlatform = ref<Platform | null>(null)
const modalVisible = ref(false)
const connectHint = ref('')
const connectErr = ref('')
const connectCanvas = ref<HTMLCanvasElement | null>(null)
let poll: ReturnType<typeof setInterval> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

const botsOf = (platform: string) => bots.value.filter(bot => bot.platform === platform)
async function loadBots() {
  try {
    const result = await userBotsApi.list()
    bots.value = result.items || []
  } catch { bots.value = [] }
}
async function startConnect(platform: Platform) {
  connecting.value = platform.key; connectErr.value = ''
  try {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    const result = await platform.api.start(); modalPlatform.value = platform; connect.value = { platform: platform.key, id: result.poll_id || result.task_id }; modalVisible.value = true
    connectHint.value = t(`profileImUi.${platform.key}ConnectHint`); await nextTick()
    await QRCode.toCanvas(connectCanvas.value, result.scan_url, { width: 168, margin: 1 }); startPoll(platform)
  } catch (error) { connectErr.value = error instanceof Error ? error.message : t('profileImUi.qrGenerateFailed'); connect.value = null }
  finally { connecting.value = '' }
}
function startPoll(platform: Platform) {
  stopPoll(); let tries = 0
  poll = setInterval(async () => {
    tries++; if (!connect.value) return
    try {
      const result = await platform.api.poll(connect.value.id)
      if (result.status === 'success') { cancelConnect(); await loadBots() }
      else if (result.status === 'expired') { connectErr.value = t('profileImUi.qrExpired'); cancelConnect() }
      else if (result.status === 'fail') { connectErr.value = t('profileImUi.connectionFailedWithReason', { reason: result.reason || t('profileImUi.unknownError') }); cancelConnect() }
    } catch { /* 网络抖动时保留二维码，下一轮继续 */ }
    if (tries > 100) cancelConnect()
  }, 3000)
}
function stopPoll() { if (poll) { clearInterval(poll); poll = null } }
function cancelConnect() {
  stopPoll(); modalVisible.value = false
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    if (!modalVisible.value) { connect.value = null; modalPlatform.value = null }
    closeTimer = null
  }, 180)
}
onMounted(loadBots)
onBeforeUnmount(() => { stopPoll(); if (closeTimer) clearTimeout(closeTimer) })
</script>

<style scoped>
.onboarding-im-setup { align-self: center; display: grid; gap: var(--space-sm); width: 100%; min-width: 0; }
.onboarding-im-card { min-width: 0; padding: var(--space-md); border: 1px solid var(--workspace-card-border); border-radius: var(--card-radius); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); transition: border-color var(--motion-hover-control), box-shadow var(--motion-hover-control); }
.onboarding-im-card:hover, .onboarding-im-card.is-open { border-color: var(--workspace-card-border-hover); }
.onboarding-im-card.is-open { border-color: var(--workspace-card-border-hover); }
.onboarding-im-card-head { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; }
.onboarding-im-icon { flex: 0 0 34px; width: 34px; height: 34px; display: grid; place-items: center; border-radius: var(--control-radius); background: var(--action-soft); color: var(--action-primary); }
.onboarding-im-icon > svg { width: 16px; height: 16px; }
.onboarding-im-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
.onboarding-im-copy strong { color: var(--content-primary); font-size: var(--font-size-sm); }
.onboarding-im-copy small { overflow: hidden; color: var(--content-tertiary); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.onboarding-im-status { flex: 0 0 auto; color: var(--status-success); font-size: var(--font-size-xs); }
.onboarding-im-connect, .onboarding-im-cancel {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  min-height: var(--choice-chip-min-height); padding: var(--choice-chip-padding);
  border: 1px solid var(--choice-chip-border); border-radius: var(--choice-chip-radius);
  background: var(--choice-chip-bg); color: var(--choice-chip-fg);
  font: 500 var(--font-size-xs) var(--font-sans); line-height: var(--choice-chip-line-height);
  cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.onboarding-im-connect:hover, .onboarding-im-cancel:hover { border-color: var(--choice-chip-border-hover); background: var(--choice-chip-bg-hover); color: var(--choice-chip-fg-hover); }
.onboarding-im-connect:disabled { opacity: .45; cursor: not-allowed; }
.onboarding-im-connect:disabled:hover { border-color: var(--choice-chip-border); background: var(--choice-chip-bg); color: var(--choice-chip-fg); }
.onboarding-im-qr-canvas { display: block; width: 168px; height: 168px; padding: var(--space-xs); border-radius: var(--radius-sm); background: var(--content-on-accent); }
.onboarding-im-qr-copy { min-width: 0; color: var(--content-secondary); font-size: var(--font-size-xs); line-height: 1.55; }
.onboarding-im-modal { padding: var(--space-lg); }
.onboarding-im-modal-head { display: flex; align-items: center; gap: var(--space-sm); padding-bottom: var(--space-md); border-bottom: 1px solid var(--panel-divider); }
.onboarding-im-modal-body { display: flex; flex-direction: column; align-items: center; gap: var(--space-md); padding: var(--space-lg) 0; text-align: center; }
.onboarding-im-modal-body .onboarding-im-qr-copy { max-width: 280px; }
.onboarding-im-modal-actions { display: flex; justify-content: flex-end; padding-top: var(--space-sm); border-top: 1px solid var(--panel-divider); }
</style>
