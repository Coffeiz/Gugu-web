<template>
  <BaseModal :show="show" width="520px" background="var(--panel-bg)" @close="emit('close')">
    <div class="support-modal">
      <div class="support-header">
        <div>
          <h2>{{ t('layout.support') }}</h2>
          <p>{{ t('layout.supportHint') }}</p>
        </div>
        <CloseButton :title="t('common.actions.close')" @click="emit('close')" />
      </div>
      <div class="support-grid">
        <button v-if="SUPPORT_KOFI_URL" class="support-card" type="button" @click="openLink(SUPPORT_KOFI_URL)">
          <KoFiIcon class="support-card-mark" :size="24" />
          <span class="support-card-copy"><strong>{{ t('layout.kofi') }}</strong><small>{{ t('layout.openSupportLink') }}</small></span>
          <RiExternalLinkLine class="support-card-external" size="16" aria-hidden="true" />
        </button>
        <button v-if="SUPPORT_ALIPAY_QR_URL" class="support-card support-card-qr" type="button" :aria-expanded="expandedQr === 'alipay'" @click="toggleQr('alipay')">
          <span class="support-card-summary"><RiAlipayFill class="support-card-mark" size="24" aria-hidden="true" /><span class="support-card-copy"><strong>{{ t('layout.alipay') }}</strong><small>{{ t('layout.qrHint') }}</small></span><FlipChevron :open="expandedQr === 'alipay'" :size="10" :transition="'transform var(--motion-hover-card) var(--motion-ease-emphasis)'" aria-hidden="true" /></span>
          <span class="support-qr-detail" :class="{ expanded: expandedQr === 'alipay' }"><span class="support-qr-detail-inner"><img :src="SUPPORT_ALIPAY_QR_URL" :alt="t('layout.alipay')" /></span></span>
        </button>
        <button v-if="SUPPORT_WECHAT_QR_URL" class="support-card support-card-qr" type="button" :aria-expanded="expandedQr === 'wechat'" @click="toggleQr('wechat')">
          <span class="support-card-summary"><RiWechatFill class="support-card-mark" size="24" aria-hidden="true" /><span class="support-card-copy"><strong>{{ t('layout.wechat') }}</strong><small>{{ t('layout.qrHint') }}</small></span><FlipChevron :open="expandedQr === 'wechat'" :size="10" :transition="'transform var(--motion-hover-card) var(--motion-ease-emphasis)'" aria-hidden="true" /></span>
          <span class="support-qr-detail" :class="{ expanded: expandedQr === 'wechat' }"><span class="support-qr-detail-inner"><img :src="SUPPORT_WECHAT_QR_URL" :alt="t('layout.wechat')" /></span></span>
        </button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import BaseModal from './BaseModal.vue'
import CloseButton from './CloseButton.vue'
import FlipChevron from './FlipChevron.vue'
import KoFiIcon from './KoFiIcon.vue'
import { RiAlipayFill, RiExternalLinkLine, RiWechatFill } from '@remixicon/vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORT_ALIPAY_QR_URL, SUPPORT_KOFI_URL, SUPPORT_WECHAT_QR_URL } from '@/config/support'

defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const expandedQr = ref<'alipay' | 'wechat' | ''>('')

function openLink(url: string) { window.open(url, '_blank', 'noopener,noreferrer') }
function toggleQr(channel: 'alipay' | 'wechat') { expandedQr.value = expandedQr.value === channel ? '' : channel }
</script>

<style scoped>
.support-modal { padding:24px; color:var(--content-primary); }
.support-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:20px; }
.support-header h2 { margin:0; font-size:18px; line-height:1.35; }
.support-header p { margin:6px 0 0; color:var(--content-secondary); font-size:12px; }
.support-header :deep(.app-close-button) { flex:0 0 30px; }
.support-grid { display:flex; flex-direction:column; gap:8px; }
.support-card { width:100%; min-width:0; padding:12px 14px; display:flex; align-items:center; gap:12px; border:1px solid var(--border-hairline); border-radius:var(--radius-md); background:var(--surface-soft); color:var(--content-primary); text-align:left; cursor:pointer; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard); }
.support-card:hover { background:var(--surface-soft-hover); border-color:var(--border-focus); }
.support-card-summary { width:100%; display:flex; align-items:center; gap:12px; }
.support-card-summary :deep(.flip-chevron) { margin-left:auto; }
.support-card-mark { flex:0 0 42px; width:42px; height:42px; padding:9px; box-sizing:border-box; border-radius:50%; background:var(--selection-bg); color:var(--selection-fg); }
.support-card-copy { display:flex; flex-direction:column; gap:5px; }
.support-card-copy strong, .support-card-qr strong { font-size:14px; }
.support-card-copy small { color:var(--content-secondary); font-size:11px; line-height:1.4; }
.support-card-external { margin-left:auto; color:var(--content-secondary); }
.support-card-qr { flex-direction:column; align-items:stretch; gap:0; }
.support-qr-detail { width:100%; height:0; opacity:0; overflow:hidden; transition:height var(--motion-hover-card) var(--motion-ease-emphasis), opacity var(--motion-hover-card) var(--motion-ease-standard), margin-top var(--motion-hover-card) var(--motion-ease-emphasis); }
.support-qr-detail.expanded { height:360px; margin-top:12px; opacity:1; }
.support-qr-detail-inner { display:flex; justify-content:center; min-height:0; height:360px; overflow:hidden; }
.support-qr-detail img { display:block; width:auto; max-width:100%; height:360px; object-fit:contain; border-radius:var(--radius-sm); background:#fff; }
</style>
