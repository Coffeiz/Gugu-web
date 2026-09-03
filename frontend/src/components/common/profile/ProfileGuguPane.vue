<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">{{ quota.is_byok ? t('profileGuguUi.tokenUsage') : t('profileGuguUi.energy') }}</div>
      <div v-if="quotaLoading" class="pm-quota-skeleton">
        <div v-for="label in [t('profileGuguUi.energy'), t('profileGuguUi.thisWeek')]" :key="label" class="pm-quota-item"><div class="pm-quota-row"><span class="pm-quota-label">{{ label }}</span><div class="pm-qs-pct"></div></div><div class="pm-quota-bar"><div class="pm-qs-fill"></div></div></div>
      </div>
      <template v-else>
        <template v-if="quota.is_byok">
          <TokenTrendChart
            :labels="trends?.labels ?? []"
            :tokens-in="trends?.tokens_in ?? []"
            :cache-read="trends?.cache_read ?? []"
            :tokens-out="trends?.tokens_out ?? []"
          />
        </template>
        <template v-else>
          <div class="pm-quota-item"><div class="pm-quota-row"><span class="pm-quota-label">{{ recoverLabel }}</span><span class="pm-quota-pct" :class="quotaPctClass(quota.used_6h, quota.limit_6h)">{{ quota.limit_6h ? Math.round(quota.used_6h / quota.limit_6h * 100) + '%' : t('profileGuguUi.unlimited') }}</span></div><div class="pm-quota-bar"><div class="pm-quota-fill" :style="quotaBarStyle(quota.used_6h, quota.limit_6h)" /></div></div>
          <div class="pm-quota-item"><div class="pm-quota-row"><span class="pm-quota-label">{{ t('profileGuguUi.thisWeek') }}</span><span class="pm-quota-pct" :class="quotaPctClass(quota.used_weekly, quota.limit_weekly)">{{ quota.limit_weekly ? Math.round(quota.used_weekly / quota.limit_weekly * 100) + '%' : t('profileGuguUi.unlimited') }}</span></div><div class="pm-quota-bar"><div class="pm-quota-fill" :style="quotaBarStyle(quota.used_weekly, quota.limit_weekly)" /></div></div>
        </template>
      </template>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('profileGuguUi.replyStyle') }}</div>
      <div v-for="setting in styleSettings" :key="setting.key" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ setting.label }}</span><span class="pm-field-hint">{{ setting.hint }}</span></div><div class="pm-style-group"><button v-for="opt in setting.options" :key="opt.value" class="pm-style-chip" :class="{ active: setting.current === opt.value }" @click="setting.select(opt.value)">{{ opt.label }}</button></div></div>
    </div>
    <div class="pm-sep"></div>
    <ProfilePersonalityPane />
    <div class="pm-sep"></div>
    <div class="pm-section"><div class="pm-section-label">{{ t('profileGuguUi.conversation') }}</div><div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileGuguUi.reopen') }}</span><span class="pm-field-hint">{{ t('profileGuguUi.reopenHint') }}</span></div><div class="pm-style-group"><button class="pm-style-chip" :class="{ active: reopenResume }" @click="setReopenResume(true)">{{ t('profileGuguUi.resume') }}</button><button class="pm-style-chip" :class="{ active: !reopenResume }" @click="setReopenResume(false)">{{ t('profileGuguUi.newConversation') }}</button></div></div></div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('profileGuguUi.memory') }}</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileGuguUi.deleteAllMemory') }}</span><span class="pm-field-hint">{{ t('profileGuguUi.memoryHint') }}</span></div><button class="pm-danger-btn" :disabled="memoryClearing" @click="clearMemory">{{ memoryClearing ? t('profileGuguUi.clearing') : t('profileGuguUi.deleteMemory') }}</button></div>
      <div v-if="memoryMsg" class="pm-msg" :class="memoryMsgType">{{ memoryMsg }}</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('profileGuguUi.deleteAttachments') }}</span><span class="pm-field-hint">{{ t('profileGuguUi.attachmentsHint') }}</span></div><button class="pm-danger-btn" :disabled="attachClearing" @click="clearAttachments">{{ attachClearing ? t('profileGuguUi.clearing') : t('profileGuguUi.deleteAttachments') }}</button></div>
      <div v-if="attachMsg" class="pm-msg" :class="attachMsgType">{{ attachMsg }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { agentApi, authApi } from '@/services/api'
import { usePreferencesStore } from '@/stores/preferences'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import ProfilePersonalityPane from './ProfilePersonalityPane.vue'
import TokenTrendChart from './TokenTrendChart.vue'

const { t } = useI18n()

const prefsStore = usePreferencesStore()
const TONE_OPTS = computed(() => [{ value: 'natural', label: t('profileGuguUi.natural') }, { value: 'formal', label: t('profileGuguUi.formal') }, { value: 'lively', label: t('profileGuguUi.lively') }])
const LENGTH_OPTS = computed(() => [{ value: 'medium', label: t('profileGuguUi.medium') }, { value: 'short', label: t('profileGuguUi.short') }, { value: 'detailed', label: t('profileGuguUi.detailed') }])
const reopenResume = ref(localStorage.getItem('gugu_reopen_resume') === '1')
function setReopenResume(value: boolean) { reopenResume.value = value; localStorage.setItem('gugu_reopen_resume', value ? '1' : '0') }

const quota = ref({ used_6h: 0, limit_6h: null as number | null, reset_6h_at: null as string | null, used_weekly: 0, limit_weekly: null as number | null, usage_kind: 'platform', is_byok: false, byok_tokens_today: 0, byok_tokens_month: 0, byok_cache_rate: 0 })
const quotaLoading = ref(false)
const trends = ref<{ labels: string[]; tokens_in: number[]; cache_read: number[]; tokens_out: number[] } | null>(null)
const recoverLabel = computed(() => {
  if (!quota.value.used_6h || !quota.value.reset_6h_at) return t('profileGuguUi.fullEnergy')
  const diffMs = new Date(quota.value.reset_6h_at).getTime() - Date.now()
  if (diffMs <= 0) return t('profileGuguUi.fullEnergy')
  const minutes = Math.ceil(diffMs / 60000); const hours = Math.floor(minutes / 60); const rest = minutes % 60
  return t('profileGuguUi.energyRecovery', { time: hours > 0 ? t('profileGuguUi.hoursMinutes', { hours, minutes: rest }) : t('profileGuguUi.minutes', { minutes: rest }) })
})
function quotaBarStyle(used: number, limit: number | null) { if (!limit) return { width: '8%', background: 'rgba(123,127,178,0.3)' }; const pct = Math.min(100, used / limit * 100); const color = pct >= 90 ? 'rgba(200,80,80,0.7)' : pct >= 70 ? 'rgba(210,160,60,0.75)' : 'linear-gradient(90deg, rgba(123,127,178,0.6), rgba(149,144,196,0.75))'; return { width: pct + '%', background: color } }
function quotaPctClass(used: number, limit: number | null) { if (!limit) return ''; const pct = used / limit * 100; return pct >= 90 ? 'pct-danger' : pct >= 70 ? 'pct-warn' : '' }
async function loadQuota() { quotaLoading.value = true; try { quota.value = await authApi.getQuota(); if (quota.value.is_byok) loadTrends() } catch {} finally { quotaLoading.value = false } }
async function loadTrends() { try { trends.value = await authApi.getUsageTrends(30) } catch {} }
function onQuotaChanged() { loadQuota() }

const memoryClearing = ref(false); const memoryMsg = ref(''); const memoryMsgType = ref('ok')
async function clearMemory() { if (!await confirmDialog({ title: t('profileGuguUi.deleteMemoryTitle'), message: t('profileGuguUi.deleteMemoryMessage'), tone: 'danger', confirmText: t('profileGuguUi.deleteMemory') })) return; memoryClearing.value = true; memoryMsg.value = ''; try { await agentApi.clearMemory(); memoryMsg.value = t('profileGuguUi.cleared'); memoryMsgType.value = 'ok' } catch (error) { memoryMsg.value = (error instanceof Error ? error.message : '') || t('profileGuguUi.deleteFailed'); memoryMsgType.value = 'err' } finally { memoryClearing.value = false } }
const attachClearing = ref(false); const attachMsg = ref(''); const attachMsgType = ref('ok')
async function clearAttachments() { if (!await confirmDialog({ title: t('profileGuguUi.deleteAttachments'), message: t('profileGuguUi.deleteAttachmentsConfirm'), tone: 'danger', confirmText: t('profileGuguUi.deleteFiles') })) return; attachClearing.value = true; attachMsg.value = ''; try { const result = await agentApi.clearAttachments(); attachMsg.value = result.deleted > 0 ? t('profileGuguUi.attachmentsDeleted', { count: result.deleted }) : t('profileGuguUi.noAttachments'); attachMsgType.value = 'ok' } catch (error) { attachMsg.value = (error instanceof Error ? error.message : '') || t('profileGuguUi.deleteFailed'); attachMsgType.value = 'err' } finally { attachClearing.value = false } }

const styleSettings = computed(() => [
  { key: 'tone', label: t('profileGuguUi.tone'), hint: t('profileGuguUi.toneHint'), current: prefsStore.replyTone ?? 'natural', options: TONE_OPTS.value, select: (value: string) => prefsStore.saveStyle({ tone: value === 'natural' ? null : value }) },
  { key: 'length', label: t('profileGuguUi.replyLength'), hint: t('profileGuguUi.replyLengthHint'), current: prefsStore.replyLength ?? 'medium', options: LENGTH_OPTS.value, select: (value: string) => prefsStore.saveStyle({ length: value === 'medium' ? null : value }) },
])
onMounted(() => { loadQuota(); reopenResume.value = localStorage.getItem('gugu_reopen_resume') === '1'; window.addEventListener('gugu-quota-changed', onQuotaChanged) })
onUnmounted(() => window.removeEventListener('gugu-quota-changed', onQuotaChanged))
</script>

<style scoped>
</style>
