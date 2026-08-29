<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">精力</div>
      <div v-if="quotaLoading" class="pm-quota-skeleton">
        <div v-for="label in ['精力', '本周']" :key="label" class="pm-quota-item"><div class="pm-quota-row"><span class="pm-quota-label">{{ label }}</span><div class="pm-qs-pct"></div></div><div class="pm-quota-bar"><div class="pm-qs-fill"></div></div></div>
      </div>
      <template v-else>
        <div class="pm-quota-item"><div class="pm-quota-row"><span class="pm-quota-label">{{ recoverLabel }}</span><span class="pm-quota-pct" :class="quotaPctClass(quota.used_6h, quota.limit_6h)">{{ quota.limit_6h ? Math.round(quota.used_6h / quota.limit_6h * 100) + '%' : '不限' }}</span></div><div class="pm-quota-bar"><div class="pm-quota-fill" :style="quotaBarStyle(quota.used_6h, quota.limit_6h)" /></div></div>
        <div class="pm-quota-item"><div class="pm-quota-row"><span class="pm-quota-label">本周</span><span class="pm-quota-pct" :class="quotaPctClass(quota.used_weekly, quota.limit_weekly)">{{ quota.limit_weekly ? Math.round(quota.used_weekly / quota.limit_weekly * 100) + '%' : '不限' }}</span></div><div class="pm-quota-bar"><div class="pm-quota-fill" :style="quotaBarStyle(quota.used_weekly, quota.limit_weekly)" /></div></div>
      </template>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">回复风格</div>
      <div v-for="setting in styleSettings" :key="setting.key" class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ setting.label }}</span><span class="pm-field-hint">{{ setting.hint }}</span></div><div class="pm-style-group"><button v-for="opt in setting.options" :key="opt.value" class="pm-style-chip" :class="{ active: setting.current === opt.value }" @click="setting.select(opt.value)">{{ opt.label }}</button></div></div>
    </div>
    <div class="pm-sep"></div>
    <ProfilePersonalityPane />
    <div class="pm-sep"></div>
    <div class="pm-section"><div class="pm-section-label">对话</div><div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">重开浏览器时</span><span class="pm-field-hint">下次重新打开浏览器，是接着上次的对话、还是开一段新对话</span></div><div class="pm-style-group"><button class="pm-style-chip" :class="{ active: reopenResume }" @click="setReopenResume(true)">接着上次</button><button class="pm-style-chip" :class="{ active: !reopenResume }" @click="setReopenResume(false)">开新对话</button></div></div></div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">记忆</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">删除所有记忆</span><span class="pm-field-hint">清除咕咕记住的关于你的所有事实和对话记录，不可恢复</span></div><button class="pm-danger-btn" :disabled="memoryClearing" @click="clearMemory">{{ memoryClearing ? '清除中…' : '删除记忆' }}</button></div>
      <div v-if="memoryMsg" class="pm-msg" :class="memoryMsgType">{{ memoryMsg }}</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">删除临时文件</span><span class="pm-field-hint">清除发给咕咕但未存入文件库的聊天附件（图片、文件等），临时文件 7 天后自动过期</span></div><button class="pm-danger-btn" :disabled="attachClearing" @click="clearAttachments">{{ attachClearing ? '清除中…' : '删除临时文件' }}</button></div>
      <div v-if="attachMsg" class="pm-msg" :class="attachMsgType">{{ attachMsg }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { agentApi, authApi } from '@/services/api'
import { usePreferencesStore } from '@/stores/preferences'
import { confirmDialog } from '@/composables/useConfirmDialog'
import ProfilePersonalityPane from './ProfilePersonalityPane.vue'

const prefsStore = usePreferencesStore()
const TONE_OPTS = [{ value: 'natural', label: '自然' }, { value: 'formal', label: '正式' }, { value: 'lively', label: '活泼' }]
const LENGTH_OPTS = [{ value: 'medium', label: '适中' }, { value: 'short', label: '简短' }, { value: 'detailed', label: '详细' }]
const reopenResume = ref(localStorage.getItem('gugu_reopen_resume') === '1')
function setReopenResume(value: boolean) { reopenResume.value = value; localStorage.setItem('gugu_reopen_resume', value ? '1' : '0') }

const quota = ref({ used_6h: 0, limit_6h: null as number | null, reset_6h_at: null as string | null, used_weekly: 0, limit_weekly: null as number | null })
const quotaLoading = ref(false)
const recoverLabel = computed(() => {
  if (!quota.value.used_6h || !quota.value.reset_6h_at) return '精力充沛'
  const diffMs = new Date(quota.value.reset_6h_at).getTime() - Date.now()
  if (diffMs <= 0) return '精力充沛'
  const minutes = Math.ceil(diffMs / 60000); const hours = Math.floor(minutes / 60); const rest = minutes % 60
  return `${hours > 0 ? `${hours} 小时 ${rest} 分钟` : `${rest} 分钟`}后恢复精力`
})
function quotaBarStyle(used: number, limit: number | null) { if (!limit) return { width: '8%', background: 'rgba(123,127,178,0.3)' }; const pct = Math.min(100, used / limit * 100); const color = pct >= 90 ? 'rgba(200,80,80,0.7)' : pct >= 70 ? 'rgba(210,160,60,0.75)' : 'linear-gradient(90deg, rgba(123,127,178,0.6), rgba(149,144,196,0.75))'; return { width: pct + '%', background: color } }
function quotaPctClass(used: number, limit: number | null) { if (!limit) return ''; const pct = used / limit * 100; return pct >= 90 ? 'pct-danger' : pct >= 70 ? 'pct-warn' : '' }
async function loadQuota() { quotaLoading.value = true; try { quota.value = await authApi.getQuota() } catch {} finally { quotaLoading.value = false } }

const memoryClearing = ref(false); const memoryMsg = ref(''); const memoryMsgType = ref('ok')
async function clearMemory() { if (!await confirmDialog({ title: '删除咕咕记忆', message: '确定要删除咕咕的所有记忆吗？此操作不可恢复。', tone: 'danger', confirmText: '删除记忆' })) return; memoryClearing.value = true; memoryMsg.value = ''; try { await agentApi.clearMemory(); memoryMsg.value = '记忆已清除'; memoryMsgType.value = 'ok' } catch (error) { memoryMsg.value = (error instanceof Error ? error.message : '') || '删除失败'; memoryMsgType.value = 'err' } finally { memoryClearing.value = false } }
const attachClearing = ref(false); const attachMsg = ref(''); const attachMsgType = ref('ok')
async function clearAttachments() { if (!await confirmDialog({ title: '删除临时文件', message: '确定要删除所有临时文件吗？', tone: 'danger', confirmText: '删除文件' })) return; attachClearing.value = true; attachMsg.value = ''; try { const result = await agentApi.clearAttachments(); attachMsg.value = result.deleted > 0 ? `已删除 ${result.deleted} 个临时文件` : '没有可删除的临时文件'; attachMsgType.value = 'ok' } catch (error) { attachMsg.value = (error instanceof Error ? error.message : '') || '删除失败'; attachMsgType.value = 'err' } finally { attachClearing.value = false } }

const styleSettings = computed(() => [
  { key: 'tone', label: '语气', hint: '咕咕回复时的语气风格', current: prefsStore.replyTone ?? 'natural', options: TONE_OPTS, select: (value: string) => prefsStore.saveStyle({ tone: value === 'natural' ? null : value }) },
  { key: 'length', label: '回复长度', hint: '咕咕回复内容的详细程度', current: prefsStore.replyLength ?? 'medium', options: LENGTH_OPTS, select: (value: string) => prefsStore.saveStyle({ length: value === 'medium' ? null : value }) },
])
onMounted(() => { loadQuota(); reopenResume.value = localStorage.getItem('gugu_reopen_resume') === '1' })
</script>
